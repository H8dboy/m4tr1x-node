<div align="center">

# m4tr1x-node

[![License](https://img.shields.io/github/license/H8dboy/m4tr1x-node)](LICENSE)

**The self-hosted backend that powers the M4TR1X network.**

🌐 **Official site & downloads — [nderja.com](https://nderja.com)**
_M4TR1X is distributed only from nderja.com._

</div>

---

## Why this exists

When regulators want to enforce identity verification on a social platform, they send a letter to the company that runs the servers. M4TR1X has no such company and no such servers — only nodes run by individuals.

The EU's push toward mandatory identity verification for social platforms — through the DSA, age verification proposals, and digital identity schemes — assumes that social infrastructure has a center: a company, a server, a database to hand over. m4tr1x-node is designed to have none of those things. Anyone can run one. No one owns the network.

Every node that comes online makes the network more resilient and harder to disable by targeting a single point. Running a node is not just using the network — it is the network.

---

## What a node does

A M4TR1X node is a self-hosted backend that:

- Runs a **Nostr relay** — receives and stores signed events (posts, messages, metadata) from users
- Runs a **Blossom blob store** — stores binary content (videos, photos, music) addressed by SHA-256 hash
- Serves **HLS video streams** — transcodes and segments video for playback
- Hosts **photo and story posts** — stores and serves image content for feeds and stories
- Runs the **AI detector** — on-node inference to flag AI-generated video content

All content is stored locally on the node operator's machine. There is no central storage. Content is replicated across nodes according to demand.

---

## Node operator economics

Node operators earn **30% of every tip** that passes through their node, paid automatically in H8 tokens at the time of the transaction. No invoicing, no dashboard, no withdrawal request.

---

## Requirements

- Node.js 18+
- ffmpeg (for HLS transcoding)
- Minimum 20 GB disk space (more is better)
- A static IP or dynamic DNS (recommended for public-facing nodes)

---

## Install

```bash
git clone https://github.com/H8dboy/m4tr1x-node.git
cd m4tr1x-node
npm install
cp .env.example .env
```

Edit `.env`:

```env
PORT=8080
NODE_NAME=my-node
HEAD_NODE_URL=http://<head-node-host>:8080   # node directory (optional)
RELAY_PEERS=ws://<peer-host>:4848            # static mesh peers (optional)
```

Start (headless — `npm start` launches the desktop client instead):

```bash
npm run server
```

The node will announce itself to the network and begin accepting connections.

**One-command install (Ubuntu 22.04+ / Debian 12+)** — installs Node.js 20 and
ffmpeg, configures the node and registers it as a systemd service:

```bash
HEAD_NODE_URL=http://<head-host>:8080 NODE_NAME=my-node \
  bash scripts/install-node.sh
```

---

## Relay mesh — how content travels between nodes

Each node runs its own embedded Nostr relay (`ws://<node>:4848`). The **relay
mesh** keeps these relays in sync using only standard NIP-01 messages: every
node opens a persistent subscription to its peers' relays and imports their
events into its own relay, where signatures are verified and duplicates are
dropped. Posts, likes, follows, profiles and ledger blocks propagate across
the whole network while every client keeps talking only to its local relay —
no central server in the data path, works over LAN and clearnet today.

Peers are discovered automatically from the head node directory
(`HEAD_NODE_URL`) and/or configured statically (`RELAY_PEERS`) — a network
can run with no head node at all.

```bash
curl http://localhost:8080/api/v1/mesh/status      # sync status per peer
npm run test:mesh                                  # two-node end-to-end test
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  m4tr1x-node                     │
│                                                  │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ Nostr Relay │  │   Blossom Blob Store     │  │
│  │ (WebSocket) │  │  (SHA-256 addressed)     │  │
│  └──────┬──────┘  └────────────┬─────────────┘  │
│         │                      │                 │
│  ┌──────▼──────────────────────▼─────────────┐  │
│  │              Express API                  │  │
│  │  HLS transcoder │ Photo/story handler     │  │
│  │  Tip processor  │ AI detector bridge      │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │           Tor Hidden Service             │   │
│  │  (automatic if TOR_ENABLED=true)         │   │
│  └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

---

## Modules

| Module | Description |
|--------|-------------|
| `relay/` | Nostr relay — stores and forwards signed events |
| `blossom/` | Blob store — content addressed by SHA-256 |
| `hls/` | Video transcoding and segmented streaming |
| `media/` | Photo and story post handler |
| `ai-detector/` | Bridge to [m4tr1x-ai-detector](https://github.com/H8dboy/m4tr1x-ai-detector) |
| `tips/` | H8 token tip processing and operator payout |
| `tor/` | Tor hidden service management |

---

## Security

- Node identity: **ML-DSA-65 keypair** (NIST FIPS-204)
- All content verified by **SHA-256 hash** before storage
- Nostr events validated against cryptographic signatures before relay
- No user credentials stored on the node — identity lives on the client

---

## Tor routing

Enabled by default. On startup the node creates a Tor hidden service and publishes its `.onion` address to the network. Clients on censored networks route through Tor automatically. Disable with `TOR_ENABLED=false` in `.env`.

---

## Connecting the desktop app

Once your node is running, open the M4TR1X desktop app ([m4tr1x-electron](https://github.com/H8dboy/m4tr1x-electron)) and add your node address under Settings → Nodes.

---

## Full documentation

See [`docs/NODE_OPERATOR.md`](docs/NODE_OPERATOR.md) for the complete setup guide including firewall configuration, storage management, and performance tuning.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to [SECURITY.md](SECURITY.md).

---

## License

MIT — see [LICENSE](LICENSE).

Part of the [M4TR1X project](https://github.com/H8dboy/m4tr1x-electron) — built by [@H8dboy](https://github.com/H8dboy) — Brescia, Italy
