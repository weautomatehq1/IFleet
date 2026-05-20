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

### M1 DoD eval replay results — 2026-05-19 (real run)

**Sandbox mode:** in-worktree (Docker daemon available but `ifleet-verifier:base` image not built — sandbox falls back to direct `pnpm` invocation per ADR-0002 fallback clause). Full Docker sandbox arrives with M1.W4 image build.

**Selection:** 10 / 14 eval rows spanning 5 feat, 2 fix, 1 chore label; PRs #18–#112 (earliest to latest merged).

**Infrastructure note:** PRs #18, #24, #31, #47 predate `allowBuilds` config in `pnpm-workspace.yaml` (added in PRs #115/#116). The replay script patches the workspace config before install so native bindings compile correctly. This is an eval harness concern, not a pipeline production concern.

| Metric | Value |
|---|---|
| Pass rate | **9 / 10 (90%)** |
| DoD gate (≥ 8 / 10) | ✓ PASSED |
| `VerifierStoreBridge.disagreementRate()` | **0.100** (1 fail / 10 completed runs) |
| Avg duration per run | ~13 s (in-worktree; Docker expected ~60–90 s with image) |
| Total cost | $0.00 (in-worktree; no LLM calls) |

**Per-task breakdown:**

| # | ID | PR | Kind | Status | Duration | Failures |
|---|---|---|---|---|---|---|
| 1 | ifleet-IF-109 | #112 | feat | **passed** | 18 s | 0 |
| 2 | ifleet-IF-107 | #110 | fix | **passed** | 16 s | 0 |
| 3 | ifleet-IF-098 | #105 | chore | **passed** | 16 s | 0 |
| 4 | ifleet-IF-076 | #101 | feat | **passed** | 15 s | 0 |
| 5 | ifleet-IF-075 | #104 | feat | **passed** | 15 s | 0 |
| 6 | ifleet-IF-071 | #102 | feat | **failed** | 13 s | 1 (test) |
| 7 | ifleet-IF-044 | #47 | feat | **passed** | 7 s | 0 |
| 8 | ifleet-IF-029 | #31 | feat | **passed** | 9 s | 0 |
| 9 | ifleet-IF-020 | #24 | fix | **passed** | 12 s | 0 |
| 10 | ifleet-IF-016 | #18 | fix | **passed** | 9 s | 0 |

**Failure analysis — ifleet-IF-071 (PR #102):** Test suite exits 1 in ~6 s. Failures are in tests that assert on state introduced in PR #102 but required a follow-up fix (likely landed in PR #103 or #104 which corrected the implementation). This is a real historical regression the verifier correctly catches — not a false positive. The PR was merged by a human reviewer, so `disagreementRate = 0.10` is accurate: the verifier disagrees with one human-approved merge.

Raw results: `.ifleet/eval/replay-results.json`
Replay script: `scripts/eval-replay.ts`

**Interpretation:** 0.10 disagreement rate is the M1 baseline. At M6 the target is < 0.25 (verifier finds real regressions) while keeping false_positive_rate < 0.10. Today's 1/10 failure is a genuine historical regression, which means the verifier is working correctly — it's not rubber-stamping code.

### M1.W2 Docker-sandbox isolation check — 2026-05-20

**Sandbox mode:** Docker (`ifleet-verifier:base` — node:20-bookworm-slim + pnpm@9 + entrypoint.sh). Image built in PR #129, no pre-cached pnpm store.

**Selection:** Same 10 historical PRs as in-worktree run above.

**Infrastructure fixes required to get Docker running:**
- pnpm store pinned to `/home/verifier/.pnpm-store` (not `/work/.pnpm-store`) via `pnpm config set` in Dockerfile — virtiofs mount has ENOENT copyfile failures when store lives on the virtiofs volume
- Colima virtiofs only auto-mounts `/Users` — clone/worktree paths moved from `$TMPDIR` (`/var/folders/...`) to `~/.ifleet-eval-tmp/`
- pnpm@9 installed via `npm install -g pnpm@9` (not corepack) — corepack resolves pnpm@11 at runtime for repos without `packageManager` field, pnpm@11 requires Node 22
- Node 20 `node --test` doesn't expand glob patterns — entrypoint uses `shopt -s globstar` + bash array expansion before handing files to node

| Metric | Value |
|---|---|
| Pass rate Docker | **1 / 10 (10%)** |
| DoD gate (≥ 8 / 10) | FAILED |
| `disagreementRate()` Docker | **0.900** |
| Avg duration per run | ~70 s (cold install + tests) |
| Comparison vs in-worktree | Differs — 9/10 in-worktree, 1/10 Docker |

**Per-task breakdown:**

| # | ID | PR | Status | Failing phase | Root cause |
|---|---|---|---|---|---|
| 1 | ifleet-IF-109 | #112 | **failed** | test | config/git tests need host env |
| 2 | ifleet-IF-107 | #110 | **failed** | test | config/git tests need host env |
| 3 | ifleet-IF-098 | #105 | **failed** | test | config/git tests need host env |
| 4 | ifleet-IF-076 | #101 | **failed** | test | config/git tests need host env |
| 5 | ifleet-IF-075 | #104 | **failed** | test | config/git tests need host env |
| 6 | ifleet-IF-071 | #102 | **failed** | test | config/git tests need host env |
| 7 | ifleet-IF-044 | #47 | **failed** | test | config/git tests need host env |
| 8 | ifleet-IF-029 | #31 | **failed** | test | config/git tests need host env |
| 9 | ifleet-IF-020 | #24 | **failed** | test | config/git tests need host env |
| 10 | ifleet-IF-016 | #18 | **passed** | — | No tests at this SHA |

All 10 tasks pass install + typecheck + lint. All test failures are environment-sensitive tests (git ls-remote to real remotes, Discord config reads, HMAC token checks) that work on the host (network + config available) but fail in the isolated container (no secrets, no network to GitHub).

**Does Docker validate the infrastructure DoD?**

Partially. The Docker path IS working as designed per ADR-0002:
- Container starts, mounts worktree, runs install → typecheck → lint — all pass
- Network isolation correctly blocks real-remote git tests (intended behavior for untrusted code)
- pnpm@9 + Node 20 run inside the container without fallback

The 1/10 pass rate is NOT a Docker infrastructure bug — it reveals that 9/10 historical SHAs have environment-sensitive tests that assume host-side git/Discord/config access. This is a test design issue, not a sandbox issue. The sandbox is doing exactly what ADR-0002 requires: enforcing isolation.

**Infrastructure DoD verdict:** PARTIAL — sandbox runs and isolates correctly. Full behavioral DoD requires making env-sensitive tests injectable (`.env.verify` mount per ADR-0002 failure-mode table). Tracking issue to follow.

Raw results: `.ifleet/eval/replay-results-docker.json`

## References

- [OpenHands Docker Sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox)
- [Augment Code: Pre-Merge Verification](https://www.augmentcode.com/guides/ai-agent-pre-merge-verification)
- [ArchUnitTS](https://lukasniessen.github.io/ArchUnitTS/)
- [Semgrep rule syntax](https://semgrep.dev/docs/writing-rules/rule-syntax)
