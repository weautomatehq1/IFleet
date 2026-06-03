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

export interface RoutingHints {
  model?: 'opus' | 'sonnet' | 'haiku' | 'codex';
  priority: 'low' | 'normal' | 'high';
  verify: VerifyKind[];
  autonomy: 'auto' | 'review';
  /**
   * Explicit category label (canonical §3.2 override #1). When set to one of
   * {security, auth, payments, migration}, the classifier promotes the
   * architect to Opus regardless of severity or mode (M4.7).
   */
  category?: 'security' | 'auth' | 'payments' | 'migration';
  /**
   * Explicit severity label (canonical §3.2 override #2). When set to
   * 'critical', the classifier promotes the architect to Opus regardless of
   * category or mode (M4.7).
   */
  severity?: 'critical' | 'important' | 'cosmetic';
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
export const LABEL_IFLEET_IN_PROGRESS = 'ifleet:in_progress';
export const LABEL_IFLEET_DONE = 'ifleet:done';
export const LABEL_IFLEET_COOLDOWN = 'ifleet:cooldown';
export const LABEL_IFLEET_CHRONIC_FAIL = 'ifleet:chronic-fail';
export const LABEL_RETRY_PREFIX = 'ifleet:retry:';
export const COOLDOWN_MS = 30 * 60 * 1000;
/**
 * Maximum number of times sweepCooldowns will auto-restore `auto:ship` after
 * failures. After this many retries the issue is tagged with
 * `LABEL_IFLEET_CHRONIC_FAIL` and skipped by future sweeps (no more auto-retry).
 * Human operators must remove the label by hand to re-enable retries.
 */
export const MAX_AUTO_RETRIES = 2;
