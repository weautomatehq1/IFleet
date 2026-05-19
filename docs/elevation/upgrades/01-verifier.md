# Upgrade 1 — Closed-loop verifier (Docker sandbox)

**Month:** M1 | **Depends on:** ADR-0001, ADR-0002 | **KPI:** >80% of IFleet PRs pass external CI on first try

## What it does

After the Editor completes, runs the change in an isolated Docker sandbox: install → build → typecheck → lint → test → invariants (Semgrep + ArchUnitTS-style). On failure, structured failures re-queue to the Editor with max 3 retries. On success, the PR opens with the verification report attached.

## Why it matters

Every system at the top of SWE-Bench Verified has this. IFleet doesn't. Without it: "PR opened" ≠ "code works." 80% of real engineering lives in the gap.

## Integration point in IFleet

```
Existing:   classifier → architect → editor → src/verify/ (in-worktree) → diff-reviewer → PR
New M1:     classifier → architect → editor → src/verify/ (pre-flight, fast) → VerifierAgent (sandbox, hard wall) → diff-reviewer → PR
                                                                                    ↑
                                                              re-queue to editor with structured feedback (max 3 retries)
```

`src/verify/` stays as the fast in-worktree pre-flight (immediate feedback to editor). New `src/agents/verifier/` is the deterministic gate post-editor. Both run; they have different jobs.

## Files added in M1

```
src/agents/verifier/
├── index.ts           # VerifierAgent — subscribes to editor.completed, orchestrates run
├── sandbox.ts         # Docker invocation, container lifecycle
├── failure-parser.ts  # Parse pnpm/vitest/eslint/tsc output → structured failures
├── invariants.ts      # Semgrep + ArchUnit-style runner
├── types.ts           # Event payloads, run state
└── __tests__/

scripts/verifier-image/
├── Dockerfile.base    # node:20-bookworm + pnpm + git + python3
└── README.md

src/orchestrator/migrations/
└── 0008-verifier-runs.sql
```

## Data model

```sql
CREATE TABLE verifier_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued | running | passed | failed | timeout | error
  started_at INTEGER, finished_at INTEGER,
  cost_usd REAL,                       -- model time + sandbox compute
  attempt INTEGER NOT NULL DEFAULT 1,  -- 1..3
  fingerprint_before TEXT,             -- JSON (M4)
  fingerprint_after TEXT,              -- JSON (M4)
  raw_log_url TEXT                     -- S3 link to full log
);
CREATE INDEX idx_verifier_runs_task ON verifier_runs(task_id);

CREATE TABLE verifier_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES verifier_runs(id),
  kind TEXT NOT NULL,                  -- build | typecheck | lint | test | invariant
  file TEXT, line INTEGER, column INTEGER,
  message TEXT NOT NULL,
  raw_output TEXT
);
CREATE INDEX idx_verifier_failures_run ON verifier_failures(run_id);
```

## Pipeline step

**Input** (subscribed event):
```typescript
{ taskId: string, repoUrl: string, sha: string, branch: string }
```

**Output** (emitted events):
```typescript
// success
{ taskId, runId, status: 'passed', report: { tests: N, lint: 0, invariants: 0, duration_ms } }

// failure
{ taskId, runId, status: 'failed', failures: VerifierFailure[], attempt: 1|2|3 }
```

**Trigger:** `editor.completed` event from `SprintManager`.

## Discord interface

| Command | Behavior |
|---|---|
| `/status <taskId>` | Augmented to show verifier state (queued/running/passed/failed) and last attempt's failures |
| `/verify <taskId>` | Manually trigger a verifier rerun (gated by `allowedUserIds`) |

**On verifier failure (in thread of the original `/ship`):**
```
❌ Verifier failed (attempt 2/3)
  test: src/foo.test.ts:42 — expected "ok", got "error"
  typecheck: src/bar.ts:17 — Property 'baz' does not exist on type 'X'

[Retry] [Force-PR] [Cancel]
```

`[Force-PR]` requires explicit `allowedUserIds` membership; logged as a deliberate override.

## Failure modes

| Failure | Handling |
|---|---|
| No `test` script in package.json | Run build+lint+typecheck only, label PR `verified: partial` |
| Test flaky (>20% historical flake) | Track in `verifier_runs.flake_rate`, ignore with banner |
| Sandbox >10 min | SIGKILL, mark `timeout`, surface cost |
| Repo needs secrets | Mount `.env.verify` from control plane, ACL'd per channel |
| Docker daemon down | Fall back to in-worktree `src/verify/` with banner `sandbox: unavailable`, alert |
| OOM | Cap container 4GB RAM; if hit, label `verified: partial` |
| `pnpm install` fails (network / registry) | Retry once with backoff, then mark `error` (not `failed`) |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 | Scaffold (empty shell, emits `verifier.passed` unconditionally, contract decision locked). **This is the M0.W1 commit.** |
| W2 | Real Docker harness — install/build/typecheck/lint/test. Parse failures into structured rows. Re-queue to editor with feedback. |
| W3 | Discord surfacing (`/status` augment, `/verify` command, button handlers). Cost tracking in `verifier_runs.cost_usd`. |
| W4 | Invariant integration. Semgrep rules + ArchUnitTS-style assertions in `.ifleet/invariants/<repo>/`. |

## Invariant format (W4)

`.ifleet/invariants/<repo>/semgrep.yml`:
```yaml
rules:
  - id: no-supabase-outside-data
    message: Supabase calls only allowed in data/ layer
    severity: ERROR
    languages: [typescript]
    pattern: supabase.$METHOD($X)
    pattern-not-inside:
      paths: ["data/**", "supabase/**"]
```

`.ifleet/invariants/<repo>/arch.ts` (TypeScript-only, ArchUnitTS-style):
```typescript
import { projectFiles } from 'archunit';
export default async function archTests() {
  projectFiles()
    .inFolder('src/api/**')
    .shouldNot()
    .dependOnFiles().inFolder('src/orchestrator/**')
    .check();
}
```

## Verification (Definition of Done for M1)

- 10 historical PRs from eval set replayed through pipeline. ≥8 verifier-passed.
- Discord `/verify` works end-to-end against a test repo.
- Verifier failure → editor retry → verifier pass happens in <5 min on a deliberately broken test.
- Cost per verifier run tracked in `verifier_runs.cost_usd`, queryable.

## References

- [OpenHands Docker Sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox)
- [Augment Code: Pre-Merge Verification](https://www.augmentcode.com/guides/ai-agent-pre-merge-verification)
- [ArchUnitTS](https://lukasniessen.github.io/ArchUnitTS/)
- [Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax)
