import type {
  GitOps,
  IssueCommenter,
  OpenPrInput,
  PipelineInput,
  PrOpener,
  QueuedTask,
  RoutingDecision,
  SpawnHandle,
  SpawnOpts,
  SpawnResult,
  VerifyKind,
  VerifyResult,
  VerifyRunner,
  WorkerPool,
  WorkerSpec,
} from '../types.js';

export interface ScriptedSpawn {
  role: SpawnOpts['role'];
  output: string;
  ok?: boolean;
  rateLimitHits?: number;
  /**
   * Optional USD cost the worker would report. Mirrors the `total_cost_usd`
   * Claude emits in its `result` event. Tests that exercise cost propagation
   * set this to assert the value reaches `logCosts`.
   */
  totalCostUsd?: number;
  /** Used by tests to inspect ordering. */
  workerIdMatcher?: (id: string) => boolean;
}

export interface MockWorkerPool extends WorkerPool {
  calls: Array<{ spec: WorkerSpec; brief: string; opts: SpawnOpts }>;
}

export function makeMockWorkerPool(scripted: ScriptedSpawn[]): MockWorkerPool {
  const calls: MockWorkerPool['calls'] = [];
  let idx = 0;
  const pool: MockWorkerPool = {
    calls,
    spawn(spec: WorkerSpec, brief: string, opts: SpawnOpts): SpawnHandle {
      calls.push({ spec, brief, opts });
      const script = scripted[idx++];
      if (!script) {
        throw new Error(`MockWorkerPool: no scripted response for spawn #${idx} (role=${opts.role})`);
      }
      if (script.role !== opts.role) {
        throw new Error(
          `MockWorkerPool: expected role=${script.role} but pipeline asked for role=${opts.role}`,
        );
      }
      const result: SpawnResult = {
        ok: script.ok ?? true,
        output: script.output,
        sessionId: `session-${idx}`,
        rateLimitHits: script.rateLimitHits ?? 0,
        ...(script.totalCostUsd !== undefined && { totalCostUsd: script.totalCostUsd }),
      };
      let cancelled = false;
      return {
        async result(): Promise<SpawnResult> {
          if (opts.abortSignal?.aborted || cancelled) {
            return { ok: false, output: '', sessionId: result.sessionId, rateLimitHits: 0, error: 'aborted' };
          }
          return result;
        },
        async cancel(): Promise<void> {
          cancelled = true;
        },
      };
    },
  };
  return pool;
}

export interface MockVerifyRunner extends VerifyRunner {
  calls: Array<{ worktreePath: string; kinds: VerifyKind[] }>;
}

export function makeMockVerifyRunner(scripted: VerifyResult[]): MockVerifyRunner {
  const calls: MockVerifyRunner['calls'] = [];
  let idx = 0;
  return {
    calls,
    async run(worktreePath: string, kinds: VerifyKind[]): Promise<VerifyResult> {
      calls.push({ worktreePath, kinds });
      const v = scripted[idx++];
      if (!v) throw new Error(`MockVerifyRunner: no scripted result for call #${idx}`);
      return v;
    },
  };
}

export interface MockIssueCommenter extends IssueCommenter {
  comments: Array<{ issueNumber: number; body: string }>;
  approvals: Array<{ issueNumber: number; approver: string }>;
}

export function makeMockIssueCommenter(approvalResult: boolean = true): MockIssueCommenter {
  const comments: MockIssueCommenter['comments'] = [];
  const approvals: MockIssueCommenter['approvals'] = [];
  return {
    comments,
    approvals,
    async comment(issueNumber, body) {
      comments.push({ issueNumber, body });
    },
    async waitForApproval(issueNumber, opts) {
      approvals.push({ issueNumber, approver: opts.approver });
      return approvalResult;
    },
  };
}

export interface MockPrOpener extends PrOpener {
  opened: OpenPrInput[];
}

export function makeMockPrOpener(): MockPrOpener {
  const opened: OpenPrInput[] = [];
  return {
    opened,
    async open(input) {
      opened.push(input);
      return { url: `https://github.com/${input.repo}/pull/123`, number: 123 };
    },
  };
}

export function makeMockGit(diff = 'diff --git a/x b/x\n+hello\n', branch = 'feat/x'): GitOps {
  return {
    async diff() {
      return diff;
    },
    async currentBranch() {
      return branch;
    },
  };
}

export function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    id: 'task-1',
    issueNumber: 42,
    repo: 'weautomatehq1/IFleet',
    title: 'add greeting',
    body: 'Add a hello() function that returns "hello"',
    autonomy: 'auto',
    labels: [],
    ...overrides,
  };
}

export function makeRouting(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    architect: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
    editor: { provider: 'codex', model: 'gpt-5.5-codex', workerId: 'codex-pro-1' },
    reviewer: { provider: 'claude', model: 'opus-4.7', workerId: 'claude-max-1' },
    verify: ['typecheck', 'lint', 'test'],
    ...overrides,
  };
}

export interface BuildInputOpts {
  task?: Partial<QueuedTask>;
  routing?: Partial<RoutingDecision>;
  scripted: ScriptedSpawn[];
  verify?: VerifyResult[];
  approvalResult?: boolean;
  abortSignal?: AbortSignal;
  /**
   * When set, the pipeline writes per-attempt cost records to
   * `<repoRoot>/.omc/costs.json`. Tests asserting cost propagation should
   * point this at a temp dir; default leaves it undefined so `logCosts`
   * short-circuits.
   */
  repoRoot?: string;
}

export function buildPipelineInput(opts: BuildInputOpts): {
  input: PipelineInput;
  workerPool: MockWorkerPool;
  verify: MockVerifyRunner;
  issues: MockIssueCommenter;
  pr: MockPrOpener;
} {
  const workerPool = makeMockWorkerPool(opts.scripted);
  const verify = makeMockVerifyRunner(opts.verify ?? [{ ok: true, failures: [] }]);
  const issues = makeMockIssueCommenter(opts.approvalResult ?? true);
  const pr = makeMockPrOpener();
  const git = makeMockGit();
  const controller = new AbortController();
  const signal = opts.abortSignal ?? controller.signal;
  const input: PipelineInput = {
    task: makeTask(opts.task),
    workerPool,
    worktreePath: '/tmp/worktree',
    routing: makeRouting(opts.routing),
    abortSignal: signal,
    verify,
    issues,
    pr,
    git,
    codeowners: ['@monstersebas1'],
    baseBranch: 'main',
    approver: '@monstersebas1',
    ...(opts.repoRoot !== undefined && { repoRoot: opts.repoRoot }),
  };
  return { input, workerPool, verify, issues, pr };
}

export const PLAN_OUTPUT = `1) Files: src/hello.ts
2) Signatures: export function hello(): string
3) Risks: none
4) Tests: unit test for hello()

This task adds a tiny hello() helper that returns the string "hello".`;

export function approveJson(): string {
  return '{"verdict":"approve","concerns":[]}';
}

export function rejectJson(concerns: string[]): string {
  return JSON.stringify({ verdict: 'request_changes', concerns });
}

export function doctorJson(requiresNewBrief = false): string {
  return JSON.stringify({
    rootCause: 'missing import',
    proposedFix: 'add the import at top of file',
    confidence: 0.9,
    requiresNewBrief,
  });
}
