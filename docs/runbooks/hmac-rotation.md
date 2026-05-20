# Runbook — IFleet HMAC secret rotation

**Audience:** IFleet operators (Seb, Esme)
**Last updated:** 2026-05-20
**Related:** `SECURITY.md`, `src/server.ts`, `deploy/install-vps.sh`, `src/queue/control-plane.ts`

## What this is

`IFLEET_HMAC_SECRET` is the shared secret used to sign every request from the Discord daemon (`ifleet` PM2 app) to the public control plane (`control-plane` PM2 app, port 3001, fronted by nginx at `https://control.weautomatehq.cloud`). The control plane verifies the HMAC, the timestamp (skew window), and the nonce on every `POST /control` before it ingests a `sprint_goal`, `approve`, or `cancel` command.

Rotation is mechanical: generate a new value, atomically swap the env on the VPS, restart both PM2 apps that read it, verify a signed request still round-trips, then discard the old value.

## Where the secret lives

| Surface | Path / location | How it is loaded |
|---|---|---|
| VPS environment | `/etc/environment` line `IFLEET_HMAC_SECRET="…"` | PM2 inherits `/etc/environment` after `pm2 startup` + reboot/relogin. `ecosystem.config.cjs` does not hardcode the value. |
| Local `.env` (optional) | `<repo>/.env` line `IFLEET_HMAC_SECRET=…` | `ecosystem.config.cjs` reads `.env` and merges into each app's env block. Gitignored. |
| Reader (verifier) | `src/server.ts` → `env['IFLEET_HMAC_SECRET']` → passed to `createControlPlane({ hmacSecret })` | Required at boot; missing value throws `IFLEET_HMAC_SECRET is required` and the app crashes. |
| Writer (signer) | Discord daemon (`src/orchestrator/daemon.ts` and the HMAC client wired into the bot) | Reads the same env var; must match the verifier. |

## When to rotate

- **Suspected compromise** (`.env` leaked, screenshot in a channel, laptop lost, contractor offboard). Rotate immediately.
- **Quarterly cadence** (calendar reminder). 90-day default.
- **Role change** among operators with shell access to the VPS (Seb / Esme today).
- **After any incident** where the secret was pasted into a log, transcript, or unsigned channel.

## Rotation procedure

Run from the laptop. SSH access to `root@187.124.77.142` is required.

1. **Generate a new secret** locally.
   ```sh
   NEW_SECRET=$(openssl rand -hex 32)
   echo "$NEW_SECRET" | wc -c    # expect 65 (64 hex + newline)
   ```
   Do not paste the value into Discord, chat, or any agent prompt.

2. **Snapshot the existing VPS env** before mutating it.
   ```sh
   ssh root@187.124.77.142 'cp /etc/environment /etc/environment.bak.$(date +%Y%m%d-%H%M%S)'
   ```
   The dated backup is the rollback handle for step 9.

3. **Atomically rewrite `/etc/environment`** with the new value. Edit in place via a temp file + `mv` so the file is never half-written.
   ```sh
   ssh root@187.124.77.142 bash <<EOF
   set -euo pipefail
   tmp=\$(mktemp /etc/environment.new.XXXXXX)
   awk -v s="$NEW_SECRET" '
     /^IFLEET_HMAC_SECRET=/ { print "IFLEET_HMAC_SECRET=\"" s "\""; next }
     { print }
   ' /etc/environment > "\$tmp"
   grep -q "^IFLEET_HMAC_SECRET=" "\$tmp" || { echo "rewrite missed IFLEET_HMAC_SECRET line"; exit 1; }
   mv "\$tmp" /etc/environment
   chmod 644 /etc/environment
   EOF
   ```

4. **Reload PM2 with the new env.** Both apps read `IFLEET_HMAC_SECRET`; both must restart.
   ```sh
   ssh root@187.124.77.142 'set -a; . /etc/environment; set +a; pm2 reload control-plane --update-env && pm2 reload ifleet --update-env && pm2 save'
   ```
   `--update-env` forces PM2 to re-read the parent shell env (which now sources the new `/etc/environment`).

5. **Verify the control plane is up** (does not exercise HMAC; just confirms the app didn't crash on boot).
   ```sh
   curl -fsS https://control.weautomatehq.cloud/healthz
   ```
   Expect `{"ok":true}` with HTTP 200. If non-200, jump to step 9 (rollback).

6. **Round-trip a signed request.** This is the real test — daemon-side signing with the new secret, control-plane-side verification with the new secret. From the laptop:
   ```sh
   IFLEET_HMAC_SECRET="$NEW_SECRET" \
     CONTROL_PLANE_URL="https://control.weautomatehq.cloud/control" \
     node --import tsx scripts/channels-health.ts
   ```
   `channels-health` posts a signed `health_check` command; success means signing + verification + clock skew + nonce are all green end-to-end.

   If the script doesn't accept `health_check`, an alternative is a manually-signed `cancel <fake-task-id>` from Discord — it will hit the control plane, sign-check will pass, and the store layer will reject the unknown task (which is the success signal for our purpose).

7. **Confirm in PM2 logs** that the next inbound signed event from the Discord daemon verifies cleanly.
   ```sh
   ssh root@187.124.77.142 'pm2 logs control-plane --lines 50 --nostream'
   ```
   Look for the next `POST /control` line with `200`. A `401 invalid signature` line means the daemon and control plane disagree about the secret — jump to step 9.

8. **Discard the old secret.** Securely erase any local copies (`unset NEW_SECRET`, `history -c` if it landed in shell history, delete the dated `/etc/environment.bak.*` snapshot only after 24h of clean operation).

9. **Rollback (only if verification fails at step 5, 6, or 7).**
   ```sh
   ssh root@187.124.77.142 bash <<'EOF'
   set -euo pipefail
   latest_bak=$(ls -1t /etc/environment.bak.* | head -1)
   [ -n "$latest_bak" ] || { echo "no backup found"; exit 1; }
   mv "$latest_bak" /etc/environment
   set -a; . /etc/environment; set +a
   pm2 reload control-plane --update-env
   pm2 reload ifleet --update-env
   pm2 save
   EOF
   curl -fsS https://control.weautomatehq.cloud/healthz
   ```
   File an incident note in `memory/handoff.md` under Incidents with the failure signal observed.

## Where to look for evidence

| Question | Where to look |
|---|---|
| Did the new secret take effect? | `pm2 env <id-of-control-plane>` on the VPS; look for `IFLEET_HMAC_SECRET` length. |
| Did a signed request after rotation succeed? | `pm2 logs control-plane --lines 100 --nostream` — first `POST /control 200` after the rotation timestamp. |
| Was there an unsigned or wrongly-signed request? | Same log, look for `401 invalid signature` or `401 timestamp skew`. |
| When was the secret last rotated? | The timestamp on the most recent `/etc/environment.bak.*` file on the VPS. |

## Notes

- The HMAC payload, signature header, timestamp header, and nonce header are defined in `src/queue/control-plane.ts` (`SIGNATURE_HEADER`, `TIMESTAMP_HEADER`, `NONCE_HEADER`). Any future change to those constants is a coordinated daemon+control-plane upgrade, not a rotation.
- Discord webhook signature secrets (Discord → bot direction) are managed in the Discord developer portal and are independent of `IFLEET_HMAC_SECRET`; that rotation is a separate procedure.
- Do **not** edit `/opt/ifleet/.env` directly — the production source of truth is `/etc/environment`. Local dev uses `<repo>/.env` only.
