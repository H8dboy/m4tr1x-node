/**
 * H8 Coin (H8C) — M4TR1X Native Currency
 *
 * Rules (immutable after genesis):
 *   - Total supply:   100,000,000 H8C (hard cap)
 *   - Alpha node:      50,000,000 H8C → founder pre-mint (alpha launch)
 *   - Network reserve: 50,000,000 H8C → distributed via purchases & node rewards
 *   - Decimals:        8 (smallest unit = 0.00000001 H8C)
 *   - Signing:         secp256k1 (same keypair as Nostr identity)
 *   - Model:           account-based ledger (address → balance in satoshis)
 *   - No inflation:    no new coins after genesis, ever
 *
 * Transaction flow:
 *   sender signs tx → node verifies sig + balance → updates ledger → broadcasts via Nostr
 */

'use strict'

const crypto   = require('crypto')
const fs       = require('fs')
const path     = require('path')
const Database = require('better-sqlite3')
const secp     = require('@noble/secp256k1')
const { sha256 }      = require('@noble/hashes/sha256')
const { hmac }        = require('@noble/hashes/hmac')
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils')

// Wire up synchronous hash for secp256k1 v3 verify
secp.hashes.sha256      = sha256
secp.hashes.hmacSha256  = (k, ...msgs) => hmac(sha256, k, secp.etc.concatBytes(...msgs))

// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_SUPPLY_SAT  = 10_000_000_000_000_000n  // 100,000,000 H8C in satoshis
const FOUNDER_ALLOC_SAT =  5_000_000_000_000_000n  //  50,000,000 H8C — alpha node pre-mint
const RESERVE_ALLOC_SAT =  5_000_000_000_000_000n  //  50,000,000 H8C — network reserve (purchases + rewards)
const DECIMALS          = 8
const COIN              = 100_000_000n              // 1 H8C = 1e8 satoshis
const GENESIS_VERSION   = 1
const COIN_NAME         = 'H8 Coin'
const COIN_SYMBOL       = 'H8C'

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x')
const DB_PATH   = path.join(DATA_DIR, 'h8coin.db')
const GENESIS_PATH = path.join(DATA_DIR, 'h8coin_genesis.json')

// ─── DB ───────────────────────────────────────────────────────────────────────
let _db = null
function getDb() {
  if (!_db) _db = new Database(DB_PATH)
  return _db
}

function initCoinDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      address    TEXT PRIMARY KEY,
      balance    TEXT NOT NULL DEFAULT '0',
      nonce      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      txid       TEXT PRIMARY KEY,
      from_addr  TEXT NOT NULL,
      to_addr    TEXT NOT NULL,
      amount_sat TEXT NOT NULL,
      fee_sat    TEXT NOT NULL DEFAULT '0',
      nonce      INTEGER NOT NULL,
      memo       TEXT DEFAULT '',
      signature  TEXT NOT NULL,
      pubkey     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      block_idx  INTEGER DEFAULT 0,
      status     TEXT DEFAULT 'confirmed'
    );
    CREATE TABLE IF NOT EXISTS genesis (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      version    INTEGER NOT NULL,
      founder_address TEXT NOT NULL,
      reserve_address TEXT NOT NULL,
      total_supply    TEXT NOT NULL,
      founder_alloc   TEXT NOT NULL,
      reserve_alloc   TEXT NOT NULL,
      genesis_hash    TEXT NOT NULL,
      founder_pubkey  TEXT NOT NULL,
      signature       TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_addr);
    CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_addr);
    CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(created_at);
  `)
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

// hex privkey → hex pubkey (compressed, 33 bytes)
function privkeyToPubkey(privkeyHex) {
  return bytesToHex(secp.getPublicKey(hexToBytes(privkeyHex), true))
}

// pubkey (compressed hex) → H8C address (h8c1<hash160>)
function pubkeyToAddress(pubkeyHex) {
  const pub  = hexToBytes(pubkeyHex)
  const hash = sha256(pub)
  // second hash with crypto (RIPEMD-160 not in noble, use sha256 double)
  const hash2 = crypto.createHash('sha256').update(hash).digest()
  const hash3 = crypto.createHash('sha256').update(hash2).digest().slice(0, 20)
  return 'h8c1' + hash3.toString('hex')
}

// Sign a message — sha256 the payload ourselves, tell secp prehash:false
async function sign(privkeyHex, message) {
  const msgBytes = sha256(Buffer.from(JSON.stringify(message)))
  const sigBytes = await secp.signAsync(msgBytes, hexToBytes(privkeyHex), { prehash: false })
  return bytesToHex(sigBytes)
}

// Verify compact hex signature
function verify(pubkeyHex, message, sigHex) {
  try {
    const msgBytes = sha256(Buffer.from(JSON.stringify(message)))
    return secp.verify(hexToBytes(sigHex), msgBytes, hexToBytes(pubkeyHex), { prehash: false })
  } catch { return false }
}

// Deterministic TXID
function makeTxid(tx) {
  const data = `${tx.from}:${tx.to}:${tx.amount}:${tx.nonce}:${tx.created_at}`
  return bytesToHex(sha256(Buffer.from(data)))
}

// Genesis hash — SHA256 of all genesis params
function makeGenesisHash(params) {
  return bytesToHex(sha256(Buffer.from(JSON.stringify(params))))
}

// ─── Ledger ───────────────────────────────────────────────────────────────────
function getBalance(address) {
  const row = getDb().prepare('SELECT balance FROM ledger WHERE address=?').get(address)
  return row ? BigInt(row.balance) : 0n
}

function getNonce(address) {
  const row = getDb().prepare('SELECT nonce FROM ledger WHERE address=?').get(address)
  return row ? row.nonce : 0
}

function creditAddress(address, amountSat) {
  const cur = getBalance(address)
  const newBal = cur + amountSat
  getDb().prepare(`
    INSERT INTO ledger (address, balance, nonce) VALUES (?, ?, 0)
    ON CONFLICT(address) DO UPDATE SET balance=?, updated_at=strftime('%s','now')
  `).run(address, String(newBal), String(newBal))
}

function debitAddress(address, amountSat) {
  const cur = getBalance(address)
  if (cur < amountSat) throw new Error('INSUFFICIENT_FUNDS')
  const newBal = cur - amountSat
  getDb().prepare("UPDATE ledger SET balance=?, updated_at=strftime('%s','now') WHERE address=?")
    .run(String(newBal), address)
}

// ─── Genesis ──────────────────────────────────────────────────────────────────

function isGenesisCreated() {
  initCoinDb()
  const row = getDb().prepare('SELECT id FROM genesis WHERE id=1').get()
  return !!row
}

async function createGenesis(founderPrivkeyHex) {
  initCoinDb()
  if (isGenesisCreated()) throw new Error('GENESIS_ALREADY_EXISTS')

  const founderPubkey  = privkeyToPubkey(founderPrivkeyHex)
  const founderAddress = pubkeyToAddress(founderPubkey)

  // Reserve address — derived from "h8c:reserve" constant string (no one holds the key)
  const reserveHash = sha256(Buffer.from('h8coin:network:reserve:v1'))
  const reserveAddress = 'h8c1' + Buffer.from(reserveHash).slice(0, 20).toString('hex')

  const genesisParams = {
    version:          GENESIS_VERSION,
    coin:             COIN_SYMBOL,
    total_supply:     String(TOTAL_SUPPLY_SAT),
    founder_address:  founderAddress,
    founder_alloc:    String(FOUNDER_ALLOC_SAT),
    reserve_address:  reserveAddress,
    reserve_alloc:    String(RESERVE_ALLOC_SAT),
    decimals:         DECIMALS,
    created_at:       Math.floor(Date.now() / 1000),
    immutable:        true,
  }

  const genesisHash = makeGenesisHash(genesisParams)
  const signature   = await sign(founderPrivkeyHex, { genesis: genesisHash })

  // Write to DB (only once, ever)
  const db = getDb()
  db.transaction(() => {
    // Record genesis
    db.prepare(`
      INSERT INTO genesis
        (id, version, founder_address, reserve_address, total_supply,
         founder_alloc, reserve_alloc, genesis_hash, founder_pubkey, signature, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      GENESIS_VERSION,
      founderAddress, reserveAddress,
      String(TOTAL_SUPPLY_SAT), String(FOUNDER_ALLOC_SAT), String(RESERVE_ALLOC_SAT),
      genesisHash, founderPubkey, signature,
      genesisParams.created_at
    )

    // Mint to founder
    creditAddress(founderAddress, FOUNDER_ALLOC_SAT)

    // Mint to reserve
    creditAddress(reserveAddress, RESERVE_ALLOC_SAT)

    // Genesis transactions
    const founderTxid = bytesToHex(sha256(Buffer.from('genesis:founder:' + founderAddress)))
    const reserveTxid = bytesToHex(sha256(Buffer.from('genesis:reserve:' + reserveAddress)))

    db.prepare(`
      INSERT OR IGNORE INTO transactions
        (txid, from_addr, to_addr, amount_sat, fee_sat, nonce, memo, signature, pubkey, created_at, block_idx)
      VALUES (?, 'genesis', ?, ?, '0', 0, 'Genesis founder allocation', ?, ?, ?, 0)
    `).run(founderTxid, founderAddress, String(FOUNDER_ALLOC_SAT), signature, founderPubkey, genesisParams.created_at)

    db.prepare(`
      INSERT OR IGNORE INTO transactions
        (txid, from_addr, to_addr, amount_sat, fee_sat, nonce, memo, signature, pubkey, created_at, block_idx)
      VALUES (?, 'genesis', ?, ?, '0', 0, 'Genesis network reserve', ?, ?, ?, 0)
    `).run(reserveTxid, reserveAddress, String(RESERVE_ALLOC_SAT), signature, founderPubkey, genesisParams.created_at)
  })()

  // Persist genesis file (immutable record)
  const genesisRecord = { ...genesisParams, genesis_hash: genesisHash, signature, founder_pubkey: founderPubkey }
  fs.writeFileSync(GENESIS_PATH, JSON.stringify(genesisRecord, null, 2))

  console.log(`[H8C] ✓ Genesis created — supply: ${formatH8C(TOTAL_SUPPLY_SAT)} H8C`)
  console.log(`[H8C]   Founder (${founderAddress}): ${formatH8C(FOUNDER_ALLOC_SAT)} H8C`)
  console.log(`[H8C]   Reserve (${reserveAddress}): ${formatH8C(RESERVE_ALLOC_SAT)} H8C`)
  console.log(`[H8C]   Genesis hash: ${genesisHash}`)

  return genesisRecord
}

// ─── Transactions ─────────────────────────────────────────────────────────────

async function createTransaction({ fromPrivkey, toAddress, amountSat, memo = '', feeSat = 0n }) {
  initCoinDb()

  const fromPubkey = privkeyToPubkey(fromPrivkey)
  const fromAddress = pubkeyToAddress(fromPubkey)
  const nonce = getNonce(fromAddress) + 1
  const created_at = Math.floor(Date.now() / 1000)

  const totalCost = BigInt(amountSat) + BigInt(feeSat)
  const balance = getBalance(fromAddress)
  if (balance < totalCost) {
    throw new Error(`INSUFFICIENT_FUNDS: have ${formatH8C(balance)} H8C, need ${formatH8C(totalCost)} H8C`)
  }

  const txBody = {
    from:       fromAddress,
    to:         toAddress,
    amount:     String(amountSat),
    fee:        String(feeSat),
    nonce,
    memo,
    created_at,
  }

  const signature = await sign(fromPrivkey, txBody)
  const txid = makeTxid({ from: fromAddress, to: toAddress, amount: String(amountSat), nonce, created_at })

  // Apply to ledger atomically
  const db = getDb()
  db.transaction(() => {
    debitAddress(fromAddress, totalCost)
    creditAddress(toAddress, BigInt(amountSat))
    db.prepare('UPDATE ledger SET nonce=? WHERE address=?').run(nonce, fromAddress)
    db.prepare(`
      INSERT INTO transactions
        (txid, from_addr, to_addr, amount_sat, fee_sat, nonce, memo, signature, pubkey, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txid, fromAddress, toAddress, String(amountSat), String(feeSat), nonce, memo, signature, fromPubkey, created_at)
  })()

  return { txid, from: fromAddress, to: toAddress, amount: String(amountSat), fee: String(feeSat), nonce, memo, signature, pubkey: fromPubkey, created_at }
}

function verifyTransaction(tx) {
  const txBody = { from: tx.from_addr, to: tx.to_addr, amount: tx.amount_sat, fee: tx.fee_sat, nonce: tx.nonce, memo: tx.memo, created_at: tx.created_at }
  return verify(tx.pubkey, txBody, tx.signature)
}

// ─── Queries ──────────────────────────────────────────────────────────────────

function getTx(txid) {
  initCoinDb()
  return getDb().prepare('SELECT * FROM transactions WHERE txid=?').get(txid) || null
}

function getTxHistory(address, limit = 50) {
  initCoinDb()
  return getDb().prepare(`
    SELECT * FROM transactions
    WHERE from_addr=? OR to_addr=?
    ORDER BY created_at DESC LIMIT ?
  `).all(address, address, limit)
}

function getSupplyInfo() {
  initCoinDb()
  const genesis = getDb().prepare('SELECT * FROM genesis WHERE id=1').get()
  if (!genesis) return null
  const circulating = getDb().prepare(
    "SELECT COALESCE(SUM(CAST(balance AS REAL)),0) as s FROM ledger WHERE address NOT LIKE 'h8c1%' OR address NOT IN (SELECT reserve_address FROM genesis)"
  ).get()
  return {
    total_supply:   String(TOTAL_SUPPLY_SAT),
    founder_alloc:  genesis.founder_alloc,
    reserve_alloc:  genesis.reserve_alloc,
    genesis_hash:   genesis.genesis_hash,
    decimals:       DECIMALS,
    symbol:         COIN_SYMBOL,
    name:           COIN_NAME,
  }
}

function getGenesisRecord() {
  initCoinDb()
  return getDb().prepare('SELECT * FROM genesis WHERE id=1').get() || null
}

function getRichList(limit = 20) {
  initCoinDb()
  return getDb().prepare(
    'SELECT address, balance FROM ledger ORDER BY CAST(balance AS REAL) DESC LIMIT ?'
  ).all(limit).map(r => ({ address: r.address, balance: r.balance, h8c: formatH8C(BigInt(r.balance)) }))
}

// ─── Reward (called by node for content/relay work) ───────────────────────────
async function issueReward(toAddress, amountSat, reason = '') {
  initCoinDb()
  const genesis = getDb().prepare('SELECT reserve_address FROM genesis WHERE id=1').get()
  if (!genesis) throw new Error('GENESIS_NOT_CREATED')

  const reserveAddr = genesis.reserve_address
  const reserveBal  = getBalance(reserveAddr)
  if (reserveBal < BigInt(amountSat)) throw new Error('RESERVE_EMPTY')

  const db = getDb()
  const txid = bytesToHex(sha256(Buffer.from(`reward:${toAddress}:${amountSat}:${Date.now()}`)))
  const now  = Math.floor(Date.now() / 1000)

  db.transaction(() => {
    debitAddress(reserveAddr, BigInt(amountSat))
    creditAddress(toAddress, BigInt(amountSat))
    db.prepare(`
      INSERT INTO transactions
        (txid, from_addr, to_addr, amount_sat, fee_sat, nonce, memo, signature, pubkey, created_at)
      VALUES (?, ?, ?, ?, '0', 0, ?, 'system', 'system', ?)
    `).run(txid, reserveAddr, toAddress, String(amountSat), reason || 'Network reward', now)
  })()

  return txid
}

// ─── Format ───────────────────────────────────────────────────────────────────
function formatH8C(satoshis) {
  const s = satoshis.toString().padStart(9, '0')
  return s.slice(0, -8) + '.' + s.slice(-8)
}

function parseH8C(h8cString) {
  const [int, dec = ''] = String(h8cString).split('.')
  const decPadded = dec.padEnd(8, '0').slice(0, 8)
  return BigInt(int + decPadded)
}

module.exports = {
  initCoinDb,
  isGenesisCreated,
  createGenesis,
  privkeyToPubkey,
  pubkeyToAddress,
  getBalance,
  getNonce,
  createTransaction,
  verifyTransaction,
  getTx,
  getTxHistory,
  getSupplyInfo,
  getGenesisRecord,
  getRichList,
  issueReward,
  formatH8C,
  parseH8C,
  TOTAL_SUPPLY_SAT,
  FOUNDER_ALLOC_SAT,
  COIN_SYMBOL,
  COIN_NAME,
  DECIMALS,
}
