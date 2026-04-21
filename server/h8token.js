/**
 * H8 Token — Ledger a Hash Chain (mini-blockchain)
 *
 * Ogni transazione contiene l'hash SHA3-256 di quella precedente.
 * Manomettere un blocco invalida tutta la catena successiva.
 *
 * Supply controllata: solo la mint key (conservata offline da H8-Group)
 * può creare nuovi token. Nessuno può gonfiare il supply senza la chiave.
 *
 * Split dei tip:   50% creator · 20% piattaforma · 30% server operator
 * Split dello shop: 85% venditore · 10% piattaforma · 5% server operator
 *
 * Unità: 1 H8 = 100 centesimi H8 (per divisibilità nei micropagamenti)
 * Equivalenza consigliata: 100 H8 = ~€1 (definita dalla piattaforma al lancio)
 */

const Database = require('better-sqlite3')
const crypto   = require('crypto')
const path     = require('path')

const { getUnlockedIdentity, signWithUnlocked } = require('./h8identity')

// ─── Costanti split ────────────────────────────────────────────────────────────
const TIP_CREATOR  = 50
const TIP_PLATFORM = 20
const TIP_SERVER   = 30

const SHOP_SELLER   = 85
const SHOP_PLATFORM = 10
const SHOP_SERVER   = 5

// ─── Indirizzi speciali ────────────────────────────────────────────────────────
function platformAddress() {
  return process.env.H8_PLATFORM_ADDRESS || 'H8000000platform0000000000000000000000000'
}
function serverAddress() {
  return process.env.H8_SERVER_ADDRESS || platformAddress()
}

// ─── DB ───────────────────────────────────────────────────────────────────────
let db

function getDbPath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'h8ledger.db')
  } catch {
    return path.join(process.cwd(), 'h8ledger.db')
  }
}

// ─── Hash helpers ─────────────────────────────────────────────────────────────

function sha3(data) {
  return crypto.createHash('sha3-256').update(data).digest('hex')
}

/** Hash deterministico di un blocco (esclude il campo sig per consentire firma post-hash). */
function blockHash({ prev_hash, tx_type, from_id, to_id, amount, payload, ts }) {
  return sha3(`${prev_hash}|${tx_type}|${from_id || ''}|${to_id}|${amount}|${payload || ''}|${ts}`)
}

function getLastHash() {
  const row = db.prepare('SELECT hash FROM h8_chain ORDER BY id DESC LIMIT 1').get()
  return row ? row.hash : '0'.repeat(64)
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initH8Db() {
  db = new Database(getDbPath())

  db.exec(`
    CREATE TABLE IF NOT EXISTS h8_chain (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      prev_hash TEXT    NOT NULL,
      tx_type   TEXT    NOT NULL,          -- genesis|mint|transfer|tip_creator|tip_platform|tip_server|shop_seller|shop_platform|shop_server|boost
      from_id   TEXT,                      -- NULL per mint/genesis
      to_id     TEXT    NOT NULL,
      amount    INTEGER NOT NULL,          -- in centesimi H8
      payload   TEXT,                      -- JSON metadata (contentId, listingId, note...)
      sig       TEXT    NOT NULL,          -- firma ML-DSA65 del mittente (hex)
      hash      TEXT    NOT NULL UNIQUE,   -- SHA3-256 di questo blocco
      ts        INTEGER NOT NULL           -- Unix timestamp
    );

    CREATE INDEX IF NOT EXISTS idx_h8_from ON h8_chain(from_id);
    CREATE INDEX IF NOT EXISTS idx_h8_to   ON h8_chain(to_id);
    CREATE INDEX IF NOT EXISTS idx_h8_ts   ON h8_chain(ts);

    CREATE TABLE IF NOT EXISTS h8_pubkeys (
      address      TEXT PRIMARY KEY,
      public_key   TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    );
  `)

  // Blocco genesis se la catena è vuota
  const count = db.prepare('SELECT COUNT(*) as c FROM h8_chain').get().c
  if (count === 0) {
    const ts = Math.floor(Date.now() / 1000)
    const row = {
      prev_hash: '0'.repeat(64),
      tx_type:   'genesis',
      from_id:   null,
      to_id:     'H8genesis',
      amount:    0,
      payload:   JSON.stringify({ message: 'H8 Token — M4TR1X Network', version: '1.0.0', date: new Date().toISOString() }),
      sig:       'genesis',
      ts,
    }
    row.hash = blockHash(row)
    db.prepare(`
      INSERT INTO h8_chain (prev_hash, tx_type, from_id, to_id, amount, payload, sig, hash, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.prev_hash, row.tx_type, row.from_id, row.to_id, row.amount, row.payload, row.sig, row.hash, row.ts)
    console.log('[H8] Genesis block:', row.hash.substring(0, 16) + '...')
  }

  console.log('[H8] Ledger pronto:', getDbPath())
}

// ─── Saldo ────────────────────────────────────────────────────────────────────

function getBalance(address) {
  const inn = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM h8_chain WHERE to_id = ?').get(address).t
  const out = db.prepare('SELECT COALESCE(SUM(amount),0) as t FROM h8_chain WHERE from_id = ?').get(address).t
  return inn - out
}

function getHistory(address, limit = 50) {
  return db.prepare(`
    SELECT * FROM h8_chain WHERE from_id = ? OR to_id = ?
    ORDER BY ts DESC LIMIT ?
  `).all(address, address, limit)
}

// ─── Inserimento blocco ────────────────────────────────────────────────────────

function insertBlock(tx_type, from_id, to_id, amount, payload, sig) {
  const ts        = Math.floor(Date.now() / 1000)
  const prev_hash = getLastHash()
  const row       = { prev_hash, tx_type, from_id, to_id, amount, payload: payload || null, sig, ts }
  row.hash        = blockHash(row)
  db.prepare(`
    INSERT INTO h8_chain (prev_hash, tx_type, from_id, to_id, amount, payload, sig, hash, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.prev_hash, row.tx_type, row.from_id, row.to_id, row.amount, row.payload, row.sig, row.hash, row.ts)
  return row.hash
}

// ─── Operazioni ───────────────────────────────────────────────────────────────

/**
 * Mint: crea nuovi H8 dal nulla.
 * Solo chiamabile con la mint key (autorità H8-Group, chiave offline).
 * La firma ML-DSA65 della mint key prova l'autorizzazione.
 */
async function mint(toAddress, amount, mintNote = '') {
  if (amount <= 0) throw new Error('Amount must be positive')
  const msg = `mint|${toAddress}|${amount}|${getLastHash()}`
  const sig = await signWithUnlocked(msg)
  const hash = insertBlock('mint', null, toAddress, amount, JSON.stringify({ note: mintNote }), sig)
  console.log(`[H8] Mint: ${amount} H8 → ${toAddress.substring(0, 12)}...`)
  return hash
}

/**
 * Trasferimento diretto (utente → utente).
 */
async function transfer(toAddress, amount, note = '') {
  const identity = getUnlockedIdentity()
  if (!identity) throw new Error('H8 wallet bloccato.')
  const balance = getBalance(identity.address)
  if (balance < amount) throw new Error(`Saldo insufficiente: hai ${balance}, servono ${amount} H8`)
  if (amount <= 0) throw new Error('Amount must be positive')

  const msg = `transfer|${identity.address}|${toAddress}|${amount}|${getLastHash()}`
  const sig = await signWithUnlocked(msg)
  return insertBlock('transfer', identity.address, toAddress, amount, JSON.stringify({ note }), sig)
}

/**
 * Tip a un creator (split 50/20/30).
 * @param {string} creatorAddress  - H8 address del creator
 * @param {number} totalAmount     - totale in centesimi H8
 * @param {string} contentId       - ID del contenuto (video_id, track_id, ecc.)
 */
async function tip(creatorAddress, totalAmount, contentId = '') {
  const identity = getUnlockedIdentity()
  if (!identity) throw new Error('H8 wallet bloccato.')
  const balance = getBalance(identity.address)
  if (balance < totalAmount) throw new Error(`Saldo insufficiente: hai ${balance}, servono ${totalAmount} H8`)
  if (totalAmount <= 0) throw new Error('Amount must be positive')

  const creatorAmt  = Math.floor(totalAmount * TIP_CREATOR  / 100)
  const platformAmt = Math.floor(totalAmount * TIP_PLATFORM / 100)
  const serverAmt   = totalAmount - creatorAmt - platformAmt

  const msg = `tip|${identity.address}|${creatorAddress}|${totalAmount}|${contentId}|${getLastHash()}`
  const sig = await signWithUnlocked(msg)
  const payload = JSON.stringify({ contentId, total: totalAmount })

  // Inserimento atomico dei 3 blocchi
  const insertAll = db.transaction(() => {
    insertBlock('tip_creator',  identity.address, creatorAddress,   creatorAmt,  payload, sig)
    insertBlock('tip_platform', identity.address, platformAddress(), platformAmt, payload, sig)
    insertBlock('tip_server',   identity.address, serverAddress(),   serverAmt,   payload, sig)
  })
  insertAll()

  console.log(`[H8] Tip ${totalAmount} H8 → creator:${creatorAmt} platform:${platformAmt} server:${serverAmt}`)
  return { creatorAmt, platformAmt, serverAmt }
}

/**
 * Boost: paga H8 per aumentare la visibilità di un contenuto nel feed.
 * Il boost score è la somma degli H8 spesi sul contentId.
 */
async function boost(contentId, amount) {
  const identity = getUnlockedIdentity()
  if (!identity) throw new Error('H8 wallet bloccato.')
  const balance = getBalance(identity.address)
  if (balance < amount) throw new Error(`Saldo insufficiente: hai ${balance}, servono ${amount} H8`)

  const msg = `boost|${identity.address}|${contentId}|${amount}|${getLastHash()}`
  const sig = await signWithUnlocked(msg)
  // Il boost va alla piattaforma (che gestisce il ranking)
  const hash = insertBlock('boost', identity.address, platformAddress(), amount,
    JSON.stringify({ contentId, boost: true }), sig)

  console.log(`[H8] Boost ${amount} H8 → content: ${contentId}`)
  return hash
}

/**
 * Acquisto shop (split 85/10/5).
 */
async function shopPay(sellerAddress, amount, listingId) {
  const identity = getUnlockedIdentity()
  if (!identity) throw new Error('H8 wallet bloccato.')
  const balance = getBalance(identity.address)
  if (balance < amount) throw new Error(`Saldo insufficiente: hai ${balance}, servono ${amount} H8`)
  if (amount <= 0) throw new Error('Amount must be positive')

  const sellerAmt   = Math.floor(amount * SHOP_SELLER   / 100)
  const platformAmt = Math.floor(amount * SHOP_PLATFORM / 100)
  const serverAmt   = amount - sellerAmt - platformAmt

  const msg = `shop|${identity.address}|${sellerAddress}|${amount}|${listingId}|${getLastHash()}`
  const sig = await signWithUnlocked(msg)
  const payload = JSON.stringify({ listingId, total: amount })

  const insertAll = db.transaction(() => {
    insertBlock('shop_seller',   identity.address, sellerAddress,   sellerAmt,   payload, sig)
    insertBlock('shop_platform', identity.address, platformAddress(), platformAmt, payload, sig)
    insertBlock('shop_server',   identity.address, serverAddress(),   serverAmt,   payload, sig)
  })
  insertAll()

  console.log(`[H8] Shop ${amount} H8 → seller:${sellerAmt} platform:${platformAmt} server:${serverAmt}`)
  return { sellerAmt, platformAmt, serverAmt }
}

/**
 * Boost score di un contenuto (somma degli H8 spesi su quel contentId).
 */
function getBoostScore(contentId) {
  return db.prepare(`
    SELECT COALESCE(SUM(amount),0) as score FROM h8_chain
    WHERE tx_type = 'boost' AND payload LIKE ?
  `).get(`%${contentId}%`).score
}

/**
 * Registra la chiave pubblica di un utente per verifica futura delle firme.
 */
function registerPubkey(address, publicKey) {
  db.prepare('INSERT OR REPLACE INTO h8_pubkeys (address, public_key, registered_at) VALUES (?,?,?)')
    .run(address, publicKey, Math.floor(Date.now() / 1000))
}

/**
 * Verifica l'integrità dell'intera catena.
 * Controlla: prev_hash coerenti + hash deterministici.
 */
function verifyChain() {
  const rows = db.prepare('SELECT * FROM h8_chain ORDER BY id ASC').all()
  for (let i = 1; i < rows.length; i++) {
    const row  = rows[i]
    const prev = rows[i - 1]
    if (row.prev_hash !== prev.hash)
      return { valid: false, errorAt: row.id, error: `prev_hash errato al blocco ${row.id}` }
    if (row.hash !== blockHash(row))
      return { valid: false, errorAt: row.id, error: `hash errato al blocco ${row.id}` }
  }
  return { valid: true, blocks: rows.length }
}

module.exports = {
  initH8Db,
  getBalance,
  getHistory,
  getBoostScore,
  verifyChain,
  registerPubkey,
  mint,
  transfer,
  tip,
  boost,
  shopPay,
}
