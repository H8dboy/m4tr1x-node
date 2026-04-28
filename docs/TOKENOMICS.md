# H8 Token — Tokenomics

This document explains the H8 token honestly. There is no whitepaper magic, no decentralized governance theatre, no "community-owned protocol" hand-waving. H8 is a utility credit, the founder controls the mint key, and that is the correct architecture for a project at this stage. Read on for why.

## What H8 is

- **A utility closed-credit token.** Equivalent in legal classification to Twitch Bits, Roblox Robux, or a prepaid arcade token.
- **Non-transferable outside M4TR1X.** You cannot withdraw H8 to an exchange. There is no on-chain bridge. There is no stablecoin pair.
- **Denominated in cents internally.** 1 H8 = 100 ledger units. The smallest tip is 1 unit (0.01 H8).
- **Recorded on a hash-chained ledger.** Every transaction is signed with ML-DSA65 (post-quantum) and chained with SHA3-256. Anyone can verify the entire chain integrity by calling `/api/v1/h8/chain/verify`.

H8 address format: `H8` + first 38 hex chars of `SHA3-256(publicKey)` — 40 characters total.

## What H8 is NOT

- Not a cryptocurrency
- Not an investment
- Not subject to MiCA (because it's closed-loop, not transferable)
- Not pegged to anything
- Not on any blockchain

## Mint authority

The mint key is held by the founder (Arif Harizi / H8dboy). Only the admin endpoint (`POST /api/v1/admin/h8/mint`) with a valid `ADMIN_KEY` can issue new H8 into circulation. This endpoint is restricted to localhost only. This is the same architecture as:

- **Signal** — open protocol, founder controls the registration server
- **Bitcoin** — open protocol, Satoshi pre-mined approximately 1M BTC
- **Ethereum** — open protocol, Foundation pre-allocated 70M ETH
- **Mastodon** — open code, Eugen Rochko controls mastodon.social
- **Roblox** — closed credit, Roblox Corp controls Robux issuance

Decentralization without sovereignty in the bootstrap phase produces dead networks. See Diaspora, Urbit, SSB. Decentralization with sovereign founders during bootstrap, transitioning out as the network matures, produces working networks. This project chose the second path deliberately.

## Where H8 comes from (issuance)

In v2.3.0:

1. **Manual mint by founder.** The founder issues H8 in exchange for fiat (SEPA, wire transfer, manual P2P). The audit trail is the ledger itself — every mint is a signed `mint` transaction visible to anyone with chain access.
2. **Server operator share.** Every tip processed through a node automatically credits 30% to the node's `H8_SERVER_ADDRESS`.

In v2.4 (planned):

3. **Documented manual fiat gateway.** Public process for purchasing H8: send EUR via SEPA to a published IBAN, receive H8 within 24h. Conversion rate fixed by founder, posted publicly, updated quarterly.

## Where H8 goes (flow)

Every tip splits automatically into three:

```
Tip 1000 H8 →
  ├── 50% → creator             (500 H8)
  ├── 20% → platform (founder)  (200 H8)
  └── 30% → server operator     (300 H8)
```

These splits are hard-coded in `server/h8token.js` and verifiable in source. Each leg is a separate signed ledger block.

Boost (visibility purchase):

```
Boost 500 H8 →
  └── 100% → platform            (boost score is the only proof of impact)
```

## Founder allocation rationale

The founder's 20% tip cut pays for:

- Software development (full-time work on M4TR1X)
- Legal and tax compliance in the EU
- Domain, code-signing certificates, infrastructure for the build pipeline
- Eventually: dedicated security audit, contractor payments

This is transparent and explicit. There is no "community treasury" hiding a wage. There is the founder, doing the work, getting paid for it.

## Lock-in vs. exit

You can leave M4TR1X at any time. Your H8 balance does not transfer out. This is a feature, not a bug — it's what keeps the project outside MiCA, what keeps the economy stable (no speculation), and what keeps incentives aligned with using the platform rather than extracting from it.

If the founder ever attempts to inflate H8 or otherwise abuse the mint key, the ledger is verifiable. Bad behavior is provable. The exit is forking the protocol — the code is MIT, the protocol is open. The brand and mint authority are not.

## Genesis allocation

The genesis block is:

```
block_index: 1
from: 0x0
to: H8_MINT_ADDRESS (founder)
amount: 0
tx_type: mint
note: "genesis"
```

Zero pre-allocation. All H8 in circulation is minted in response to user purchases and operator earnings. Verify the chain at any time:

```bash
curl http://localhost:8080/api/v1/h8/chain/verify
# {"valid": true, "blocks": N}
```

Returns `firstInvalidBlock` if any signature, hash link, or balance check fails.

## Questions

Open an issue with the `tokenomics` label.
