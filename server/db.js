/**
 * M4TR1X - Database SQLite
 * Sostituisce la gestione SQLite di api_server.py
 */

const path = require('path')
const Database = require('better-sqlite3')

let db

function getDbPath() {
  if (process.env.M4TR1X_DATA_DIR) {
    return path.join(process.env.M4TR1X_DATA_DIR, 'm4tr1x.db')
  }
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'm4tr1x.db')
  } catch {
    return path.join(process.cwd(), 'm4tr1x.db')
  }
}

function initDb() {
  const dbPath = getDbPath()
  db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_results (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_created_at ON analysis_results(created_at);
  `)

  console.log(`[M4TR1X] Database inizializzato: ${dbPath}`)
}

function saveResult(id, data) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO analysis_results (id, data, created_at)
    VALUES (?, ?, ?)
  `)
  stmt.run(id, JSON.stringify(data), new Date().toISOString())
}

function loadResult(id) {
  const row = db.prepare('SELECT data FROM analysis_results WHERE id = ?').get(id)
  return row ? JSON.parse(row.data) : null
}

function listResults(limit = 50) {
  const rows = db.prepare(
    'SELECT id, created_at, data FROM analysis_results ORDER BY created_at DESC LIMIT ?'
  ).all(limit)
  return rows.map(r => ({ id: r.id, created_at: r.created_at, ...JSON.parse(r.data) }))
}

module.exports = { initDb, saveResult, loadResult, listResults }
