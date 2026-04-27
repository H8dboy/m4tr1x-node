/**
 * M4TR1X — H8 Token Ledger
 * Hash chain SHA3-256, firme ML-DSA65 via h8identity.
 * Token utility closed-credit stile Twitch Bits — fuori perimetro MiCA.
 */

const Database = require('better-sqlite3')
const crypto   = require('crypto')
const path     = require('path')
const h8id     = require('./h8identity')

const MINT_ADDRESS     = process.env.H8_MINT_ADDRESS     || 'H8' + '0'.repeat(38)
const PLATFORM_ADDRESS = process.env.H8_PLATFORM_ADDRESS || 'H8' + '1'.repeat(38)
const SERVER_ADDRESS   = process.env.H8_SERVER_ADDRESS   || 'H8' + '2'.repeat(38)

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

function hashBlock(idx, ts, from, to, amount, type, contentId, prevHash) {
  return crypto.createHash('sha3-256')
    .update(`${idx}|${ts}|${from}|${to}|${amount}|${type}|${contentId||''}|${prevHash}`)
    .digest('hex')
}

function validAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  if (/^H8[0-9a-f]{38}$/.test(addr)) return true
  if (/^nostr_[0-9a-f]{38}$/.test(addr)) return true
  return addr === '0x0'
}

function initLedger() {
  const db = getDb()
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      block_index INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      from_addr   TEXT NOT NULL,
      to_addr     TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      tx_type     TEXT NOT NULL,
      content_id  TEXT,
      note        TEXT,
      prev_hash   TEXT NOT NULL,
      hash        TEXT NOT NULL,
      signature   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_from    ON ledger(from_addr);
    CREATE INDEX IF NOT EXISTS idx_to      ON ledger(to_addr);
    CREATE INDEX IF NOT EXISTS idx_content ON ledger(content_id);
    CREATE INDEX IF NOT EXISTS idx_ts      ON ledger(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_type    ON ledger(tx_type);
  `)

  const count = db.prepare('SELECT COUNT(*) as c FROM ledger').get().c
  if (count === 0) {
    const ts = Math.floor(Date.now()/1000)
    const prevHash = '0'.repeat(64)
    const hash = hashBlock(1, ts, '0x0', MINT_ADDRESS, 0, 'mint', null, prevHash)
    db.prepare(`INSERT INTO ledger (ts, from_addr, to_addr, amount, tx_type, content_id, note, prev_hash, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ts, '0x0', MINT_ADDRESS, 0, 'mint', null, 'genesis', prevHash, hash, null)
    console.log('[H8] Ledger genesis block created.')
  }
}

function getLastBlock() {
  return getDb().prepare('SELECT * FROM ledger ORDER BY block_index DESC LIMIT 1').get()
}

async function appendBlock({ from, to, amount, tx_type, content_id = null, note = null }) {
  if (!validAddress(from) || !validAddress(to)) throw new Error('Invalid address format')
  if (!VALID_TX_TYPES.has(tx_type)) throw new Error('Invalid tx_type')
  if (!Number.isInteger(amount) || amount < 0) throw new Error('amount must be non-negative integer (centesimi H8)')

  const db = getDb()
  const last = getLastBlock()
  const idx = (last ? last.block_index : 0) + 1
  const ts  = Math.floor(Date.now() / 1000)
  const prevHash = last ? last.hash : '0'.repeat(64)
  const hash = hashBlock(idx, ts, from, to, amount, tx_type, content_id, prevHash)

  let signature = null
  if (tx_type !== 'mint') {
    try { signature = await h8id.signWithUnlocked(hash) }
    catch (e) { throw new Error('H8 wallet locked: cannot sign transaction') }
  }

  db.prepare(`INSERT INTO ledger (ts, from_addr, to_addr, amount, tx_type, content_id, note, prev_hash, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, from, to, amount, tx_type, content_id, note, prevHash, hash, signature)

  return { block_index: idx, ts, from_addr: from, to_addr: to, amount, tx_type, hash }
}

function getBalance(address) {
  if (!validAddress(address)) return 0
  const db = getDb()
  const incoming = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE to_addr = ?').get(address).s
  const outgoing = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE from_addr = ?').get(address).s
  return incoming - outgoing
}

function getHistory(address, limit = 50) {
  if (!validAddress(address)) return []
  return getDb().prepare(`SELECT block_index, ts, from_addr, to_addr, amount, tx_type, content_id, note, hash FROM ledger WHERE from_addr = ? OR to_addr = ? ORDER BY ts DESC LIMIT ?`).all(address, address, limit)
}

async function transfer(to, amount, note = '') {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  const from = unlocked.address
  if (getBalance(from) < amount) throw new Error('Saldo insufficiente')
  return appendBlock({ from, to, amount, tx_type: 'transfer', note })
}

async function tip(creatorAddr, amount, contentId) {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  const from = unlocked.address
  if (getBalance(from) < amount) throw new Error('Saldo insufficiente per tip')

  const creatorShare  = Math.floor(amount * 0.50)
  const platformShare = Math.floor(amount * 0.20)
  const serverShare   = amount - creatorShare - platformShare

  const b1 = await appendBlock({ from, to: creatorAddr,      amount: creatorShare,  tx_type: 'tip_creator',  content_id: contentId })
  const b2 = await appendBlock({ from, to: PLATFORM_ADDRESS, amount: platformShare, tx_type: 'tip_platform', content_id: contentId })
  const b3 = await appendBlock({ from, to: SERVER_ADDRESS,   amount: serverShare,   tx_type: 'tip_server',   content_id: contentId })
  return { creator: b1, platform: b2, server: b3, total: amount }
}

async function boost(contentId, amount) {
  const unlocked = h8id.getUnlockedIdentity()
  if (!unlocked) throw new Error('H8 wallet locked')
  const from = unlocked.address
  if (getBalance(from) < amount) throw new Error('Saldo insufficiente per boost')
  return appendBlock({ from, to: PLATFORM_ADDRESS, amount, tx_type: 'boost', content_id: contentId })
}

function getBoostScore(contentId) {
  const r = getDb().prepare(`SELECT COALESCE(SUM(amount),0) as s FROM ledger WHERE content_id = ? AND tx_type = 'boost'`).get(contentId)
  return r.s
}

function getBoostScoresBatch(ids) {
  if (!ids || !ids.length) return {}
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb().prepare(`SELECT content_id, COALESCE(SUM(amount),0) as s FROM ledger WHERE tx_type = 'boost' AND content_id IN (${placeholders}) GROUP BY content_id`).all(...ids)
  const result = {}
  ids.forEach(id => { result[id] = 0 })
  rows.forEach(r => { result[r.content_id] = r.s })
  return result
}

function verifyChain() {
  const rows = getDb().prepare('SELECT * FROM ledger ORDER BY block_index ASC').all()
  let expectedPrev = '0'.repeat(64)
  for (const b of rows) {
    if (b.prev_hash !== expectedPrev) return { valid: false, firstInvalidBlock: b.block_index, reason: 'prev_hash mismatch' }
    const recomputed = hashBlock(b.block_index, b.ts, b.from_addr, b.to_addr, b.amount, b.tx_type, b.content_id, b.prev_hash)
    if (recomputed !== b.hash) return { valid: false, firstInvalidBlock: b.block_index, reason: 'hash mismatch' }
    expectedPrev = b.hash
  }
  return { valid: true, blocks: rows.length }
}

function mintTokens(to, amount) {
  if (!validAddress(to)) throw new Error('Invalid recipient address')
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount positive integer required')
  return appendBlock({ from: '0x0', to, amount, tx_type: 'mint', note: 'admin_mint' })
}

module.exports = {
  initLedger, getBalance, getHistory, transfer, tip, boost,
  getBoostScore, getBoostScoresBatch, verifyChain, mintTokens,
  MINT_ADDRESS, PLATFORM_ADDRESS, SERVER_ADDRESS,
}
