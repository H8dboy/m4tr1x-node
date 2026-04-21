# M4TR1X v2.0 — Electron

> **Decentralized social network for authentic video documentation.**
> Zero cloud. Zero Python. L'utente scarica l'app e tutto gira in locale.

---

## Stack tecnico

| Layer | Tecnologia |
|---|---|
| Desktop | Electron + Node.js |
| AI detection | ONNX Runtime (EfficientNet-B0) |
| Crittografia | AES-256-GCM + scrypt, ML-DSA65 (post-quantum) |
| Database | SQLite (better-sqlite3) |
| Identità | H8 Identity — keypair ML-DSA65 (NIST FIPS-204) |
| Token | H8 Token — ledger a hash chain locale |
| Social | Nostr (NIP-01, NIP-44, NIP-19), Mastodon, PeerTube, Funkwhale |
| Privacy | Tor (auto-detect SOCKS5), pulizia metadati ExifTool |

---

## Prerequisiti (sviluppo)

- **Node.js** 18+
- **ffmpeg** — incluso automaticamente via `ffmpeg-static` dopo `npm install`
- **ExifTool** (opzionale) — pulizia metadati GPS/EXIF → https://exiftool.org

---

## Installazione e avvio

```bash
npm install
cp .env.example .env   # opzionale — configura ADMIN_KEY, H8_PLATFORM_ADDRESS, ecc.
npm start
```

L'app si apre come finestra desktop. Il server API locale gira su `http://localhost:8080`.

---

## H8 Identity (post-quantum)

Ogni utente M4TR1X ha un **H8-ID** derivato da una keypair **ML-DSA65** (CRYSTALS-Dilithium, NIST FIPS-204 — resistente a computer quantistici).

```
H8 Address = 'H8' + SHA3-256(publicKey)[0:38]   → 40 caratteri
```

- Il secret key è cifrato a riposo con **AES-256-GCM + scrypt** (password utente)
- In sessione, l'identità sbloccata vive in memoria — si blocca alla chiusura dell'app
- Firma digitale ML-DSA65 su ogni transazione H8

---

## H8 Token

Token nativo della piattaforma — ledger locale a **hash chain** (ogni blocco contiene SHA3-256 del precedente).

| Parametro | Valore |
|---|---|
| Unità | 1 H8 = 100 centesimi H8 |
| Supply | Controllata — solo la mint key di H8-Group può coniare |
| Split tip | 50% creator · 20% piattaforma · 30% server operator |
| Split shop | 85% venditore · 10% piattaforma · 5% server operator |

La catena è verificabile localmente: manomettere un blocco invalida tutta la catena successiva.

---

## Modello AI (ONNX)

Rileva video AI-generated via EfficientNet-B0. Senza il file ONNX, la detection gira in modalità **UNCERTAIN** — nessun crash.

```bash
# Se hai il progetto Python v1:
cd m4tr1x-python
python ai_detector.py --export-onnx
cp models/m4tr1x_detector.onnx ../m4tr1x-electron/models/
```

---

## Struttura progetto

```
m4tr1x-electron/
├── main.js               # Electron entry point + sicurezza CSP/Tor
├── preload.js            # Bridge sicuro renderer ↔ main (contextBridge)
├── server/
│   ├── index.js          # Express API server — tutte le route
│   ├── h8identity.js     # Identità post-quantum (ML-DSA65)
│   ├── h8token.js        # Ledger H8 (hash chain, mint, transfer, tip, boost)
│   ├── badges.js         # Badge utente (richiesta, approvazione admin)
│   ├── ai_detector.js    # ONNX AI detector
│   ├── core.js           # Pulizia metadati ExifTool
│   ├── db.js             # SQLite risultati analisi
│   ├── shop.js           # Shop decentralizzato (H8 token)
│   ├── nostr.js          # Nostr (NIP-01, NIP-44, NIP-19)
│   ├── mastodon.js       # Mastodon / ActivityPub
│   ├── peertube.js       # PeerTube
│   ├── funkwhale.js      # Funkwhale (musica)
│   └── tor.js            # Rilevamento e configurazione Tor
├── frontend/
│   ├── index.html        # App principale (feed, forum, shop, DM)
│   ├── auth.html         # Autenticazione
│   ├── admin.html        # Pannello admin (solo localhost)
│   ├── loading.html      # Schermata caricamento
│   └── safety.html       # Guida sicurezza (6 lingue)
├── models/
│   └── m4tr1x_detector.onnx
└── uploads/
```

---

## API — server locale `http://localhost:8080`

### Core

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET  | `/health` | Health check |
| POST | `/api/v1/analyze` | Upload + analisi video (multipart `video`) |
| GET  | `/api/v1/analysis/:id` | Risultato analisi per ID |
| GET  | `/api/v1/analyses` | Lista risultati (`?limit=N`) |

### H8 Identity & Wallet

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET  | `/api/v1/h8/wallet/status` | Stato wallet (esiste? saldo? bloccato?) |
| POST | `/api/v1/h8/wallet/create` | Crea identità H8 (`{ password }`) |
| POST | `/api/v1/h8/wallet/unlock` | Sblocca sessione (`{ password }`) |
| POST | `/api/v1/h8/wallet/lock` | Blocca sessione |
| GET  | `/api/v1/h8/balance` | Saldo H8 dell'identità attiva |
| GET  | `/api/v1/h8/history` | Storico transazioni (`?limit=N`) |
| POST | `/api/v1/h8/transfer` | Invia H8 (`{ toAddress, amount, note }`) |
| POST | `/api/v1/h8/tip` | Tip a creator (`{ creatorAddress, amount, contentId }`) |
| POST | `/api/v1/h8/boost` | Boost contenuto (`{ contentId, amount }`) |
| GET  | `/api/v1/h8/boost/:contentId` | Score boost di un contenuto |
| GET  | `/api/v1/h8/chain/verify` | Verifica integrità dell'intera catena |

### Shop Decentralizzato (H8)

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET    | `/api/v1/shop/listings` | Lista prodotti (`?category=...&limit=N`) |
| GET    | `/api/v1/shop/listings/:id` | Dettaglio prodotto |
| POST   | `/api/v1/shop/listings` | Crea prodotto (`{ sellerPubkey, title, priceH8, ... }`) |
| DELETE | `/api/v1/shop/listings/:id` | Disattiva prodotto |
| POST   | `/api/v1/shop/orders` | Acquisto (`{ listingId, buyerPubkey }`) — pagamento H8 istantaneo |
| GET    | `/api/v1/shop/orders/:id` | Dettaglio ordine |

### Badge Utente

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| POST | `/api/v1/badge/request` | Richiedi badge (upload documento) |
| GET  | `/api/v1/badge/:pubkey` | Badge approvato di un utente |
| GET  | `/api/v1/badge/my/:pubkey` | Stato richiesta corrente |
| GET  | `/api/v1/admin/badges` | Lista richieste (solo admin/localhost) |
| POST | `/api/v1/admin/badge/:id/approve` | Approva badge (solo admin) |
| POST | `/api/v1/admin/badge/:id/reject` | Rifiuta badge (solo admin) |

### Training Crowd

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| POST | `/api/v1/train/vote` | Vota autenticità video (`{ videoHash, label }`) |
| GET  | `/api/v1/train/stats/:videoHash` | Stats voti per hash |
| GET  | `/api/v1/train/stats` | Stats globali |
| GET  | `/api/v1/train/leaderboard` | Classifica contributor |
| GET  | `/api/v1/train/labels` | Export label (admin) |
| POST | `/api/v1/train/sync` | Sincronizza dataset da peer |
| GET  | `/api/v1/train/model/latest` | Versione modello corrente |
| POST | `/api/v1/train/model/update` | Aggiorna modello (admin) |

### Nostr

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| POST | `/api/v1/nostr/keys` | Genera keypair Nostr |
| POST | `/api/v1/nostr/load-keys` | Carica chiavi (`{ privkey }`) |
| GET  | `/api/v1/nostr/relays` | Lista relay attivi |
| GET  | `/api/v1/nostr/feed` | Feed (`?tags=...&limit=N`) |
| POST | `/api/v1/nostr/post` | Pubblica nota |
| POST | `/api/v1/nostr/profile` | Pubblica profilo (kind:0) |
| POST | `/api/v1/nostr/dm` | Invia DM cifrato NIP-44 |
| GET  | `/api/v1/nostr/dm/:pubkey` | Fetch DM con una pubkey |

### Mastodon

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET  | `/api/v1/mastodon/timeline` | Timeline pubblica |
| GET  | `/api/v1/mastodon/hashtag/:tag` | Cerca hashtag |
| GET  | `/api/v1/mastodon/search` | Ricerca testo |
| POST | `/api/v1/mastodon/post` | Pubblica post |

### PeerTube

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/v1/peertube/videos` | Video recenti |
| GET | `/api/v1/peertube/search` | Cerca video |
| GET | `/api/v1/peertube/video/:instance/:uuid` | Dettaglio video |
| GET | `/api/v1/peertube/instances` | Scopri istanze |

### Funkwhale (Musica)

| Method | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/v1/music/tracks` | Tracce recenti |
| GET | `/api/v1/music/search` | Cerca tracce |
| GET | `/api/v1/music/albums` | Album recenti |
| GET | `/api/v1/music/channels` | Canali / artisti |
| GET | `/api/v1/music/instances` | Scopri istanze |

---

## Build distribuzione

```bash
npm run build:win    # Windows (.exe)
npm run build:mac    # macOS (.dmg)
npm run build:linux  # Linux (.AppImage)
```

---

## Variabili d'ambiente (`.env`)

```env
ADMIN_KEY=                    # chiave per endpoint admin — OBBLIGATORIA in produzione
H8_PLATFORM_ADDRESS=          # H8 address della piattaforma (split fee)
H8_SERVER_ADDRESS=            # H8 address del server operator (split fee)
API_KEY=                      # chiave API opzionale per proteggere le route
PORT=8080
```

---

## Sicurezza

- **H8 Identity**: secret key cifrato AES-256-GCM + scrypt — mai trasmesso in chiaro
- **Firme post-quantum**: ogni transazione firmata ML-DSA65 (resistente a QC)
- **Nostr privkey**: in `sessionStorage`, mai inviata al server
- **Tor**: se `tor` è attivo al lancio, tutto il traffico passa via SOCKS5 automaticamente
- **Metadati video**: rimossi via ExifTool prima dell'analisi
- **Admin endpoint**: `localhostOnly` + `ADMIN_KEY` — non esposti su rete

---

> *"In the age of synthetic reality, authenticity is the new resistance."*
> **For the Truth. 👁️**
