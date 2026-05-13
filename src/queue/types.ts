export interface QueueAdapter {
  pickNext(opts?: PickOpts): Promise<QueuedTask | null>;
  markPicked(task: QueuedTask, workerId: string): Promise<void>;
  markCompleted(task: QueuedTask, prUrl: string): Promise<void>;
  markFailed(task: QueuedTask, reason: string): Promise<void>;
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
}

export interface RepoConfig {
  repos: RepoRef[];
}

export const LABEL_AUTO_SHIP = 'auto:ship';
export const LABEL_IN_FLIGHT = 'in_flight';
export const LABEL_SHIPPED = 'auto:shipped';
export const LABEL_FAILED = 'auto:failed';
