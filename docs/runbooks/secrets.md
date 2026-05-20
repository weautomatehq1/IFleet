# Runbook — verify-env secrets

**Audience:** IFleet operators (Seb, Esme)
**Last updated:** 2026-05-19
**Related:** `docs/adr/0002-docker-verifier-sandbox.md`, `docs/elevation/upgrades/01-verifier.md`

## What this is

The Docker verifier sandbox needs secrets (GitHub tokens, Discord IDs) to run test suites in target repos. These are stored as dotenv files in `.ifleet/verify-env/` on the operator's machine — gitignored, never committed, mounted into the container at run time via `docker run --env-file`.

## When to create a verify-env file

Create one when:
- You trigger `/verify <taskId>` and the verifier reports `verify-env: not configured`
- You're onboarding a new repo whose test suite reads secrets from the environment
- Tests fail with `missing token` / `unauthorized` errors that only appear inside the sandbox

## How to create one

1. Copy the example:
   ```sh
   cp deploy/env.verify.example .ifleet/verify-env/<repoId>.env
   ```
   Where `<repoId>` is derived from the GitHub URL: `owner/repo` → `owner_repo`.
   Example: `weautomatehq1/IFleet` → `weautomatehq1_IFleet`

2. Fill in the values with **read-only credentials** (see scoping rules below).

3. Verify it's gitignored before anything else:
   ```sh
   echo "TEST=1" > .ifleet/verify-env/<repoId>.env
   git status   # must NOT show the file
   rm .ifleet/verify-env/<repoId>.env
   ```

4. Write the real values, then run a smoke test:
   ```sh
   docker run --rm \
     --env-file .ifleet/verify-env/<repoId>.env \
     ifleet-verifier:base \
     bash -c 'echo $GITHUB_TOKEN | cut -c1-10'
   ```
   Expected: first 10 chars of the token, nothing else. If you see the full token echoed — fine, this is a local sanity check. But never run this in a shared terminal session.

## Scoping rules — GitHub PAT

- **Scope: read-only.** Enable `contents: read` and `pull_requests: read` only.
- **Never enable write scopes** (`contents: write`, `issues: write`, `admin`, `delete_repo`).
- Limit to the specific repos under test (fine-grained PAT preferred over classic PAT).
- Token prefix `github_pat_` (fine-grained) is preferred over `ghp_` (classic).
- Label the token in GitHub as `ifleet-verify-<repoId>` so you can find and revoke it.

## How to rotate

1. In GitHub → Settings → Developer settings → Personal access tokens, revoke the old token.
2. Create a new token with the same (read-only) scopes.
3. Update `.ifleet/verify-env/<repoId>.env` in place.
4. No restart required — the env file is read at `docker run` time, not at daemon start.

## Why not Supabase / 1Password?

Out of scope for v1. The control plane is single-operator (Seb + Esme on one machine), so a local gitignored file has the same security posture as a local secret manager without the integration surface. Future work: integrate with the VPS secrets manager when IFleet moves to multi-operator.

## ACL gate (future)

Per ADR-0002, access to verify-env files should eventually be gated by `allowedUserIds` at the Discord queue layer — so only listed Discord users can trigger a `/verify` that mounts secrets. This gate is **not implemented in v1**. Until it is, `/verify` is implicitly restricted to anyone who can send commands to the IFleet Discord channel.

See: `docs/adr/0002-docker-verifier-sandbox.md` failure-mode table, row "Repo needs secrets in tests".
