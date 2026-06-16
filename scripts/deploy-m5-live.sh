#!/usr/bin/env bash
set -euo pipefail

# M5 live-deploy script.
# Applies migration 0004, sets proposer env vars, and restarts PM2.
# Execution gated on Sebastian creating #ifleet-proposals and supplying the channel id.
# Do NOT run against the real VPS until the PR is merged and the channel id is known.

usage() {
  cat >&2 <<EOF
Usage: $0 --vps-host <host> --kg-db-url <url> --proposals-channel-id <snowflake> --approver-ids <csv> [--dry-run]

  --vps-host             SSH host (e.g. root@1.2.3.4)
  --kg-db-url            KG Postgres URL (must start with postgresql://)
  --proposals-channel-id Discord channel snowflake id (5-32 digits)
  --approver-ids         Comma-separated Discord user id(s) authorised to approve proposals
  --dry-run              Print every command that WOULD run; exit 0 without SSHing anywhere
EOF
  exit 1
}

# ── Arg parsing ──────────────────────────────────────────────────────────────
VPS_HOST=""
KG_DB_URL=""
PROPOSALS_CHANNEL_ID=""
APPROVER_IDS=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vps-host)             VPS_HOST="$2";             shift 2 ;;
    --kg-db-url)            KG_DB_URL="$2";            shift 2 ;;
    --proposals-channel-id) PROPOSALS_CHANNEL_ID="$2"; shift 2 ;;
    --approver-ids)         APPROVER_IDS="$2";         shift 2 ;;
    --dry-run)              DRY_RUN=1;                 shift   ;;
    *) echo "Unknown arg: $1" >&2; usage ;;
  esac
done

# ── Validation ────────────────────────────────────────────────────────────────
ERRORS=()

[[ -z "$VPS_HOST" ]]             && ERRORS+=("--vps-host is required")
[[ -z "$KG_DB_URL" ]]            && ERRORS+=("--kg-db-url is required")
[[ -z "$PROPOSALS_CHANNEL_ID" ]] && ERRORS+=("--proposals-channel-id is required")
[[ -z "$APPROVER_IDS" ]]         && ERRORS+=("--approver-ids is required")

if [[ -n "$KG_DB_URL" ]] && [[ "$KG_DB_URL" != postgresql://* ]]; then
  ERRORS+=("--kg-db-url must start with postgresql://")
fi

if [[ -n "$PROPOSALS_CHANNEL_ID" ]] && ! [[ "$PROPOSALS_CHANNEL_ID" =~ ^[0-9]{5,32}$ ]]; then
  ERRORS+=("--proposals-channel-id must be a Discord snowflake (5-32 digits)")
fi

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  printf "Validation error: %s\n" "${ERRORS[@]}" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
STEP=0
step_start() {
  STEP=$(( STEP + 1 ))
  echo "── Step $STEP: $1"
}

run_ssh() {
  local label="$1"; shift
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] ssh $VPS_HOST $*"
    return 0
  fi
  # shellcheck disable=SC2029
  ssh "$VPS_HOST" "$@" || {
    echo "❌ deploy failed at step $STEP: $label" >&2
    exit 1
  }
}

set_env_var() {
  local key="$1" val="$2"
  # Idempotent upsert in /etc/environment: update if key exists, append if not.
  local cmd="grep -q '^${key}=' /etc/environment \
    && sed -i \"s|^${key}=.*|${key}=${val}|\" /etc/environment \
    || echo \"${key}=${val}\" >> /etc/environment"
  run_ssh "set $key in /etc/environment" bash -c "$cmd"
}

# ── Dry-run header ────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN — commands that WOULD execute (no SSH attempted):"
  echo ""
fi

# ── Step 1: git pull ──────────────────────────────────────────────────────────
step_start "git pull --ff-only on VPS"
run_ssh "git pull" bash -c "cd /opt/ifleet && git pull --ff-only origin main"

# ── Step 2: pnpm install ──────────────────────────────────────────────────────
step_start "pnpm install --frozen-lockfile on VPS"
run_ssh "pnpm install" bash -c "cd /opt/ifleet && pnpm install --frozen-lockfile"

# ── Step 3: apply KG migration 0004 ──────────────────────────────────────────
step_start "pnpm graph:migrate (apply 0004-goal-proposals.sql)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] ssh $VPS_HOST IFLEET_KG_DATABASE_URL=<url> pnpm -C /opt/ifleet graph:migrate"
else
  # shellcheck disable=SC2029
  MIGRATE_OUT=$(ssh "$VPS_HOST" "cd /opt/ifleet && IFLEET_KG_DATABASE_URL='$KG_DB_URL' pnpm graph:migrate 2>&1") || {
    echo "$MIGRATE_OUT" >&2
    echo "❌ deploy failed at step $STEP: graph:migrate exited non-zero" >&2
    exit 1
  }
  echo "$MIGRATE_OUT"
fi

# ── Step 4: set env vars in /etc/environment ──────────────────────────────────
step_start "set IFLEET_PROPOSALS_CHANNEL_ID, IFLEET_PROPOSALS_APPROVER_IDS, PROPOSER_ENABLED"
set_env_var "IFLEET_PROPOSALS_CHANNEL_ID" "$PROPOSALS_CHANNEL_ID"
set_env_var "IFLEET_PROPOSALS_APPROVER_IDS" "$APPROVER_IDS"
set_env_var "PROPOSER_ENABLED" "1"

# ── Step 5: pm2 restart (IFleet apps only — never touch arca) ────────────────
# Enumerate explicitly. `pm2 restart all` is forbidden: the VPS co-hosts arca
# (a friend's project) and `all` would restart its PM2 entry. Add new IFleet
# apps to this list as ecosystem.config.cjs grows; never widen back to `all`.
IFLEET_PM2_APPS="ifleet ifleet-mcp ifleet-standup ifleet-canary ifleet-retro ifleet-audit-nightly ifleet-proposer ifleet-audit-morning"
step_start "pm2 restart IFleet apps only (never arca) — apps: $IFLEET_PM2_APPS"
# `pm2 restart` accepts space-separated names. Missing apps fail loudly; that's
# the right behaviour — drift between this list and ecosystem.config.cjs must
# surface, not silently widen scope.
run_ssh "pm2 restart" bash -c "pm2 restart $IFLEET_PM2_APPS --update-env"

# ── Step 6: confirm cron registered ──────────────────────────────────────────
step_start "verify ifleet-proposer cron entry"
echo "PM2 ifleet-proposer describe (cron field):"
run_ssh "pm2 describe" bash -c "pm2 describe ifleet-proposer | grep -i cron"

# ── Step 7: tail recent logs ──────────────────────────────────────────────────
step_start "pm2 logs ifleet-proposer --lines 50 --nostream"
run_ssh "pm2 logs" bash -c "pm2 logs ifleet-proposer --lines 50 --nostream"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "✅ M5 dry-run complete — no VPS was touched"
else
  echo "✅ M5 live on VPS"
fi
