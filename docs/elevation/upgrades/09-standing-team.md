# Upgrade 9 — Standing-team rituals (Discord)

**Month:** M1 (parallel — no dependencies) | **Depends on:** nothing | **KPI:** Daily standup post live; persona consistency in voices

## What it does

Makes IFleet feel like a team of people who show up to work every day, have opinions, push back, escalate, and report. Pure prompt + cron + Discord templates — no new infrastructure.

This is the **highest perceived-value-to-effort ratio** of anything in this roadmap. Build first, parallel with M1.

## Why it matters

- Today IFleet is a task runner you talk to. Asymmetric — you initiate, it executes.
- With standing rituals, IFleet feels like teammates: predictable rhythms, voices, escalation paths.
- Cheap to build. Hard to fake quality without it.

## Rituals

### 9am — Daily standup post

Posted to `#ifleet` channel (or `#ifleet-ops` for cross-repo digest):

```
☀️ IFleet standup — 2026-05-20

Yesterday:
  • Shipped 3 PRs:
    – weautomatehq1/IFleet#234 — feat(verifier): retry loop ✅ merged
    – weautomatehq1/factory#89 — fix(spec): doc typo ✅ merged
    – weautomatehq1/voice-discovery#41 — refactor(intake): split prompt ❌ rejected (Sebastian: "scope creep")

Today (planned):
  • 3 proposals queued in #ifleet-proposals — awaiting approval
  • Continuing M1.W2 verifier work (taskId=ifleet-2026-512)

Blockers:
  • Postgres not provisioned — blocking M3.W1 start (need go-ahead on Supabase decision)

Last 24h: 12h LLM time, $4.30 spent, 89% verifier pass rate.
```

### Sunday 8pm — Weekly retro post

Posted to `#ifleet-ops`:

```
🪞 IFleet retro — week of 2026-05-13

Shipped: 18 PRs (15 merged, 2 rejected, 1 reverted)
Cost: $34.80 over the week
Verifier pass rate: 87% (target: 80%)
Disagreement rate: 14% (target: <25%)

Top win: Plan-Reviewer caught a schema migration bug before editor ran (saved ~$2 in retries)
Top failure: 3 PRs in voice-discovery rejected for missing tests — pattern detected

Suggested change for next week:
  Add invariant rule: PRs to voice-discovery/ must include test changes
```

(Weekly retro requires M5+ data — start the daily standup in M1, weekly retro starts when there's a week of data.)

### Per-role persona

When IFleet writes anything (PR description, Discord message, plan, review), the voice is consistent per role:

| Role | Voice | Example |
|---|---|---|
| Architect | Formal, asks clarifying questions, considers tradeoffs | "I see two paths here: (a) ... (b) ... I recommend (a) because ..." |
| Plan-Reviewer | Critical, structured | "Veto: this plan touches src/orchestrator/sprint.ts — protected per SECURITY.md. Suggested revision: ..." |
| Editor | Terse, just-the-code | "Implemented. Tests passing. Build green." |
| Diff-Reviewer | Pedantic, line-specific | "src/foo.ts:42 — this allocation is in the hot path. Move outside the loop." |
| Verifier | Factual, no opinion | "Build: passed. Tests: 47/47. Lint: clean. Invariants: clean. Duration: 87s." |
| Proposer | Curious, opens with rationale | "I noticed the last 3 PRs touching src/api/ were rejected for missing rate-limit checks. Proposing: add invariant rule." |
| Coherence-Watcher | Alarm-bell tone, urgent for breaking | "🛑 Breaking drift: User.email type changed in IFleet but not voice-discovery." |

### Escalation paths

When a role hits an impasse, it pings `@Sebastian` with structured disagreement, not a flat "help":

```
@Sebastian — Plan-Reviewer ↔ Architect disagreement (taskId=ifleet-2026-512, attempt 2/2)

Architect proposes: refactor src/orchestrator/sprint.ts to add new event type
Plan-Reviewer vetoes: src/orchestrator/sprint.ts is in SECURITY.md protected paths

I recommend: Architect's revision (adding the event type in a new file src/orchestrator/events/verifier.ts)
satisfies the spirit of the protection. Approve revision?

[Approve revision] [Block — needs ADR] [Cancel task]
```

## Integration into IFleet

**Files added in M1.W2 (parallel with verifier):**

```
src/agents/rituals/
├── standup.ts          # Daily standup generator
├── retro.ts            # Weekly retro generator (starts firing M5+)
├── personas.ts         # Per-role voice prompts (consumed by all agents)
└── escalation.ts       # Structured disagreement message format

ecosystem.config.cjs    # Add cron entries for standup (9am) and retro (Sunday 8pm)
```

## Data sources

Standup reads:
- `verifier_runs` table (from M1) — yesterday's verification outcomes
- `pr_decisions` table (from M5 / will be empty until then — degrade gracefully)
- Task trace events (from existing `store.ts`) — yesterday's tasks
- `goal_proposals` table (from M5)
- PM2 process state — uptime, restarts

Retro reads:
- All of the above for last 7 days
- LLM cost aggregation

## Failure modes

| Failure | Handling |
|---|---|
| No activity yesterday | Standup says so: "Slow day — 0 PRs, 0 tasks. M1.W2 verifier work continues today." |
| Sentiment-y wording creeping in (LLM-generated standup gets fluffy) | Hard prompt rule: "Facts only. No 'great work,' 'exciting progress,' or similar." |
| Discord rate-limit on long messages | Split into 2 messages or use Discord thread |
| Persona drift over time | Quarterly audit: read 10 random IFleet messages, check voice consistency |

## Implementation order

| Week | Deliverable |
|---|---|
| W1 | Persona prompts wired into all existing roles (architect, editor, diff-reviewer). |
| W2 | Standup cron + generator. Posts to `#ifleet`. |
| W3 | Escalation message format. Used by plan-reviewer in M2. |
| M5+ | Retro cron starts firing once there's a week of data in the new tables. |

## Verification (Definition of Done for M1 rituals)

- Standup post fires at 9am for 5 consecutive days.
- Each role's outputs follow the persona guide (manually spot-check 3 messages per role).
- 1 escalation message generated end-to-end (test trigger).

## References

- (No published reference — this is interaction design, not technical research. The pattern comes from observing how distributed engineering teams actually communicate.)
