# Changelog

## v2.4.0 — Federation & Production Hardening

### Cross-Node Federation
- `server/federation.js`: syncs video/audio/photo from all registered nodes every 5 min
- SOCKS5 tunnel for .onion-to-.onion federation without exposing LAN IPs
- Self-exclusion filter: checks pubkey, LAN URL, and onion hostname to skip self
- `/api/v1/feed/global?type=film|music|photo` — merged federated feed endpoint
- Frontend: `loadPeerTube()` and `loadFunkwhale()` merge local + federated content

### Head Node
- `head-server/head_server.js` added to repo (deployed on antiX USB)
- `head-server/dashboard/index.html`: real-time network dashboard with relative timestamps,
  upload rates, node health table, user table, growth charts
- `/api/v1/head/nodes` endpoint for federation node discovery
- `server/db_backup.js`: automatic SQLite backup every 6h, keeps 24 most recent

### Heartbeat
- Exponential backoff: 60s → 120s → 240s → max 10 min on head node failure
- Fixed `node_url` vs `onion` separation — LAN URL and .onion stored correctly in head DB
- Nostr display name lookup from local relay.db at startup (no more "unnamed" users)
- 20s after boot: scans all kind:0 profiles and registers each user with head node

### Electron App
- `preload.js`: exposes `getNodeConfig()` and `getTorStatus()` IPC calls to renderer
- `main.js`: `get-node-config` IPC handler; CSP expanded to allow node .onion for
  img-src, media-src, connect-src
- Frontend config now loaded dynamically from `/api/v1/config` — no hardcoded URLs
- Wallet init and relay connection moved inside `_cfgPromise` to fix race condition
- Tor indicator shown on avatar when Tor is active

### Bug Fixes
- `connectRelays()` now reads `CONFIG.relays` directly instead of a stale snapshot
  taken before the server config loaded — .onion relay was never connected
- Federated video dedup key now includes node origin prefix to prevent UUID collision
  across nodes
- `localizeUrl()`: rewrites self-node .onion URLs to `localhost:8080` so content plays
  without Tor (Blossom uploads, video attestations stored .onion in Nostr events)
- `/api/v1/config` now extracts onion hostname from `PRIVATE_NODE_URL` as fallback
  when Tor hostname file is not at `M4TR1X_DATA_DIR`
- Blossom upload URL uses LAN address instead of .onion so uploads work without Tor
- Blossom uploads now call `announceContent()` and `trackUpload()` for media files

### Security & Ops
- `ufw` firewall: allows SSH/8080/4848, blocks everything else
- `fail2ban`: SSH jail (5 attempts → 1h ban) + M4TR1X API jail (rate-limit triggers)
- `scripts/monitor.sh`: tmux dashboard with live logs, active connections, banned IPs
- `server/index.js`: rate limiting confirmed active on `/analyze` and `/blossom/upload`

### Known Limitations (v2.5)
- CROWDTRAIN votes fail to publish to Nostr if keys not loaded at vote time
- ONNX AI model not present — detector runs in UNCERTAIN fallback mode
- No user onboarding flow for second users joining an existing node
- No content search
- No push notifications for DMs/mentions when app is backgrounded

## v2.3.0 — Developer Preview

### H8 Token Economy (live)
- Modulo `server/h8token.js`: ledger hash chain SHA3-256, firme ML-DSA65
- 9 endpoint: balance, history, transfer, tip (split 50/20/30), boost, boost/batch, boost/:id, chain/verify, admin/mint
- Supporto pseudo-address `nostr_<pubkey[:38]>` come destinatario tip

### Security
- Scrypt N=131072 per H8 identity (migration silenziosa v1→v2)
- Rimosso modulo Monero dead code (TLS bypass)
- Git history pulita

### Truth alignment
- Banner DM: Nostr NIP-44 (era erroneamente "Signal Protocol")
- README e GitHub About allineati alla realtà
- Shop documentato come Nostr-native (kind:30402)

### Compat
- Alias frontend: `/api/v1/timelines/tag/:tag`, `/videos`, `/tracks`
- Config fallback a localhost quando privateNodeUrl null
- `server/index.js` legge `PORT` dall'env quando avviato direttamente

### Known limitations (v2.4)
- Pseudo-address `nostr_...` riceve tip ma non spende (claim flow in v2.3.1)
- Mint manuale via admin (fiat gateway in v2.4)
- Mobile Tauri presente ma non distribuito (v2.4)
- No moderation reporting (v2.4)
