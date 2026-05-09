/**
 * M4TR1X — H8 Token Ledger v3
 *
 * Hash chain SHA3-256, mandatory ML-DSA65 signature on every block.
 * Fixed supply: 100,000,000 H8 — no mint beyond genesis.
 *
 * Genesis allocation (transparent, auditable):
 *   50,000,000  →  founder   (H8_FOUNDER_ADDRESS)
 *   30,000,000  →  community (H8_COMMUNITY_ADDRESS)
 *   20,000,000  →  nodes     (H8_NODES_ADDRESS)
 *
 * Tip split:  50% creator · 20% platform · 30% node operator
 *
 * Token utility: closed-credit, Twitch Bits model — outside MiCA scope.
 */

const Database  = require('better-sqlite3')
const crypto    = require('crypto')
const path      = require('path')
const h8id      = require('./h8identity')
const { sha3_256 }  = require('@noble/hashes/sha3')
const { bytesToHex } = require('@noble/hashes/utils')

// ─── Supply constants ─────────────────────────────────────────────────────────
const MAX_SUPPLY       = 100_000_000
const FOUNDER_SHARE    =  50_000_000
const COMMUNITY_SHARE  =  30_000_000
const NODES_SHARE      =  20_000_000

// ─── Reserved addresses ───────────────────────────────────────────────────────
const MINT_ADDRESS      = '0x0'
const FOUNDER_ADDRESS   = process.env.H8_FOUNDER_ADDRESS   || 'H8' + 'f'.repeat(38)
const COMMUNITY_ADDRESS = process.env.H8_COMMUNITY_ADDRESS || 'H8' + 'c'.repeat(38)
const NODES_ADDRESS     = process.env.H8_NODES_ADDRESS     || 'H8' + 'e'.repeat(38)
const PLATFORM_ADDRESS  = process.env.H8_PLATFORM_ADDRESS  || 'H8' + '1'.repeat(38)
const SERVER_ADDRESS    = process.env.H8_SERVER_ADDRESS    || 'H8' + '2'.repeat(38)

const VALID_TX_TYPES = new Set([
  'mint', 'transfer',
  'tip_creator', 'tip_platform', 'tip_server',
  'boost',
  'shop_seller', 'shop_platform', 'shop_server',
])

let _db = null

function getDbPath() {
  try { return path.join(require('electron').app.getPath('userData'), 'h8ledger.db') }
  catch { return path.join(process.env.M4TR1X_DATA_DIR || process.cwd(), 'h8ledger.db') }
}

function getDb() {
  if (!_db) _db = new Database(getDbPath())
  return _db
}

// ─── Hash chain ───────────────────────────────────────────────────────────────
function hashBlock(idx, ts, from, to, amount, type, contentId, prevHash) {
  const input = `${idx}|${ts}|${from}|${to}|${amount}|${type}|${contentId||''}|${prevHash}`
  return bytesToHex(sha3_256(new TextEncoder().encode(input)))
}

// ─── Address validation ───────────────────────────────────────────────────────
function validAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  if (addr === MINT_ADDRESS) return true
  if (/^H8[0-9a-f]{38}$/.test(addr)) return true
  if (/^nostr_[0-9a-f]{38}$/.test(addr)) return true
  return false
}

// ─── Total minted supply ──────────────────────────────────────────────────────
function getTotalMinted() {
  const r = getDb().prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type='mint'`).get()
  return r.s
}

// ─── Init ledger + genesis pre-mint ──────────────────────────────────────────
function initLedger() {
  const db = getDb()
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      block_index INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      from_addr   TEXT    NOT NULL,
      to_addr     TEXT    NOT NULL,
      amount      INTEGER NOT NULL,
      tx_type     TEXT    NOT NULL,
      content_id  TEXT,
      note        TEXT,
      prev_hash   TEXT    NOT NULL,
      hash        TEXT    NOT NULL,
      signature   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_from    ON ledger(from_addr);
    CREATE INDEX IF NOT EXISTS idx_to      ON ledger(to_addr);
    CREATE INDEX IF NOT EXISTS idx_content ON ledger(content_id);
    CREATE INDEX IF NOT EXISTS idx_ts      ON ledger(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_type    ON ledger(tx_type);
  `)

  const count = db.prepare('SELECT COUNT(*) as c FROM ledger').get().c
  if (count === 0) {
    _genesisSync()
    console.log('[H8] Genesis: 100,000,000 H8 minted — founder 50M · community 30M · nodes 20M')
  }
}

// Genesis runs synchronously at startup (no wallet needed — uses deterministic genesis key)
function _genesisSync() {
  const db  = getDb()
  const ts  = Math.floor(Date.now() / 1000)
  const genesisNote = `genesis|max_supply:${MAX_SUPPLY}|founder:${FOUNDER_SHARE}|community:${COMMUNITY_SHARE}|nodes:${NODES_SHARE}`

  const allocs = [
    { to: FOUNDER_ADDRESS,   amount: FOUNDER_SHARE,   note: 'genesis_founder'   },
    { to: COMMUNITY_ADDRESS, amount: COMMUNITY_SHARE,  note: 'genesis_community' },
    { to: NODES_ADDRESS,     amount: NODES_SHARE,      note: 'genesis_nodes'     },
  ]

  let prevHash = '0'.repeat(64)
  let idx = 1

  for (const alloc of allocs) {
    const hash = hashBlock(idx, ts, MINT_ADDRESS, alloc.to, alloc.amount, 'mint', null, prevHash)
    // Genesis signature = SHA3-256 of hash (deterministic, no wallet needed)
    const sig = 'genesis:' + bytesToHex(sha3_256(new TextEncoder().encode(hash + genesisNote)))
    db.prepare(`INSERT INTO ledger (ts, from_addr, to_addr, amount, tx_type, content_id, note, prev_hash, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ts, MINT_ADDRESS, alloc.to, alloc.amount, 'mint', null, alloc.note, prevHash, hash, sig)
    prevHash = hash
    idx++
  }
}

// ─── Append signed block ──────────────────────────────────────────────────────
async function appendBlock({ from, to, amount, tx_type, content_id = null, note = null }) {
  if (!validAddress(from)) throw new Error(`Invalid from address: ${from}`)
  if (!validAddress(to))   throw new Error(`Invalid to address: ${to}`)
  if (!VALID_TX_TYPES.has(tx_type)) throw new Error('Invalid tx_type')
  if (!Number.isInteger(amount) || amount < 0) throw new Error('amount must be a non-negative integer')

  // Block any mint beyond genesis
  if (tx_type === 'mint') throw new Error('Mint closed: supply is fixed at genesis')

  const db      = getDb()
  const last    = db.prepare('SELECT * FROM ledger ORDER BY block_index DESC LIMIT 1').get()
  const idx     = (last ? last.block_index : 0) + 1
  const ts      = Math.floor(Date.now() / 1000)
  const prevHash = last ? last.hash : '0'.repeat(64)
  const hash    = hashBlock(idx, ts, from, to, amount, tx_type, content_id, prevHash)

  // Every block requires a wallet signature — no exceptions
  let signature
  try {
    signature = await h8id.signWithUnlocked(hash)
  } catch (e) {
    throw new Error('H8 wallet locked — unlock your wallet to sign this transaction')
  }
  if (!signature) throw new Error('Signature failed')

  db.prepare(`INSERT INTO ledger (ts, from_addr, to_addr, amount, tx_type, content_id, note, prev_hash, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, from, to, amount, tx_type, content_id, note, prevHash, hash, signature)

  return { block_index: idx, ts, from_addr: from, to_addr: to, amount, tx_type, hash }
}

// ─── Balance ──────────────────────────────────────────────────────────────────
function getBalance(address) {
  if (!validAddress(address)) return 0
  const db = getDb()
  const inc = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE to_addr=?').get(address).s
  const out = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE from_addr=? AND from_addr!=?').get(address, MINT_ADDRESS).s
  return inc - out
}

// ─── History ──────────────────────────────────────────────────────────────────
function getHistory(address, limit = 50) {
  if (!validAddress(address)) return []
  return getDb().prepare(`
    SELECT block_index, ts, from_addr, to_addr, amount, tx_type, content_id, note, hash, signature
    FROM ledger WHERE from_addr=? OR to_addr=? ORDER BY ts DESC LIMIT ?
  `).all(address, address, limit)
}

// ─── Public ledger (full, paginated) ─────────────────────────────────────────
function getPublicLedger(limit = 100, offset = 0) {
  return getDb().prepare(`
    SELECT block_index, ts, from_addr, to_addr, amount, tx_type, content_id, note, prev_hash, hash, signature
    FROM ledger ORDER BY block_index ASC LIMIT ? OFFSET ?
  `).all(limit, offset)
}

function getLedgerStats() {
  const db = getDb()
  const totalBlocks = db.prepare('SELECT COUNT(*) as c FROM ledger').get().c
  const totalMinted = getTotalMinted()
  const totalTransferred = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type='transfer'`).get().s
  const totalTipped = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type='tip_creator'`).get().s
  const totalBoosted = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type='boost'`).get().s
  return {
    max_supply: MAX_SUPPLY,
    total_minted: totalMinted,
    remaining_unminted: MAX_SUPPLY - totalMinted,
    total_blocks: totalBlocks,
    total_transferred: totalTransferred,
    total_tipped: totalTipped,
    total_boosted: totalBoosted,
    allocation: {
      founder:   { address: FOUNDER_ADDRESS,   amount: FOUNDER_SHARE },
      community: { address: COMMUNITY_ADDRESS,  amount: COMMUNITY_SHARE },
      nodes:     { address: NODES_ADDRESS,      amount: NODES_SHARE },
    }
  }
}

// ─── Transfer ─────────────────────────────────────────────────────────────────
async function transfer(to, amount, note = '') {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  if (!validAddress(to)) throw new Error('Invalid recipient address')
  if (getBalance(unlocked.address) < amount) throw new Error('Insufficient balance')
  return appendBlock({ from: unlocked.address, to, amount, tx_type: 'transfer', note })
}

// ─── Tip (50% creator · 20% platform · 30% server) ───────────────────────────
async function tip(creatorAddr, amount, contentId) {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  if (getBalance(unlocked.address) < amount) throw new Error('Insufficient balance for tip')

  const creatorShare  = Math.floor(amount * 0.50)
  const platformShare = Math.floor(amount * 0.20)
  const serverShare   = amount - creatorShare - platformShare

  const b1 = await appendBlock({ from: unlocked.address, to: creatorAddr,      amount: creatorShare,  tx_type: 'tip_creator',  content_id: contentId })
  const b2 = await appendBlock({ from: unlocked.address, to: PLATFORM_ADDRESS, amount: platformShare, tx_type: 'tip_platform', content_id: contentId })
  const b3 = await appendBlock({ from: unlocked.address, to: SERVER_ADDRESS,   amount: serverShare,   tx_type: 'tip_server',   content_id: contentId })
  return { creator: b1, platform: b2, server: b3, total: amount }
}

// ─── Boost ────────────────────────────────────────────────────────────────────
async function boost(contentId, amount) {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  if (getBalance(unlocked.address) < amount) throw new Error('Insufficient balance for boost')
  return appendBlock({ from: unlocked.address, to: PLATFORM_ADDRESS, amount, tx_type: 'boost', content_id: contentId })
}

// ─── Boost scores ─────────────────────────────────────────────────────────────
function getBoostScore(contentId) {
  return getDb().prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE content_id=? AND tx_type='boost'`).get(contentId).s
}

function getBoostScoresBatch(ids) {
  if (!ids?.length) return {}
  const ph = ids.map(() => '?').join(',')
  const rows = getDb().prepare(`SELECT content_id, COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type='boost' AND content_id IN (${ph}) GROUP BY content_id`).all(...ids)
  const result = {}
  ids.forEach(id => { result[id] = 0 })
  rows.forEach(r => { result[r.content_id] = r.s })
  return result
}

// ─── Chain verification (hash + signature presence) ───────────────────────────
function verifyChain() {
  const rows = getDb().prepare('SELECT * FROM ledger ORDER BY block_index ASC').all()
  let expectedPrev = '0'.repeat(64)
  let unsignedCount = 0

  for (const b of rows) {
    if (b.prev_hash !== expectedPrev)
      return { valid: false, firstInvalidBlock: b.block_index, reason: 'prev_hash mismatch' }

    const recomputed = hashBlock(b.block_index, b.ts, b.from_addr, b.to_addr, b.amount, b.tx_type, b.content_id, b.prev_hash)
    if (recomputed !== b.hash)
      return { valid: false, firstInvalidBlock: b.block_index, reason: 'hash mismatch' }

    if (!b.signature) unsignedCount++

    expectedPrev = b.hash
  }

  return { valid: true, blocks: rows.length, unsigned_blocks: unsignedCount }
}

module.exports = {
  initLedger,
  getBalance,
  getHistory,
  getPublicLedger,
  getLedgerStats,
  transfer,
  tip,
  boost,
  getBoostScore,
  getBoostScoresBatch,
  verifyChain,
  MAX_SUPPLY,
  FOUNDER_ADDRESS,
  COMMUNITY_ADDRESS,
  NODES_ADDRESS,
  PLATFORM_ADDRESS,
  SERVER_ADDRESS,
}
