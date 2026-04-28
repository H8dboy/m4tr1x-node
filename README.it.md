<div align="center">

# M4TR1X

### L'Occhio Senza Filtri

**Rete sociale decentralizzata per l'individuo liquido.**
*Privacy prima di tutto. Post-quantum. Compatibile con Tor. Nessun datacenter.*

[![Release](https://img.shields.io/github/v/release/H8dboy/m4tr1x-electron)](https://github.com/H8dboy/m4tr1x-electron/releases)
[![License](https://img.shields.io/github/license/H8dboy/m4tr1x-electron)](LICENSE)
[![Build](https://github.com/H8dboy/m4tr1x-electron/actions/workflows/build.yml/badge.svg)](https://github.com/H8dboy/m4tr1x-electron/actions)

> 🇬🇧 [English version](README.md)

[Scarica](https://github.com/H8dboy/m4tr1x-electron/releases/latest) · [Gestisci un nodo](docs/NODE_OPERATOR.md) · [Architettura](docs/ARCHITECTURE.md) · [Tokenomics](docs/TOKENOMICS.md) · [Contribuisci](CONTRIBUTING.md)

</div>

---

## Perché esiste M4TR1X

Nel 2024, i video delle proteste in Iran, Bielorussia e Hong Kong sono spariti da Instagram e TikTok nel giro di poche ore. Le piattaforme che monetizzano l'attenzione hanno anche dei datacenter che i governi possono obbligare, citare in giudizio o spegnere. M4TR1X esiste perché quella infrastruttura è quella sbagliata per documentare la verità.

Ma i social mainstream sono rotti anche in un altro senso. L'individuo liquido del 2026 — la stessa persona è un operatore CNC, un musicista, un filmmaker indipendente, un programmatore, un venditore di prodotti di nicchia — deve frammentarsi su cinque piattaforme. Cinque algoritmi, cinque tagli del 30% sui ricavi, cinque profili contraddittori. M4TR1X collassa tutto questo: un'identità, un nickname, un wallet, ogni forma di espressione in un unico posto.

La terza innovazione è economica. Il "like" è gratis, quindi vince lo spam. Il "tip" costa token H8, quindi vince il segnale. Il costo stesso è il livello di moderazione — il mercato filtra ciò che gli algoritmi non riescono, senza bisogno di un Trust & Safety department che M4TR1X strutturalmente non può avere.

## Cosa c'è nella v2.3.0 (Developer Preview)

- **Identità post-quantum** — Ogni account usa ML-DSA65 (NIST FIPS-204). I computer quantistici futuri non potranno falsificare le firme. Le chiavi segrete sono cifrate a riposo con AES-256-GCM + scrypt N=131072.
- **Relay Nostr embedded** su `ws://localhost:4848` — Il tuo client È un relay. Connettiti, ospita, replica.
- **Ledger token H8** — Hash chain SHA3-256, transazioni firmate ML-DSA65, verificabili da qualsiasi client. Split dei tip 50/20/30 (creator / piattaforma / operatore nodo).
- **Contenuto federato** — Nostr (post, DM), PeerTube (video), Mastodon (forum), Funkwhale (musica). Tutto visibile da un unico feed.
- **Marketplace** — Nativo Nostr, kind:30402. Nessun server di listing centrale. Gli annunci sono eventi Nostr firmati con la chiave del venditore.
- **Tor-first** — Rileva automaticamente Tor Browser (porta 9150) o il demone tor (porta 9050) all'avvio. Bridge integrati obfs4, Snowflake e meek-azure per reti censurate.
- **Rilevamento deepfake AI crowdsourced** — Gli utenti votano, i voti vanno su Nostr, i modelli vengono riaddestrati e ridistribuiti.
- **Cifratura DM** — Nostr NIP-44 (ChaCha20-Poly1305 + ECDH secp256k1).
- **Multi-piattaforma** — Build Linux .deb, macOS .dmg, Windows .exe via GitHub Actions.

## Quick start

### Esegui il binario precompilato

Scarica l'installer per il tuo sistema operativo dalle [Release](https://github.com/H8dboy/m4tr1x-electron/releases/latest), verifica il SHA-256 contro `checksums-*.txt` ed esegui.

### Compila dal sorgente

```bash
git clone https://github.com/H8dboy/m4tr1x-electron.git
cd m4tr1x-electron
npm install
cd server && npm install && cd ..
cp .env.example .env  # modifica se vuoi un URL nodo personalizzato
npm start
```

L'app si apre su `http://localhost:8080/app`. Il relay Nostr è in ascolto su `ws://localhost:4848`.

### Esegui lo smoke test

```bash
npm run test:smoke
```

Test end-to-end del ledger H8: creazione wallet, mint, tip con split, boost, verifica della catena.

## Architettura

```
┌─────────────────────────────────────────────┐
│  Processo principale Electron               │
│    │  - Enforcement CSP                     │
│    │  - Renderer sandboxed (Chromium)       │
│    │  - Auto-rilevamento SOCKS5 Tor         │
│    │  - Avvia il server Express in-process  │
│    ▼                                        │
│  http://127.0.0.1:8080  (Express API)       │
│    │                                        │
│    ├── h8identity.js   Keypair ML-DSA65     │
│    ├── h8token.js      Ledger hash chain    │
│    ├── nostr.js        NIP-01/04/44/19      │
│    ├── relay.js        Relay embedded :4848 │
│    ├── peertube.js     Federazione video    │
│    ├── mastodon.js     Federazione forum    │
│    ├── funkwhale.js    Federazione musica   │
│    ├── crowdtrain.js   Label distribuiti    │
│    ├── ai_detector.js  Rilevamento ONNX     │
│    ├── tor.js          Auto-detect SOCKS5   │
│    └── ...                                  │
│                                             │
│  ws://0.0.0.0:4848  (Relay Nostr)           │
│    └── NIP-01/11, accessibile ai peer       │
└─────────────────────────────────────────────┘
```

Vedi [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) per i dettagli completi.

## Struttura del progetto

```
m4tr1x-electron/
├── main.js              # Processo principale Electron (CSP, sandbox, Tor)
├── preload.js           # Superficie contextBridge
├── server/
│   ├── index.js         # Express API — 80+ route
│   ├── h8identity.js    # Identità post-quantum (ML-DSA65)
│   ├── h8token.js       # Ledger H8 (hash chain, tip, boost, mint)
│   ├── nostr.js         # Client Nostr (NIP-01/04/44/19)
│   ├── relay.js         # Relay NIP-01/11 embedded
│   ├── peertube.js      # Federazione PeerTube
│   ├── mastodon.js      # Mastodon / ActivityPub
│   ├── funkwhale.js     # Federazione musica Funkwhale
│   ├── universal_post.js # Post cross-protocollo
│   ├── crowdtrain.js    # Training AI crowdsourced
│   ├── ai_detector.js   # Rilevatore deepfake ONNX
│   ├── badges.js        # Badge utenti verificati
│   ├── tor.js           # Rilevamento proxy Tor
│   ├── livestream.js    # Stream P2P WebRTC
│   ├── node_manager.js  # Scoperta nodi
│   └── core.js          # Rimozione metadati ExifTool
├── frontend/
│   ├── index.html       # UI principale dell'app
│   ├── auth.html        # Accesso / Registrazione
│   └── admin.html       # Pannello admin (solo localhost)
├── scripts/
│   └── smoke-test.js    # Test end-to-end ledger H8
└── .github/workflows/
    └── build.yml        # CI multi-piattaforma
```

## Tokenomics in un paragrafo

H8 è un token di utilità a credito chiuso (modello Twitch Bits). L'allocazione genesis e il mint sono controllati dalla chiave del founder. **Questo è by design ed è documentato apertamente** — vedi [docs/TOKENOMICS.md](docs/TOKENOMICS.md). I token non sono trasferibili fuori dall'economia M4TR1X, il che mantiene il progetto fuori dal perimetro MiCA preservando al contempo la monetizzazione completa dei creator. Il protocollo è open source; l'allocazione del token è sovrana. Stesso modello di Signal (protocollo aperto, bootstrap centralizzato), Mastodon (codice aperto, flagship controllato dal founder), Bitcoin delle origini (pre-mine di Satoshi).

## Gestisci un nodo, guadagna dai tip

Ogni tip instradato attraverso il tuo nodo ti accredita automaticamente il 30% dell'importo. I nodi community pubblicizzano le loro capacità (`film`, `music`, `reels`, `topic`) sul layer di discovery Nostr e guadagnano la quota server su tutti i tip di contenuto che elaborano. La configurazione richiede 5 minuti. Vedi [docs/NODE_OPERATOR.md](docs/NODE_OPERATOR.md).

## Contribuire

Le PR sono benvenute. Leggi [CONTRIBUTING.md](CONTRIBUTING.md) per la nomenclatura dei branch, lo stile del codice e come rivendicare una `good-first-issue`. Problemi di sicurezza: vedi [SECURITY.md](SECURITY.md).

## Stato & roadmap

**v2.3.0 (attuale)** — Developer Preview. Stabile per self-hoster e contributor. Non ancora raccomandato per attivismo ad alto rischio.

**v2.3.1** — Claim flow per pseudo-address (attualmente gli indirizzi `nostr_*` possono ricevere ma non spendere finché non vengono reclamati da un wallet H8 reale).

**v2.4** — Public Beta. Wizard di onboarding, segnalazione moderazione (conformità DSA), recupero password via Nostr nsec, documentazione gateway fiat manuale, build mobile (Tauri Android/iOS).

**v3.0** — Pronto per l'attivismo. Audit di sicurezza indipendente, liaison con EFF/Tor Project, UI multilingua, integrazione cifratura disco completo.

## Licenza

MIT. Vedi [LICENSE](LICENSE).

---

<div align="center">

*"Nell'era della realtà sintetica, l'autenticità è la nuova resistenza."*

Creato da [@H8dboy](https://github.com/H8dboy) — Brescia, Italia 🇮🇹

</div>
