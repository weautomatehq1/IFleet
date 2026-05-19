# Example briefs — one per sprint mode

These are seed examples used by the Haiku auto-router as in-context references
and by humans skimming the modes. Each file corresponds to one of the four
named modes (`ralph`, `ulw`, `tdd`, `deslop`). `standard` is the no-op default
and has no example — write a normal brief without a `mode:` tag.

| File | Mode | When to pick it |
|---|---|---|
| `ralph.md` | `ralph` | Flaky test or intermittent bug — keep retrying until verify is green. |
| `ulw.md` | `ulw` | Multi-file refactor with independent edits — parallel-safe. |
| `tdd.md` | `tdd` | New behavior that must be test-first. |
| `deslop.md` | `deslop` | AI-generated boilerplate that needs to be cleaned to repo conventions. |
