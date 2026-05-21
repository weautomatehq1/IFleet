# IFleet Dashboard

Local-only, read-only ops dashboard for IFleet. Single page that combines:

- **GitHub view** — open PRs + recent commits (calls api.github.com from the browser; optional token in localStorage to lift rate limits).
- **Live state view** — active sprints, task queue, recent PR decisions, and per-sprint budget burn, served from the two local SQLite databases.

No auth. No writes. Meant to be opened by Seb on his laptop while the fleet runs.

## Run

```bash
pnpm dashboard
# → http://localhost:3737
```

The server is a ~250-line Node HTTP server (no Express dep). It opens both
databases with `better-sqlite3` in `readonly: true, fileMustExist: true`
mode, so the dashboard cannot corrupt or mutate state even if there is a
bug in a handler.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `DASHBOARD_PORT` | `3737` | HTTP port |
| `DASHBOARD_HOST` | `127.0.0.1` | Interface to bind. Default is localhost-only (no LAN exposure). Set to `0.0.0.0` to expose to the LAN (e.g. for a tablet on the same WiFi). The dashboard has no auth — only switch when you trust the network. |
| `DASHBOARD_TASKS_DB` | `${IFLEET_STATE_DIR:-./state}/tasks.db` | Path to TaskStore SQLite |
| `DASHBOARD_STATE_DB` | `~/.omc/ifleet/state.db` | Path to StateStore SQLite |
| `IFLEET_STATE_DIR` | `./state` | Used when `DASHBOARD_TASKS_DB` is unset |

Both files must already exist — the dashboard refuses to create them.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/` | The dashboard page |
| GET | `/api/health` | `{ ok, tasksDb, stateDb }` |
| GET | `/api/sprints/active` | Sprints whose `state.kind` is not in `failed`/`completed`/`cancelled`/`aborted` |
| GET | `/api/tasks/queue?limit=50` | Tasks in `pending` or `in_flight` (in_flight first, then by priority + age) |
| GET | `/api/pr-decisions?limit=20` | Most recent rows from `pr_decisions` (StateStore) |
| GET | `/api/budget` | All rows of `sprint_runtime_state` ordered by `spent_usd DESC` |

Note: there are two `pr_decisions` tables in the codebase — one in
`TaskStore` (queue/store.ts) and one in `StateStore` (orchestrator/store.ts).
The dashboard reads the StateStore one because that's where the sprint
manager writes terminal decisions (see PR #158).

## Scope (deliberately small)

- Read-only. The dashboard never writes — `better-sqlite3` is opened with
  `readonly: true`, and there are no POST/PUT/DELETE handlers.
- No auth, no CSRF, no users. If you bind it to anything other than
  localhost you own the consequences.
- No build step. The page is a single `index.html` that ships Tailwind via
  CDN and renders entirely client-side.

## Stopping it

Ctrl-C. There is no daemon.
