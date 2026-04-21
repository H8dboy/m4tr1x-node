/**
 * M4TR1X — Universal Post
 *
 * Da un solo profilo (H8 Address) pubblica su tutti i protocolli connessi:
 *   • Nostr  — sempre attivo (se chiavi caricate)
 *   • Mastodon — se l'utente ha collegato il suo account
 *   • PeerTube — solo per video (HTTP upload)
 *   • Funkwhale — solo per audio (HTTP upload)
 *
 * I token OAuth sono cifrati a riposo con AES-256-GCM.
 */

const Database = require('better-sqlite3')
const path     = require('path')
const crypto   = require('crypto')
const fs       = require('fs')

// ─── Config ───────────────────────────────────────────────────────────────────
const APP_SECRET = process.env.APP_SECRET || 'h8m4tr1x_proto_secret_change_in_env'
if (!process.env.APP_SECRET) {
  console.warn('[SECURITY] ⚠️  APP_SECRET non impostata! I token OAuth sono cifrati con chiave di default.')
  console.warn('[SECURITY]     Imposta APP_SECRET=<stringa_casuale_lunga> nelle variabili d\'ambiente.')
}

// ─── Lazy imports (evita dipendenze circolari) ────────────────────────────────
function getNostr()    { return require('./nostr') }
function getMastodon() { return require('./mastodon') }

// ─── DB ───────────────────────────────────────────────────────────────────────
let _db = null
function getDb() {
  if (!_db) {
    const dbPath = path.join(process.env.M4TR1X_DATA_DIR || process.cwd(), 'm4tr1x.db')
    _db = new Database(dbPath)
  }
  return _db
}

function initUniversalDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS protocol_accounts (
      h8address    TEXT NOT NULL,
      protocol     TEXT NOT NULL,
      instance     TEXT,
      token_enc    TEXT,
      username     TEXT,
      connected_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (h8address, protocol)
    )
  `)
}

// ─── Token encryption ─────────────────────────────────────────────────────────
function encryptToken(token) {
  const key = crypto.scryptSync(APP_SECRET, 'h8_proto_salt', 32)
  const iv  = crypto.randomBytes(12)
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()])
  return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex')
}

function decryptToken(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':')
  const key = crypto.scryptSync(APP_SECRET, 'h8_proto_salt', 32)
  const d   = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
  d.setAuthTag(Buffer.from(tagHex, 'hex'))
  return d.update(Buffer.from(encHex, 'hex'), null, 'utf8') + d.final('utf8')
}

// ─── CRUD credenziali ─────────────────────────────────────────────────────────

function connectProtocol(h8address, protocol, instance, accessToken, username) {
  const enc = accessToken ? encryptToken(accessToken) : null
  getDb().prepare(`
    INSERT INTO protocol_accounts (h8address, protocol, instance, token_enc, username, connected_at)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(h8address, protocol) DO UPDATE SET
      instance=excluded.instance,
      token_enc=excluded.token_enc,
      username=excluded.username,
      connected_at=excluded.connected_at
  `).run(h8address, protocol, instance || null, enc, username || null)
}

function disconnectProtocol(h8address, protocol) {
  getDb().prepare(
    'DELETE FROM protocol_accounts WHERE h8address=? AND protocol=?'
  ).run(h8address, protocol)
}

function getConnectedProtocols(h8address) {
  return getDb().prepare(
    'SELECT protocol, instance, username, connected_at FROM protocol_accounts WHERE h8address=?'
  ).all(h8address)
}

function getProtocolCreds(h8address, protocol) {
  const row = getDb().prepare(
    'SELECT instance, token_enc, username FROM protocol_accounts WHERE h8address=? AND protocol=?'
  ).get(h8address, protocol)
  if (!row) return null
  return {
    instance: row.instance,
    username: row.username,
    token:    row.token_enc ? decryptToken(row.token_enc) : null,
  }
}

// ─── Profile sync ────────────────────────────────────────────────────────────
// Spinge l'identità M4TR1X su tutti gli account esterni collegati.
// Ogni piattaforma mostra il tuo nome reale + H8 address in bio → stesso profilo ovunque.

const M4TR1X_SIGNATURE = (h8address) =>
  `\n\n🔐 M4TR1X · H8: ${h8address}`

/**
 * Sincronizza il profilo M4TR1X su un singolo protocollo.
 *
 * @param {string} h8address
 * @param {{ name, bio, picture }} profile
 * @param {string} protocol  — 'mastodon' | 'peertube' | 'funkwhale' | 'nostr'
 * @returns {{ ok, error? }}
 */
async function syncProfileToProtocol(h8address, profile, protocol) {
  const sig     = M4TR1X_SIGNATURE(h8address)
  const bioFull = (profile.bio || '') + sig

  if (protocol === 'nostr') {
    try {
      const nostr = getNostr()
      // Includi tutti gli account collegati nel kind 0 — visibili a chiunque
      const linked = getConnectedProtocols(h8address)
      const nostrProfile = {
        name:    profile.name || '',
        about:   bioFull,
        picture: profile.picture || '',
        h8:      h8address,
      }
      linked.forEach(row => {
        if (row.protocol === 'mastodon')  nostrProfile.mastodon  = (row.username ? row.username + '@' : '') + (row.instance || '')
        if (row.protocol === 'peertube')  nostrProfile.peertube  = 'https://' + row.instance + (row.username ? '/c/' + row.username : '')
        if (row.protocol === 'funkwhale') nostrProfile.funkwhale = 'https://' + row.instance + (row.username ? '/@' + row.username : '')
      })
      await nostr.publishProfile(nostrProfile)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  const creds = getProtocolCreds(h8address, protocol)
  if (!creds?.token) return { ok: false, error: 'account non connesso' }

  if (protocol === 'mastodon') {
    try {
      // PATCH /api/v1/accounts/update_credentials — multipart o JSON
      const form = new FormData()
      form.append('display_name', profile.name || '')
      form.append('note', bioFull)
      const res = await fetch(`https://${creds.instance}/api/v1/accounts/update_credentials`, {
        method:  'PATCH',
        headers: { 'Authorization': `Bearer ${creds.token}` },
        body:    form,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  if (protocol === 'peertube') {
    try {
      const res = await fetch(`https://${creds.instance}/api/v1/users/me`, {
        method:  'PUT',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          displayName: profile.name || '',
          description: bioFull,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  if (protocol === 'funkwhale') {
    try {
      const res = await fetch(`https://${creds.instance}/api/v1/users/me`, {
        method:  'PATCH',
        headers: {
          'Authorization': `Bearer ${creds.token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          name:    profile.name || '',
          summary: bioFull,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  return { ok: false, error: `protocollo sconosciuto: ${protocol}` }
}

/**
 * Sincronizza il profilo M4TR1X su tutti i protocolli connessi (+ Nostr).
 * @returns {object} results per protocollo
 */
async function syncAllProfiles(h8address, profile) {
  const connected  = getConnectedProtocols(h8address).map(r => r.protocol)
  const allProtos  = ['nostr', ...connected]
  const results    = {}
  await Promise.allSettled(
    allProtos.map(async proto => {
      results[proto] = await syncProfileToProtocol(h8address, profile, proto)
    })
  )
  return results
}

// ─── Universal post ───────────────────────────────────────────────────────────

/**
 * Pubblica testo su tutti i protocolli connessi.
 *
 * @param {string} h8address  - H8 Address del mittente
 * @param {object} payload
 *   @param {string}   payload.text   - Testo del post (obbligatorio)
 *   @param {string}   [payload.title] - Titolo opzionale (preposto al testo)
 *   @param {string[]} [payload.tags]  - Hashtag (senza #)
 * @returns {object} results — { nostr, mastodon, ... }
 */
async function universalPost(h8address, { text, title, tags = [] }) {
  const results = {}
  const body    = title ? `${title}\n\n${text}` : text

  // ── Nostr (sempre, se chiavi caricate) ──────────────────────────────────────
  try {
    const nostr     = getNostr()
    const nostrTags = tags.map(t => ['t', t])
    const ev = await nostr.publishNote(body, nostrTags)
    results.nostr = { ok: true, id: ev?.id }
  } catch (e) {
    results.nostr = { ok: false, error: e.message }
  }

  // ── Mastodon (se connesso) ───────────────────────────────────────────────────
  const masto = getProtocolCreds(h8address, 'mastodon')
  if (masto?.token) {
    try {
      const mastoClient = getMastodon()
      // Aggiunge hashtag in fondo al testo Mastodon
      const mastoBody = tags.length
        ? body + '\n\n' + tags.map(t => '#' + t).join(' ')
        : body
      const post = await mastoClient.publishPost(
        masto.instance, masto.token, mastoBody, { visibility: 'public' }
      )
      results.mastodon = { ok: true, id: post.id, url: post.url }
    } catch (e) {
      results.mastodon = { ok: false, error: e.message }
    }
  }

  // PeerTube e Funkwhale non supportano post testuali puri —
  // i loro upload sono gestiti separatamente dal modal upload video/audio.

  return results
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  initUniversalDb,
  connectProtocol,
  disconnectProtocol,
  getConnectedProtocols,
  getProtocolCreds,
  universalPost,
  syncProfileToProtocol,
  syncAllProfiles,
}
