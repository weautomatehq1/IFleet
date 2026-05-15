# Architecture Decision Records

One file per decision. Filename: `NNNN-short-title.md`. Decisions are immutable — superseded ones link forward, never edited in place.

Format: Context → Decision → Consequences. ADRs answer "why this choice over alternatives", not "how to implement" (runbooks own that).

Existing load-bearing decisions to capture as ADRs:
- SprintManager emits events; queue bridge owns all GitHub I/O
- Single-seat Max-plan policy (no parallel sessions)
- Editor must be Sonnet floor
- Reviewer haiku cost-split gate
