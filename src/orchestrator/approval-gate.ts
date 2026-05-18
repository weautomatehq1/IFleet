// In-memory bridge between ControlPlane button events (Discord) and the
// pipeline's architect approval step. The architect calls
// `awaitApproval({ taskId, ... })`; the daemon wires ControlPlane's
// `onApprove` / `onCancel` callbacks to `resolveApproval` / `resolveCancel`.

import type { ApprovalGate } from '../pipeline/types.js';

type Verdict = 'approve' | 'reject' | 'cancel';

interface Pending {
  resolve: (verdict: Verdict) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
}

export class ControlPlaneApprovalGate implements ApprovalGate {
  private readonly pending = new Map<string, Pending>();

  /**
   * Suspend the architect until a verdict is observed for `taskId`. Returns
   * `true` for approve, `false` for reject/cancel/timeout/abort. Safe to call
   * multiple times for the same taskId only sequentially — a second call
   * overwrites the first deferred.
   */
  async awaitApproval(opts: {
    taskId: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
  }): Promise<boolean> {
    if (opts.abortSignal.aborted) return false;

    return new Promise<boolean>((resolve) => {
      const settle = (verdict: Verdict): void => {
        const entry = this.pending.get(opts.taskId);
        if (!entry) return;
        clearTimeout(entry.timer);
        opts.abortSignal.removeEventListener('abort', entry.onAbort);
        this.pending.delete(opts.taskId);
        resolve(verdict === 'approve');
      };

      const onAbort = (): void => settle('cancel');
      const timer = setTimeout(() => settle('cancel'), opts.timeoutMs);

      this.pending.set(opts.taskId, {
        resolve: settle,
        timer,
        onAbort,
      });
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Resolve a pending approval with the given verdict. No-op if unknown. */
  resolve(taskId: string, verdict: Verdict): void {
    const entry = this.pending.get(taskId);
    if (!entry) return;
    entry.resolve(verdict);
  }

  /** True if `taskId` is currently waiting on a verdict. */
  has(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  /** Resolve every pending awaiter as cancelled. Used during graceful shutdown. */
  drain(): void {
    for (const taskId of Array.from(this.pending.keys())) {
      this.resolve(taskId, 'cancel');
    }
  }
}
