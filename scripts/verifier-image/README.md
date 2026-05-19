# verifier-image

Docker image scaffolding for the IFleet VerifierAgent (see [`src/agents/verifier/`](../../src/agents/verifier/) and [ADR-0002](../../docs/adr/0002-docker-verifier-sandbox.md)).

## Current state (M0.W1)

`Dockerfile.base` builds a no-op base image with the toolchain VerifierAgent will need (node 20, pnpm 9, git, build-essential). The image is not yet wired to a runtime — VerifierAgent uses `StubSandboxRunner` until M1.W2.

## Build

```bash
docker build -f scripts/verifier-image/Dockerfile.base -t ifleet-verifier:base scripts/verifier-image/
```

## What lands when

| Milestone | What gets added |
|---|---|
| M0.W1 (this commit) | Base image scaffold — toolchain only, no entrypoint |
| M1.W2 | Real entrypoint script: clone branch, pnpm install, build, typecheck, lint, test |
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
