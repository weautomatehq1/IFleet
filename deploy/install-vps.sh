#!/usr/bin/env bash
# One-shot VPS bootstrap. Idempotent.
#
# Run on the VPS as root:
#   bash install-vps.sh
#
# Creates the IFleet runtime layout under /opt/ifleet without touching any
# of the rsync-managed source tree.

set -euo pipefail

TARGET="${IFLEET_VPS_PATH:-/opt/ifleet}"

echo "[install] preparing ${TARGET}"
mkdir -p "${TARGET}"
mkdir -p "${TARGET}/state"
mkdir -p "${TARGET}/repos"
mkdir -p "${TARGET}/worktrees"
mkdir -p "${TARGET}/logs"
mkdir -p /var/log/pm2

# pm2-logrotate keeps /var/log/pm2 from filling the disk.
if command -v pm2 >/dev/null 2>&1; then
  pm2 install pm2-logrotate || true
  pm2 set pm2-logrotate:max_size 50M || true
  pm2 set pm2-logrotate:retain 14 || true
fi

echo "[install] done"
