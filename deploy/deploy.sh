#!/usr/bin/env bash
# Deploy IFleet to the VPS. Idempotent — safe to re-run.
#
# Required env:
#   IFLEET_VPS_HOST       — e.g. root@vps.example.com
#   IFLEET_VPS_PATH       — e.g. /opt/ifleet (target dir on VPS)
#
# Optional env:
#   RSYNC_EXTRA           — extra flags appended to rsync (e.g. --dry-run)
#
# Run from the repo root: `bash deploy/deploy.sh`

set -euo pipefail

: "${IFLEET_VPS_HOST:?set IFLEET_VPS_HOST=user@host}"
: "${IFLEET_VPS_PATH:=/opt/ifleet}"

RSYNC_FLAGS=(
  -avz
  --delete
  --exclude=node_modules
  --exclude=.git
  --exclude=.omc
  --exclude=state
  --exclude='.env*'
  --exclude='*.log'
  --exclude=coverage
  # CRITICAL: these paths are written by the running daemon on the VPS.
  # Including them in --delete would wipe active worktrees, fetched repos,
  # and the rolling PM2 logs mid-sprint.
  --exclude=repos
  --exclude=worktrees
  --exclude=logs
)

if [[ -n "${RSYNC_EXTRA:-}" ]]; then
  # shellcheck disable=SC2206
  RSYNC_FLAGS+=( ${RSYNC_EXTRA} )
fi

echo "[deploy] syncing repo → ${IFLEET_VPS_HOST}:${IFLEET_VPS_PATH}"
rsync "${RSYNC_FLAGS[@]}" \
  ./ \
  "${IFLEET_VPS_HOST}:${IFLEET_VPS_PATH}/"

echo "[deploy] installing dependencies + reloading PM2"
ssh "${IFLEET_VPS_HOST}" "
  set -euo pipefail
  cd '${IFLEET_VPS_PATH}'
  pnpm install --frozen-lockfile
  pm2 startOrReload ecosystem.config.cjs --update-env
  pm2 save
"

echo "[deploy] done"
