/**
 * SQL bridge for verifier_runs / verifier_failures rows. Kept in its own file
 * so the orchestrator's `store.ts` doesn't grow when M1.W2 lands — store.ts
 * already declared the tables in the M0.W1 scaffold; we only add typed
 * helpers here.
 *
 * The bridge accepts a {@link StateStore} but reaches into a small subset of
 * the underlying `better-sqlite3` connection. It is intentionally narrow:
 *   - insertRun / updateRun(finished, status)
 *   - insertFailures (batch)
 *   - listRunsByTask
 *   - getDisagreementRate (canary metric — verifier failed but src/verify/ passed)
 */

import type Database from 'better-sqlite3';
import type { StateStore } from '../../orchestrator/store.js';
import type { SprintId, TaskId } from '../../orchestrator/types.js';
import type { VerifierFailure, VerifierRunResult, VerifierStatus } from './types.js';

interface StoreInternal {
  // Exposed by reading the runtime field; we don't call private methods.
  db: Database.Database;
}

export interface PersistedVerifierRun {
  id: string;
  taskId: TaskId;
  sprintId: SprintId;
  repoUrl: string;
  branch: string;
  sha: string;
  status: VerifierStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  attempt: number;
  costUsd: number | null;
  rawLogUrl: string | null;
}

export class VerifierStoreBridge {
  private readonly db: Database.Database;

  constructor(store: StateStore) {
    this.db = (store as unknown as StoreInternal).db;
    if (!this.db) {
      throw new Error('VerifierStoreBridge requires a StateStore with a `db` field');
    }
  }

  insertRun(args: {
    runId: string;
    taskId: TaskId;
    sprintId: SprintId;
    repoUrl: string;
    branch: string;
    sha: string;
    attempt: number;
    startedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO verifier_runs
          (id, task_id, sprint_id, repo_url, branch, sha, status, started_at, attempt)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        args.runId,
        args.taskId,
        args.sprintId,
        args.repoUrl,
        args.branch,
        args.sha,
        args.startedAt,
        args.attempt,
      );
  }

  completeRun(result: VerifierRunResult): void {
    this.db
      .prepare(
        `UPDATE verifier_runs
            SET status = ?, finished_at = ?, duration_ms = ?, cost_usd = ?, raw_log_url = ?
          WHERE id = ?`,
      )
      .run(
        result.status,
        result.finishedAt,
        result.durationMs,
        result.costUsd ?? null,
        result.rawLogUrl ?? null,
        result.runId,
      );
    if (result.failures.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO verifier_failures (run_id, kind, file, line, column_num, message, raw_output)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((failures: ReadonlyArray<VerifierFailure>) => {
      for (const f of failures) {
        stmt.run(
          result.runId,
          f.kind,
          f.file ?? null,
          f.line ?? null,
          f.column ?? null,
          f.message,
          f.rawOutput ?? null,
        );
      }
    });
    tx(result.failures);
  }

  listRunsByTask(taskId: TaskId): PersistedVerifierRun[] {
    const rows = this.db
      .prepare('SELECT * FROM verifier_runs WHERE task_id = ? ORDER BY started_at ASC')
      .all(taskId) as ReadonlyArray<{
      id: string;
      task_id: string;
      sprint_id: string;
      repo_url: string;
      branch: string;
      sha: string;
      status: string;
      started_at: number;
      finished_at: number | null;
      duration_ms: number | null;
      attempt: number;
      cost_usd: number | null;
      raw_log_url: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id as TaskId,
      sprintId: r.sprint_id as SprintId,
      repoUrl: r.repo_url,
      branch: r.branch,
      sha: r.sha,
      status: r.status as VerifierStatus,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      attempt: r.attempt,
      costUsd: r.cost_usd,
      rawLogUrl: r.raw_log_url,
    }));
  }

  /**
   * Canary metric — fraction of verifier runs whose `failed` verdict
   * contradicts the in-worktree pre-flight (recorded by the pipeline as
   * `task.verify_passed`). High disagreement = the new sandbox is finding
   * things the old verify missed; low disagreement = redundant work.
   * Returns null when there are too few samples (<5) to be meaningful.
   */
  disagreementRate(): number | null {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM verifier_runs
         WHERE status IN ('failed','passed')`,
      )
      .get() as { total: number; failed: number };
    if (!row || row.total < 5) return null;
    return row.failed / row.total;
  }
}
