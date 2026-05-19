# Upgrade 4 — Behavioral fingerprinting

**Month:** M4 (ship with Upgrade 5) | **Depends on:** Upgrade 1 (verifier exists), Upgrade 3 (KG for impact scoping) | **KPI:** 50% of merged PRs have fingerprint diff attached

## What it does

Before and after the editor runs, the Verifier (M1) takes a **behavioral snapshot** of the affected surfaces:
- OpenAPI spec hash + breaking-change diff
- Prisma schema hash + destructive change detection
- Playwright screenshot hash per changed UI route
- Golden-request response-shape hash for affected endpoints

PR opens with label `breaking: true | false | unknown` and the fingerprint diff attached. Regression detection becomes deterministic instead of vibes-based.

## Why it matters

AgentAssay (2026) reports behavioral fingerprinting catches 86% of regressions where binary pass/fail catches 0%. Tests pass but behavior changed — that's the gap fingerprinting closes.

This is also the foundation for "auto-revert on regression" (future, post-M6) and for client-facing assurances in the Operating Standard.

## Integration into IFleet

Extends Verifier from M1 — same `verifier_runs` table, two new JSON columns: `fingerprint_before` and `fingerprint_after`.

Reuses existing `src/verify/screenshot.ts` for UI screenshots (already in the codebase).

**Files added in M4:**

```
src/agents/verifier/fingerprint/
├── index.ts              # Orchestrate all 4 fingerprint types
├── openapi.ts            # Generate OpenAPI from routes; diff with oasdiff or Optic
├── schema.ts             # Prisma schema hash + destructive change detection
├── ui.ts                 # Playwright per-route screenshot + perceptual hash
└── trace.ts              # Run N golden requests, hash response shape
```

## Data model

No new tables. Two columns on `verifier_runs`:

```json
{
  "openapi": {
    "hash": "sha256:abc...",
    "breaking_changes": [
      "DELETE /v1/users — now requires role=admin"
    ],
    "added_endpoints": ["GET /v1/users/{id}/audit"],
    "removed_endpoints": []
  },
  "schema": {
    "hash": "sha256:def...",
    "destructive": false,
    "added_tables": [], "removed_tables": [],
    "added_columns": ["users.last_seen_at"],
    "removed_columns": [],
    "type_changes": []
  },
  "ui_routes": {
    "/dashboard": { "hash": "sha256:...", "diff_pct": 0.02 },
    "/billing":   { "hash": "sha256:...", "diff_pct": 0.18 }
  },
  "traces": {
    "GET /api/users":  { "status": 200, "shape_hash": "sha256:..." },
    "POST /api/auth":  { "status": 200, "shape_hash": "sha256:..." }
  }
}
```

## Pipeline step

**Before editor runs** (`editor.started`): Verifier captures `fingerprint_before` against `main` HEAD.

**After verifier passes** (`verifier.passed`): captures `fingerprint_after` against the editor's branch.

**Diff computation:** comparison runs in the sandbox, results posted to PR description as a collapsible section.

## Discord interface

PR-opened message in Discord gets a labeled banner:

```
✅ PR #234 opened — sebs/IFleet
breaking: false
fingerprint: OpenAPI clean, schema +1 col, UI changed (/billing 18%)
```

For `breaking: true`, the banner is red and pings the channel.

## Failure modes

| Failure | Handling |
|---|---|
| No OpenAPI spec in repo | Skip OpenAPI fingerprint, mark `openapi: not_applicable` |
| Prisma not in repo | Skip schema fingerprint |
| No Playwright tests | Skip UI fingerprint |
| Golden requests fail to run | Skip trace fingerprint, log |
| Fingerprint timeout (>2 min per type) | Mark partial, continue |

## Implementation order

Shared with Upgrade 5 (PR rejection learning). M4 is "one month, two ships."

| Week | Deliverable |
|---|---|
| W1 | OpenAPI diff (use [oasdiff](https://github.com/oasdiff/oasdiff) or Optic). Prisma schema diff. |
| W2 | UI screenshot diff (Playwright + perceptual hash like pHash). |
| W3 | Trace shape diff. PR description integration. |
| W4 | Ship with Upgrade 5 (PR rejection learning) in same release. |

## Tool choices

- **OpenAPI diff:** [oasdiff](https://github.com/oasdiff/oasdiff) (Go, fast, has breaking-change detection). Alternative: [Optic](https://useoptic.com).
- **Prisma diff:** `prisma migrate diff --from-* --to-* --script` then parse SQL.
- **Image diff:** [pixelmatch](https://github.com/mapbox/pixelmatch) or [odiff](https://github.com/dmtrKovalenko/odiff) for perceptual hash.
- **Trace shape:** custom — recursive JSON shape extraction, SHA256.

## Verification (Definition of Done for M4 fingerprinting)

- 10 eval-set tasks replayed. Each gets a `breaking: true|false|unknown` label.
- At least 1 task in eval set has a true `breaking: true` (validated by reading the PR description manually).
- Average fingerprint computation <90 seconds per task.
- PR description has a readable collapsible "Fingerprint diff" section.

## References

- [AgentAssay: Token-Efficient Regression Testing](https://arxiv.org/html/2603.02601v1)
- [oasdiff](https://github.com/oasdiff/oasdiff)
- [Optic OpenAPI Diff](https://useoptic.com/docs/diff-openapi)
- [TestSprite Contract Testing](https://www.testsprite.com/use-cases/en/contract-testing)
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)
