# Langfuse — IFleet observability (Phase 1.1)

Self-hosted Langfuse v3 stack on the same VPS as IFleet. Web on `127.0.0.1:3010`, reverse-proxied by nginx at `langfuse.weautomatehq.cloud`.

Port choice: **3010, not 3000.** Port 3000 is owned by `arca` (friend's project, do not touch).

## Stack

| Service | Image | Network | Volume |
|---|---|---|---|
| langfuse-web | `langfuse/langfuse:3` | `langfuse` + host:3010 | — |
| langfuse-worker | `langfuse/langfuse-worker:3` | `langfuse` only | — |
| langfuse-postgres | `postgres:16` | `langfuse` only | `langfuse_postgres_data` |
| clickhouse | `clickhouse/clickhouse-server:24.12` | `langfuse` only | `langfuse_clickhouse_data`, `langfuse_clickhouse_logs` |
| redis | `redis:7` | `langfuse` only | — |
| minio | `minio/minio` | `langfuse` only | `langfuse_minio_data` |
| minio-mc | `minio/mc` | one-shot bucket init | — |

Resource budget: ~4 GB RAM, ~7 GB disk. VPS headroom check confirmed adequate (6.3 GB free → 1.9 GB free after install).

## One-time install (on VPS as root)

```bash
# 1. Install docker compose plugin (Docker engine 29.x already present).
apt update && apt install -y docker-compose-plugin

# 2. Generate and write secrets.
cd /opt/ifleet/deploy/langfuse
cp .env.example .env

# Generate the three required secrets and paste into .env:
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
echo "SALT=$(openssl rand -base64 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "LANGFUSE_POSTGRES_PASSWORD=$(openssl rand -base64 24)"
echo "CLICKHOUSE_PASSWORD=$(openssl rand -base64 24)"
echo "REDIS_AUTH=$(openssl rand -base64 24)"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -base64 24)"

nano .env   # paste outputs, set LANGFUSE_INIT_USER_PASSWORD

# 3. Boot the stack.
docker compose up -d

# 4. Wait for healthy state, then check.
docker compose ps
curl -fsS http://127.0.0.1:3010/api/public/health
```

## Iterative updates

```bash
cd /opt/ifleet/deploy/langfuse
docker compose pull
docker compose up -d
```

## Logs

```bash
docker compose logs -f langfuse-web
docker compose logs -f langfuse-worker
docker compose logs -f clickhouse
```

## Backup

ClickHouse + Postgres + MinIO volumes hold the data. Cheapest backup: weekly volume snapshot via Hostinger.

For a hot dump:
```bash
docker compose exec langfuse-postgres pg_dump -U langfuse langfuse > backup-$(date +%F).sql
```

## What is NOT in this directory

- **nginx vhost** for the subdomain lives at `nginx/langfuse.conf` (parallel to `nginx/ifleet-control.conf`). Installed via the existing nginx-reload flow in `deploy/install-vps.sh`.
- **DNS A record** `langfuse.weautomatehq.cloud → 187.124.77.142` must exist at the DNS provider before nginx + certbot can succeed. Verify with `dig +short langfuse.weautomatehq.cloud`.
- **Certbot cert**: `certbot --nginx -d langfuse.weautomatehq.cloud` after the vhost is in place and DNS resolves.

## Failure modes worth knowing

| Symptom | Likely cause | Fix |
|---|---|---|
| `langfuse-web` keeps restarting, logs show migration errors | ClickHouse not healthy yet | Wait 30s; ClickHouse first-boot is slow |
| MinIO bucket `langfuse` missing | `minio-mc` job failed | `docker compose run --rm minio-mc` |
| `curl /api/public/health` returns 500 | Bad `ENCRYPTION_KEY` length | Must be exactly 64 hex chars (32 bytes) |
| RAM pressure / OOM on ClickHouse | Heavy trace volume + tight RAM | Move ClickHouse to separate $10/mo box |
| Port 3010 collision | Something else grabbed it | Check `ss -tlnp \| grep 3010`; never use 3000 (arca) |
