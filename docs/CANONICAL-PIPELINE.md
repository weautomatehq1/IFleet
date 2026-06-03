# IFleet — Canonical Pipeline Implementation

> Maps the canonical pattern at `~/.claude/skills/CANONICAL-PATTERN.md` to IFleet's current implementation. This is the living traceability doc; update whenever IFleet's substrate changes.

## How to read this

Each row is one canonical-pattern phase. "Status" indicates whether IFleet's implementation conforms (✅), partially conforms (⚠️ with notes), or doesn't yet exist (❌).

## Phase mapping

| Canonical phase | IFleet implementation | File / component | Status |
|---|---|---|---|
| Ingest project context | classifier reads target-repo `SECURITY.md` keywords for risk flags | `src/classifier/auto-router.ts` | ⚠️ partial — does not yet read NON_GOALS.md or ARCHITECTURE.md per canonical Section 2; tracked as separate work item |
| Plan + split | GitHub Issues queue with label-driven routing dispatches each issue as one single-trace sprint | `src/queue/github.ts`, `src/orchestrator/` | ✅ |
| Route to model | Canonical correctness-first matrix on scorer + routing.json rule paths; HIGH_KEYWORDS (auth/security/migration/payments) route architect to Opus per canonical §3.2 override #1. End-to-end alignment on `mode:*` and explicit category/severity label paths tracked as M4.6/M4.7/M4.8 in ADR-0004 §Known-Limitations | `src/classifier/index.ts`, `config/routing.json` | ⚠️ scoped ship M4.5 (2026-06-03, ADR-0004); follow-up gaps tracked |
| Code (Editor) | Editor role spawned per task, model chosen by routing | `src/workers/claude.ts`, `src/workers/codex.ts` | ✅ Sonnet floor enforced (mandatory rule 3) |
| Review (Diff-Reviewer + Plan-Reviewer) | 4-role pipeline: Architect → Plan-Reviewer → Editor → Diff-Reviewer | `src/pipeline/*` | ✅ shipped M2 (PR #132) |
| Test (CI gate) | typecheck + lint + test before draft PR opens | `src/verify/ci.ts`, `src/verify/playwright.ts` | ✅ shipped M1 |
| Fix (Doctor) | Doctor reads CI failure, proposes fix, max 2 retries | `src/pipeline/doctor.ts` | ✅ |
| Push | Branch push from isolated worktree | ComposioHQ/agent-orchestrator (adopted) | ✅ |
| Merge | Draft PR opens only on green CI; human merges (HITL per NON_GOALS Upgrade 6) | branch protection + manual merge | ✅ canonical-conformant (canonical does not require auto-merge; HITL is a valid implementation) |
| Learn — fingerprint dedup | `pr_decisions.fingerprint` column | `src/observability/` + M4 schema | ⚠️ M4 in flight (SPRINT.md) |
| Learn — rule drafting | not yet ported from manual `audit-rule-drafter.sh` | n/a | ❌ deferred — manual implementation is canonical reference |
| Learn — rejected gate | not yet ported from manual `audit-rejected-gate.sh` | n/a | ❌ deferred |
| Learn — reviewer prefs | M4 reviewer preference cards | `.ifleet/prefs/<reviewer>.json` (planned) | ⚠️ M4 in flight |

## Conformance summary

- Fully conformant phases: 7
- Partial conformance (in-flight implementation work or scoped-ship with tracked gaps): 4
- Not yet implemented (deferred to canonical-implementation): 2

## Tracked alignment work

- M4.6 — mode override category protection (prevent `mode:tdd|ulw|ralph|deslop` from demoting canonical-Opus assignments). See ADR-0004 §Known-Limitations.
- M4.7 — explicit `category:*` / `severity:*` label parsing in `src/queue/labels.ts` so canonical §3.2 overrides #1 and #2 are reachable via labels, not only via the HIGH_KEYWORDS scorer. See ADR-0004 §Known-Limitations.
- M4.8 — reviewer derivation after mode overrides (preexisting bug surfaced by Phase C). See ADR-0004 §Known-Limitations.
- Read `<repo>/NON_GOALS.md` and `<repo>/docs/ARCHITECTURE.md` in classifier — TBD
- Port `audit-rule-drafter.sh` logic into IFleet — TBD post-M4
- Port `audit-rejected-gate.sh` registry — TBD post-M4
- Implement `audit-to-ifleet.sh` bridge script (lives in `~/.claude/scripts/`) — TBD

## See also

- `~/.claude/skills/CANONICAL-PATTERN.md` — the spec this doc traces against
- `docs/ARCHITECTURE.md` — IFleet's own architecture (implementation detail)
- `docs/MODEL-ROUTING.md` — canonical correctness-first routing (post-M4.5; see [ADR-0004](adr/0004-canonical-routing-alignment.md))
- `ROADMAP.md` — milestone plan (M0-M6); M4.5 row marks the routing alignment
