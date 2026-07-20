/**
 * Read-only dashboard server.
 *
 * Opens both SQLite databases (TaskStore + StateStore) in `readonly: true`
 * mode and serves a static `index.html` plus a small JSON API. Local-only,
 * no auth, single user. Never writes to either DB.
 */
import Database from 'better-sqlite3';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['DASHBOARD_PORT'] ?? 3737);
const TASKS_DB =
  process.env['DASHBOARD_TASKS_DB'] ??
  join(process.env['IFLEET_STATE_DIR'] ?? join(process.cwd(), 'state'), 'tasks.db');
const STATE_DB =
  process.env['DASHBOARD_STATE_DB'] ?? join(homedir(), '.omc', 'ifleet', 'state.db');

// 'aborted' is not a valid SprintState kind — the state machine uses 'cancelled'.
// AUDIT-IFleet-e2f3a4b5.
const TERMINAL_SPRINT_KINDS = new Set(['failed', 'completed', 'cancelled']);

export interface DashboardServerOptions {
  port?: number;
  tasksDbPath?: string;
  stateDbPath?: string;
}

export interface DashboardHandles {
  tasksDb: Database.Database;
  stateDb: Database.Database;
}

export function openDashboardDbs(options: DashboardServerOptions = {}): DashboardHandles {
  const tasksDbPath = options.tasksDbPath ?? TASKS_DB;
  const stateDbPath = options.stateDbPath ?? STATE_DB;
  const tasksDb = new Database(tasksDbPath, { readonly: true, fileMustExist: true });
  const stateDb = new Database(stateDbPath, { readonly: true, fileMustExist: true });
  return { tasksDb, stateDb };
}

interface SprintRow {
  id: string;
  mode: string;
  goal: string;
  state_json: string;
  created_at: number;
  updated_at: number;
}

interface TaskQueueRow {
  id: string;
  source_kind: string;
  repo: string;
  title: string;
  brief: string;
  state: string;
  priority: string;
  created_at: number;
  picked_at: number | null;
}

interface PrDecisionRow {
  id: string;
  task_id: string;
  repo: string;
  pr_number: number | null;
  verdict: string;
  reviewer_login: string | null;
  created_at: number;
}

interface BudgetRow {
  sprint_id: string;
  spent_usd: number;
  rate_reset_at: number | null;
  updated_at: number;
}

export function listActiveSprints(stateDb: Database.Database) {
  const rows = stateDb
    .prepare(
      `SELECT id, mode, goal, state_json, created_at, updated_at
         FROM sprints
        ORDER BY updated_at DESC`,
    )
    .all() as SprintRow[];
  return rows
    .map((r) => {
      let kind = 'unknown';
      let state: unknown = null;
      try {
        state = JSON.parse(r.state_json);
        if (state && typeof state === 'object' && 'kind' in state) {
          kind = String((state as { kind: unknown }).kind ?? 'unknown');
        }
      } catch {
        // leave kind = unknown
      }
      return {
        id: r.id,
        mode: r.mode,
        goal: r.goal,
        kind,
        state,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    })
    .filter((s) => !TERMINAL_SPRINT_KINDS.has(s.kind));
}

export function listTaskQueue(tasksDb: Database.Database, limit = 50) {
  const rows = tasksDb
    .prepare(
      `SELECT id, source_kind, repo, title, brief, state, priority, created_at, picked_at
         FROM tasks
        WHERE state IN ('pending', 'in_flight')
        ORDER BY CASE state WHEN 'in_flight' THEN 0 ELSE 1 END,
                 CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
                 created_at ASC
        LIMIT @limit`,
    )
    .all({ limit }) as TaskQueueRow[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source_kind,
    repo: r.repo,
    title: r.title,
    briefPreview: r.brief.slice(0, 160),
    state: r.state,
    priority: r.priority,
    createdAt: r.created_at,
    pickedAt: r.picked_at,
  }));
}

export function listPrDecisions(tasksDb: Database.Database, limit = 20) {
  const rows = tasksDb
    .prepare(
      `SELECT id, task_id, repo, pr_number, verdict, reviewer_login, created_at
         FROM pr_decisions
        ORDER BY created_at DESC
        LIMIT @limit`,
    )
    .all({ limit }) as PrDecisionRow[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    repo: r.repo,
    prNumber: r.pr_number,
    verdict: r.verdict,
    reviewerLogin: r.reviewer_login,
    createdAt: r.created_at,
  }));
}

export function listBudgetBurn(stateDb: Database.Database) {
  const rows = stateDb
    .prepare(
      `SELECT sprint_id, spent_usd, rate_reset_at, updated_at
         FROM sprint_runtime_state
        ORDER BY spent_usd DESC`,
    )
    .all() as BudgetRow[];
  return rows.map((r) => ({
    sprintId: r.sprint_id,
    spentUsd: r.spent_usd,
    rateResetAt: r.rate_reset_at,
    updatedAt: r.updated_at,
  }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function createDashboardServer(options: DashboardServerOptions = {}) {
  const { tasksDb, stateDb } = openDashboardDbs(options);
  const indexHtml = readFileSync(join(HERE, 'index.html'));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port ?? PORT}`);
    const path = url.pathname;

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method not allowed');
        return;
      }

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(indexHtml);
        return;
      }
      if (path === '/api/health') {
        // Do NOT leak filesystem paths — even bound to 127.0.0.1, any browser
        // tab the operator has open can fetch this endpoint and learn the
        // local username + db layout. (Audit finding, post-merge.)
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/sprints/active') {
        sendJson(res, 200, listActiveSprints(stateDb));
        return;
      }
      if (path === '/api/tasks/queue') {
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
        sendJson(res, 200, listTaskQueue(tasksDb, limit));
        return;
      }
      if (path === '/api/pr-decisions') {
        const limit = clampInt(url.searchParams.get('limit'), 20, 1, 200);
        sendJson(res, 200, listPrDecisions(tasksDb, limit));
        return;
      }
      if (path === '/api/budget') {
        sendJson(res, 200, listBudgetBurn(stateDb));
        return;
      }
      sendError(res, 404, 'not found');
    } catch (err) {
      // Log the real error for the operator but return a generic message —
      // raw `Error.message` can include SQLite internals, file paths, or
      // stack-trace excerpts that don't belong over the wire.
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[dashboard] handler error:', detail);
      sendError(res, 500, 'internal server error');
    }
  });

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => {
        try {
          tasksDb.close();
          stateDb.close();
        } catch {
          // best-effort
        }
        if (err) reject(err);
        else resolve();
      });
    });

  return { server, close, tasksDb, stateDb };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { server } = createDashboardServer({ port: PORT });
  // Bind explicitly to 127.0.0.1 — the dashboard is a local single-user
  // ops view with no auth. The Node default (`0.0.0.0`) would expose the
  // server to any device on the same LAN. Use `DASHBOARD_HOST=0.0.0.0` to
  // opt in to LAN exposure (e.g. for a tablet on the same WiFi).
  const HOST = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[dashboard] tasksDb=${TASKS_DB}`);
    // eslint-disable-next-line no-console
    console.log(`[dashboard] stateDb=${STATE_DB}`);
  });
}
