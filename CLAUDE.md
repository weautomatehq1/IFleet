@AGENTS.md

# CLAUDE.md — Claude Code specific overrides

The `@AGENTS.md` import above pulls in all shared agent rules (identity, architecture rule, mandatory rules, project-specific). This file adds only Claude-Code-specific behaviors that Codex / Cursor / Aider don't share.

## Skills auto-load

- `superagent` (when designing sprint orchestration)
- `subagent-protocol` (when delegating to workers)
- `code-workflow` (mandatory phases A–F)
- `code-reviewer` agent (every block close)
