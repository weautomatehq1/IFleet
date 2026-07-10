# `src/repos/` — Channel router & repo manager

Maps a Discord channel ID to a concrete git repo on disk, and owns the
clone / worktree lifecycle the pipeline uses.

- **`router.ts`** — `FileChannelRouter` loads `config/channels.json` and
  exposes the `ChannelRouter` contract (`resolve`, `list`).
- **`manager.ts`** — `GitRepoManager` implements clone-on-demand, per-task
  worktree allocation, and release.
- **`health.ts`** — `RepoHealthChecker` probes each mapped repo via
  `git ls-remote` and reports `{ reachable, cloned, lastFetched }`.

The shared contracts live in `src/contracts/channel-router.ts` (additive
only — other terminals consume the same shape).

> ⚠️ **Config duplication, intentional for now.** `config/channels.json`
> (this directory's input) and `config/repos.json` (used by the legacy queue
> in `src/queue/config.ts`) both enumerate repos with partial overlap.
> Unifying them is out of scope for this cleanup pass — flagged here so the
> next refactor knows to consolidate. See reviewer notes in
> `~/.omc/splits/20260518-0900-cleanup-pass/MASTER.md`.

## Adding a new channel

1. Append an entry to `config/channels.json`:
   ```jsonc
   {
     "channelId": "<discord snowflake>",
     "name": "<short label>",
     "repo": "<owner/name>",
     "defaultBranch": "main",
     "defaultModel": "opus" | "sonnet" | "haiku",
     "allowedUserIds": ["<discord user id>", ...],
     "codeowners": ["@github-handle", ...]
   }
   ```
2. Make sure the GitHub repo exists and the `GITHUB_TOKEN` fine-grained PAT
   has Contents + Metadata write access to it.
3. Run `pnpm channels:health` — must show `reachable: true` for the new row.
4. Commit the JSON change. No code change required.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT (Contents + Metadata write, weautomatehq1 org) | _required for private repos_ |
| `IFLEET_REPOS_DIR` | Where canonical clones + worktrees live on the VPS | `/opt/ifleet/repos` |
| `IFLEET_CHANNELS_CONFIG` | Override the channels file path (used by tests / staging) | `config/channels.json` |

The token is passed inline per `git` invocation via
`-c http.https://github.com/.extraheader=AUTHORIZATION: bearer <token>` — it is
**never** written to `.git/config`. It is, however, visible to other local
processes via `ps`; this is acceptable on a dedicated VPS.

## Layout on disk

```
/opt/ifleet/repos/
└── weautomatehq1-IFleet/
    ├── main/                         # canonical clone, branch=main
    └── worktrees/
        ├── task-01HXYZ.../           # checkout of ifleet/task-01HXYZ...
        └── task-01HXYW.../
```

`allocateWorktree({ taskId })` returns `{ path, branch }` and that `path`
goes into `PipelineInput.worktreePath`. `releaseWorktree` is idempotent and
also drops the local branch if it has no upstream.

## Disk space

Budget ~1 GB per repo (clone + a few concurrent worktrees). With the three
channels seeded today that's ~3 GB headroom. Flag if any single repo grows
past ~2 GB cloned — that's the signal to switch to `--filter=blob:none`
partial clones.

T3 must ensure `/opt/ifleet/repos/` exists (and is writable by the PM2 user)
in the install script.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `fatal: Authentication failed` from `pnpm channels:health` | `GITHUB_TOKEN` unset / expired / lacks scope | Rotate PAT, set `GITHUB_TOKEN` in `/etc/environment`, restart pm2 |
| `Repository not found` | Repo doesn't exist or PAT not scoped to the owner | Create the repo, or extend PAT scope to the org |
| `releaseWorktree` leaves a dirty dir | Editor process held an open file handle | Manager force-removes the worktree and falls back to `rm -rf` — re-run release |
| `git worktree add … already exists` | A previous task crashed mid-allocation | `releaseWorktree({ taskId })` is idempotent; safe to call before retry |
| `ENOSPC` during `ensureClone` | Disk full | Run `df -h /opt/ifleet/repos`, prune old worktrees via `git -C <canonical> worktree prune` |

## Stubs / TODO

- Hot reload of `channels.json` (file watcher) — defer until we add a 4th channel.
- Garbage collection of stale worktrees (> 7 days, no associated open task) —
  belongs in a periodic job once T2's task store is wired.
- Partial clones (`--filter=blob:none`) once any repo exceeds ~2 GB.
