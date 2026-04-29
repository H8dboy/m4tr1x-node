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

    CREATE TABLE IF NOT EXISTS local_videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      filename TEXT NOT NULL,
      thumbnail TEXT DEFAULT '',
      uploader_address TEXT NOT NULL,
      uploader_name TEXT DEFAULT '',
      category TEXT DEFAULT 'reels',
      tags TEXT DEFAULT '[]',
      duration INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_videos_uploaded ON local_videos(uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_videos_category ON local_videos(category);

    CREATE TABLE IF NOT EXISTS local_tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT DEFAULT '',
      album TEXT DEFAULT '',
      filename TEXT NOT NULL,
      cover TEXT DEFAULT '',
      uploader_address TEXT NOT NULL,
      uploader_name TEXT DEFAULT '',
      duration INTEGER DEFAULT 0,
      plays INTEGER DEFAULT 0,
      uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_uploaded ON local_tracks(uploaded_at);
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

// ─── Local Videos ────────────────────────────────────────────────────────────

function insertVideo(v) {
  db.prepare(`INSERT OR REPLACE INTO local_videos
    (id, title, description, filename, thumbnail, uploader_address, uploader_name,
     category, tags, duration, views, likes, uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?)`).run(
    v.id, v.title, v.description || '', v.filename, v.thumbnail || '',
    v.uploader_address, v.uploader_name || '', v.category || 'reels',
    JSON.stringify(v.tags || []), v.duration || 0, new Date().toISOString()
  )
}

function getVideos({ category, limit = 30, offset = 0 } = {}) {
  const where = category ? 'WHERE category = ?' : ''
  const args = category ? [category, limit, offset] : [limit, offset]
  return db.prepare(`SELECT * FROM local_videos ${where} ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`).all(...args)
}

function searchVideos(q, limit = 20) {
  const like = `%${q}%`
  return db.prepare(`SELECT * FROM local_videos
    WHERE title LIKE ? OR description LIKE ? OR uploader_name LIKE ?
    ORDER BY uploaded_at DESC LIMIT ?`).all(like, like, like, limit)
}

function getVideoById(id) {
  return db.prepare('SELECT * FROM local_videos WHERE id = ?').get(id)
}

function incrementViews(id) {
  db.prepare('UPDATE local_videos SET views = views + 1 WHERE id = ?').run(id)
}

function likeVideo(id) {
  db.prepare('UPDATE local_videos SET likes = likes + 1 WHERE id = ?').run(id)
}

// ─── Local Tracks ─────────────────────────────────────────────────────────────

function insertTrack(t) {
  db.prepare(`INSERT OR REPLACE INTO local_tracks
    (id, title, artist, album, filename, cover, uploader_address, uploader_name,
     duration, plays, uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?)`).run(
    t.id, t.title, t.artist || '', t.album || '', t.filename, t.cover || '',
    t.uploader_address, t.uploader_name || '', t.duration || 0, new Date().toISOString()
  )
}

function getTracks({ limit = 30, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM local_tracks ORDER BY uploaded_at DESC LIMIT ? OFFSET ?').all(limit, offset)
}

function searchTracks(q, limit = 20) {
  const like = `%${q}%`
  return db.prepare(`SELECT * FROM local_tracks
    WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?
    ORDER BY uploaded_at DESC LIMIT ?`).all(like, like, like, limit)
}

function getTrackById(id) {
  return db.prepare('SELECT * FROM local_tracks WHERE id = ?').get(id)
}

function getDb() { return db }

module.exports = {
  initDb, saveResult, loadResult, listResults,
  insertVideo, getVideos, searchVideos, getVideoById, incrementViews, likeVideo,
  insertTrack, getTracks, searchTracks, getTrackById,
  getDb,
}
