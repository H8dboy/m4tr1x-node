#!/usr/bin/env node
/**
 * Run this on the antiX head node to add:
 *  - GET /api/v1/head/nodes   — list all registered nodes (needed for federation)
 *  - POST /api/v1/head/tip    — record tip statistics
 *  - Automatic DB backup every 6h
 *
 * Usage:  node patch_head_server.js /path/to/head_server.js
 */

const fs   = require('fs')
const path = require('path')

const target = process.argv[2]
if (!target || !fs.existsSync(target)) {
  console.error('Usage: node patch_head_server.js <path-to-head_server.js>')
  process.exit(1)
}

let src = fs.readFileSync(target, 'utf8')
const backup = target + '.bak.' + Date.now()
fs.writeFileSync(backup, src)
console.log('Backup saved to', backup)

// ─── 1. Add GET /api/v1/head/nodes ───────────────────────────────────────────
const nodesEndpoint = `
// List all registered nodes — used by alpha nodes for content federation
app.get('/api/v1/head/nodes', (req, res) => {
  try {
    const rows = db.prepare(\`
      SELECT pubkey, name, node_url, onion, capabilities, last_seen
      FROM nodes ORDER BY last_seen DESC
    \`).all()
    res.json(rows.map(r => ({
      ...r,
      capabilities: (() => { try { return JSON.parse(r.capabilities) } catch { return [] } })(),
    })))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

`

// ─── 2. Add POST /api/v1/head/tip ────────────────────────────────────────────
const tipEndpoint = `
// Record a tip event for network statistics
app.post('/api/v1/head/tip', (req, res) => {
  try {
    const { from, to, amount, content_id } = req.body
    if (!to || !amount) return res.status(400).json({ error: 'to and amount required' })
    db.prepare(\`
      CREATE TABLE IF NOT EXISTS tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_addr TEXT, to_addr TEXT NOT NULL,
        amount INTEGER NOT NULL, content_id TEXT DEFAULT '',
        ts INTEGER NOT NULL
      )\`).run()
    db.prepare('INSERT INTO tips (from_addr, to_addr, amount, content_id, ts) VALUES (?,?,?,?,?)')
      .run(from || '', to, parseInt(amount) || 0, content_id || '', Math.floor(Date.now() / 1000))
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

`

// ─── 3. DB backup every 6h ───────────────────────────────────────────────────
const backupCode = `
// Automatic DB backup every 6 hours
;(function startDbBackup() {
  const fsBk = require('fs'), pathBk = require('path')
  function doBackup() {
    const src = dbPath || 'head.db'
    if (!fsBk.existsSync(src)) return
    const dir = pathBk.join(pathBk.dirname(src), 'backups')
    if (!fsBk.existsSync(dir)) fsBk.mkdirSync(dir, { recursive: true })
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dest = pathBk.join(dir, 'head_' + ts + '.db')
    try {
      fsBk.copyFileSync(src, dest)
      console.log('[BACKUP] head.db →', dest)
      // Keep only latest 24
      const files = fsBk.readdirSync(dir).filter(f => f.startsWith('head_') && f.endsWith('.db')).sort()
      if (files.length > 24) files.slice(0, files.length - 24).forEach(f => { try { fsBk.unlinkSync(pathBk.join(dir, f)) } catch {} })
    } catch (e) { console.error('[BACKUP] Failed:', e.message) }
  }
  doBackup()
  setInterval(doBackup, 6 * 60 * 60 * 1000)
})()
`

// Insert before the last app.listen or module.exports
const insertMarkers = [
  'app.listen(',
  'module.exports',
  'server.listen(',
]

let inserted = false
for (const marker of insertMarkers) {
  const idx = src.lastIndexOf(marker)
  if (idx !== -1) {
    src = src.slice(0, idx) + nodesEndpoint + tipEndpoint + backupCode + '\n' + src.slice(idx)
    inserted = true
    console.log(`Inserted before '${marker}' at position ${idx}`)
    break
  }
}

if (!inserted) {
  src += '\n' + nodesEndpoint + tipEndpoint + backupCode
  console.log('Appended to end of file')
}

fs.writeFileSync(target, src)
console.log('Done. Restart the head server process.')
