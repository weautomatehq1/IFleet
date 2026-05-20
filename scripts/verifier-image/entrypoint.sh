#!/usr/bin/env bash
# IFleet verifier entrypoint — future-ready script for DockerSandboxRunner.
#
# Security: NEVER set -x, echo $VAR, printenv, or env in this script.
# --env-file from .ifleet/verify-env/<repoId>.env mounts secrets into the
# container environment. Bash xtrace would leak them into docker logs.
set -euo pipefail
set +x  # Explicit guard: xtrace off even if caller enabled it

if [[ ! -f /work/package.json ]]; then
  echo "ERROR: /work/package.json not found — worktree mount failed" >&2
  exit 1
fi

cd /work

PHASE="${1:-}"
shift || true

case "$PHASE" in
  install)
    exec pnpm install --frozen-lockfile --prefer-offline --store-dir /root/.pnpm-store "$@"
    ;;
  build|typecheck|lint|test)
    exec pnpm run "$PHASE" "$@"
    ;;
  "")
    echo "ERROR: no phase argument supplied" >&2
    echo "Usage: entrypoint.sh <install|build|typecheck|lint|test>" >&2
    exit 2
    ;;
  *)
    echo "ERROR: unknown phase '$PHASE'" >&2
    exit 2
    ;;
esac
