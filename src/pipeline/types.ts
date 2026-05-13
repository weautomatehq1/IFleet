// Public types for the Architect → Editor → Reviewer pipeline.
//
// Other modules (queue, workers, verify) own the placeholder interfaces below;
// they are declared here as the minimum shape this package depends on so the
// pipeline can compile and be unit-tested in isolation.

export type VerifyKind =
  | 'typecheck'
  | 'lint'
  | 'test'
  | 'playwright'
  | 'screenshot';

export type Provider = 'claude' | 'codex';

export type Autonomy = 'auto' | 'review';

export interface QueuedTask {
  id: string;
  issueNumber: number;
  repo: string;
  title: string;
  body: string;
  autonomy: Autonomy;
  labels: string[];
}

export interface WorkerSpec {
  provider: Provider;
  model: string;
  workerId: string;
}

export interface RoutingDecision {
  architect: WorkerSpec;
  editor: WorkerSpec;
  reviewer: WorkerSpec;
  verify: VerifyKind[];
}

export interface SpawnOpts {
  worktreePath?: string;
  systemPrompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  abortSignal?: AbortSignal;
  role: 'architect' | 'editor' | 'reviewer' | 'doctor';
}

export interface SpawnResult {
  ok: boolean;
  output: string;
  sessionId: string;
  rateLimitHits: number;
  error?: string;
}

export interface SpawnHandle {
  result(): Promise<SpawnResult>;
  cancel(): Promise<void>;
}

export interface WorkerPool {
  spawn(spec: WorkerSpec, brief: string, opts: SpawnOpts): SpawnHandle;
}

export interface VerifyResult {
  ok: boolean;
  failures: Array<{ kind: VerifyKind; log: string }>;
}

export interface VerifyRunner {
  run(worktreePath: string, kinds: VerifyKind[]): Promise<VerifyResult>;
}

export interface IssueCommenter {
  comment(issueNumber: number, body: string): Promise<void>;
  waitForApproval(issueNumber: number, opts: WaitForApprovalOpts): Promise<boolean>;
}

export interface WaitForApprovalOpts {
  approver: string;
  pollIntervalMs: number;
  timeoutMs: number;
  abortSignal: AbortSignal;
}

export interface PrOpener {
  open(input: OpenPrInput): Promise<{ url: string; number: number }>;
}

export interface OpenPrInput {
  repo: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  issueNumber: number;
  reviewers: string[];
}

export interface GitOps {
  diff(worktreePath: string, baseRef: string): Promise<string>;
  currentBranch(worktreePath: string): Promise<string>;
}

export interface PipelineInput {
  task: QueuedTask;
  workerPool: WorkerPool;
  worktreePath: string;
  routing: RoutingDecision;
  abortSignal: AbortSignal;
  verify: VerifyRunner;
  issues: IssueCommenter;
  pr: PrOpener;
  git: GitOps;
  codeowners: string[];
  baseBranch?: string;
  approver?: string;
  doctorMaxAttempts?: number;
  reviewerMaxRounds?: number;
  repoRoot?: string;
  sprintId?: string;
}

export interface AttemptRecord {
  role: 'architect' | 'editor' | 'reviewer' | 'doctor';
  workerId: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  output: string;
  rateLimitHits: number;
}

export type PipelineStatus =
  | 'pr_opened'
  | 'blocked_by_reviewer'
  | 'failed'
  | 'cancelled';

export interface PipelineResult {
  status: PipelineStatus;
  prUrl?: string;
  planSummary?: string;
  reviewSummary?: string;
  attempts: AttemptRecord[];
  failureReason?: string;
}

export interface PipelineRunner {
  run(input: PipelineInput): Promise<PipelineResult>;
}

export interface ReviewerVerdict {
  verdict: 'approve' | 'request_changes';
  concerns: string[];
  raw: string;
}

export interface DoctorDiagnosis {
  rootCause: string;
  proposedFix: string;
  confidence: number;
  requiresNewBrief: boolean;
  raw: string;
}
