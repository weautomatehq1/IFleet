# ADR-0002 — Docker sandbox for verifier

**Status:** Accepted (2026-05-19)
**Decider:** Sebastian Puig
**Supersedes:** None (extends `src/verify/`)

## Context

IFleet's existing `src/verify/` (ci.ts, playwright.ts, runner.ts, screenshot.ts) runs verification **inside the worktree** as part of the editor session. This is sufficient for "did the build pass on my machine" but fails the closed-loop requirement:

- No isolation from host state (filesystem, env vars, network)
- No clean reset between runs (flaky test caused by prior artifact)
- Cannot run untrusted code from external contributors safely
- Cannot be replayed deterministically for the shadow eval (M0.U8)

The top of the SWE-Bench Verified leaderboard (87.6% Opus 4.7, 88.7% GPT-5.5) is dominated by systems that run agent actions inside Docker (OpenHands, SWE-agent). Epoch AI ran the entire SWE-Bench Verified set in 1 hour on 1 machine using Docker.

## Decision

**Per-repo ephemeral Docker sandbox for the new VerifierAgent. Existing `src/verify/` becomes pre-flight (in-worktree, fast) and the new VerifierAgent becomes the closed-loop gate (sandboxed, hard wall).**

Architecture:
```
editor.completed (branch SHA)
  → existing src/verify/ runs pre-flight in worktree (fast feedback to editor)
  → VerifierAgent.start(taskId, repoUrl, sha)
  → docker run --rm -v workdir:/work ifleet-verifier:<repo-fingerprint>
       (inside: install → build → typecheck → lint → test → invariants)
  → emit verifier.passed | verifier.failed (structured)
  → on failed: re-queue to editor with feedback (max 3 retries)
  → on passed: open PR with verification report attached
```

## Alternatives considered

1. **CI-only verification (no Docker, rely on GitHub Actions).** Rejected — too slow (no agent-side feedback loop), and CI runs after PR open, defeating the "verify before PR" requirement.
2. **microVMs (Firecracker / Chunk pattern).** Rejected for v1 — adds operational burden, no proven advantage over Docker at IFleet's scale. Revisit if we hit Docker daemon contention at 50+ sprints/day.
3. **Host-process verification (existing `src/verify/`).** Rejected as the *only* layer — security risk (untrusted code from issue prompts), non-deterministic (host state pollution). Kept as pre-flight layer.
4. **Cloud sandboxes (E2B, Modal).** Rejected — adds external dependency, network latency, and per-second pricing that conflicts with flat-rate plan policy.

## Image strategy

- Base image: `node:20-bookworm` + `pnpm@9` + `git` + `curl` + `python3` (for Python repos)
- Per-repo image: `ifleet-verifier:<repo-id>-<lockfile-hash>` — cached, rebuilt on lockfile change
- Build context: `scripts/verifier-image/` (Dockerfile.base + per-repo overlays)
- Cache mount: `~/.pnpm-store` mounted as Docker volume for fast installs

## Failure modes

| Failure | Handling |
|---|---|
| No test command in package.json | Fall back to build+lint+typecheck only, label PR `verified: partial` |
| Test flaky (>20% historical flake rate) | Track per-test in `verifier_runs.flake_rate`, ignore with banner in Discord |
| Sandbox runs >10 min | SIGKILL, mark `timeout`, surface cost in Discord |
| Repo needs secrets in tests | Mount `.env.verify` from control plane, scoped per repo, ACL'd to `allowedUserIds` |
| Docker daemon unreachable | Fallback to existing `src/verify/` with banner `sandbox: unavailable`; alert |
| OOM (large repos) | Cap container at 4GB RAM; if hit, label `verified: partial` + investigate |

## Consequences

**Positive:**
- Closed loop: agent sees deterministic exit codes and reruns
- Replayable for shadow eval (M0.U8)
- Untrusted-code-safe (preview env requirement for client repos)

**Negative:**
- Docker dependency on Hostinger VPS (already present for n8n? Verify)
- Image cache disk usage — ~500MB/repo × 17 repos = 8.5GB. Manageable.
- First-run cold start ~30-60s (npm install). Mitigated by pnpm-store cache mount.

## References

- [OpenHands Docker Sandbox docs](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox)
- [Epoch AI: SWE-bench Verified in 1 hour on 1 machine](https://epoch.ai/blog/swebench-docker)
- [Augment Code: AI Agent Pre-Merge Verification](https://www.augmentcode.com/guides/ai-agent-pre-merge-verification)
