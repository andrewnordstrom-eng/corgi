# Deployment Guide

This guide is for deploying your own instance of the Community-Governed Bluesky Feed on a VPS.

> **Production boundary:** this is a self-hosting guide, not authorization to
> mutate Corgi production. Corgi's `Deploy to VPS` workflow is a manual,
> exact-SHA promotion path protected by an enable flag and the `production`
> environment. Do not dispatch or approve it without an explicit production
> gate, and do not substitute these self-hosting commands for that workflow.

## Prerequisites

- Ubuntu 22.04+ VPS with at least 2GB RAM
- A domain pointed to your VPS
- A Bluesky account for feed publishing/admin
- `sudo` access on the server

## 1. Create/prepare Bluesky account

1. Create or choose the account that will publish the feed (for example `my-feed.bsky.social`).
2. Create an app password in Bluesky settings.
3. Resolve its DID:

```bash
curl "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=my-feed.bsky.social"
```

Save the returned `did`.

## 2. Install system dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl xz-utils git nginx certbot python3-certbot-nginx redis-server postgresql
```

Install the exact Node release into a versioned directory. These archive hashes
come from the [signed Node 22.23.2 release checksums](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.asc).
The directory must not already exist; this procedure does not overwrite an
existing runtime installation.

```bash
(
  set -eu
  case "$(uname -m)" in
    x86_64)
      CORGI_NODE_ARCH=x64
      CORGI_NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
      ;;
    aarch64|arm64)
      CORGI_NODE_ARCH=arm64
      CORGI_NODE_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8
      ;;
    *) printf 'Unsupported Node architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  CORGI_NODE_TMP="$(mktemp -d)"
  trap 'rm -rf "$CORGI_NODE_TMP"' EXIT
  cd "$CORGI_NODE_TMP"
  curl --fail --silent --show-error --location --proto '=https' \
    --output node.tar.xz \
    "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-${CORGI_NODE_ARCH}.tar.xz"
  printf '%s  node.tar.xz\n' "$CORGI_NODE_SHA256" | sha256sum --check --strict
  sudo mkdir -m 0755 /opt/corgi-node-v22.23.2
  sudo tar --extract --xz --file node.tar.xz --strip-components=1 \
    --no-same-owner --no-same-permissions --directory /opt/corgi-node-v22.23.2
)
export PATH="/opt/corgi-node-v22.23.2/bin:$PATH"
# Install the exact package manager into this versioned runtime prefix.
sudo /opt/corgi-node-v22.23.2/bin/node \
  /opt/corgi-node-v22.23.2/lib/node_modules/npm/bin/npm-cli.js \
  install --global --prefix /opt/corgi-node-v22.23.2 --ignore-scripts npm@11.19.1
test "$(npm --version)" = "11.19.1"
```

## 3. Create PostgreSQL database

```bash
sudo -u postgres psql
```

```sql
CREATE USER feeduser WITH PASSWORD 'replace-with-strong-password';
CREATE DATABASE community_feed OWNER feeduser;
\q
```

## 4. Clone repository

```bash
cd /opt
sudo git clone https://github.com/andrewnordstrom-eng/corgi.git /opt/bluesky-feed
sudo chown -R "$USER":"$USER" /opt/bluesky-feed
cd /opt/bluesky-feed
```

Before installing dependencies, verify that the host matches the repository's
exact runtime contract. Stop if Node, npm, or the native module ABI differs.

```bash
test "$(cat .nvmrc)" = "22.23.2"
test "$(node --version)" = "v22.23.2"
test "$(npm --version)" = "11.19.1"
test "$(node -p 'process.versions.modules')" = "127"
```

## 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set required values:

- `DATABASE_URL`
- `REDIS_URL`
- `FEEDGEN_HOSTNAME`
- `BSKY_IDENTIFIER`
- `BSKY_APP_PASSWORD`
- `BOT_ADMIN_DIDS`

Recommended security defaults:

- `CORS_ALLOWED_ORIGINS` should be explicit for your production UI origin(s)
- `TRUST_PROXY` should match your reverse-proxy topology (typical single-host Nginx: `loopback`)
- `GOVERNANCE_SESSION_COOKIE_SAME_SITE=lax` (or `strict` if your deployment allows)

### DID bootstrap

Resolve and print `.env` DID values:

```bash
npm run generate-feed-did -- my-feed.bsky.social
```

Then copy the printed `FEEDGEN_SERVICE_DID` and `FEEDGEN_PUBLISHER_DID` into `.env`.

## 6. Install dependencies and build

```bash
npm install
npm --prefix web-next install
npm --prefix web install
npm run build
npm --prefix web-next run build
npm --prefix web run build
```

## 7. Run migrations

```bash
npm run migrate
```

## 8. Publish feed record to Bluesky

```bash
npm run publish-feed
```

This creates/updates the `app.bsky.feed.generator/community-gov` record.

## 9. Configure systemd

Create a dedicated service account and grant app directory ownership:

```bash
sudo useradd --system --home /opt/bluesky-feed --shell /usr/sbin/nologin bluesky-feed || true
sudo chown -R bluesky-feed:bluesky-feed /opt/bluesky-feed
```

Create `/etc/systemd/system/bluesky-feed.service`:

```ini
[Unit]
Description=Bluesky Community Feed Generator
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=bluesky-feed
Group=bluesky-feed
WorkingDirectory=/opt/bluesky-feed
Environment=NODE_ENV=production
EnvironmentFile=/opt/bluesky-feed/.env
ExecStart=/opt/corgi-node-v22.23.2/bin/node dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable/start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bluesky-feed
sudo systemctl start bluesky-feed
sudo systemctl status bluesky-feed
```

## 10. Configure Nginx + TLS

Create `/etc/nginx/sites-available/bluesky-feed`:

```nginx
server {
    listen 80;
    server_name feed.yourdomain.com;

    location / {
        # Match FEEDGEN_PORT from your .env
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and validate:

```bash
sudo ln -sf /etc/nginx/sites-available/bluesky-feed /etc/nginx/sites-enabled/bluesky-feed
sudo nginx -t
sudo systemctl reload nginx
```

Issue certificate:

```bash
sudo certbot --nginx -d feed.yourdomain.com
```

After enabling Nginx, confirm the app is not directly exposed on `FEEDGEN_PORT` from the internet and relies on trusted proxy headers only.

## 11. Verify deployment

```bash
curl -f https://feed.yourdomain.com/health
curl -f "https://feed.yourdomain.com/xrpc/app.bsky.feed.describeFeedGenerator"
```

Also verify logs:

```bash
sudo journalctl -u bluesky-feed -f
```

## 12. Admin access

- Log in on the web UI with the Bluesky account.
- Ensure that account DID is included in `BOT_ADMIN_DIDS`.
- Restart service after `.env` changes:

```bash
sudo systemctl restart bluesky-feed
```

## 13. Optional: public docs subdomain (`docs.corgi.network`)

This repository includes a dedicated docs deployment workflow:

- Workflow: `.github/workflows/deploy-docs.yml`
- Source artifacts: `docs/docs-site/index.html` and `docs/docs-site/openapi.json`
- VPS target directory: `/var/www/corgi-docs`

Expected Nginx location:

```nginx
location / {
    root /var/www/corgi-docs;
    index index.html;
    try_files $uri $uri/ /index.html;
}
```

Required GitHub Actions secrets:

- Add these as repository-level secrets in the transferred org repo:
  `Settings -> Secrets and variables -> Actions` for
  `andrewnordstrom-eng/corgi`.
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `VPS_SSH_HOST_KEY` (recommended host-key pin for strict SSH verification)
- `DATABASE_URL` (required by `daily-health.yml` and `weekly-export.yml`)
- `EXPORT_ANONYMIZATION_SALT` (required by `weekly-export.yml`)
- `HEALTHCHECK_PING_URL` (optional, used by deploy and daily health monitor pings)

On each `main` push that changes `docs/docs-site/**`, the workflow currently
uploads the docs bundle to the VPS and verifies that live
`https://docs.corgi.network/` and `/openapi.json` hashes match the repository
artifacts. The workflow does not yet enforce an approval or exact-SHA gate
before its publish step. Do not rely on or trigger that production mutation
until a separately tracked workflow fix adds the gate and receives explicit
activation approval.

## Operations checklist

- Keep ports `5432` and `6379` private.
- Only expose `80/443`.
- Rotate app passwords and admin DID list as needed.
- Watch `/health` and systemd logs.
- Use `docs/OPS_RUNBOOK.md` for day-2 operations, retention, alerting, and incident response.
- After any repo/org transfer, run the "Post-Transfer Validation (Manual Dispatch)" section in `docs/OPS_RUNBOOK.md`.
