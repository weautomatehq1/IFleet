# verifier-image

Docker image scaffolding for the IFleet VerifierAgent (see [`src/agents/verifier/`](../../src/agents/verifier/) and [ADR-0002](../../docs/adr/0002-docker-verifier-sandbox.md)).

## Current state (M1.W2)

`Dockerfile.base` builds a fully-wired base image with the toolchain and a real entrypoint (`entrypoint.sh` → `/usr/local/bin/ifleet-verify`). The entrypoint runs install → build → typecheck → lint → test with structured phase headers that `DockerSandboxRunner` and `eval-replay.ts` parse.

**Key implementation notes:**
- pnpm@9 installed via `npm install -g pnpm@9` (not corepack — corepack resolves pnpm@11 for repos without `packageManager` field; pnpm@11 requires Node 22)
- pnpm store pinned to `/home/verifier/.pnpm-store` via `pnpm config set` — keeps store out of the virtiofs-mounted `/work` volume (virtiofs ENOENT on concurrent copyfile)
- `node --test` glob expansion: entrypoint uses `shopt -s globstar` + bash array before handing files to node (Node 20 doesn't auto-expand globs in `--test`)

## Build

```bash
docker build -f scripts/verifier-image/Dockerfile.base -t ifleet-verifier:base scripts/verifier-image/
```

## What lands when

| Milestone | What gets added |
|---|---|
| M0.W1 | Base image scaffold — toolchain only, no-op CMD |
| M1.W2 (this PR) | Real entrypoint (`entrypoint.sh`): install → build → typecheck → lint → test |
| M1.W3 | Per-repo overlay images cached by `lockfile-hash` |
| M1.W4 | Invariant runner (Semgrep + ArchUnitTS) layered into the entrypoint |
| M4 | Behavioral fingerprint capture (OpenAPI / Prisma / Playwright / trace shape) |

## Why a separate image (not host execution)

Per ADR-0002:
- Isolation from host state — flaky tests caused by host filesystem don't recur
- Deterministic replay — needed for the shadow eval gate in Upgrade 10
- Untrusted-code safety — required before any client repo runs through IFleet

## Resource limits

Defaults from ADR-0002 / `sandbox.ts`:
- Memory: 4096 MB
- Wall clock: 600 s (10 min) — SIGKILL after
- CPU: unlimited (revisit if Docker daemon contention hits >50 sprints/day)

## See also

- [`docs/elevation/upgrades/01-verifier.md`](../../docs/elevation/upgrades/01-verifier.md) — full upgrade spec
- [`src/agents/verifier/sandbox.ts`](../../src/agents/verifier/sandbox.ts) — runner that invokes this image
