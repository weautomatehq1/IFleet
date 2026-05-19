mode: deslop

# Clean up `src/workers/spawn-runner.ts` (parked AI scaffolding)

This file shipped from the parked Agent SDK spike. It contains:

- Dead exports never imported anywhere (`runStreamingLegacy`, helpers prefixed
  with `_unsafe`).
- Defensive validation for impossible inputs (e.g. asserting that the parsed
  JSON event is an object after we already JSON-parsed it).
- Multi-paragraph docstrings on internal helpers that nobody calls.
- Try/catch blocks that re-throw the same error after logging.

Plan a deletion-heavy diff that conforms to the repo's "no comments unless the
why is non-obvious / no defensive validation on internal callers" rule
(`~/.claude/CLAUDE.md`). Net lines should decrease.

## Acceptance

- All dead exports removed, confirmed via grep across the repo.
- No new abstractions; this is a clean-up pass.
- Every removal cites the rule it enforces in the PR body.
- Net change: at least −80 lines.
