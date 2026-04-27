# Changelog

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
