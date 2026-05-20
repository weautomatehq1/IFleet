import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PLAN_REVIEW_COST_CAP_MULTIPLIER,
  formatPlanReviewerEscalation,
  parsePlanReview,
  PLAN_REVIEWER_MAX_VETOES,
  runPlanReviewer,
  type PlanReviewVetoReason,
} from '../plan-reviewer.js';
import type { PipelineEvent, WorkerSpec } from '../types.js';
import { DefaultPipelineRunner } from '../runner.js';
import {
  approveJson,
  buildPipelineInput,
  PLAN_OUTPUT,
} from './helpers.js';
import { makeMockWorkerPool } from './helpers.js';

const planReviewerSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-haiku-4-5-20251001',
  workerId: 'plan-reviewer-1',
};
const architectSpec: WorkerSpec = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  workerId: 'architect-1',
};

function approveOutput(rationale = 'No invariants violated; scope matches brief.'): string {
  return JSON.stringify({ decision: 'approve', rationale });
}

function vetoOutput(reasons: PlanReviewVetoReason[]): string {
  return JSON.stringify({ decision: 'veto', reasons });
}

describe('parsePlanReview', () => {
  it('parses an approve decision', () => {
    const r = parsePlanReview(approveOutput('looks good'));
    expect(r.decision).toBe('approve');
    if (r.decision === 'approve') expect(r.rationale).toBe('looks good');
  });

  it('parses a veto decision with one well-formed reason', () => {
    const r = parsePlanReview(
      vetoOutput([
        {
          kind: 'invariant',
          message: 'plan touches src/orchestrator/sprint.ts (protected per SECURITY.md)',
          suggested_revision: 'move the change into the queue bridge layer',
        },
      ]),
    );
    expect(r.decision).toBe('veto');
    if (r.decision === 'veto') {
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]?.kind).toBe('invariant');
      expect(r.reasons[0]?.suggested_revision).toContain('queue bridge');
    }
  });

  it('tolerates leading/trailing prose around the JSON object', () => {
    const r = parsePlanReview(`Here is my review:\n${approveOutput()}\nthanks`);
    expect(r.decision).toBe('approve');
  });

  it('falls back to a feasibility veto when JSON is malformed', () => {
    const r = parsePlanReview('clearly not JSON at all');
    expect(r.decision).toBe('veto');
    if (r.decision === 'veto') {
      expect(r.reasons[0]?.kind).toBe('feasibility');
      expect(r.reasons[0]?.message).toMatch(/malformed/);
    }
  });

  it('falls back to a feasibility veto when decision is unknown', () => {
    const r = parsePlanReview(JSON.stringify({ decision: 'maybe' }));
    expect(r.decision).toBe('veto');
  });

  it('drops malformed reasons but keeps well-formed ones', () => {
    const r = parsePlanReview(
      JSON.stringify({
        decision: 'veto',
        reasons: [
          { kind: 'bogus', message: 'x', suggested_revision: 'y' },
          {
            kind: 'scope',
            message: 'plan adds two unrelated features',
            suggested_revision: 'split into two tasks',
          },
        ],
      }),
    );
    expect(r.decision).toBe('veto');
    if (r.decision === 'veto') {
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]?.kind).toBe('scope');
    }
  });

  it('treats veto with empty reasons[] as malformed', () => {
    const r = parsePlanReview(JSON.stringify({ decision: 'veto', reasons: [] }));
    expect(r.decision).toBe('veto');
    if (r.decision === 'veto') {
      expect(r.reasons[0]?.kind).toBe('feasibility');
      expect(r.reasons[0]?.message).toMatch(/without reasons/);
    }
  });
});

describe('runPlanReviewer', () => {
  const controller = new AbortController();

  it('approve path: spawns reviewer once, returns decision and attempt record', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: approveOutput('checked invariants') },
    ]);

    const out = await runPlanReviewer({
      plan: 'do thing X',
      brief: 'please add thing X',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
    });

    expect(out.review.decision).toBe('approve');
    expect(out.skipped).toBeUndefined();
    expect(out.attempt.role).toBe('reviewer');
    expect(out.attempt.workerId).toBe('plan-reviewer-1');
    expect(out.attempt.ok).toBe(true);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.opts.role).toBe('reviewer');
    expect(pool.calls[0]?.brief).toContain('Architect plan');
    expect(pool.calls[0]?.brief).toContain('Original brief');
    expect(pool.calls[0]?.brief).toContain('do thing X');
  });

  it('veto path: returns structured reasons[] sourced from the reviewer JSON', async () => {
    const reasons: PlanReviewVetoReason[] = [
      {
        kind: 'invariant',
        message: 'plan references supabase.from() in src/api/',
        suggested_revision: 'move DB call to src/data/users.ts',
      },
      {
        kind: 'failure-mode',
        message: 'prior 5 sprints failed when modifying schema.prisma + src/data/ together',
        suggested_revision: 'split into two PRs',
      },
    ];
    const pool = makeMockWorkerPool([{ role: 'reviewer', output: vetoOutput(reasons) }]);

    const out = await runPlanReviewer({
      plan: 'p',
      brief: 'b',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
    });

    expect(out.review.decision).toBe('veto');
    if (out.review.decision === 'veto') {
      expect(out.review.reasons).toHaveLength(2);
      expect(out.review.reasons[0]?.kind).toBe('invariant');
      expect(out.review.reasons[1]?.kind).toBe('failure-mode');
      expect(out.review.reasons[1]?.suggested_revision).toContain('two PRs');
    }
  });

  it('rate-limit: rateLimitHits > 0 → skipped="rate-limit", attempt.ok=false', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: approveOutput(), rateLimitHits: 1 },
    ]);

    const out = await runPlanReviewer({
      plan: 'p',
      brief: 'b',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
    });

    expect(out.skipped).toBe('rate-limit');
    expect(out.review.decision).toBe('approve');
    if (out.review.decision === 'approve') {
      expect(out.review.rationale).toContain('skipped');
    }
    expect(out.attempt.ok).toBe(false);
  });

  it('worker error (ok=false) → skipped="worker-error", attempt.ok=false', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: '', ok: false },
    ]);

    const out = await runPlanReviewer({
      plan: 'p',
      brief: 'b',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
    });

    expect(out.skipped).toBe('worker-error');
    expect(out.review.decision).toBe('approve');
  });

  it('cost-cap: cost > architect cost × 10% → skipped="cost-cap"', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: vetoOutput([
        { kind: 'scope', message: 'x', suggested_revision: 'y' },
      ]), totalCostUsd: 0.5 },
    ]);

    const out = await runPlanReviewer({
      plan: 'p',
      brief: 'b',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
      architectCostUsd: 1.0,
      // cap is the default 0.10 → ceiling is 0.10 USD; 0.50 > 0.10 → cost-cap
    });

    expect(out.skipped).toBe('cost-cap');
    // Even if the model emitted a veto, the cost-capped run does not block the
    // editor — spec mandates "abort if exceeded" which means abort the review,
    // not the sprint.
    expect(out.review.decision).toBe('approve');
  });

  it('cost-cap: within budget → review is authoritative (not skipped)', async () => {
    const pool = makeMockWorkerPool([
      { role: 'reviewer', output: vetoOutput([
        { kind: 'scope', message: 'x', suggested_revision: 'y' },
      ]), totalCostUsd: 0.05 },
    ]);

    const out = await runPlanReviewer({
      plan: 'p',
      brief: 'b',
      attempt: 1,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: controller.signal,
      architectCostUsd: 1.0, // ceiling = 0.10 USD; 0.05 < 0.10 → not capped
    });

    expect(out.skipped).toBeUndefined();
    expect(out.review.decision).toBe('veto');
  });

  it('DEFAULT_PLAN_REVIEW_COST_CAP_MULTIPLIER is 0.10 (10% of architect cost)', () => {
    // Pinned by spec — changing this requires updating
    // docs/elevation/upgrades/02-plan-reviewer.md.
    expect(DEFAULT_PLAN_REVIEW_COST_CAP_MULTIPLIER).toBe(0.1);
  });

  it('reads invariants from .ifleet/invariants/<repoSlug>/ when repoRoot+repoSlug are set', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'plan-rev-test-'));
    try {
      const invariantsDir = join(repoRoot, '.ifleet', 'invariants', 'weautomatehq1_IFleet');
      await mkdir(invariantsDir, { recursive: true });
      await writeFile(
        join(invariantsDir, 'semgrep.yml'),
        'rules:\n  - id: no-secrets-in-env\n    severity: ERROR\n',
        'utf8',
      );

      const pool = makeMockWorkerPool([{ role: 'reviewer', output: approveOutput() }]);
      await runPlanReviewer({
        plan: 'p',
        brief: 'b',
        attempt: 1,
        architectSpec,
        reviewerSpec: planReviewerSpec,
        workerPool: pool,
        abortSignal: new AbortController().signal,
        repoRoot,
        repoSlug: 'weautomatehq1_IFleet',
      });

      const brief = pool.calls[0]?.brief ?? '';
      expect(brief).toContain('Listed invariants');
      expect(brief).toContain('no-secrets-in-env');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('priorReasons are surfaced in the brief on attempt 2 so the reviewer can detect same-reason loops', async () => {
    const pool = makeMockWorkerPool([{ role: 'reviewer', output: approveOutput() }]);
    await runPlanReviewer({
      plan: 'revised plan',
      brief: 'b',
      attempt: 2,
      architectSpec,
      reviewerSpec: planReviewerSpec,
      workerPool: pool,
      abortSignal: new AbortController().signal,
      priorReasons: [
        {
          kind: 'invariant',
          message: 'plan touches protected path',
          suggested_revision: 'use the queue bridge',
        },
      ],
    });

    const brief = pool.calls[0]?.brief ?? '';
    expect(brief).toContain('Prior veto reasons');
    expect(brief).toContain('queue bridge');
    expect(brief).toContain('attempt 2');
  });
});

describe('formatPlanReviewerEscalation', () => {
  it('renders @Sebastian ping with structured reasons (PR #119 escalation style)', () => {
    const out = formatPlanReviewerEscalation('task-42', [
      {
        kind: 'invariant',
        message: 'plan touches src/orchestrator/sprint.ts',
        suggested_revision: 'move into queue bridge',
      },
    ]);
    expect(out).toContain('🛑');
    expect(out).toContain('task-42');
    expect(out).toContain('invariant');
    expect(out).toContain('queue bridge');
    expect(out).toContain('@Sebastian');
  });
});

describe('DefaultPipelineRunner — plan-reviewer integration', () => {
  it('plan-reviewer approves first try → editor runs, PR opens', async () => {
    const events: PipelineEvent[] = [];
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'reviewer', output: approveOutput() },
        { role: 'editor', output: 'wrote code' },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: {
        planReviewer: planReviewerSpec,
      },
    });
    input.eventSink = (e) => events.push(e);

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    // Roles in order: architect, plan-reviewer, editor, diff-reviewer.
    // Both reviewers share role=reviewer in the trace today; we assert on
    // worker order instead.
    expect(workerPool.calls.map((c) => c.opts.role)).toEqual([
      'architect',
      'reviewer',
      'editor',
      'reviewer',
    ]);
    // No veto event, no escalation.
    expect(events.filter((e) => e.kind === 'plan_reviewer.vetoed')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'plan_reviewer.escalated')).toHaveLength(0);
  });

  it('plan-reviewer vetoes once, then approves the revised plan → editor runs', async () => {
    const events: PipelineEvent[] = [];
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        {
          role: 'reviewer',
          output: vetoOutput([
            {
              kind: 'scope',
              message: 'plan adds dashboard refactor not in the brief',
              suggested_revision: 'drop the dashboard work',
            },
          ]),
        },
        { role: 'architect', output: PLAN_OUTPUT }, // revised plan
        { role: 'reviewer', output: approveOutput('scope tightened') },
        { role: 'editor', output: 'wrote code' },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: { planReviewer: planReviewerSpec },
    });
    input.eventSink = (e) => events.push(e);

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    // Architect ran twice; plan-reviewer ran twice; editor once; diff-reviewer once.
    const architectCalls = workerPool.calls.filter((c) => c.opts.role === 'architect');
    expect(architectCalls).toHaveLength(2);
    // The second architect spawn must see the prior veto reasons in its brief.
    expect(architectCalls[1]?.brief).toContain('dashboard refactor');
    expect(architectCalls[1]?.brief).toContain('Plan-Reviewer vetoed');
    // Exactly one veto event, zero escalations.
    expect(events.filter((e) => e.kind === 'plan_reviewer.vetoed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'plan_reviewer.escalated')).toHaveLength(0);
  });

  it(`max-${PLAN_REVIEWER_MAX_VETOES}-veto escalation: ${PLAN_REVIEWER_MAX_VETOES} vetoes → failed + escalation event, no editor spawn`, async () => {
    const events: PipelineEvent[] = [];
    const reason: PlanReviewVetoReason = {
      kind: 'invariant',
      message: 'plan still touches protected path',
      suggested_revision: 'use the queue bridge',
    };
    // 2 architect runs each followed by a veto.
    const scripted = [
      { role: 'architect' as const, output: PLAN_OUTPUT },
      { role: 'reviewer' as const, output: vetoOutput([reason]) },
      { role: 'architect' as const, output: PLAN_OUTPUT },
      { role: 'reviewer' as const, output: vetoOutput([reason]) },
      // No editor entry — must not be reached.
    ];
    const { input, pr, workerPool, issues } = buildPipelineInput({
      scripted,
      routing: { planReviewer: planReviewerSpec },
    });
    input.eventSink = (e) => events.push(e);

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('escalated');
    expect(pr.opened).toHaveLength(0);
    // Confirm we never spawned the editor.
    expect(workerPool.calls.some((c) => c.opts.role === 'editor')).toBe(false);
    // Exactly 2 vetoes + 1 escalation event.
    expect(events.filter((e) => e.kind === 'plan_reviewer.vetoed')).toHaveLength(PLAN_REVIEWER_MAX_VETOES);
    const escalations = events.filter((e) => e.kind === 'plan_reviewer.escalated');
    expect(escalations).toHaveLength(1);
    // The escalation message is posted to the issue so the human sees it.
    expect(issues.comments.some((c) => c.body.includes('@Sebastian'))).toBe(true);
  });

  it('plan-reviewer skipped (rate-limit) → editor still runs, skipped event emitted', async () => {
    const events: PipelineEvent[] = [];
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        // Reviewer rate-limited → skipped → editor proceeds.
        { role: 'reviewer', output: approveOutput(), rateLimitHits: 2 },
        { role: 'editor', output: 'wrote code' },
        { role: 'reviewer', output: approveJson() },
      ],
      routing: { planReviewer: planReviewerSpec },
    });
    input.eventSink = (e) => events.push(e);

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    const skipped = events.filter((e) => e.kind === 'plan_reviewer.skipped');
    expect(skipped).toHaveLength(1);
    expect(workerPool.calls.some((c) => c.opts.role === 'editor')).toBe(true);
  });

  it('no planReviewer in routing → behaves as M1 (single architect, no plan-reviewer spawn)', async () => {
    const events: PipelineEvent[] = [];
    const { input, pr, workerPool } = buildPipelineInput({
      scripted: [
        { role: 'architect', output: PLAN_OUTPUT },
        { role: 'editor', output: 'wrote code' },
        { role: 'reviewer', output: approveJson() },
      ],
      // routing.planReviewer omitted on purpose.
    });
    input.eventSink = (e) => events.push(e);

    const result = await new DefaultPipelineRunner().run(input);

    expect(result.status).toBe('pr_opened');
    expect(pr.opened).toHaveLength(1);
    // Exactly 3 spawns — architect, editor, diff-reviewer. No plan-reviewer.
    expect(workerPool.calls).toHaveLength(3);
    expect(events.filter((e) => e.kind.startsWith('plan_reviewer.'))).toHaveLength(0);
  });
});
