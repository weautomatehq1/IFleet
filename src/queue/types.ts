export interface QueueAdapter {
  pickNext(opts?: PickOpts): Promise<QueuedTask | null>;
  markPicked(task: QueuedTask, workerId: string): Promise<void>;
  markCompleted(task: QueuedTask, prUrl: string): Promise<void>;
  markFailed(task: QueuedTask, reason: string): Promise<void>;
  markCapabilityBlocked(task: QueuedTask, missing: string[]): Promise<void>;
  postStatus(task: QueuedTask, status: TaskStatus, message?: string): Promise<void>;
  watchForNew(callback: (task: QueuedTask) => void): { stop: () => void };
}

export interface PickOpts {
  repos?: string[];
  excludeIds?: string[];
}

export interface QueuedTask {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  /** GitHub login of the user who opened the issue. Used by the queue's author allowlist. */
  author: string;
  labels: string[];
  routingHints: RoutingHints;
  createdAt: number;
  url: string;
}

export type SprintMode = 'ralph' | 'ulw' | 'tdd' | 'deslop' | 'default';

export interface RoutingHints {
  model?: 'opus' | 'sonnet' | 'haiku' | 'codex';
  priority: 'low' | 'normal' | 'high';
  verify: VerifyKind[];
  autonomy: 'auto' | 'review';
  /** Sprint mode derived from a `mode:*` label. Absence means 'default'. */
  mode?: SprintMode;
}

export type VerifyKind = 'typecheck' | 'lint' | 'test' | 'playwright' | 'screenshot';

export type TaskStatus =
  | 'picked'
  | 'planning'
  | 'editing'
  | 'reviewing'
  | 'ci_running'
  | 'pr_opened'
  | 'cancelled'
  | 'failed'
  | 'merged';

export interface RepoRef {
  owner: string;
  name: string;
  /**
   * GitHub logins permitted to open `auto:ship` issues for this repo. When set,
   * `pickNext` and `watchForNew` skip issues authored by anyone else (and log
   * a warning). When undefined or empty, every author is accepted and the
   * queue logs a one-time warning at construction time — the permissive mode
   * is INSECURE for public repos because the brief body is fed to a worker
   * running `claude -p --permission-mode auto`.
   */
  allowedAuthors?: ReadonlyArray<string>;
}

export interface RepoConfig {
  repos: RepoRef[];
}

export const LABEL_AUTO_SHIP = 'auto:ship';
export const LABEL_IN_FLIGHT = 'in_flight';
export const LABEL_SHIPPED = 'auto:shipped';
export const LABEL_FAILED = 'auto:failed';
export const LABEL_CAPABILITY_BLOCKED = 'blocked:missing-capability';
