# Running an M4TR1X Node

A node is a self-hosted M4TR1X server that other users discover via the Nostr peer network. Operating a node earns you 30% of every tip routed through it. This document is the full setup guide.

## What community nodes do

M4TR1X has no central datacenter. Content discovery (film, music, reels, topic feeds) is provided by independent operators. Each operator earns the server share (30%) on tips their node processes.

Community nodes advertise four capability types on the Nostr discovery layer: `film`, `music`, `reels`, `topic`. Wallet operations and payments route through the private M4TR1X node (`PRIVATE_NODE_URL`) — this is by design, to prevent third parties from intercepting token transfers.

## Requirements

- A VPS or home server with a public IPv4 (or IPv6 + reachable DNS)
- Linux (Debian 12 / Ubuntu 22.04 LTS or newer recommended), macOS, or Windows Server
- 2 GB RAM minimum, 4 GB recommended
- 20 GB disk for the embedded Nostr relay's content store
- Node.js 20 LTS or newer
- (Optional but recommended) a domain name and TLS certificate (Let's Encrypt)

## Quick setup (Linux)

```bash
git clone https://github.com/H8dboy/m4tr1x-electron.git
cd m4tr1x-electron/server
npm install

cp ../.env.example .env
nano .env
```

In `.env`, set:

```
PORT=8080
ADMIN_KEY=<generate a 32-char random hex string>
APP_SECRET=<generate a 64-char random hex string>
M4TR1X_DATA_DIR=/var/lib/m4tr1x
H8_SERVER_ADDRESS=<your H8 wallet address — earns the 30% tip share>
PRIVATE_NODE_URL=https://your-domain.example
```

Generate secrets:

```bash
openssl rand -hex 16   # ADMIN_KEY
openssl rand -hex 32   # APP_SECRET
```

Start as a systemd service. Create `/etc/systemd/system/m4tr1x-node.service`:

```ini
[Unit]
Description=M4TR1X Node
After=network.target

[Service]
Type=simple
User=m4tr1x
WorkingDirectory=/opt/m4tr1x-electron/server
EnvironmentFile=/opt/m4tr1x-electron/.env
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable --now m4tr1x-node
sudo systemctl status m4tr1x-node
```

## Reverse proxy (nginx + Let's Encrypt)

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.example;

  ssl_certificate     /etc/letsencrypt/live/your-domain.example/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/your-domain.example/privkey.pem;

  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /relay {
    proxy_pass http://127.0.0.1:4848;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## Declare your node on the network

Once running, call the declare endpoint. The node publishes its capabilities to Nostr so peers can discover it:

```bash
curl -X POST -H "Content-Type: application/json" \
     -d '{"capabilities":["film","music","reels","topic"],"wsPort":4848}' \
     https://your-domain.example/api/v1/node/declare
```

Valid capabilities are `film`, `music`, `reels`, `topic`. Your node is now visible in the peer discovery feed.

## Earnings

The 30% server share of every tip routed through your node is credited to the H8 address you set as `H8_SERVER_ADDRESS`. View your accrued balance:

```bash
curl https://your-domain.example/api/v1/h8/balance?address=<your-server-address>
```

In v2.3.0 the platform mint is manual. Withdrawals are coordinated with the founder. v2.4 will introduce a node operator dashboard.

## Security checklist

- Run as a dedicated non-root user
- Firewall: open only 443 (and 80 for Let's Encrypt renewal)
- Keep `ADMIN_KEY` and `APP_SECRET` out of git, backed up offline
- Enable unattended-upgrades for OS security patches
- Monitor `journalctl -u m4tr1x-node -f` for the first week
- Rotate `ADMIN_KEY` quarterly

## Health check

```bash
curl https://your-domain.example/api/v1/health
# {"status":"online","version":"2.3.0",...}
```

## Troubleshooting

**`better-sqlite3` build fails on install:** install build tools — `sudo apt install build-essential python3` on Debian/Ubuntu.

**Port 8080 already in use:** change `PORT` in `.env`. Update reverse proxy accordingly.

**Tor not detected:** node operators don't need Tor; it's a client-side feature. Ignore the warning.

**Node won't appear in peer discovery:** confirm you called `/api/v1/node/declare` after startup and that your Nostr keys are configured (`/api/v1/nostr/keys` to generate).

## Getting help

Open an issue with the `node-operator` label. Include logs from `journalctl -u m4tr1x-node --since "1 hour ago"`.
