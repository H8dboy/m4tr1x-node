/**
 * M4TR1X — H8 Ledger Sync
 *
 * Sincronizza le transazioni H8 tra nodi della rete via Nostr.
 *
 * Ogni transazione firmata con ML-DSA65 è un fatto globale verificabile.
 * I nodi si scambiano blocchi via eventi Nostr kind-30078.
 *
 * Flusso:
 *  1. Nodo A esegue una transazione → firma con ML-DSA65 → annuncia su Nostr
 *  2. Nodo B riceve l'evento → verifica firma ML-DSA65 → verifica H8 address
 *  3. Se valido → salva in remote_blocks → aggiorna saldo globale
 *
 * Anti-double-spend: ogni nodo verifica il saldo globale (locale + remoto)
 * prima di approvare una transazione.
 */

const Database = require('better-sqlite3')
const path     = require('path')
const { subscribeToFilter, publishEvent, getUnlockedNostrPrivkey } = require('./nostr')
const h8id     = require('./h8identity')

const BLOCK_KIND = 30078
const BLOCK_TAG  = 'm4tr1x-h8-block'

const SYNCABLE_TX_TYPES = new Set([
  'transfer', 'tip_creator', 'tip_platform', 'tip_server',
  'boost', 'shop_seller', 'shop_platform', 'shop_server',
])

// ─── Remote block DB ──────────────────────────────────────────────────────────

let _rdb = null

function getRemoteDb() {
  if (_rdb) return _rdb
  const dbPath = (() => {
    try { return path.join(require('electron').app.getPath('userData'), 'remote_blocks.db') }
    catch { return path.join(process.env.M4TR1X_DATA_DIR || process.cwd(), 'remote_blocks.db') }
  })()
  _rdb = new Database(dbPath)
  _rdb.pragma('journal_mode = WAL')
  _rdb.pragma('synchronous = NORMAL')
  _rdb.exec(`
    CREATE TABLE IF NOT EXISTS remote_blocks (
      signature     TEXT PRIMARY KEY,          -- ML-DSA65 sig — dedup globale
      hash          TEXT UNIQUE NOT NULL,       -- hash blocco originale
      ts            INTEGER NOT NULL,
      from_addr     TEXT    NOT NULL,
      to_addr       TEXT    NOT NULL,
      amount        INTEGER NOT NULL,
      tx_type       TEXT    NOT NULL,
      content_id    TEXT,
      signer_pubkey TEXT    NOT NULL,           -- chiave pubblica ML-DSA65 del firmatario
      verified      INTEGER DEFAULT 0,          -- 1 = firma ML-DSA65 verificata
      received_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rb_from ON remote_blocks(from_addr);
    CREATE INDEX IF NOT EXISTS idx_rb_to   ON remote_blocks(to_addr);
    CREATE INDEX IF NOT EXISTS idx_rb_ts   ON remote_blocks(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_rb_ver  ON remote_blocks(verified);
  `)
  console.log('[LEDGER_SYNC] Remote blocks DB inizializzato.')
  return _rdb
}

// ─── Validazione blocco remoto ────────────────────────────────────────────────

function validAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  return /^H8[0-9a-f]{38}$/.test(addr) || /^nostr_[0-9a-f]{38}$/.test(addr) || addr === '0x0'
}

async function verifyRemoteBlock(block) {
  // 1. Validazione campi base
  if (!block.signature || !block.signer_pubkey || !block.hash) return false
  if (!validAddress(block.from_addr) || !validAddress(block.to_addr)) return false
  if (!SYNCABLE_TX_TYPES.has(block.tx_type)) return false
  if (!Number.isInteger(block.amount) || block.amount < 0) return false

  // 2. Il signer_pubkey deve corrispondere all'H8 address del mittente
  try {
    const derived = h8id.h8AddressFrom(block.signer_pubkey)
    if (derived !== block.from_addr) return false
  } catch { return false }

  // 3. La firma ML-DSA65 deve essere valida sul block hash
  try {
    return await h8id.verifySignature(block.signer_pubkey, block.hash, block.signature)
  } catch { return false }
}

// ─── Importa blocco remoto ────────────────────────────────────────────────────

async function importRemoteBlock(block) {
  if (!block?.signature || !block?.hash) return false

  const db = getRemoteDb()

  // Skip se già conosciuto (dedup per signature)
  if (db.prepare('SELECT signature FROM remote_blocks WHERE signature = ?').get(block.signature)) {
    return false
  }

  const verified = await verifyRemoteBlock(block)

  db.prepare(`
    INSERT OR IGNORE INTO remote_blocks
      (signature, hash, ts, from_addr, to_addr, amount, tx_type, content_id,
       signer_pubkey, verified, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    block.signature, block.hash, block.ts,
    block.from_addr, block.to_addr, block.amount,
    block.tx_type, block.content_id || null,
    block.signer_pubkey, verified ? 1 : 0,
    Math.floor(Date.now() / 1000)
  )

  if (verified) {
    console.log(`[LEDGER_SYNC] ✅ ${block.from_addr.slice(0, 10)}→${block.to_addr.slice(0, 10)} ${block.amount} H8 (${block.tx_type})`)
  }
  return verified
}

// ─── Annuncia blocco locale alla rete ────────────────────────────────────────

async function announceBlock(block) {
  if (!block?.signature || !block?.signer_pubkey) return
  if (!SYNCABLE_TX_TYPES.has(block.tx_type)) return

  if (!getUnlockedNostrPrivkey()) return

  try {
    await publishEvent({
      kind: BLOCK_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d',          `m4tr1x-block-${block.hash}`],
        ['t',          BLOCK_TAG],
        ['t',          'm4tr1x'],
        ['from',       block.from_addr],
        ['to',         block.to_addr],
        ['amount',     String(block.amount)],
        ['tx_type',    block.tx_type],
        ['hash',       block.hash],
        ['ts',         String(block.ts)],
        ['sig',        block.signature],
        ['pubkey_h8',  block.signer_pubkey],
        ...(block.content_id ? [['content_id', block.content_id]] : []),
      ],
      content: '',
    })
    console.log(`[LEDGER_SYNC] Block announced: ${block.hash.slice(0, 12)}...`)
  } catch (e) {
    console.warn('[LEDGER_SYNC] Announce failed:', e.message)
  }
}

// ─── Sottoscrizione ai blocchi remoti ─────────────────────────────────────────

function startBlockSync() {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600  // last 24h

  subscribeToFilter({ kinds: [BLOCK_KIND], '#t': [BLOCK_TAG], since }, async ev => {
    try {
      const get = tag => ev.tags.find(t => t[0] === tag)?.[1]
      const amountStr = get('amount')
      const tsStr     = get('ts')

      const block = {
        hash:          get('hash'),
        ts:            tsStr ? parseInt(tsStr) : 0,
        from_addr:     get('from'),
        to_addr:       get('to'),
        amount:        amountStr ? parseInt(amountStr) : -1,
        tx_type:       get('tx_type'),
        content_id:    get('content_id') || null,
        signature:     get('sig'),
        signer_pubkey: get('pubkey_h8'),
      }

      if (block.hash && block.from_addr && block.signature) {
        await importRemoteBlock(block)
      }
    } catch {}
  })

  console.log('[LEDGER_SYNC] Subscribed to remote block stream.')
}

// ─── Saldo e storico cross-nodo ───────────────────────────────────────────────

function getRemoteBalance(address) {
  const db       = getRemoteDb()
  const incoming = db.prepare(
    'SELECT COALESCE(SUM(amount),0) as s FROM remote_blocks WHERE to_addr = ? AND verified = 1'
  ).get(address).s
  const outgoing = db.prepare(
    'SELECT COALESCE(SUM(amount),0) as s FROM remote_blocks WHERE from_addr = ? AND verified = 1'
  ).get(address).s
  return incoming - outgoing
}

function getRemoteHistory(address, limit = 50) {
  return getRemoteDb().prepare(`
    SELECT hash, ts, from_addr, to_addr, amount, tx_type, content_id,
           'remote' AS source
    FROM remote_blocks
    WHERE (from_addr = ? OR to_addr = ?) AND verified = 1
    ORDER BY ts DESC LIMIT ?
  `).all(address, address, limit)
}

function getRemoteStats() {
  const db = getRemoteDb()
  return {
    total_blocks:    db.prepare('SELECT COUNT(*) as n FROM remote_blocks').get().n,
    verified_blocks: db.prepare('SELECT COUNT(*) as n FROM remote_blocks WHERE verified = 1').get().n,
    unique_senders:  db.prepare('SELECT COUNT(DISTINCT from_addr) as n FROM remote_blocks WHERE verified = 1').get().n,
  }
}

module.exports = {
  announceBlock,
  startBlockSync,
  importRemoteBlock,
  getRemoteBalance,
  getRemoteHistory,
  getRemoteStats,
}
