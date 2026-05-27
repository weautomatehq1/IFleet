# `src/observability/`

Two posting surfaces live here:

| File                          | Purpose                                                                              |
|-------------------------------|--------------------------------------------------------------------------------------|
| `discord.ts`                  | Status-card reducer + buffered formatter (used by the `/status` slash command).      |
| `discord-output.ts`           | `DiscordOut` adapter — per-task threads, embeds, button approvals.                   |
| `channel-router-bridge.ts`    | Resolves `QueuedTask` → destination channel (uses `T4`'s `ChannelRouter`).           |
| `task-done-notify.ts`         | Legacy task-done webhook (kept for the `discord-bot`-less path; unchanged by T5).    |

## DiscordOut adapter

`DiscordOutAdapter` implements [`src/contracts/discord-out.ts`](../contracts/discord-out.ts).
Construction takes:

```ts
new DiscordOutAdapter({
  client,                                     // discord.js Client (T1's singleton)
  router,                                     // ChannelRouter from T4
  fallbackChannelId: env.DISCORD_FALLBACK_CHANNEL_ID,
});
```

### Behaviour

- **GitHub-sourced task** → posts an anchor embed in the repo's mapped
  channel, then opens a thread off that anchor.
- **Discord-sourced task** → opens a thread directly off the user's origin
  message (`task.source.messageId`), so the user sees their command and the
  thread side-by-side on mobile.
- **No route found** → falls back to `DISCORD_FALLBACK_CHANNEL_ID`. If that
  env is unset too, logs `warn` and drops; never throws.
- **Discord outage** → every `await` is wrapped in try/catch. Failures log
  via the injected `log` callback (defaults to `console.warn`) and resolve
  with empty results so the orchestrator's tick loop is never broken.

### Button `customId` format (consumed by T1)

The plan-approval embed publishes three buttons. T1's `interactionCreate`
handler parses the customId via `parseCustomId()` from
[`src/contracts/discord-out.ts`](../contracts/discord-out.ts).

| customId            | Meaning                              |
|---------------------|--------------------------------------|
| `approve:<taskId>`  | User approved the architect plan     |
| `reject:<taskId>`   | User rejected the plan (rework)      |
| `cancel:<taskId>`   | User cancelled the whole task        |

`<taskId>` is the unified `QueuedTask.id` (ULID) — shorter than the Discord
threadId and lookup-able in O(1) via `store.getById(taskId)`. When the
adapter has not seen the thread before (no `postTaskCreated` / no
`bindThreadToTask` call), it falls back to `<verb>:<threadId>` so T1 can
still recover via `store.list({channelId: threadId})`.

### Supported orchestrator events

The orchestrator (`src/orchestrator/index.ts:dispatchToDiscord`) subscribes
to these `OrchestratorEvent.kind` values and routes them through
`DiscordOut`:

| Event kind             | Adapter call                                            | Routed by |
|------------------------|---------------------------------------------------------|-----------|
| `task.completed`       | `postCompleted(thread, payload.pr)`                     | `Orchestrator.dispatchToDiscord` |
| `task.failed`          | `postFailed(thread, payload.error)`                     | `Orchestrator.dispatchToDiscord` |
| `task.cancelled`       | `postProgress(thread, '🛑 cancelled')`                  | `Orchestrator.dispatchToDiscord` |
| `task.assigned`        | `postProgress(thread, '🟡 picked up — architect starting')` | `daemon.ts:wireSprintCompletion` (re-reads the task so a thread created post-ingest is picked up) |
| `architect.plan_ready` | `postPlanForApproval(thread, payload.plan)`             | pipeline `onArchitectPlan` callback in `daemon.ts:wrapFactoryWithApprovalAndEmit` |

> **Routing note:** `task.assigned` is intentionally NOT handled by
> `Orchestrator.dispatchToDiscord` — that handler short-circuits before
> thread resolution for any event kind it doesn't post per-task, so it
> doesn't waste a `postTaskCreated` / `bindThreadToTask` call. The daemon's
> `wireSprintCompletion` owns the picked-up message because it can re-read
> the task after `discordSource.ingest()` opens the thread. See
> `AUDIT-IFleet-b3fdcf22` / `c2feb878` / `6d692d64` for history.

Other event kinds (`ratelimit.observed`, `sprint.*`, `task.capability_blocked`)
are intentionally NOT routed per task — they belong on the sprint-level
status card and are handled by `task-done-notify.ts` / the legacy webhook.

### Status badge convention

`STATUS_BADGE` constants (exported from `discord-output.ts`):

| Badge | Meaning            |
|-------|--------------------|
| 🟡    | picked / queued    |
| 🔵    | building           |
| 🟢    | done               |
| 🔴    | failed             |
| 🛑    | cancelled          |
| ⏸     | paused (rate limit)|

### File attachment threshold

Plans longer than `PLAN_ATTACHMENT_THRESHOLD` (3800 chars) are posted with a
400-char preview embed plus the full plan attached as `plan.md`. This keeps
mobile rendering clean while preserving full fidelity.
