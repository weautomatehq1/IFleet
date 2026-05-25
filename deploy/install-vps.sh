#!/usr/bin/env bash
#
# install-vps.sh — one-shot bootstrap for a fresh Hostinger VPS.
# Run AS ROOT on the VPS, ONCE. Re-running is mostly idempotent but TLS
# issuance will skip if a cert already exists.
#
#   ssh root@187.124.77.142
#   cd /opt/ifleet            # after first rsync from deploy.sh
#   bash deploy/install-vps.sh
#
# Then: edit /etc/environment with real secrets, `source /etc/environment`,
# log out + back in, and run deploy/deploy.sh from the laptop.

set -euo pipefail

DOMAIN="${IFLEET_DOMAIN:-control.weautomatehq.cloud}"
LE_EMAIL="${IFLEET_LE_EMAIL:-weautomatehq1@gmail.com}"
REPO_DIR="${IFLEET_REPO_DIR:-/opt/ifleet}"

log() { printf '\n\033[1;34m[install]\033[0m %s\n' "$*"; }

# ---- 1. system packages ------------------------------------------------------
log "Installing apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git build-essential nginx ufw

# ---- 2. Node 20 (NodeSource) -------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  log "Installing Node 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

# ---- 3. pnpm (matches packageManager field in package.json) -----------------
# NOTE: if packageManager in package.json is updated, update the version here in tandem.
PNPM_REQUIRED="10.33.2"
PNPM_INSTALLED="$(pnpm --version 2>/dev/null || true)"
if [[ "$PNPM_INSTALLED" != "$PNPM_REQUIRED" ]]; then
  log "Installing pnpm@${PNPM_REQUIRED} (installed: '${PNPM_INSTALLED:-none}')"
  npm install -g "pnpm@${PNPM_REQUIRED}"
fi
pnpm --version

# ---- 4. PM2 + logrotate ------------------------------------------------------
log "Installing PM2 + pm2-logrotate"
npm install -g pm2
pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

# ---- 5. Claude Code CLI ------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  log "Installing Claude Code CLI"
  # Official Linux install — pin a known version if needed
  curl -fsSL https://claude.ai/install.sh | bash
  # Ensure /usr/local/bin/claude is on PATH for PM2 (non-interactive shells)
  if [[ -x "$HOME/.local/bin/claude" && ! -e /usr/local/bin/claude ]]; then
    ln -s "$HOME/.local/bin/claude" /usr/local/bin/claude
  fi
fi
claude --version || log "WARN: claude --version failed, verify install manually"

# ---- 6. Directory layout -----------------------------------------------------
log "Creating /opt/ifleet directory tree"
mkdir -p "$REPO_DIR"/{state,repos,logs}
mkdir -p /var/log/pm2

# ---- 7. /etc/environment template (only if missing) --------------------------
if ! grep -q '^IFLEET_HMAC_SECRET=' /etc/environment 2>/dev/null; then
  log "Seeding /etc/environment template (placeholders — FILL THEM IN)"
  cat >> /etc/environment <<'EOF'

# --- IFleet (managed by install-vps.sh) — fill in real values ---
ANTHROPIC_API_KEY=""
GITHUB_TOKEN=""
DISCORD_BOT_TOKEN=""
DISCORD_CLIENT_ID=""
DISCORD_GUILD_ID=""
IFLEET_HMAC_SECRET=""
CONTROL_PLANE_URL="http://localhost:3001/control"
IFLEET_STATE_DIR="/opt/ifleet/state"
CLAUDE_PATH="/usr/local/bin/claude"
EOF
  log "EDIT /etc/environment NOW. Then \`source /etc/environment\` and re-login."
fi

# ---- 8. PM2 startup (systemd) -----------------------------------------------
log "Registering PM2 with systemd"
pm2 startup systemd -u root --hp /root | tee /tmp/pm2-startup.txt
PM2_CMD=$(grep -E '^sudo env ' /tmp/pm2-startup.txt || true)
if [[ -n "$PM2_CMD" ]]; then
  log "Executing printed PM2 startup command"
  eval "$PM2_CMD"
fi

# ---- 9. nginx site -----------------------------------------------------------
if [[ -f "$REPO_DIR/nginx/ifleet-control.conf" ]]; then
  log "Installing nginx site $DOMAIN"
  cp "$REPO_DIR/nginx/ifleet-control.conf" /etc/nginx/sites-available/ifleet-control
  ln -sf /etc/nginx/sites-available/ifleet-control /etc/nginx/sites-enabled/ifleet-control
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl reload nginx
else
  log "WARN: $REPO_DIR/nginx/ifleet-control.conf missing — skip nginx step (run deploy.sh first)"
fi

# ---- 10. firewall (open 80/443/22 only) ---------------------------------------
log "Configuring ufw"
ufw allow 22/tcp || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
yes | ufw enable || true

# ---- 11. TLS via certbot ----------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  apt-get install -y certbot python3-certbot-nginx
fi
if [[ ! -e "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  log "Requesting Let's Encrypt cert for $DOMAIN (DNS must already point to this VPS)"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" || \
    log "WARN: certbot failed — verify A record for $DOMAIN then re-run \`certbot --nginx -d $DOMAIN\`"
else
  log "Cert already present for $DOMAIN, skipping certbot"
fi

log "Bootstrap complete."
cat <<'EOF'

Next steps (from your laptop):
  1. Confirm DNS: dig +short control.weautomatehq.cloud   # must return VPS IP
  2. Edit /etc/environment on the VPS, then re-login (PM2 reads it on startup)
  3. From laptop: bash deploy/deploy.sh
  4. Verify: curl https://control.weautomatehq.cloud/healthz

EOF
