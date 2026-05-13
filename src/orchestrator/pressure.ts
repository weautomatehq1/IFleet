import type { RateLimitHeaders, RateLimitSnapshot, WorkerId } from './types';

export const PRESSURE_BLOCK_THRESHOLD = 0.85;

export interface PressureTrackerOptions {
  now?: () => number;
}

export class PressureTracker {
  private readonly snapshots = new Map<WorkerId, RateLimitSnapshot>();
  private readonly now: () => number;

  constructor(opts: PressureTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  recordHeaders(workerId: WorkerId, headers: RateLimitHeaders): RateLimitSnapshot {
    const pressure = computePressure(headers);
    const snapshot: RateLimitSnapshot = {
      workerId,
      tokensRemaining: headers.tokensRemaining,
      resetAt: headers.resetAt,
      pressure,
      observedAt: this.now(),
    };
    this.snapshots.set(workerId, snapshot);
    return snapshot;
  }

  pressureFor(workerId: WorkerId): number {
    const snap = this.snapshots.get(workerId);
    if (!snap) return 0;
    if (snap.resetAt <= this.now()) return 0;
    return snap.pressure;
  }

  snapshotFor(workerId: WorkerId): RateLimitSnapshot | undefined {
    return this.snapshots.get(workerId);
  }

  nextAvailableSlot(workerId: WorkerId): number {
    const snap = this.snapshots.get(workerId);
    const now = this.now();
    if (!snap) return now;
    if (snap.pressure < PRESSURE_BLOCK_THRESHOLD) return now;
    if (snap.resetAt <= now) return now;
    return snap.resetAt;
  }

  shouldDispatch(workerId: WorkerId): boolean {
    return this.pressureFor(workerId) < PRESSURE_BLOCK_THRESHOLD;
  }

  load(snapshot: RateLimitSnapshot): void {
    this.snapshots.set(snapshot.workerId, snapshot);
  }
}

export function computePressure(headers: RateLimitHeaders): number {
  if (headers.tokensLimit <= 0) return 0;
  const used = headers.tokensLimit - headers.tokensRemaining;
  const raw = used / headers.tokensLimit;
  if (Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}
