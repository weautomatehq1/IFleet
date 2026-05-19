# Brief library

Real-world example briefs derived from shipped IFleet sprints. Each file is one self-contained brief in the format the classifier and architect consume.

## Frontmatter shape

```yaml
---
id: <kebab-case slug, unique>
title: <one-line conventional commit-style title>
mode: ralph | ulw | tdd | deslop | default
tags: [feature | bugfix | refactor | docs | test | chore | security, ...]
source: <originating GitHub issue number, optional>
---
```

After frontmatter the body is plain markdown: problem, acceptance criteria, and (when useful) out-of-scope.

## Modes

| Mode | When to pick |
|---|---|
| `ralph` | bug / broken / persistence loop until green |
| `ulw` | multi-file refactor or feature touching 4+ files |
| `tdd` | tests-first changes, behaviour-driven |
| `deslop` | clean up dead code, comments, drift |
| `default` | normal single-area changes |

## How to use these

- Treat them as templates — copy the structure, replace the content.
- The classifier and learnings system read this directory at architect phase to build few-shot examples.
- One file per brief, kebab-case names, ≤ 60 lines each.
