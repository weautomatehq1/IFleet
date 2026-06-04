# Upgrade 10 — Self-improving IFleet (DEFERRED, M4+ minimum)

**Month:** M4+ (gated, do not start earlier) | **Depends on:** Eval set ≥50 tasks, SECURITY.md, Operating Standard signed off | **KPI:** Self-PRs match or beat baseline on eval set

## ⚠️ Do not build until preconditions met

**Hard prerequisites — verify all before starting:**

<!-- Status as of 2026-06-04: 2/5 met. Upgrade 10 is blocked. Do not start implementation. -->

- [ ] `.ifleet/eval/eval-set.jsonl` has ≥50 rows — **NOT MET: 13/50 rows as of 2026-06-04; in progress** (per `eval-set.md` sizing schedule; SPRINT.md targets ≥50 by M3, with further growth to ≥100 by M5)
- [x] `SECURITY.md` lists protected paths — **MET** (protected-paths table + self-modification constraints present)
- [ ] `docs/elevation/operating-standard.md` signed off — **NOT MET: sign-off boxes empty; blocked by Upgrade 10 readiness milestone**
- [ ] Shadow eval harness exists (`src/agents/self-improver/`) — **NOT MET: directory does not exist; planned for M4+**
- [x] Rollback runbook documented in `deploy/rollback.sh` — **MET** (v1 shipped: single-PR revert + optional PM2 reload + healthz verify + audit log; multi-host and time-windowed variants are planned follow-ups)

Skipping any precondition = self-inflicted production incident.

## What it does

IFleet monitors its own repo for tech debt, proposes self-improvements, and ships PRs to itself under strict safety constraints. SICA (ICLR 2025) is the reference architecture; AGrail (ACL 2025) is the reference guardrail framework. **Published guardrails in SICA are weak — we add more.**

## Why it matters (and why to be paranoid)

- IFleet is the only repo where bugs in IFleet's PR-generation directly affect IFleet's PR-generation. Feedback loop.
- Self-improvement done badly = unrecoverable degradation.
- Self-improvement done well = compounding gains. Every month IFleet ships to IFleet, all subsequent client work benefits.

## Safety constraints (load-bearing — do not weaken)

| # | Constraint | Enforced by |
|---|---|---|
| 1 | Target path NOT in `SECURITY.md` protected list | Pre-PR check in editor; build fails if violated |
| 2 | Diff ≤5 files, ≤300 lines | Pre-PR check; reject otherwise |
| 3 | Human approval required — `auto-merge` disabled for `ifleet:self` label | GitHub branch protection rule |
| 4 | Shadow eval must match or beat baseline on ALL metrics | Pre-PR; reject if any metric regresses |
| 5 | Rollback path tested in last 30 days | Automated in M4 ops cron |
| 6 | No self-PR while another self-PR is in-flight | Lock in `self_improvement_runs` table |
| 7 | No self-modifying the safety constraints (1-6) themselves | Pre-PR check via list of "meta-protected" files |

## Integration into IFleet

**New service:** `src/agents/self-improver/` — separate from Proposer (M5) because the gates are stricter and the eval cycle is different.

**Files added in M4+:**

```
src/agents/self-improver/
├── index.ts                  # SelfImproverAgent — orchestrates the gated flow
├── candidates.ts             # Detect tech-debt patterns (TODOs, lint warnings, dead code)
├── shadow-eval.ts            # Run candidate code against eval-set, compare metrics
├── safety-check.ts           # Verify all 7 constraints before PR
└── rollback-monitor.ts       # Watches deployed IFleet, triggers PM2 reload on regression

scripts/
├── shadow-ifleet.ts          # Spin up shadow IFleet instance against eval-set
└── self-improvement-canary.ts  # Compare baseline vs candidate metrics
```

## Data model

```sql
CREATE TABLE self_improvement_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  candidate_branch TEXT NOT NULL,
  target_files TEXT[] NOT NULL,
  loc_added INTEGER, loc_removed INTEGER,
  shadow_eval_baseline JSONB,            -- metrics on main
  shadow_eval_candidate JSONB,           -- metrics on candidate branch
  shadow_eval_decision TEXT,             -- pass | regression | inconclusive
  safety_checks JSONB,                   -- result of each of the 7 constraints
  pr_url TEXT,
  merged_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ, revert_reason TEXT
);
```

## Pipeline step

**Trigger (manual, M4-early; cron, M5+):**

```
1. SelfImproverAgent scans IFleet repo for candidates:
   - TODO comments older than 30 days
   - Lint warnings (eslint --quiet)
   - Functions with cyclomatic complexity >10
   - Dead exports (ts-prune)
   - Test coverage gaps

2. Score candidates by (impact, risk, locality).

3. Pick top-1 candidate; check safety constraints 1, 2, 6.

4. Spawn standard IFleet pipeline (classifier → architect → plan-reviewer → editor → verifier) on the candidate.
   IMPORTANT: this pipeline runs INSIDE the sandbox sentry — it cannot modify the running IFleet, only a candidate branch.

5. Once PR is verifier-passed in sandbox:
   a. Run shadow eval — spin up shadow IFleet instance with candidate code, replay eval-set tasks, compare metrics
   b. If any metric regresses → reject; mark `shadow_eval_decision: regression`
   c. If all metrics match or beat baseline → open PR with `ifleet:self` label

6. Sebastian reviews and approves manually. Auto-merge is disabled.

7. After merge:
   a. PM2 reload to deploy new code
   b. rollback-monitor watches for 24h: if disagreement rate climbs >25% in first 24h, automatic revert + alert
```

## Discord interface

| Command | Behavior |
|---|---|
| `/self-improve scan` | Manually scan for candidates, post top 5 |
| `/self-improve status` | Current in-flight self-improvement run |
| `/self-improve rollback` | Manual revert of last self-PR (requires confirmation) |

Self-PR message in `#ifleet`:

```
🔧 IFleet self-improvement PR #ifleet-self-2026-001
  Target: src/utils/format-cost.ts (12 LOC, locality: low)
  Shadow eval: pass (verifier 91% vs baseline 89%; cost -3%)
  Safety: all 7 checks ✅
  Diff: <link>

  [Approve & Merge] [Reject]
```

## Failure modes

| Failure | Handling |
|---|---|
| Shadow eval inconclusive (some metrics up, some down) | Reject; require human review |
| Safety check fails post-PR (constraints changed mid-run) | Auto-close PR; alert |
| Rollback monitor triggers but revert fails | `@Sebastian` ping; pause all self-improvement |
| Self-PR introduces a bug only visible in production | Rollback monitor (24h disagreement rate watch) is the last-line defense |
| Eval set drift (eval set no longer representative) | Quarterly refresh of eval-set; document any removals |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 (M4+) | shadow-eval harness — can replay eval-set against any IFleet branch and emit metrics JSON. |
| W2 | Safety-check enforcement (all 7 constraints, fail-loud on violation). |
| W3 | Candidate detection (TODOs, lint, dead code). Manual trigger only — no cron. |
| W4 | Rollback monitor + 24h disagreement-rate watch. Discord commands. |
| Later | Cron-trigger after 1 month of stable manual operation. |

## Verification (Definition of Done for M4+ self-improvement)

- 1 self-PR opened, reviewed, approved, merged, **not reverted** in 7 days.
- Shadow eval correctly rejected 1 candidate that regressed a metric.
- Safety-check correctly blocked 1 candidate that touched a protected path.
- Rollback monitor tested via deliberate regression injection.

## References

- [SICA: Self-Improving Coding Agent (ICLR 2025)](https://arxiv.org/html/2504.15228v1)
- [AGrail: Lifelong Agent Guardrails (ACL 2025)](https://github.com/EvoAgentX/Awesome-Self-Evolving-Agents)
- [Voyager skill library](https://voyager.minedojo.org/) — relevant for the candidate-scoring approach
