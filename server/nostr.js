/**
 * M4TR1X - Nostr Module (server/nostr.js)
 * NIP-01, NIP-04, NIP-44, NIP-19
 * Fixed: localhost:4848 priority, reconnect, timeouts, error handling
 */

const { SimplePool, finalizeEvent, generateSecretKey, getPublicKey,
  nip04, nip44, nip19 } = require('nostr-tools')
const { webcrypto } = require('crypto')
const path  = require('path')
const fs    = require('fs')
const os    = require('os')
const WS    = require('ws')

// Polyfill WebCrypto for nostr-tools in Node
if (!globalThis.crypto) globalThis.crypto = webcrypto

// ── Key storage ───────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || path.join(os.homedir(), '.m4tr1x')
const KEYS_FILE = path.join(DATA_DIR, 'nostr_keys.json')

function getKeysPath () { return KEYS_FILE }

function generateKeys () {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  return {
    privkey: Buffer.from(sk).toString('hex'),
    pubkey:  pk,
    npub:    nip19.npubEncode(pk),
    nsec:    nip19.nsecEncode(sk)
  }
}

function saveKeys (keys) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 })
}

function loadSavedKeys () {
  if (!fs.existsSync(KEYS_FILE)) return null
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) } catch { return null }
}

function loadKeys (privkeyHex) {
  const sk = Buffer.from(privkeyHex, 'hex')
  const pk = getPublicKey(sk)
  const keys = { privkey: privkeyHex, pubkey: pk,
    npub: nip19.npubEncode(pk), nsec: nip19.nsecEncode(sk) }
  saveKeys(keys)
  return keys
}

function getCurrentPubkey () {
  const k = loadSavedKeys()
  return k ? k.pubkey : null
}

// ── Relay pool ────────────────────────────────────────────────────────────────
// ws://localhost:4848 is FIRST — the embedded M4TR1X relay has priority
// M4TR1X uses only its embedded local relay — no external Nostr networks
const DEFAULT_RELAYS = [
  'ws://localhost:4848',
]

let _pool            = null
let _connectedRelays = []
let _reconnectTimer  = null
let _reconnectDelay  = 1000   // ms — doubles on each failure, capped at 30s
const MAX_RECONNECT  = 30000

function getPool () {
  if (!_pool) _pool = new SimplePool()
  return _pool
}

/**
 * Probe each relay URL with a bare WebSocket.
 * Returns the list of URLs that accepted the connection.
 * Also schedules auto-reconnect for the local relay if it is down.
 */
async function connectToRelays (relayUrls) {
  const urls = relayUrls || DEFAULT_RELAYS
  _connectedRelays = []

  await Promise.allSettled(urls.map(url =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(), 5000)
      let ws
      try {
        ws = new WS(url)
        ws.on('open', () => {
          clearTimeout(timer)
          _connectedRelays.push(url)
          _reconnectDelay = 1000        // reset backoff on any success
          ws.close()
          resolve()
        })
        ws.on('error', () => { clearTimeout(timer); resolve() })
        ws.on('close', () => resolve())
      } catch { clearTimeout(timer); resolve() }
    })
  ))

  // If local relay is not reachable, schedule a reconnect attempt
  if (!_connectedRelays.includes('ws://localhost:4848')) {
    _scheduleReconnect()
  }

  return _connectedRelays
}

function _scheduleReconnect () {
  if (_reconnectTimer) return
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null
    console.log('[nostr] Reconnecting local relay (ws://localhost:4848)...')
    await connectToRelays(['ws://localhost:4848'])
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_RECONNECT)
  }, _reconnectDelay)
}

function getConnectedRelays () {
  // Always return at least the local relay URL so callers have something to work with
  return _connectedRelays.length > 0 ? _connectedRelays : ['ws://localhost:4848']
}

// ── Publish helpers ───────────────────────────────────────────────────────────
async function publishEvent (template, privkeyHex) {
  const sk    = Buffer.from(privkeyHex, 'hex')
  const event = finalizeEvent(template, sk)
  const pool  = getPool()
  try {
    await Promise.any(pool.publish(DEFAULT_RELAYS, event))
    return event
  } catch (err) {
    console.error('[nostr] publishEvent failed:', err.message)
    throw err
  }
}

async function publishNote (content, privkeyHex, tags = []) {
  return publishEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  }, privkeyHex)
}

async function publishVideoAttestation (videoHash, meta, privkeyHex) {
  return publishEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'm4tr1x'],
      ['t', 'video-attestation'],
      ['m4tr1x-hash', videoHash],
      ['m4tr1x-ai',   meta.aiResult   || 'UNCERTAIN'],
      ['m4tr1x-conf', String(meta.confidence || 0)],
    ],
    content: meta.description || ''
  }, privkeyHex)
}

async function publishProfile (profileData, privkeyHex) {
  return publishEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags:    [],
    content: JSON.stringify(profileData)
  }, privkeyHex)
}

// ── Feed ──────────────────────────────────────────────────────────────────────
/**
 * Fetch the public feed (kind:1 notes).
 * Races against an 8-second timeout so the API never hangs.
 * Falls back to [] on any error — caller shows empty state.
 */
async function fetchFeed (opts = {}) {
  const { limit = 50, since, tags = [] } = opts
  const pool   = getPool()
  const filter = { kinds: [1], limit }
  if (since)       filter.since  = since
  if (tags.length) filter['#t'] = tags

  try {
    const events = await Promise.race([
      new Promise(resolve => {
        const collected = []
        const sub = pool.subscribeMany(DEFAULT_RELAYS, [filter], {
          onevent (e) { collected.push(e) },
          oneose  ()  { sub.close(); resolve(collected) }
        })
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('feed timeout after 8s')), 8000)
      )
    ])
    return events.sort((a, b) => b.created_at - a.created_at)
  } catch (err) {
    console.warn('[nostr] fetchFeed:', err.message)
    return []
  }
}

// ── Direct Messages (NIP-44 with NIP-04 fallback) ─────────────────────────────
async function sendEncryptedDM (recipientPubkey, content, privkeyHex) {
  try {
    const sk = Buffer.from(privkeyHex, 'hex')
    const ck = nip44.v2.utils.getConversationKey(sk, recipientPubkey)
    const encrypted = nip44.v2.encrypt(content, ck)
    return publishEvent({
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: encrypted
    }, privkeyHex)
  } catch (err) {
    console.error('[nostr] sendEncryptedDM error:', err.message)
    throw err
  }
}

async function decryptDM (event, privkeyHex, senderPubkey) {
  const sk = Buffer.from(privkeyHex, 'hex')
  // Try NIP-44 first, fall back to NIP-04, fall back to placeholder
  try {
    const ck = nip44.v2.utils.getConversationKey(sk, senderPubkey)
    return nip44.v2.decrypt(event.content, ck)
  } catch { /* fall through */ }
  try {
    return await nip04.decrypt(privkeyHex, senderPubkey, event.content)
  } catch { /* fall through */ }
  return '[encrypted message]'
}

async function fetchDMs (myPubkey, peerPubkey, privkeyHex, limit = 50) {
  const pool = getPool()
  const filterIn  = { kinds: [14, 4], limit, '#p': [myPubkey],   authors: [peerPubkey] }
  const filterOut = { kinds: [14, 4], limit, '#p': [peerPubkey], authors: [myPubkey]   }

  try {
    const events = await Promise.race([
      new Promise(resolve => {
        const collected = []
        let eoseCount = 0
        const sub = pool.subscribeMany(DEFAULT_RELAYS, [filterIn, filterOut], {
          onevent (e) { collected.push(e) },
          oneose  ()  { if (++eoseCount >= 2) { sub.close(); resolve(collected) } }
        })
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DM fetch timeout')), 8000)
      )
    ])

    const decrypted = await Promise.all(events.map(async e => {
      const sender = e.pubkey
      const peer   = sender === myPubkey ? peerPubkey : sender
      const text   = await decryptDM(e, privkeyHex, peer)
      return { ...e, decryptedContent: text }
    }))

    return decrypted.sort((a, b) => a.created_at - b.created_at)
  } catch (err) {
    console.warn('[nostr] fetchDMs:', err.message)
    return []
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanup () {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_pool) { try { _pool.close(DEFAULT_RELAYS) } catch {} _pool = null }
  _connectedRelays = []
}

// ── Subscribe to feed (server-side, persistent) ───────────────────────────────
function subscribeToFilter (filter, onEvent) {
  const pool = getPool()
  const sub = pool.subscribeMany(DEFAULT_RELAYS, [filter], {
    onevent (e) { try { onEvent(e) } catch {} }
  })
  return () => { try { sub.close() } catch {} }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  generateKeys,
  loadKeys,
  saveKeys,
  loadSavedKeys,
  getKeysPath,
  getCurrentPubkey,
  connectToRelays,
  getConnectedRelays,
  publishEvent,
  publishNote,
  publishVideoAttestation,
  publishProfile,
  fetchFeed,
  subscribeToFilter,
  sendEncryptedDM,
  decryptDM,
  fetchDMs,
  DEFAULT_RELAYS,
  cleanup,
}
