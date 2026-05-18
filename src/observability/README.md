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

The orchestrator subscribes to these `OrchestratorEvent.kind` values and
routes them through `DiscordOut`:

| Event kind             | Adapter call                                            |
|------------------------|---------------------------------------------------------|
| `task.assigned`        | `postProgress(thread, '🟡 picked up — architect starting')` |
| `task.completed`       | `postCompleted(thread, payload.pr)`                     |
| `task.failed`          | `postFailed(thread, payload.error)`                     |
| `task.cancelled`       | `postProgress(thread, '🛑 cancelled')`                  |
| `architect.plan_ready` | `postPlanForApproval(thread, payload.plan)` *(new event — see T2 contract drift note in T5-done.md)* |

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
