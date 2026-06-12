#!/usr/bin/env bash
#
# M4TR1X node installer — Ubuntu 22.04+ / Debian 12+
#
# Installa Node.js 20, ffmpeg, clona il repo, configura il nodo e lo
# registra come servizio systemd che parte al boot.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/H8dboy/m4tr1x-node/main/scripts/install-node.sh | bash
# oppure, da repo già clonato:
#   bash scripts/install-node.sh
#
# Variabili opzionali (esempio):
#   HEAD_NODE_URL=http://192.168.56.1:8080 NODE_NAME=nodo-vm-1 bash scripts/install-node.sh
#
set -euo pipefail

REPO_URL="https://github.com/H8dboy/m4tr1x-node.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/m4tr1x-node}"
NODE_NAME="${NODE_NAME:-node-$(hostname -s)}"
HEAD_NODE_URL="${HEAD_NODE_URL:-}"
RELAY_PEERS="${RELAY_PEERS:-}"
PORT="${PORT:-8080}"

echo "══════════════════════════════════════════════"
echo "  M4TR1X node installer — $NODE_NAME"
echo "══════════════════════════════════════════════"

# ── Dipendenze di sistema ─────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(parseInt(process.versions.node))')" -lt 18 ]; then
  echo "→ Installo Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "→ Installo ffmpeg, git, build tools..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg git build-essential python3

# ── Codice ────────────────────────────────────────────────────────────────────
if [ -f "$(dirname "$0")/../package.json" ]; then
  # Lanciato da dentro un repo già clonato
  INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  echo "→ Uso il repo esistente: $INSTALL_DIR"
elif [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "→ Clono $REPO_URL in $INSTALL_DIR..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "→ npm install (può richiedere qualche minuto)..."
npm install --omit=dev --no-audit --no-fund

# ── Configurazione ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^NODE_NAME=.*|NODE_NAME=$NODE_NAME|" .env
  sed -i "s|^HEAD_NODE_URL=.*|HEAD_NODE_URL=$HEAD_NODE_URL|" .env
  sed -i "s|^RELAY_PEERS=.*|RELAY_PEERS=$RELAY_PEERS|" .env
  echo "→ Creato .env (NODE_NAME=$NODE_NAME, HEAD_NODE_URL=${HEAD_NODE_URL:-<vuoto>})"
else
  echo "→ .env già presente, non lo tocco."
fi

# ── Servizio systemd ──────────────────────────────────────────────────────────
echo "→ Registro il servizio systemd m4tr1x-node..."
sudo tee /etc/systemd/system/m4tr1x-node.service >/dev/null <<EOF
[Unit]
Description=M4TR1X Node — The Unfiltered Eye
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
ExecStart=$(command -v node) server/index.js
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now m4tr1x-node

LAN_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "══════════════════════════════════════════════"
echo "  ✓ Nodo M4TR1X attivo"
echo "  API:    http://$LAN_IP:$PORT"
echo "  Relay:  ws://$LAN_IP:4848"
echo "  Stato:  sudo systemctl status m4tr1x-node"
echo "  Log:    journalctl -u m4tr1x-node -f"
echo "  Mesh:   curl http://localhost:$PORT/api/v1/mesh/status"
echo "══════════════════════════════════════════════"
