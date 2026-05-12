'use strict'
require('dotenv').config({ path: __dirname + '/.env' })
const express    = require('express')
const cors       = require('cors')
const rateLimit  = require('express-rate-limit')
const path       = require('path')
const crypto     = require('crypto')
const fs         = require('fs')
const Database   = require('better-sqlite3')

const PORT      = parseInt(process.env.PORT || '8080')
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || path.join(__dirname, '..', 'data')
const TOR_FILE  = process.env.TOR_HOSTNAME_FILE || '/var/lib/tor/m4tr1x/hostname'

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'head.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    pubkey TEXT PRIMARY KEY, name TEXT DEFAULT '', node_url TEXT DEFAULT '',
    onion TEXT DEFAULT '', capabilities TEXT DEFAULT '[]', ws_port INTEGER DEFAULT 4848,
    registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    address TEXT PRIMARY KEY, pubkey TEXT DEFAULT '', node_url TEXT DEFAULT '',
    name TEXT DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS content (
    content_id TEXT PRIMARY KEY, content_type TEXT DEFAULT 'video', title TEXT DEFAULT '',
    creator_address TEXT DEFAULT '', node_url TEXT DEFAULT '', onion TEXT DEFAULT '',
    announced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pubkey TEXT NOT NULL, node_name TEXT DEFAULT '',
    requests_1h INTEGER DEFAULT 0, users_active INTEGER DEFAULT 0,
    uploads_1h INTEGER DEFAULT 0, errors_1h INTEGER DEFAULT 0,
    uptime_s INTEGER DEFAULT 0, ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
    node_name TEXT DEFAULT '', detail TEXT DEFAULT '', ts TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, active_nodes INTEGER DEFAULT 0,
    total_users INTEGER DEFAULT 0, total_content INTEGER DEFAULT 0,
    total_requests INTEGER DEFAULT 0, snapshot_at TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS idx_hb_pubkey ON heartbeats(pubkey);
  CREATE INDEX IF NOT EXISTS idx_hb_ts ON heartbeats(ts);
  CREATE INDEX IF NOT EXISTS idx_ev_ts ON events(ts);
`)
console.log('[HEAD] Database inizializzato:', path.join(DATA_DIR, 'head.db'))

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString()
const OFFLINE_MS = 5 * 60 * 1000

function getOnionAddress() {
  try { return fs.readFileSync(TOR_FILE, 'utf8').trim() } catch { return null }
}

function getNetworkStatus() {
  return db.prepare(`
    SELECT h.pubkey, h.node_name, h.requests_1h, h.users_active, h.uploads_1h, h.errors_1h, h.uptime_s, h.ts
    FROM heartbeats h
    INNER JOIN (SELECT pubkey, MAX(ts) as max_ts FROM heartbeats GROUP BY pubkey) l
      ON h.pubkey = l.pubkey AND h.ts = l.max_ts
    ORDER BY h.ts DESC
  `).all().map(n => ({ ...n, online: (Date.now() - new Date(n.ts).getTime()) < OFFLINE_MS }))
}

function getNetworkStats() {
  const since = new Date(Date.now() - 3600000).toISOString()
  const t = db.prepare(`
    SELECT SUM(requests_1h) as total_requests, SUM(users_active) as total_users,
           SUM(uploads_1h) as total_uploads, SUM(errors_1h) as total_errors
    FROM heartbeats h
    INNER JOIN (SELECT pubkey, MAX(ts) as max_ts FROM heartbeats GROUP BY pubkey) l
      ON h.pubkey = l.pubkey AND h.ts = l.max_ts WHERE h.ts > ?
  `).get(since)
  const s = getNetworkStatus()
  return { ...t, online_nodes: s.filter(n=>n.online).length, offline_nodes: s.filter(n=>!n.online).length }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())
app.use('/api/v1/head/', rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false }))

// Dashboard
const dashFile = path.join(__dirname, 'dashboard', 'index.html')
app.get('/', (req, res) => fs.existsSync(dashFile) ? res.sendFile(dashFile) : res.send('M4TR1X Head Node'))
app.get('/dashboard', (req, res) => res.redirect('/'))

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/api/v1/head/ping',   (req, res) => res.json({ ok: true, ts: Date.now() }))
app.get('/api/v1/head/status', (req, res) => res.json({ head: true, onion: getOnionAddress(), node: process.env.NODE_NAME || 'head' }))

app.post('/api/v1/head/node', (req, res) => {
  const { pubkey, name, node_url, onion, capabilities, ws_port } = req.body
  if (!pubkey) return res.status(400).json({ error: 'pubkey richiesta' })
  const n = now()
  db.prepare(`INSERT INTO nodes (pubkey,name,node_url,onion,capabilities,ws_port,registered_at,last_seen)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET
    name=excluded.name,node_url=excluded.node_url,onion=excluded.onion,
    capabilities=excluded.capabilities,ws_port=excluded.ws_port,last_seen=excluded.last_seen`)
    .run(pubkey,name||'',node_url||'',onion||'',JSON.stringify(capabilities||[]),ws_port||4848,n,n)
  db.prepare(`INSERT INTO events (type,node_name,detail,ts) VALUES (?,?,?,?)`)
    .run('node_registered', name||pubkey.slice(0,12), node_url||onion||'', n)
  console.log('[HEAD] Nodo registrato:', name || pubkey.slice(0,12))
  res.json({ registered: true })
})

app.get('/api/v1/head/nodes', (req, res) => res.json(db.prepare('SELECT * FROM nodes ORDER BY last_seen DESC').all()))

app.post('/api/v1/head/user', (req, res) => {
  const { address, pubkey, node_url, name } = req.body
  if (!address) return res.status(400).json({ error: 'address richiesto' })
  const n = now()
  db.prepare(`INSERT INTO users (address,pubkey,node_url,name,registered_at,last_seen)
    VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET
    pubkey=excluded.pubkey,node_url=excluded.node_url,name=excluded.name,last_seen=excluded.last_seen`)
    .run(address,pubkey||'',node_url||'',name||'',n,n)
  console.log('[HEAD] Utente registrato:', address.slice(0,16))
  res.json({ registered: true })
})

app.get('/api/v1/head/users', (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY last_seen DESC').all()))

app.post('/api/v1/head/content', (req, res) => {
  const { content_id, content_type, title, creator_address, node_url, onion } = req.body
  if (!content_id || !creator_address) return res.status(400).json({ error: 'content_id e creator_address richiesti' })
  db.prepare(`INSERT INTO content (content_id,content_type,title,creator_address,node_url,onion,announced_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET
    node_url=excluded.node_url,onion=excluded.onion,announced_at=excluded.announced_at`)
    .run(content_id,content_type||'video',title||'',creator_address,node_url||'',onion||'',now())
  res.json({ registered: true })
})

app.get('/api/v1/head/content', (req, res) =>
  res.json(db.prepare('SELECT * FROM content ORDER BY announced_at DESC LIMIT ?').all(parseInt(req.query.limit)||100)))

app.get('/api/v1/head/resolve/creator/:id', (req, res) => {
  const r = db.prepare('SELECT creator_address,node_url,onion FROM content WHERE content_id=?').get(req.params.id)
  r ? res.json(r) : res.status(404).json({ error: 'non trovato' })
})

app.get('/api/v1/head/resolve/user/:address', (req, res) => {
  const r = db.prepare('SELECT * FROM users WHERE address=?').get(req.params.address)
  r ? res.json(r) : res.status(404).json({ error: 'non trovato' })
})

app.post('/api/v1/head/heartbeat', (req, res) => {
  const { pubkey, node_name, requests_1h, users_active, uploads_1h, errors_1h, uptime_s, node_url, onion, capabilities } = req.body
  if (!pubkey) return res.status(400).json({ error: 'pubkey richiesta' })
  db.prepare(`INSERT INTO heartbeats (pubkey,node_name,requests_1h,users_active,uploads_1h,errors_1h,uptime_s,ts)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(pubkey,node_name||'',requests_1h||0,users_active||0,uploads_1h||0,errors_1h||0,uptime_s||0,now())
  if (node_url || onion) {
    const n = now()
    db.prepare(`INSERT INTO nodes (pubkey,name,node_url,onion,capabilities,ws_port,registered_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET
      name=excluded.name,node_url=excluded.node_url,onion=excluded.onion,last_seen=excluded.last_seen`)
      .run(pubkey,node_name||'',node_url||'',onion||'',JSON.stringify(capabilities||[]),4848,n,n)
  }
  if ((errors_1h||0) > 50)
    db.prepare('INSERT INTO events (type,node_name,detail,ts) VALUES (?,?,?,?)').run('high_errors',node_name||'',`${errors_1h} errors/hr`,now())
  res.json({ ok: true })
})

app.get('/api/v1/head/network/status',  (req, res) => res.json(getNetworkStatus()))
app.get('/api/v1/head/network/stats',   (req, res) => res.json(getNetworkStats()))
app.get('/api/v1/head/network/events',  (req, res) =>
  res.json(db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(parseInt(req.query.limit)||50)))

app.post('/api/v1/head/network/event', (req, res) => {
  const { type, node_name, detail } = req.body
  if (!type) return res.status(400).json({ error: 'type richiesto' })
  db.prepare('INSERT INTO events (type,node_name,detail,ts) VALUES (?,?,?,?)').run(type,node_name||'',detail||'',now())
  res.json({ ok: true })
})

app.get('/api/v1/head/network/summary', (req, res) => {
  const stats   = getNetworkStats()
  const users   = db.prepare('SELECT COUNT(*) as c FROM users').get()
  const content = db.prepare('SELECT COUNT(*) as c FROM content').get()
  res.json({ online_nodes: stats.online_nodes||0, total_users: users.c, total_content: content.c, requests_hr: stats.total_requests||0 })
})

app.get('/api/v1/head/network/history', (req, res) =>
  res.json(db.prepare('SELECT * FROM stats_history ORDER BY snapshot_at DESC LIMIT ?').all(parseInt(req.query.hours)||48)))

// ── Auto-detect offline e snapshot orario ─────────────────────────────────────
setInterval(() => {
  const nodes = getNetworkStatus()
  nodes.forEach(n => {
    const age = Date.now() - new Date(n.ts).getTime()
    if (age > OFFLINE_MS && age < OFFLINE_MS + 180000)
      db.prepare('INSERT INTO events (type,node_name,detail,ts) VALUES (?,?,?,?)').run('node_offline',n.node_name,`No heartbeat ${Math.round(age/60000)}min`,now())
  })
}, 3 * 60 * 1000)

setInterval(() => {
  const stats = getNetworkStats()
  const hour = new Date().toISOString().slice(0,13)+':00:00Z'
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get()
  const content = db.prepare('SELECT COUNT(*) as c FROM content').get()
  db.prepare(`INSERT OR REPLACE INTO stats_history (active_nodes,total_users,total_content,total_requests,snapshot_at)
    VALUES (?,?,?,?,?)`).run(stats.online_nodes||0,users.c,content.c,stats.total_requests||0,hour)
}, 60 * 60 * 1000)

// Pulizia heartbeat vecchi ogni 6 ore
setInterval(() => {
  const cutoff = new Date(Date.now() - 7*24*3600000).toISOString()
  db.prepare('DELETE FROM heartbeats WHERE ts < ?').run(cutoff)
  db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff)
}, 6 * 3600 * 1000)

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  const onion = getOnionAddress()
  console.log('[HEAD] Nodo testa in ascolto su 127.0.0.1:' + PORT)
  if (onion) console.log('[HEAD] Indirizzo Tor: http://' + onion)
  else console.log('[HEAD] Tor address non ancora disponibile')
})
