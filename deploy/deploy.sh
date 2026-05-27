#!/usr/bin/env bash
#
# deploy.sh — iterative laptop→VPS deploy.
#
#   bash deploy/deploy.sh                # default: build, rsync, reload, healthcheck
#   SKIP_BUILD=1 bash deploy/deploy.sh   # rsync-only (when dist/ already fresh)
#   DRY_RUN=1 bash deploy/deploy.sh      # show rsync plan, no changes
#
# Requires SSH access to root@${VPS_HOST} (key auth, no password prompts).

set -euo pipefail

VPS="${VPS_HOST:?Set VPS_HOST env var, e.g. export VPS_HOST=1.2.3.4}"
VPS="root@$VPS"
REMOTE_DIR="${IFLEET_REMOTE_DIR:-/opt/ifleet}"
LOCAL_REPO="${IFLEET_LOCAL_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
DOMAIN="${IFLEET_DOMAIN:-control.weautomatehq.cloud}"

log() { printf '\n\033[1;32m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$LOCAL_REPO"

# ---- 1. Local build ---------------------------------------------------------
# Note: commit 2ab0228's message said "npm ci" but the actual change went the
# opposite direction (npm ci → pnpm install --frozen-lockfile). pnpm is the
# canonical package manager here per package.json's packageManager field.
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  log "Installing local deps (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile

  log "Building TypeScript → dist/"
  npx tsc -p tsconfig.json
  [[ -d dist ]] || fail "Build produced no dist/ — check tsconfig.json"
else
  log "SKIP_BUILD=1 — assuming dist/ is current"
fi

# ---- 2. Rsync ---------------------------------------------------------------
RSYNC_FLAGS=(-avz --delete
  --exclude=node_modules
  --exclude=.git
  --exclude=.omc
  --exclude=state
  --exclude='.env*'
  --exclude='*.log'
  --exclude=coverage)

if [[ "${DRY_RUN:-}" == "1" ]]; then
  RSYNC_FLAGS+=(--dry-run -i)
  log "DRY_RUN=1 — listing changes only"
fi

log "Rsyncing to $VPS:$REMOTE_DIR/"
rsync "${RSYNC_FLAGS[@]}" ./ "$VPS:$REMOTE_DIR/"

[[ "${DRY_RUN:-}" == "1" ]] && { log "DRY_RUN complete."; exit 0; }

# ---- 3. Remote install + reload --------------------------------------------
# NOTE: Do not add `--prod`. The pipeline worktree symlinks node_modules from
# this directory (src/pipeline/factory.ts → setupWorktree), and verify steps
# need devDeps (`typescript`, `tsx`, `eslint`, `@types/*`). A prod-stripped
# install will break every worker's typecheck.
log "Installing deps on VPS + reloading PM2"
ssh "$VPS" bash <<EOF
set -euo pipefail
cd "$REMOTE_DIR"
pnpm install --frozen-lockfile
pm2 reload ecosystem.config.cjs --env production --update-env
pm2 save
EOF

# ---- 4. Health check --------------------------------------------------------
log "Waiting 3s for control-plane to settle"
sleep 3

HEALTH_URL="https://$DOMAIN/healthz"
log "Health check: $HEALTH_URL"
if ! curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
  log "HTTPS healthcheck failed — falling back to direct port 3001 via SSH tunnel test"
  ssh "$VPS" 'curl -fsS http://127.0.0.1:3001/healthz' || fail "Control plane is not responding. Check: ssh $VPS pm2 logs control-plane --lines 50"
  fail "Local healthz works but $HEALTH_URL does not — check nginx + certbot."
fi

log "Deploy OK."
ssh "$VPS" 'pm2 list --no-color'
