# M4TR1X Architecture

A 10-minute read for developers wanting to understand how the pieces fit together before contributing.

## High-level

```
┌────────────────────────────────────────────────────────┐
│  User                                                  │
│    │                                                   │
│    ▼                                                   │
│  Electron main process                                 │
│    │  - CSP via onHeadersReceived                      │
│    │  - contextIsolation + sandbox (renderer)          │
│    │  - Tor SOCKS5 auto-detection at startup           │
│    │  - Starts Express server in-process               │
│    ▼                                                   │
│  http://127.0.0.1:8080  (Express API)                  │
│    │                                                   │
│    ├──► server/h8identity.js  (ML-DSA65, AES-256-GCM)  │
│    ├──► server/h8token.js     (SHA3-256 hash chain)    │
│    ├──► server/nostr.js       (NIP-01/04/44/19 client) │
│    ├──► server/relay.js       (NIP-01/11 server :4848) │
│    ├──► server/peertube.js    (HTTP federation)        │
│    ├──► server/mastodon.js    (HTTP federation)        │
│    ├──► server/funkwhale.js   (HTTP federation)        │
│    ├──► server/crowdtrain.js  (SQLite + Nostr)         │
│    ├──► server/ai_detector.js (ONNX Runtime)           │
│    ├──► server/badges.js      (SQLite, admin-gated)    │
│    └──► ... (livestream, node_manager, universal_post) │
│                                                        │
│  ws://0.0.0.0:4848  (Embedded Nostr Relay)             │
│    └── WebSocket server, NIP-01 EVENT/REQ/EOSE/CLOSE   │
│        Accessible to external peers                    │
└────────────────────────────────────────────────────────┘
```

## Process model

There is exactly one OS process per user session: the Electron main. The Express server starts **in-process** via `require('./server/index').startServer(port)` — not as a separate child process. The renderer (Chromium) talks to the server via HTTP on `127.0.0.1:8080` only. Cross-origin is impossible by CSP. The server in turn talks to:

- Other Nostr relays (over WebSocket, optionally over Tor SOCKS5)
- PeerTube/Mastodon/Funkwhale instances (over HTTPS, optionally over Tor)
- The local SQLite databases (file IO under `M4TR1X_DATA_DIR`)

**Network exposure:** The Express API binds to `127.0.0.1:8080` (localhost only). The Nostr relay binds to `0.0.0.0:4848`, making it reachable from the local network and — if the user has port-forwarded — from the internet. This is intentional: the relay participates in the peer network.

## Why three layers (Electron, Express, modules)

The temptation in 2026 is to write everything as a single SPA + serverless. That model is wrong here for three reasons:

1. **The renderer must be sandboxed.** Crypto operations, key storage, and ML-DSA65 signing cannot live in a context that can be XSS'd. Electron's contextIsolation + sandbox give us a hard boundary.
2. **The server is the relay AND the API.** Running the relay in-process means a user with M4TR1X is automatically a Nostr peer for everyone they message. That's a property mainstream chat apps cannot have.
3. **Native modules (better-sqlite3, onnxruntime-node) need Node.js.** The browser cannot host these directly without WASM tradeoffs we don't want.

## Identity model

Every user has TWO identities, by design:

- **Nostr nsec** — the public-facing identity used to post, sign DMs, vote on AI labels, list shop items. Generated client-side, stored in a local JSON file. Uses secp256k1 (compatible with the broader Nostr ecosystem).
- **H8 wallet** — the economic identity used to receive tips, send boosts, and accumulate earnings. Generated server-side, post-quantum (ML-DSA65), encrypted with AES-256-GCM + scrypt N=131072. Address format: `H8` + first 38 hex chars of SHA3-256(publicKey) = 40 chars.

Why two? Because the cryptographic requirements are different. Nostr uses secp256k1 for ecosystem compatibility. H8 uses ML-DSA65 for post-quantum security. Mixing them would either downgrade H8's security or make the user incompatible with all other Nostr clients.

A `nostr_<pubkey[:38]>` pseudo-address can receive tips before the user creates an H8 wallet. The claim flow (v2.3.1) lets a Nostr-only user upgrade by creating a wallet and inheriting the accumulated balance.

## Federation strategy

M4TR1X does not run its own video server, music server, or forum server. It federates:

- **Posts and DMs** → Nostr (any compatible relay; bundled with embedded relay on :4848)
- **Videos** → PeerTube (any compatible instance; user picks favorite)
- **Forum/long-form** → Mastodon (any compatible instance)
- **Music** → Funkwhale (any compatible instance)

The user has ONE M4TR1X profile. Behind the scenes, `server/universal_post.js` translates a single user action ("publish this post") into the appropriate per-protocol calls. Per-protocol auth tokens are stored encrypted with AES-256-GCM derived from `APP_SECRET`.

The user never sees the federation complexity. To them it's one feed, one identity.

## Node network

Community nodes advertise four capability types: `film`, `music`, `reels`, `topic`. They are discovered via Nostr (kind:30078 events tagged `m4tr1x-node`). Wallet operations and token transfers route through the private M4TR1X node (`PRIVATE_NODE_URL`) — this separation prevents community node operators from intercepting payment traffic.

## Tor integration

`server/tor.js` checks at startup whether port 9150 (Tor Browser) or 9050 (tor daemon) is reachable on localhost. If yes, all outbound HTTPS and WebSocket connections route through SOCKS5 transparently. If no, the app shows a "Tor not detected" status with a link to bridge configuration.

Bundled bridges: **obfs4**, **Snowflake**, and **meek-azure**. obfs4 disguises Tor as random noise. Snowflake uses WebRTC to blend in with video calls. meek-azure proxies through Microsoft's CDN. Bridge list is updated per release from the Tor Project Bridge Database.

## Storage

Three SQLite databases under `M4TR1X_DATA_DIR` (defaults to process working directory when outside Electron):

- `h8ledger.db` — the H8 hash chain (write-only-append; no UPDATE or DELETE ever issued)
- `m4tr1x.db` — universal post protocol accounts, AI analysis results, badges
- `crowdtrain.db` — votes, reputation scores, model versions

All three run in WAL mode for concurrent reads.

## Network ports

| Port | Protocol | Bound to | Purpose |
|------|----------|----------|---------|
| 8080 | HTTP | 127.0.0.1 | Express API, frontend static files |
| 4848 | WebSocket | 0.0.0.0 | Embedded Nostr relay (peer-accessible) |

## Build & distribution

GitHub Actions matrix builds .deb (Linux), .dmg (macOS), .exe (Windows) on every tag push. SHA-256 checksums are published with each release. The build is fully reproducible from source — the workflow at `.github/workflows/build.yml` is the entire pipeline. No private build steps.

## What's NOT in v2.3.0

- Mobile (Tauri Android/iOS scaffolding exists in `src-tauri/`, builds not yet distributed)
- Automated fiat gateway
- Moderation reporting
- Onboarding wizard
- Auto-update

These are all v2.4+. See [README roadmap](../README.md#status--roadmap).

## Reading order for new contributors

1. `server/index.js` — top of file, top to bottom (route layout gives the full API surface)
2. `server/h8identity.js` — small file, clear shape
3. `server/h8token.js` — the heart of the economy
4. `server/nostr.js` — the heart of the social layer
5. `frontend/index.html` — bottom-up: state object `S`, then per-section render functions
6. `main.js` — Electron security config
7. Federation modules (`mastodon.js`, `peertube.js`, `funkwhale.js`) in any order

Total reading time: ~3 hours.
