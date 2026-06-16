// Tests for the M5.2 confidence-gated auto-approve seam.
//
// We do NOT touch the live `goal_proposals` table — every test injects its
// own insertProposal / recordProposalDecision / setResultingTaskId fake
// through `AutoApproveDeps`. The control plane is also a vi.fn() spy that
// records every `postCommand` call so we can assert payload shape +
// idempotency-key formatting end-to-end.

import { describe, it, expect, vi } from 'vitest';

import {
  autoApproveProposals,
  formatAutoBanditDecidedBy,
  resolveAutoApproveThreshold,
  splitAndDispatch,
  type AutoApproveDeps,
  type SplitAndDispatchDeps,
} from '../auto-approve.ts';
import type {
  ControlCommand,
  ControlPlaneAck,
  ControlPlaneClient,
} from '../../../contracts/control-plane-client.ts';
import type { DedupedCandidate, ProposerConfig } from '../types.ts';

const AUTO_APPROVE_THRESHOLD_ENV = 'IFLEET_PROPOSALS_AUTO_APPROVE_THRESHOLD';

function baseCfg(overrides: Partial<ProposerConfig> = {}): ProposerConfig {
  return {
    repoId: 'weautomatehq1/IFleet',
    repoRoot: '/nonexistent',
    budget: 3,
    hardMax: 10,
    windowDays: 7,
    pastProposalsWindowDays: 30,
    embeddingModel: 'text-embedding-3-small',
    dedupThreshold: 0.85,
    ...overrides,
  };
}

function candidate(
  title: string,
  composite_score: number,
  overrides: Partial<DedupedCandidate> = {},
): DedupedCandidate {
  return {
    title,
    rationale: `rationale for ${title}`,
    source: 'sprint_gap',
    estimated_value: 0.6,
    estimated_difficulty: 0.4,
    sprint_alignment: 0.7,
    composite_score,
    nearest_neighbor_sim: 0.1,
    dropped: false,
    ...overrides,
  };
}

interface CpSpy extends ControlPlaneClient {
  posted: ControlCommand[];
}

function controlPlaneSpy(
  ackOrFactory:
    | ControlPlaneAck
    | ((cmd: ControlCommand, index: number) => ControlPlaneAck | Promise<ControlPlaneAck>) = {
    accepted: true,
    taskId: 'task-1',
  },
): CpSpy {
  const posted: ControlCommand[] = [];
  const fn = typeof ackOrFactory === 'function' ? ackOrFactory : () => ackOrFactory;
  return {
    posted,
    async postCommand(cmd) {
      posted.push(cmd);
      return fn(cmd, posted.length - 1);
    },
  };
}

interface StoreSpy {
  inserted: string[];
  decided: Array<{ proposalId: string; decision: string; decidedBy: string }>;
  linked: Array<{ proposalId: string; taskId: string }>;
  deps: Pick<
    AutoApproveDeps,
    'insertProposal' | 'recordProposalDecision' | 'setResultingTaskId'
  >;
}

function storeSpy(
  opts: {
    decisionUpdated?: (proposalId: string) => boolean;
    insertThrows?: (proposalId: string) => boolean;
    decisionThrows?: (proposalId: string) => boolean;
    linkThrows?: (proposalId: string) => boolean;
  } = {},
): StoreSpy {
  const inserted: string[] = [];
  const decided: StoreSpy['decided'] = [];
  const linked: StoreSpy['linked'] = [];
  return {
    inserted,
    decided,
    linked,
    deps: {
      async insertProposal(input) {
        if (opts.insertThrows?.(input.id)) throw new Error(`insert ${input.id} boom`);
        inserted.push(input.id);
      },
      async recordProposalDecision(input) {
        if (opts.decisionThrows?.(input.proposalId))
          throw new Error(`decide ${input.proposalId} boom`);
        decided.push({
          proposalId: input.proposalId,
          decision: input.decision,
          decidedBy: input.decidedBy,
        });
        const updated = opts.decisionUpdated ? opts.decisionUpdated(input.proposalId) : true;
        return { updated };
      },
      async setResultingTaskId(proposalId, taskId) {
        if (opts.linkThrows?.(proposalId)) throw new Error(`link ${proposalId} boom`);
        linked.push({ proposalId, taskId });
        return { updated: true };
      },
    },
  };
}

describe('resolveAutoApproveThreshold', () => {
  it('prefers cfg.proposalsAutoApproveThreshold over env and default', () => {
    const cfg = baseCfg({ proposalsAutoApproveThreshold: 0.42 });
    process.env[AUTO_APPROVE_THRESHOLD_ENV] = '0.99';
    try {
      expect(resolveAutoApproveThreshold(cfg)).toBe(0.42);
    } finally {
      delete process.env[AUTO_APPROVE_THRESHOLD_ENV];
    }
  });

  it('falls back to env when cfg is unset', () => {
    process.env[AUTO_APPROVE_THRESHOLD_ENV] = '0.7';
    try {
      expect(resolveAutoApproveThreshold(baseCfg())).toBe(0.7);
    } finally {
      delete process.env[AUTO_APPROVE_THRESHOLD_ENV];
    }
  });

  it('returns +Infinity default when neither cfg nor env set (HITL-only sentinel)', () => {
    delete process.env[AUTO_APPROVE_THRESHOLD_ENV];
    expect(resolveAutoApproveThreshold(baseCfg())).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores non-numeric env values and falls back to default', () => {
    process.env[AUTO_APPROVE_THRESHOLD_ENV] = 'not-a-number';
    try {
      expect(resolveAutoApproveThreshold(baseCfg())).toBe(Number.POSITIVE_INFINITY);
    } finally {
      delete process.env[AUTO_APPROVE_THRESHOLD_ENV];
    }
  });
});

describe('formatAutoBanditDecidedBy', () => {
  it('renders fractional thresholds verbatim', () => {
    expect(formatAutoBanditDecidedBy(0.85)).toBe('auto-bandit-0.85');
  });

  it('renders integer thresholds without a decimal point', () => {
    expect(formatAutoBanditDecidedBy(1)).toBe('auto-bandit-1');
    expect(formatAutoBanditDecidedBy(0)).toBe('auto-bandit-0');
  });
});

describe('splitAndDispatch — threshold filtering', () => {
  it('default threshold (+Infinity) routes every candidate to Discord — even an exact-1.0 maxout — none to auto', async () => {
    // Includes 1.0 explicitly: regression guard for the worst-case scorer
    // maxout (`0.4·1 + 0.3·1 + 0.3·1`) that the previous `>=` filter at
    // threshold=1.0 would have auto-approved.
    const top: DedupedCandidate[] = [
      candidate('low', 0.5),
      candidate('mid', 0.8),
      candidate('high', 0.99),
      candidate('maxout', 1.0),
    ];
    const hitlSeen: DedupedCandidate[][] = [];
    const cp = controlPlaneSpy();
    const autoSpy = vi.fn(async () => 0);

    const deps: SplitAndDispatchDeps = {
      controlPlane: cp,
      postProposalsForApproval: async (cands) => {
        hitlSeen.push(cands);
        return cands.length;
      },
      autoApproveProposals: autoSpy,
      warn: () => {},
    };

    const count = await splitAndDispatch(top, baseCfg(), deps);

    expect(autoSpy).not.toHaveBeenCalled();
    expect(cp.posted).toHaveLength(0);
    expect(hitlSeen).toHaveLength(1);
    expect(hitlSeen[0]).toEqual(top);
    expect(count).toBe(4);
  });

  it('threshold 0.85 routes above/equal to auto, below to Discord', async () => {
    const top: DedupedCandidate[] = [
      candidate('above-1', 0.9),
      candidate('exactly', 0.85),
      candidate('below', 0.84),
      candidate('above-2', 0.95),
    ];
    const cp = controlPlaneSpy((_cmd, i) => ({
      accepted: true,
      taskId: `task-${i + 1}`,
    }));
    const store = storeSpy();
    const hitlSeen: DedupedCandidate[][] = [];
    let idCounter = 0;

    const deps: SplitAndDispatchDeps = {
      controlPlane: cp,
      postProposalsForApproval: async (cands) => {
        hitlSeen.push(cands);
        return cands.length;
      },
      autoApproveProposals: (cands, cfg, autoDeps) =>
        // Re-enter the real implementation so we exercise it through the spy
        // wiring AND so the spy id generator threads through.
        autoApproveProposals(cands, cfg, { ...autoDeps, ...store.deps }),
      generateId: () => `prop-${++idCounter}`,
      warn: () => {},
    };

    const cfg = baseCfg({ proposalsAutoApproveThreshold: 0.85 });
    const count = await splitAndDispatch(top, cfg, deps);

    // Auto path: three candidates >= 0.85
    expect(store.inserted).toEqual(['prop-1', 'prop-2', 'prop-3']);
    expect(store.decided.map((d) => d.decision)).toEqual(['approved', 'approved', 'approved']);
    expect(store.decided.every((d) => d.decidedBy === 'auto-bandit-0.85')).toBe(true);
    expect(cp.posted).toHaveLength(3);
    for (const [i, cmd] of cp.posted.entries()) {
      expect(cmd.type).toBe('sprint_goal');
      if (cmd.type !== 'sprint_goal') throw new Error('unreachable');
      expect(cmd.repo).toBe(cfg.repoId);
      expect(cmd.idempotencyKey).toBe(`proposal:prop-${i + 1}`);
    }
    expect(store.linked).toEqual([
      { proposalId: 'prop-1', taskId: 'task-1' },
      { proposalId: 'prop-2', taskId: 'task-2' },
      { proposalId: 'prop-3', taskId: 'task-3' },
    ]);

    // HITL path: only the 0.84 candidate
    expect(hitlSeen).toHaveLength(1);
    expect(hitlSeen[0]?.map((c) => c.title)).toEqual(['below']);

    expect(count).toBe(4);
  });

  it('threshold 0.0 auto-approves every candidate, Discord stage never fires', async () => {
    const top: DedupedCandidate[] = [
      candidate('a', 0.05),
      candidate('b', 0.4),
      candidate('c', 0.7),
    ];
    const cp = controlPlaneSpy((_cmd, i) => ({
      accepted: true,
      taskId: `task-${i + 1}`,
    }));
    const store = storeSpy();
    const hitlSpy = vi.fn(async () => 0);
    let idCounter = 0;

    const deps: SplitAndDispatchDeps = {
      controlPlane: cp,
      postProposalsForApproval: hitlSpy,
      autoApproveProposals: (cands, cfg, autoDeps) =>
        autoApproveProposals(cands, cfg, { ...autoDeps, ...store.deps }),
      generateId: () => `p-${++idCounter}`,
      warn: () => {},
    };

    const cfg = baseCfg({ proposalsAutoApproveThreshold: 0.0 });
    const count = await splitAndDispatch(top, cfg, deps);

    expect(hitlSpy).not.toHaveBeenCalled();
    expect(cp.posted).toHaveLength(3);
    expect(store.linked).toHaveLength(3);
    expect(count).toBe(3);
    expect(store.decided.every((d) => d.decidedBy === 'auto-bandit-0')).toBe(true);
  });

  it('dropped candidates are filtered out before either sink fires', async () => {
    const top: DedupedCandidate[] = [
      candidate('keep-auto', 0.9),
      candidate('drop-me', 0.95, { dropped: true, reason: 'dup' }),
      candidate('keep-hitl', 0.5),
    ];
    const cp = controlPlaneSpy();
    const store = storeSpy();
    const hitlSeen: DedupedCandidate[][] = [];
    let idCounter = 0;

    const deps: SplitAndDispatchDeps = {
      controlPlane: cp,
      postProposalsForApproval: async (cands) => {
        hitlSeen.push(cands);
        return cands.length;
      },
      autoApproveProposals: (cands, cfg, autoDeps) =>
        autoApproveProposals(cands, cfg, { ...autoDeps, ...store.deps }),
      generateId: () => `p-${++idCounter}`,
      warn: () => {},
    };

    const cfg = baseCfg({ proposalsAutoApproveThreshold: 0.85 });
    await splitAndDispatch(top, cfg, deps);

    expect(store.inserted).toEqual(['p-1']);
    expect(hitlSeen[0]?.map((c) => c.title)).toEqual(['keep-hitl']);
  });
});

describe('autoApproveProposals — resilience', () => {
  it('control plane refusal on one candidate logs + skips, others still ship', async () => {
    const cp = controlPlaneSpy((_cmd, i) =>
      i === 1
        ? { accepted: false, message: 'queue paused' }
        : { accepted: true, taskId: `task-${i + 1}` },
    );
    const store = storeSpy();
    const warnLines: string[] = [];
    let idCounter = 0;

    const count = await autoApproveProposals(
      [
        candidate('first', 0.9),
        candidate('refused', 0.95),
        candidate('third', 0.9),
      ],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(cp.posted).toHaveLength(3);
    expect(count).toBe(2);
    // The refused proposal still got a row + an approved decision (we wrote
    // those before the control plane call), but no resulting_task_id link.
    expect(store.inserted).toEqual(['p-1', 'p-2', 'p-3']);
    expect(store.linked.map((l) => l.proposalId)).toEqual(['p-1', 'p-3']);
    expect(warnLines.some((l) => l.includes('controlPlane refused p-2'))).toBe(true);
  });

  it('control plane throw on one candidate logs + skips, others still ship', async () => {
    const cp: CpSpy = {
      posted: [],
      async postCommand(cmd) {
        this.posted.push(cmd);
        if ('idempotencyKey' in cmd && cmd.idempotencyKey === 'proposal:p-2') {
          throw new Error('network down');
        }
        return { accepted: true, taskId: `task-${this.posted.length}` };
      },
    };
    const store = storeSpy();
    const warnLines: string[] = [];
    let idCounter = 0;

    const count = await autoApproveProposals(
      [candidate('a', 0.9), candidate('b', 0.95), candidate('c', 0.9)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(count).toBe(2);
    expect(store.linked.map((l) => l.proposalId)).toEqual(['p-1', 'p-3']);
    expect(warnLines.some((l) => l.includes('controlPlane.postCommand threw for p-2'))).toBe(true);
  });

  it('insertProposal failure skips that candidate but does not block the others', async () => {
    const cp = controlPlaneSpy((_cmd, i) => ({
      accepted: true,
      taskId: `task-${i + 1}`,
    }));
    const store = storeSpy({ insertThrows: (id) => id === 'p-2' });
    let idCounter = 0;
    const warnLines: string[] = [];

    const count = await autoApproveProposals(
      [candidate('a', 0.9), candidate('b', 0.9), candidate('c', 0.9)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(count).toBe(2);
    expect(store.inserted).toEqual(['p-1', 'p-3']);
    expect(store.decided.map((d) => d.proposalId)).toEqual(['p-1', 'p-3']);
    expect(cp.posted).toHaveLength(2);
    expect(warnLines.some((l) => l.includes('insertProposal failed for p-2'))).toBe(true);
  });

  it('recordProposalDecision returning updated=false skips the control-plane post', async () => {
    const cp = controlPlaneSpy();
    const store = storeSpy({ decisionUpdated: (id) => id !== 'p-2' });
    let idCounter = 0;
    const warnLines: string[] = [];

    const count = await autoApproveProposals(
      [candidate('a', 0.9), candidate('b', 0.9), candidate('c', 0.9)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(count).toBe(2);
    expect(cp.posted).toHaveLength(2);
    expect(warnLines.some((l) => l.includes('updated=false for p-2'))).toBe(true);
  });

  it('setResultingTaskId failure logs but still counts the candidate (task is queued)', async () => {
    const cp = controlPlaneSpy((_cmd, i) => ({
      accepted: true,
      taskId: `task-${i + 1}`,
    }));
    const store = storeSpy({ linkThrows: (id) => id === 'p-2' });
    let idCounter = 0;
    const warnLines: string[] = [];

    const count = await autoApproveProposals(
      [candidate('a', 0.9), candidate('b', 0.9)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(count).toBe(2);
    expect(warnLines.some((l) => l.includes('setResultingTaskId failed for p-2'))).toBe(true);
  });

  it('dryRun short-circuits — no inserts, no posts, returns 0', async () => {
    const cp = controlPlaneSpy();
    const store = storeSpy();
    const warnLines: string[] = [];

    const count = await autoApproveProposals(
      [candidate('a', 0.9)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85, dryRun: true }),
      {
        controlPlane: cp,
        ...store.deps,
        warn: (l) => warnLines.push(l),
      },
    );

    expect(count).toBe(0);
    expect(store.inserted).toEqual([]);
    expect(cp.posted).toEqual([]);
    expect(warnLines.some((l) => l.includes('dry-run'))).toBe(true);
  });

  it('decidedBy carries the threshold for audit-log distinction', async () => {
    const cp = controlPlaneSpy();
    const store = storeSpy();
    let idCounter = 0;

    await autoApproveProposals(
      [candidate('a', 0.95)],
      baseCfg({ proposalsAutoApproveThreshold: 0.85 }),
      {
        controlPlane: cp,
        ...store.deps,
        generateId: () => `p-${++idCounter}`,
        warn: () => {},
      },
    );

    expect(store.decided).toEqual([
      { proposalId: 'p-1', decision: 'approved', decidedBy: 'auto-bandit-0.85' },
    ]);
  });

  it('returns 0 when the auto subset is empty (no calls fire)', async () => {
    const cp = controlPlaneSpy();
    const store = storeSpy();
    const count = await autoApproveProposals([], baseCfg(), {
      controlPlane: cp,
      ...store.deps,
      warn: () => {},
    });
    expect(count).toBe(0);
    expect(cp.posted).toEqual([]);
    expect(store.inserted).toEqual([]);
  });
});
