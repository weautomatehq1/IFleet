# Architecture Decision Records

One file per decision. Filename: `NNNN-short-title.md`. Decisions are immutable — superseded ones link forward, never edited in place.

Format: Context → Decision → Consequences. ADRs answer "why this choice over alternatives", not "how to implement" (runbooks own that).

## Frontmatter template

Every ADR starts with a YAML frontmatter block (between `---` fences) so metadata is machine-readable and consistent across files. Paste-and-fill:

```yaml
---
Status: Proposed | Accepted | Deprecated | Superseded
Date: YYYY-MM-DD
Decider: Sebastian Puig
Supersedes: None | ADR-NNNN
Superseded-by: None | ADR-NNNN
Affects: <component / milestone / role this decision binds>
Extends: None | <path or ADR-NNNN this decision builds on>
---
```

Field notes:
- **Status** — `Accepted` once Sebastian signs off. `Amended YYYY-MM-DD` may be appended (e.g. `Accepted (Amended 2026-05-20)`) when a divergence correction lands without revising the decision itself.
- **Supersedes / Superseded-by** — both default to `None`. Set when an ADR replaces a prior one in either direction.
- **Affects** — the system surface the decision binds. Free-text, but specific (e.g. `VerifierAgent and downstream PR gate`, not `the codebase`).
- **Extends** — a path or ADR this decision builds on without replacing. Use when the ADR formalises behaviour of an existing module.

Frontmatter is in addition to (not a replacement for) the existing `**Status:** … **Decider:** …` lines in the body — those stay for human readers; the YAML is for tooling.

## Existing load-bearing decisions to capture as ADRs

- SprintManager emits events; queue bridge owns all GitHub I/O
- Single-seat Max-plan policy (no parallel sessions)
- Editor must be Sonnet floor
- Reviewer haiku cost-split gate
