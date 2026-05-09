/**
 * M4TR1X — Embedded Nostr Relay (NIP-01 compliant)
 * Porta 4848 · SQLite · zero dipendenze extra
 *
 * Supporta:
 *  NIP-01  — eventi, REQ/EVENT/CLOSE/EOSE
 *  NIP-11  — relay info endpoint (HTTP GET /)
 *  Filtri  — kinds, authors, ids, #t, since, until, limit
 */

const { WebSocketServer } = require('ws')
const Database = require('better-sqlite3')
const http     = require('http')
const path     = require('path')
const crypto   = require('crypto')

const RELAY_PORT = 4848
const DB_PATH    = process.env.USERDATA_PATH
  ? path.join(process.env.USERDATA_PATH, 'relay.db')
  : path.join(__dirname, '..', 'relay.db')

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    pubkey     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind       INTEGER NOT NULL,
    tags       TEXT NOT NULL,
    content    TEXT NOT NULL,
    sig        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_pubkey ON events(pubkey);
  CREATE INDEX IF NOT EXISTS idx_created ON events(created_at DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS event_tags USING fts5(id UNINDEXED, tag_name, tag_value);
`)

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events(id,pubkey,created_at,kind,tags,content,sig)
  VALUES(@id,@pubkey,@created_at,@kind,@tags,@content,@sig)
`)
const insertTag = db.prepare(`INSERT OR IGNORE INTO event_tags(id,tag_name,tag_value) VALUES(?,?,?)`)

function saveEvent(ev) {
  const row = { ...ev, tags: JSON.stringify(ev.tags) }
  const info = insertEvent.run(row)
  if (info.changes) {
    // Index tags for fast lookup
    for (const tag of ev.tags) {
      if (tag.length >= 2) insertTag.run(ev.id, tag[0], tag[1])
    }
  }
  return info.changes > 0
}

// ── Query builder ─────────────────────────────────────────────────────────────
function queryEvents(filter) {
  const limit   = Math.min(filter.limit || 100, 500)
  const clauses = []
  const params  = []

  if (filter.ids?.length) {
    clauses.push(`id IN (${filter.ids.map(() => '?').join(',')})`)
    params.push(...filter.ids)
  }
  if (filter.authors?.length) {
    clauses.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`)
    params.push(...filter.authors)
  }
  if (filter.kinds?.length) {
    clauses.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`)
    params.push(...filter.kinds)
  }
  if (filter.since)  { clauses.push('created_at >= ?'); params.push(filter.since) }
  if (filter.until)  { clauses.push('created_at <= ?'); params.push(filter.until) }

  // Tag filters (#t, #p, #e, #d, ...)
  const tagFilters = Object.entries(filter).filter(([k]) => k.startsWith('#') && k.length === 2)
  let tagJoins = ''
  tagFilters.forEach(([k, vals], i) => {
    if (!vals?.length) return
    const alias = `tf${i}`
    tagJoins += ` JOIN event_tags ${alias} ON events.id = ${alias}.id`
    clauses.push(`${alias}.tag_name = ? AND ${alias}.tag_value IN (${vals.map(() => '?').join(',')})`)
    params.push(k.slice(1), ...vals)
  })

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  const sql = `SELECT events.* FROM events${tagJoins} ${where} ORDER BY created_at DESC LIMIT ?`
  params.push(limit)

  try {
    return db.prepare(sql).all(...params).map(row => ({
      ...row,
      tags: JSON.parse(row.tags),
    }))
  } catch(e) {
    console.error('[RELAY] Query error:', e.message)
    return []
  }
}

// ── Relay info (NIP-11) ───────────────────────────────────────────────────────
const RELAY_INFO = JSON.stringify({
  name: 'M4TR1X Node',
  description: 'First M4TR1X relay — The Unfiltered Eye',
  pubkey: '',
  contact: '',
  supported_nips: [1, 11],
  software: 'https://github.com/H8dboy/m4tr1x-electron',
  version: '1.0.0',
})

// ── HTTP + WS server ──────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // NIP-11: serve relay info on GET /
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/nostr+json')
  res.end(RELAY_INFO)
})

const wss = new WebSocketServer({ server: httpServer })

// Map: subscriptionId → { ws, filters[] }
const subscriptions = new Map()

function broadcast(event, sourceWs) {
  for (const [sid, { ws, filters }] of subscriptions) {
    if (ws === sourceWs) continue
    if (ws.readyState !== ws.OPEN) continue
    if (filters.some(f => matchesFilter(event, f))) {
      ws.send(JSON.stringify(['EVENT', sid, event]))
    }
  }
}

function matchesFilter(ev, f) {
  if (f.ids?.length     && !f.ids.includes(ev.id))           return false
  if (f.authors?.length && !f.authors.includes(ev.pubkey))   return false
  if (f.kinds?.length   && !f.kinds.includes(ev.kind))       return false
  if (f.since           && ev.created_at < f.since)          return false
  if (f.until           && ev.created_at > f.until)          return false
  for (const [k, vals] of Object.entries(f)) {
    if (!k.startsWith('#') || k.length !== 2 || !vals?.length) continue
    const tagName = k.slice(1)
    if (!ev.tags.some(t => t[0] === tagName && vals.includes(t[1]))) return false
  }
  return true
}

wss.on('connection', ws => {
  const wsId = crypto.randomBytes(4).toString('hex')
  const wsSubs = new Set() // subscription IDs owned by this connection

  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const [type, ...args] = msg

    if (type === 'EVENT') {
      const ev = args[0]
      if (!ev?.id || !ev?.pubkey || !ev?.sig) return
      const saved = saveEvent(ev)
      ws.send(JSON.stringify(['OK', ev.id, true, saved ? '' : 'duplicate']))
      if (saved) broadcast(ev, ws)

    } else if (type === 'REQ') {
      const [sid, ...filters] = args
      if (!sid || !filters.length) return
      // Remove old sub with same ID if any
      subscriptions.delete(sid)
      subscriptions.set(sid, { ws, filters })
      wsSubs.add(sid)
      // Send stored events matching filters
      for (const f of filters) {
        const evs = queryEvents(f)
        for (const ev of evs) ws.send(JSON.stringify(['EVENT', sid, ev]))
      }
      ws.send(JSON.stringify(['EOSE', sid]))

    } else if (type === 'CLOSE') {
      const sid = args[0]
      subscriptions.delete(sid)
      wsSubs.delete(sid)
    }
  })

  ws.on('close', () => {
    for (const sid of wsSubs) subscriptions.delete(sid)
  })
})

httpServer.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[RELAY] Port ${RELAY_PORT} already in use — relay already running`)
    process.exit(0)
  } else {
    console.error('[RELAY] Error:', e.message)
    process.exit(1)
  }
})
httpServer.listen(RELAY_PORT, '::', () => {
  console.log(`[RELAY] M4TR1X Node ready → ws://localhost:${RELAY_PORT}`)
})

module.exports = { saveEvent, queryEvents, RELAY_PORT }
