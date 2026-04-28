<div align="center">

# M4TR1X

### The Unfiltered Eye

**Decentralized social network for the liquid individual.**
*Privacy-first. Post-quantum. Tor-ready. No datacenter.*

[![Release](https://img.shields.io/github/v/release/H8dboy/m4tr1x-electron)](https://github.com/H8dboy/m4tr1x-electron/releases)
[![License](https://img.shields.io/github/license/H8dboy/m4tr1x-electron)](LICENSE)
[![Build](https://github.com/H8dboy/m4tr1x-electron/actions/workflows/build.yml/badge.svg)](https://github.com/H8dboy/m4tr1x-electron/actions)

[Download](https://github.com/H8dboy/m4tr1x-electron/releases/latest) · [Run a Node](docs/NODE_OPERATOR.md) · [Architecture](docs/ARCHITECTURE.md) · [Tokenomics](docs/TOKENOMICS.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## Why M4TR1X exists

In 2024, footage of protests in Iran, Belarus, and Hong Kong vanished from Instagram and TikTok within hours. The platforms that monetize attention also have datacenters that governments can compel, subpoena, or shut down. M4TR1X exists because that infrastructure is the wrong infrastructure for documenting truth.

But mainstream social media is broken in another way too. The "liquid individual" of 2026 — the same person is a CNC machinist, a musician, an indie filmmaker, a programmer, a seller of niche products — has to fragment themselves across five platforms. Five algorithms, five 30% revenue cuts, five contradictory profiles. M4TR1X collapses this: one identity, one nickname, one wallet, every form of expression in one place.

The third innovation is economic. The "like" is free, so spam wins. The "tip" costs H8 tokens, so signal wins. The cost itself is the moderation layer — markets filter what algorithms can't, without requiring a Trust & Safety department M4TR1X structurally cannot have.

## What's in v2.3.0 (Developer Preview)

- **Post-quantum identity** — Every account uses ML-DSA65 (NIST FIPS-204). Future quantum computers cannot forge signatures. Secret keys encrypted at rest with AES-256-GCM + scrypt N=131072.
- **Embedded Nostr relay** on `ws://localhost:4848` — Your client IS a relay. Connect, host, replicate.
- **H8 token ledger** — SHA3-256 hash chain, ML-DSA65 signed transactions, verifiable by any client. Tip split 50/20/30 (creator / platform / node operator).
- **Federated content** — Nostr (posts, DMs), PeerTube (videos), Mastodon (forum), Funkwhale (music). All visible from one feed.
- **Marketplace** — Nostr-native, kind:30402. No central listing server. Listings are Nostr events signed with the seller's key.
- **Tor-first** — Auto-detects Tor Browser (port 9150) or tor daemon (port 9050) at launch. Bundled obfs4, Snowflake, and meek-azure bridges for censored networks.
- **Crowdsourced AI deepfake detection** — Users vote, votes go on Nostr, models are retrained and redistributed.
- **DM encryption** — Nostr NIP-44 (ChaCha20-Poly1305 + ECDH secp256k1).
- **Multi-platform** — Linux .deb, macOS .dmg, Windows .exe builds via GitHub Actions.

## Quick start

### Run the prebuilt binary

Download the installer for your OS from [Releases](https://github.com/H8dboy/m4tr1x-electron/releases/latest), verify the SHA-256 against `checksums-*.txt`, and run.

### Build from source

```bash
git clone https://github.com/H8dboy/m4tr1x-electron.git
cd m4tr1x-electron
npm install
cd server && npm install && cd ..
cp .env.example .env  # edit if you want a custom node URL
npm start
```

The app opens on `http://localhost:8080/app`. The Nostr relay listens on `ws://localhost:4848`.

### Run the smoke test

```bash
npm run test:smoke
```

End-to-end test of the H8 ledger: wallet creation, mint, tip with split, boost, chain verification.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Electron main process                      │
│    │  - CSP enforcement                     │
│    │  - Sandboxed renderer (Chromium)       │
│    │  - Tor SOCKS5 auto-detection           │
│    │  - Starts Express server in-process    │
│    ▼                                        │
│  http://127.0.0.1:8080  (Express API)       │
│    │                                        │
│    ├── h8identity.js   ML-DSA65 keypairs    │
│    ├── h8token.js      Hash-chain ledger    │
│    ├── nostr.js        NIP-01/04/44/19      │
│    ├── relay.js        Embedded relay :4848 │
│    ├── peertube.js     Video federation     │
│    ├── mastodon.js     Forum federation     │
│    ├── funkwhale.js    Music federation     │
│    ├── crowdtrain.js   Distributed labels   │
│    ├── ai_detector.js  ONNX deepfake detect │
│    ├── tor.js          SOCKS5 auto-detect   │
│    └── ...                                  │
│                                             │
│  ws://0.0.0.0:4848  (Nostr relay)           │
│    └── NIP-01/11, accessible to peers       │
└─────────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## Project structure

```
m4tr1x-electron/
├── main.js              # Electron main process (CSP, sandbox, Tor detect)
├── preload.js           # contextBridge surface
├── server/
│   ├── index.js         # Express API — 80+ routes
│   ├── h8identity.js    # Post-quantum identity (ML-DSA65)
│   ├── h8token.js       # H8 ledger (hash chain, tip, boost, mint)
│   ├── nostr.js         # Nostr client (NIP-01/04/44/19)
│   ├── relay.js         # Embedded NIP-01/11 relay
│   ├── peertube.js      # PeerTube federation
│   ├── mastodon.js      # Mastodon / ActivityPub
│   ├── funkwhale.js     # Funkwhale music federation
│   ├── universal_post.js # Cross-protocol posting
│   ├── crowdtrain.js    # Crowdsourced AI training
│   ├── ai_detector.js   # ONNX deepfake detector
│   ├── badges.js        # Verified-user badges
│   ├── tor.js           # Tor proxy detection
│   ├── livestream.js    # WebRTC P2P streams
│   ├── node_manager.js  # Node discovery
│   └── core.js          # ExifTool metadata stripping
├── frontend/
│   ├── index.html       # Main app UI
│   ├── auth.html        # Sign in / Register
│   └── admin.html       # Admin panel (localhost only)
├── scripts/
│   └── smoke-test.js    # End-to-end H8 ledger test
└── .github/workflows/
    └── build.yml        # Multi-platform CI
```

## Tokenomics in one paragraph

H8 is a utility closed-credit token (Twitch Bits model). Genesis allocation and minting controlled by the founder key. **This is by design and documented openly** — see [docs/TOKENOMICS.md](docs/TOKENOMICS.md). Tokens are non-transferable outside the M4TR1X economy, which keeps the project outside MiCA scope while preserving full creator monetization. The protocol is open source; the token allocation is sovereign. Same model as Signal (open protocol, central bootstrapping), Mastodon (open code, founder-controlled flagship), early Bitcoin (Satoshi's pre-mine).

## Run a node, earn from tips

Every tip routed through your node earns you 30% of the tip amount automatically. Community nodes advertise capabilities (`film`, `music`, `reels`, `topic`) on the Nostr discovery layer and earn the server share on all content tips they route. Setup takes 5 minutes. See [docs/NODE_OPERATOR.md](docs/NODE_OPERATOR.md).

## Contributing

PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, coding style, and how to claim a `good-first-issue`. Security issues: see [SECURITY.md](SECURITY.md).

## Status & roadmap

**v2.3.0 (current)** — Developer Preview. Stable for self-hosters and contributors. Not yet recommended for high-risk activism.

**v2.3.1** — Pseudo-address claim flow (currently `nostr_*` addresses can receive but not spend until claimed by a real H8 wallet).

**v2.4** — Public Beta. Onboarding wizard, moderation reporting (DSA compliance), password recovery via Nostr nsec, manual fiat gateway documentation, mobile (Tauri Android/iOS) builds.

**v3.0** — Activist-ready. Independent security audit, EFF/Tor Project liaison, multi-language UI, full-disk encryption integration.

## License

MIT. See [LICENSE](LICENSE).

---

<div align="center">

*"In the age of synthetic reality, authenticity is the new resistance."*

Built by [@H8dboy](https://github.com/H8dboy) — Brescia, Italy 🇮🇹

</div>
