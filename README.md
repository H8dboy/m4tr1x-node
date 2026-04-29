<div align="center">

# M4TR1X

[![Release](https://img.shields.io/github/v/release/H8dboy/m4tr1x-electron)](https://github.com/H8dboy/m4tr1x-electron/releases)
[![License](https://img.shields.io/github/license/H8dboy/m4tr1x-electron)](LICENSE)
[![Build](https://github.com/H8dboy/m4tr1x-electron/actions/workflows/build.yml/badge.svg)](https://github.com/H8dboy/m4tr1x-electron/actions)

</div>

M4TR1X is a decentralized social network. It runs on a network of community nodes — regular computers that anyone can set up — with no central server, no company behind it, and no algorithm deciding what you see.

You create one account. With that account you can post text, upload videos, share music, write in forums, send encrypted messages, and sell things — all in the same place. Your identity is tied to a cryptographic key that only you control, not to an email address or a phone number registered with a platform.

Content lives on nodes, not on a datacenter. When you upload a video it goes to a node on the M4TR1X network and stays there. Node operators earn 30% of every tip that passes through their node automatically.

The tipping currency is the H8 token — a closed utility token that only exists inside M4TR1X. Tipping costs something, so signal beats spam without needing a moderation team.

The network runs over Tor by default. If you are on a censored network, M4TR1X detects it and routes through Tor automatically.

---

## What you need to know before running it

**This is a Developer Preview (v2.3.0).** It is stable enough to self-host and contribute to. It is not yet recommended for high-risk use cases.

Every account uses ML-DSA65 post-quantum signatures (NIST FIPS-204). Your private key is encrypted on disk with AES-256-GCM. There is no account recovery if you lose your password — keep it safe.

---

## Install

Download the binary for your OS from [Releases](https://github.com/H8dboy/m4tr1x-electron/releases/latest) and run it. Verify the SHA-256 against `checksums-*.txt` before running.

Supported: Windows, macOS (Intel + Apple Silicon), Linux (Debian/Ubuntu).

## Build from source

```bash
git clone https://github.com/H8dboy/m4tr1x-electron.git
cd m4tr1x-electron
npm install
cd server && npm install && cd ..
cp .env.example .env
npm start
```

The app runs at `http://localhost:8080/app`.

## Run a node

Anyone can run a node. A node stores content (videos, music, posts) locally and makes it available to the network. Node operators earn 30% of tips automatically.

See [docs/NODE_OPERATOR.md](docs/NODE_OPERATOR.md) for setup instructions.

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
│    ├── relay.js        Embedded relay :4848 │
│    ├── peertube.js     Local video storage  │
│    ├── mastodon.js     Local forum storage  │
│    ├── funkwhale.js    Local music storage  │
│    ├── crowdtrain.js   Distributed labels   │
│    ├── ai_detector.js  ONNX deepfake detect │
│    ├── tor.js          SOCKS5 auto-detect   │
│    └── node_manager.js Node discovery       │
│                                             │
│  ws://0.0.0.0:4848  (M4TR1X relay)          │
│    └── accessible to M4TR1X peers only      │
└─────────────────────────────────────────────┘
```

Full details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tokenomics

H8 is a utility token that only works inside M4TR1X, similar to how Twitch Bits work inside Twitch. You cannot trade it on exchanges. Minting is controlled by the founder key. The full model is documented in [docs/TOKENOMICS.md](docs/TOKENOMICS.md).

## Roadmap

**v2.3.0** — Developer Preview. First public node live.

**v2.3.1** — Upload access restricted to verified M4TR1X accounts.

**v2.4** — Public Beta. Onboarding wizard, DSA compliance reporting, mobile builds (Android/iOS).

**v3.0** — Independent security audit, multi-language UI, full-disk encryption integration.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

---

<div align="center">

Built by [@H8dboy](https://github.com/H8dboy) — Brescia, Italy 🇮🇹

</div>
