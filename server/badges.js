/**
 * M4TR1X - Professional Badge System
 *
 * Utenti possono richiedere un badge professionale caricando un documento.
 * L'admin approva o rifiuta la richiesta.
 * Il badge appare sul profilo di tutti gli utenti verificati.
 */

const Database = require('better-sqlite3')
const path     = require('path')
const { v4: uuidv4 } = require('uuid')

// ─── Database ─────────────────────────────────────────────────────────────────

let db

function getBadgeDbPath() {
  if (process.env.M4TR1X_DATA_DIR) {
    return path.join(process.env.M4TR1X_DATA_DIR, 'badges.db')
  }
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'badges.db')
  } catch {
    return path.join(process.cwd(), 'badges.db')
  }
}

function initBadgeDb() {
  db = new Database(getBadgeDbPath())

  db.exec(`
    CREATE TABLE IF NOT EXISTS badge_requests (
      id                TEXT PRIMARY KEY,
      pubkey            TEXT NOT NULL,
      category          TEXT NOT NULL,
      status            TEXT DEFAULT 'pending',  -- pending | approved | rejected
      document_filename TEXT NOT NULL,
      notes             TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_badge_pubkey ON badge_requests(pubkey);
    CREATE INDEX IF NOT EXISTS idx_badge_status ON badge_requests(status);
  `)

  console.log('[BADGES] Database inizializzato.')
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Inserisce una nuova richiesta di badge in stato "pending".
 *
 * @param {string} pubkey             - Chiave pubblica Nostr dell'utente
 * @param {string} category           - Categoria professionale richiesta
 * @param {string} document_filename  - Nome del file documento caricato
 * @returns {string} id della richiesta
 */
function requestBadge(pubkey, category, document_filename) {
  const id  = uuidv4()
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO badge_requests (id, pubkey, category, status, document_filename, notes, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)
  `).run(id, pubkey, category, document_filename, now, now)

  console.log(`[BADGES] Nuova richiesta: ${pubkey.slice(0, 16)}… → ${category}`)
  return id
}

/**
 * Restituisce il badge approvato di un utente, o null se non ha badge.
 *
 * @param {string} pubkey
 * @returns {Object|null}
 */
function getApprovedBadge(pubkey) {
  return db.prepare(
    "SELECT * FROM badge_requests WHERE pubkey = ? AND status = 'approved' LIMIT 1"
  ).get(pubkey) || null
}

/**
 * Lista tutte le richieste (admin).
 *
 * @param {string|null} status - filtra per status (null = tutte)
 * @returns {Array}
 */
function getAllRequests(status = null) {
  if (status) {
    return db.prepare(
      'SELECT * FROM badge_requests WHERE status = ? ORDER BY created_at DESC'
    ).all(status)
  }
  return db.prepare(
    'SELECT * FROM badge_requests ORDER BY created_at DESC'
  ).all()
}

/**
 * Approva una richiesta di badge, assegnando la categoria finale.
 *
 * @param {string} id
 * @param {string} category - categoria approvata (può differire da quella richiesta)
 */
function approveRequest(id, category) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE badge_requests SET status = 'approved', category = ?, updated_at = ? WHERE id = ?
  `).run(category, now, id)
  console.log(`[BADGES] Richiesta ${id} APPROVATA — categoria: ${category}`)
}

/**
 * Rifiuta una richiesta di badge con note opzionali.
 *
 * @param {string} id
 * @param {string} notes - motivazione del rifiuto
 */
function rejectRequest(id, notes) {
  const now = new Date().toISOString()
  db.prepare(`
    UPDATE badge_requests SET status = 'rejected', notes = ?, updated_at = ? WHERE id = ?
  `).run(notes || null, now, id)
  console.log(`[BADGES] Richiesta ${id} RIFIUTATA`)
}

/**
 * Restituisce l'ultima richiesta di un utente (pending/approved/rejected).
 *
 * @param {string} pubkey
 * @returns {Object|null}
 */
function getUserRequest(pubkey) {
  return db.prepare(
    'SELECT * FROM badge_requests WHERE pubkey = ? ORDER BY created_at DESC LIMIT 1'
  ).get(pubkey) || null
}

module.exports = {
  initBadgeDb,
  requestBadge,
  getApprovedBadge,
  getAllRequests,
  approveRequest,
  rejectRequest,
  getUserRequest,
}
