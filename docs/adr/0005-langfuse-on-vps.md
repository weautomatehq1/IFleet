---
Status: Proposed
Date: 2026-06-03
Decider: Sebastian Puig
Supersedes: None
Superseded-by: None
Affects: P1 Observability (docs/implementation_plan_2026_05_21.md), src/orchestrator/**, src/agents/**, deploy/
Extends: ADR-0001 (single-trace architecture)
---

> **Numbering note:** The locked plan and this session's T5 handoff both referred to this ADR as "ADR-0004". That slot was taken by `docs/adr/0004-canonical-routing-alignment.md` on 2026-06-03 (the M4.5 Phase C migration). This ADR is therefore filed as ADR-0005. No content change implied.

# ADR-0005 — Langfuse on Hostinger VPS for Phase P1 Observability

**Status:** Proposed (2026-06-03)
**Decider:** Sebastian Puig
**Supersedes:** None
**Extends:** ADR-0001 (single shared trace — Langfuse is the persistence + UI for that trace, not a competing model)

## Context

Phase P1 of the locked plan (`docs/implementation_plan_2026_05_21.md`) puts observability first: *"Langfuse on VPS, ccusage + monitor, 1h prompt cache, A/B eval-replay baseline. Cameras first so every later phase is measurable."* Nothing in P2–P7 is decidable without it. P2 cannot tell whether folding audit-elevation into the fleet moves the needle. P3b cannot answer "did skip-reasons get cheaper to act on?" P4's verifier sharpening has no signal to tune against. P5 memory-and-skills work is unmeasurable. The metric Sebastian set — minutes-of-attention per shipped PR — requires per-task cost, latency, error, and reviewer-divergence numbers. Today the fleet has none of that on a dashboard. The SQLite store in `src/orchestrator/store.ts` holds `TraceEvent` rows (ADR-0001) but there is no UI, no aggregation, no per-role token accounting, and no way to compare runs A/B.

Three things make this the right moment:

1. **ADR-0001 already locked the trace shape.** Every role appends to a single trace. That is the exact shape Langfuse v3 ingests (`trace → observations → spans`). There is no schema redesign — Langfuse is a downstream consumer of `TraceEvent`, not a replacement for it.
2. **The 1-hour prompt cache changes the cost-math.** Anthropic's prompt cache went from 5-minute to 1-hour (paid option). The locked plan enables it in P1. Without observability we cannot tell whether the longer cache is paying for itself; with it, cache hit rate, cost-per-task, and per-role spend land on the same dashboard.
3. **Hostinger VPS already runs the fleet.** PM2 + nginx are in place. Adding a Docker Compose stack alongside (separate vhost, separate ports) is cheaper than spinning up a new host and re-doing the operational baseline.

The decision Sebastian needs from this ADR: **self-host Langfuse on the existing VPS, or use Langfuse Cloud free tier as a bring-up shortcut.** Both are real choices. The recommendation lives in *Decision*.

## Options considered

### A. Self-host Langfuse v3 on the Hostinger VPS

Langfuse v3 (`langfuse/langfuse:3`) is a multi-service stack (Web + Worker + Postgres + ClickHouse + Redis, plus an optional-upstream-but-enabled-here S3-compatible blob store):

- **Langfuse Web** — the API + UI (Next.js).
- **Langfuse Worker** — async ingestion + cost calculation.
- **Postgres** — operational metadata (users, projects, API keys, prompts).
- **ClickHouse** — high-volume event store (traces, observations, scores).
- **Redis** — queue + cache between Web and Worker.
- **S3-compatible blob store** for full event payloads. Optional in upstream Langfuse, but **enabled by default in our skeleton** (Minio sidecar; see the deploy section below) because v3 starts dropping large prompt/tool-output payloads from ClickHouse once blob upload is unavailable, and we want the full payloads on disk from event #1.

Resource floor (Langfuse self-host docs): ~4 GB RAM for ClickHouse alone in low-traffic mode, plus ~1 GB for Web + Worker + Postgres + Redis. At IFleet's volume (5–15 tasks/day, each producing tens of events) this is comfortably over-provisioned for years.

VPS realities (`~/dev/ai-products/IFleet/docs/project_ifleet_vps_deployment.md`):

- nginx vhost serves IFleet today (port 80/443 terminated by nginx → PM2 services).
- `arca` is a friend's project on the same box — `arca.conf` nginx vhost, PM2 entries named `arca`, port 3000, `/var/www/arca`. **Off-limits.** Any port/path picked here must route around `arca`, never displace it.
- Hostinger plan headroom: **unknown today — see open decision (1) below**.

Pros:
- All trace data stays on the same box as the fleet — no PII / customer-issue text leaves the network.
- No event-volume cap (Langfuse Cloud free tier is 50k events/month; the audit pipeline alone could hit that during heavy sprints).
- Pairs naturally with ADR-0001's single-trace architecture: the same Postgres dump that backs up `store.ts` can sit next to a Langfuse Postgres dump on the same backup schedule.
- Pairs naturally with ADR-0002's Docker sandbox — the verifier already runs Docker on the VPS, so the operational story is "we already do Docker here".
- Cost: roughly the VPS bill we already pay, plus headroom for ClickHouse RAM.

Cons:
- Operational burden: four more services to keep alive. PM2 doesn't manage them; Docker Compose does. That is a new failure mode on a host that previously had one.
- ClickHouse is unfamiliar territory. If it OOMs we lose observability at the exact moment we most need it (i.e. during a fleet incident).
- Upgrades: Langfuse moves quickly. Pinning helps but rebases on `langfuse/langfuse:3` will need a deliberate cadence.

### B. Langfuse Cloud free tier

The Langfuse-hosted SaaS offering at `cloud.langfuse.com`. Free tier covers ~50k events/month and a small number of users.

Pros:
- Zero ops burden — Langfuse runs the full service stack.
- Same SDK and dashboard as self-host, so the bring-up code on the IFleet side is identical and a later migration is a config flip on the SDK base URL.
- Fastest path to seeing trace + cost + latency for the fleet.

Cons:
- 50k events/month is plausibly insufficient at fleet scale. P2 (audit integration, 3 weeks, 4-of-8 PRs touching protected paths) will multiply observed events sharply.
- Trace payloads include prompts and tool inputs/outputs — for a fleet that handles arbitrary repository contents this is a real data-egress concern, even on a public open-source repo.
- The locked plan explicitly says "Langfuse on VPS" — Cloud would be a soft revision of that lock and should be recorded as such if chosen.

### C. Roll our own (Postgres logs + handmade dashboard)

Log `TraceEvent` rows + add a Grafana board against the same Postgres.

Pros:
- No new infrastructure. No new vendor.
- Total control over schema.

Cons:
- We re-build what Langfuse already gives away: per-span cost calculation, prompt diffing, scoring, eval-set replay UI, latency histograms, trace search.
- Operational cost we do not get back: every dashboard we did not need to build is a week of Sebastian's attention burned on plumbing instead of fleet quality.
- This is the option that violates "cameras first so every later phase is measurable" — we would be paying camera-building time in the phase whose purpose is *not* building cameras.

## Decision

**Recommend: Option A — self-host Langfuse v3 on the Hostinger VPS, contingent on Decision-1 below (VPS RAM headroom ≥ 4 GB free for ClickHouse).**

Rationale:

1. The locked plan explicitly says self-host on VPS. The supersedure protocol (ADR / project memory) requires that diverging from a locked plan get an explicit decision; the burden of proof is on the alternative.
2. The 50k-event ceiling on Cloud free tier is plausibly the wrong shape for a fleet whose whole point is to dispatch many parallel runs (P2 audit integration alone is a candidate to blow past it).
3. The data-stays-on-VPS property matters more than it looks. Audit findings include code diffs and prompts that touch private branches; even on a public repo, traces are richer than the PRs they produce.
4. Option C is rejected for the reason it was rejected at the planning layer: it spends the camera-building budget on building cameras instead of using them.

**Fallback to Option B (Cloud) is one config flip.** If Decision-1 returns "VPS cannot host ClickHouse safely", or if bring-up takes longer than a week, switch the SDK base URL to `cloud.langfuse.com`, ship P1 against the free tier, and re-evaluate at the P1 → P2 checkpoint.

**Option C is explicitly rejected.** Do not roll our own.

## Decisions still open for Sebastian (load-bearing)

1. **VPS RAM headroom.** Hostinger plan size and current RAM utilisation must be confirmed before bring-up. ClickHouse needs ≥ 4 GB headroom; if the current VPS is sized for IFleet + `arca` only, an upgrade may be required. This is the only decision that can flip the recommendation from A to B.
2. **Self-host vs Langfuse Cloud free tier.** If Decision-1 lands "no headroom and no upgrade", this defaults to B. Otherwise default to A per *Decision* above.
3. **1-hour prompt cache enable.** The locked plan says yes; the cost-impact is invisible without Langfuse running. Enable cache and Langfuse in the same change so the cache impact lands on the dashboard from event #1 rather than retroactively.

## Consequences

**Codebase changes (sized, not specced — that's P1.W1 work):**

- `src/orchestrator/**` — add a Langfuse client init at SprintManager startup. The client wraps every `TraceEvent` append in a Langfuse `span` so events land in both SQLite and Langfuse. SQLite remains the source of truth per ADR-0001; Langfuse is the read-side projection.
- `src/agents/**` — each role wraps its work in a Langfuse-named span (`role: 'architect'`, `role: 'editor'`, …) so the dashboard slices by role naturally. No behavioural change — the trace shape is already there.
- `src/verify/**` — verifier outputs (build pass/fail, test counts) attach as Langfuse `scores` on the parent trace. This is the A/B-eval-replay baseline the locked plan calls for.
- `config/` — Langfuse base URL, public key, secret key as env vars. Per project policy, secrets live in PM2 env and are not committed.

**Deploy changes:**

- `deploy/langfuse/docker-compose.yml` — skeleton already on `main` (shipped in PR #156). This ADR ratifies the design choices already encoded there: port table, internal-only services, and the always-on Minio sidecar (see the "Minio is enabled by default in the skeleton" line below for why it's not behind a Compose profile).
- `deploy/langfuse/README.md` — port table, env-var checklist, "where the nginx vhost goes when you green-light bring-up". Already on `main` alongside the compose file.
- nginx — a new vhost `langfuse.<domain>` terminates TLS for the UI. **Not yet implemented.** Captured here so the future PR has a defined surface; the README in `deploy/langfuse/` already names the file path (`nginx/langfuse.conf`) where the vhost will land.

**Monitoring changes:**

- ccusage + monitor (other P1 items in the locked plan) write to the same Langfuse project so the cost-per-task view lives in one place.
- The existing PM2 monitoring continues unchanged — Langfuse does not replace process supervision.

**Reversibility:**

- A → B: change SDK base URL, redirect events to Cloud. ~1 hour. Trace history on self-host stays in ClickHouse for the post-mortem; new traces flow to Cloud.
- B → A: same flip in reverse. Trace history on Cloud stays in Cloud.
- A → C: rejected, do not implement.

## VPS-collision notes (load-bearing)

The Hostinger VPS at `root@187.124.77.142` is a shared host. The following invariants are not negotiable:

- **`arca` namespace is off-limits.** `arca.conf` (nginx vhost), PM2 entries named `arca`, port `3000`, and `/var/www/arca` belong to Sebastian's friend's project. Any port/path conflict is resolved by *this stack* moving, not `arca`.
- **Ports chosen for the skeleton (see `deploy/langfuse/README.md` for the canonical table):**
  - `127.0.0.1:3010` — Langfuse Web UI bound to loopback only, behind a future nginx vhost (`langfuse.weautomatehq.cloud`). **Not 3000** — `arca` owns 3000.
  - Postgres, ClickHouse, Redis, Worker, Minio — **internal Docker network only.** Not published to the host. If a future operator needs psql/clickhouse-client access they `docker compose exec`.
  - Minio is enabled by default in the skeleton (Langfuse v3 uses S3-compatible blob storage for full event payloads); it stays on the internal network rather than publishing the well-known `9000`/`9001` pair to the host.
- **Nginx vhost.** New vhost lives at `nginx/conf.d/langfuse.conf` (when the bring-up PR ships). Do not edit `arca.conf`. Do not edit existing IFleet vhosts to add a `location /langfuse` — separate vhost is cleaner and survives independent restarts.

## Links

- Locked plan: `docs/implementation_plan_2026_05_21.md` (Phase P1).
- ADR-0001 (single-trace architecture): `docs/adr/0001-single-trace-architecture.md` — Langfuse extends the persistence and UI of the same trace.
- ADR-0002 (Docker sandbox): `docs/adr/0002-docker-verifier-sandbox.md` — Docker already runs on the VPS; Langfuse Compose inherits that operational story.
- VPS deployment notes: `docs/project_ifleet_vps_deployment.md`.
- Skeleton compose + README: `deploy/langfuse/`.
- Langfuse self-hosting reference: [Langfuse self-hosting docs](https://langfuse.com/self-hosting). Pin to the v3 branch — v3 is the load-bearing major version for the architecture described here.
