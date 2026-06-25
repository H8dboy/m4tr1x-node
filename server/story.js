/**
 * M4TR1X — Stories (NIP-68 kind:20 + NIP-40 expiry)
 *
 * Instagram-style ephemeral posts — visible for 24h, then auto-hidden.
 *
 * Pipeline:
 *   1. Upload image (or short video ≤60s)
 *   2. Strip EXIF, process with sharp
 *   3. Store via Blossom (SHA-256 addressed)
 *   4. Publish kind:20 with ["expiry", now+86400] + ["t","story"] + optional music tag
 *
 * Routes (registered by index.js):
 *   POST /api/v1/story/publish   — upload + publish
 *   GET  /api/v1/story/list      — active stories (not expired)
 *   GET  /api/v1/story/:id       — single story (JSON)
 */

const fs      = require('fs')
const path    = require('path')
const crypto  = require('crypto')
const { spawnSync } = require('child_process')
const sharp   = require('sharp')
const Database = require('better-sqlite3')

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x')
const BLOBS_DIR = path.join(DATA_DIR, 'blobs')
const DB_PATH   = path.join(DATA_DIR, 'm4tr1x.db')

if (!fs.existsSync(BLOBS_DIR)) fs.mkdirSync(BLOBS_DIR, { recursive: true })

// ─── Database ─────────────────────────────────────────────────────────────────
let _db = null
function getDb() {
  if (!_db) _db = new Database(DB_PATH)
  return _db
}

function initStoryDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id           TEXT PRIMARY KEY,
      sha256       TEXT NOT NULL,
      thumb_sha256 TEXT DEFAULT '',
      caption      TEXT DEFAULT '',
      alt          TEXT DEFAULT '',
      tags         TEXT DEFAULT '[]',
      music_id     TEXT DEFAULT '',
      music_title  TEXT DEFAULT '',
      music_artist TEXT DEFAULT '',
      music_url    TEXT DEFAULT '',
      width        INTEGER DEFAULT 0,
      height       INTEGER DEFAULT 0,
      size_bytes   INTEGER DEFAULT 0,
      mime         TEXT DEFAULT 'image/jpeg',
      uploader     TEXT DEFAULT '',
      nostr_event  TEXT DEFAULT '',
      created_at   INTEGER DEFAULT (strftime('%s','now')),
      expires_at   INTEGER DEFAULT 0
    )
  `)
  // Story Highlights (IG-style): survive past the 24h expiry, shown on profile.
  try { getDb().exec("ALTER TABLE stories ADD COLUMN highlighted INTEGER DEFAULT 0") } catch (e) { /* column already exists */ }
}

// ─── Highlights ─────────────────────────────────────────────────────────────
function highlightStory(id, on) {
  initStoryDb()
  const r = getDb().prepare('UPDATE stories SET highlighted=? WHERE id=?').run(on ? 1 : 0, id)
  return { ok: r.changes > 0, id, highlighted: !!on }
}

function deleteStory(id) {
  initStoryDb()
  const r = getDb().prepare('DELETE FROM stories WHERE id=?').run(id)
  return { ok: r.changes > 0, id }
}

function listHighlights(uploader, limit = 50) {
  initStoryDb()
  if (!uploader) return []
  return getDb().prepare(
    'SELECT * FROM stories WHERE uploader=? AND highlighted=1 ORDER BY created_at DESC LIMIT ?'
  ).all(uploader, limit).map(row => ({
    ...row,
    tags:  JSON.parse(row.tags || '[]'),
    url:   blobUrl(row.sha256),
    thumb: blobUrl(row.thumb_sha256),
  }))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function blobPath(sha256) {
  return path.join(BLOBS_DIR, sha256)
}

function getPublicBase() {
  return (process.env.PRIVATE_NODE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '')
}

function blobUrl(sha256) {
  return `${getPublicBase()}/blossom/${sha256}`
}

function stripExif(filePath) {
  try {
    spawnSync('exiftool', ['-all=', '-overwrite_original', filePath], { stdio: 'pipe' })
  } catch {}
}

// ─── Process image (story format: 9:16 aspect, max 1080px tall) ───────────────
async function processStoryImage(srcPath) {
  const meta = await sharp(srcPath).metadata()
  const origW = meta.width  || 0
  const origH = meta.height || 0

  // Full story: max 1080px tall (portrait-first), quality 85
  const fullBuf = await sharp(srcPath)
    .rotate()
    .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer()

  const fullSha = crypto.createHash('sha256').update(fullBuf).digest('hex')
  fs.writeFileSync(blobPath(fullSha), fullBuf)

  // Thumbnail: 360px tall
  const thumbBuf = await sharp(srcPath)
    .rotate()
    .resize(360, 640, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70, progressive: true })
    .toBuffer()

  const thumbSha = crypto.createHash('sha256').update(thumbBuf).digest('hex')
  fs.writeFileSync(blobPath(thumbSha), thumbBuf)

  const fullMeta = await sharp(fullBuf).metadata()

  return {
    sha256:      fullSha,
    thumbSha256: thumbSha,
    width:       fullMeta.width  || origW,
    height:      fullMeta.height || origH,
    size:        fullBuf.length,
    mime:        'image/jpeg',
  }
}

// ─── Resolve music track from local DB ───────────────────────────────────────
function resolveMusicTrack(musicId) {
  if (!musicId) return null
  try {
    const row = getDb().prepare('SELECT * FROM local_tracks WHERE id=?').get(musicId)
    if (!row) return null
    const base = getPublicBase()
    return {
      id:     row.id,
      title:  row.title  || '',
      artist: row.artist || '',
      url:    `${base}/api/v1/music/stream/${row.id}`,
    }
  } catch {
    return null
  }
}

// ─── Publish to Nostr (kind:20 + NIP-40 expiry + story tag + optional music) ─
async function publishStoryNostr({ sha256, thumbSha256, width, height, size, mime, caption, alt, tags, created_at, expires_at, music }) {
  try {
    const nostr = require('./nostr')
    const keys  = nostr.loadSavedKeys()
    if (!keys) return null

    const url      = blobUrl(sha256)
    const thumbUrl = blobUrl(thumbSha256)
    const dim      = `${width}x${height}`

    const imetaFull = [
      'imeta',
      `url ${url}`,
      `m ${mime}`,
      `dim ${dim}`,
      `size ${size}`,
      `x ${sha256}`,
      alt ? `alt ${alt}` : null,
    ].filter(Boolean).join(' ')

    const imetaThumb = [
      'imeta',
      `url ${thumbUrl}`,
      `m image/jpeg`,
      `x ${thumbSha256}`,
    ].join(' ')

    const eventTags = [
      [imetaFull],
      [imetaThumb],
      ['url', url],
      ['m', mime],
      ['dim', dim],
      ['size', String(size)],
      ['x', sha256],
      ['thumb', thumbUrl],
      ['expiry', String(expires_at)],
      ['t', 'story'],
      ['t', 'm4tr1x'],
      ...tags.map(t => ['t', t]),
    ]

    // Music attachment tag: ["music", id, title, artist, stream_url]
    if (music) {
      eventTags.push(['music', music.id, music.title, music.artist, music.url])
    }

    const event = await nostr.publishEvent({
      kind: 20,
      created_at,
      tags: eventTags,
      content: caption || '',
    }, keys.privkey)

    return event.id
  } catch (err) {
    console.error('[STORY] Nostr publish failed:', err.message)
    return null
  }
}

// ─── Core: publish a story ────────────────────────────────────────────────────
async function publishStory(srcPath, { caption = '', alt = '', tags = [], uploader = '', music_id = '' }) {
  initStoryDb()

  const id         = crypto.randomBytes(12).toString('hex')
  const now        = Math.floor(Date.now() / 1000)
  const expires_at = now + 86400  // 24h

  stripExif(srcPath)

  console.log(`[STORY] Processing story id=${id}`)
  const img = await processStoryImage(srcPath)

  const music    = resolveMusicTrack(music_id)
  const tagsJson = JSON.stringify(tags)

  getDb().prepare(`
    INSERT INTO stories
      (id, sha256, thumb_sha256, caption, alt, tags,
       music_id, music_title, music_artist, music_url,
       width, height, size_bytes, mime, uploader, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, img.sha256, img.thumbSha256, caption, alt, tagsJson,
    music ? music.id     : '',
    music ? music.title  : '',
    music ? music.artist : '',
    music ? music.url    : '',
    img.width, img.height, img.size, img.mime, uploader, now, expires_at
  )

  const nostrId = await publishStoryNostr({
    sha256:      img.sha256,
    thumbSha256: img.thumbSha256,
    width:       img.width,
    height:      img.height,
    size:        img.size,
    mime:        img.mime,
    caption, alt, tags, created_at: now, expires_at, music,
  })

  if (nostrId) {
    getDb().prepare('UPDATE stories SET nostr_event=? WHERE id=?').run(nostrId, id)
    console.log(`[STORY] Published to Nostr kind:20 (story) — ${nostrId}`)
  }

  return {
    id,
    url:        blobUrl(img.sha256),
    thumb:      blobUrl(img.thumbSha256),
    sha256:     img.sha256,
    width:      img.width,
    height:     img.height,
    caption,
    tags,
    music:      music || null,
    nostr_event: nostrId,
    created_at: now,
    expires_at,
  }
}

// ─── List active stories (not expired) ───────────────────────────────────────
function listStories(limit = 50) {
  initStoryDb()
  const now = Math.floor(Date.now() / 1000)
  return getDb().prepare(
    'SELECT * FROM stories WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?'
  ).all(now, limit).map(row => ({
    ...row,
    tags:  JSON.parse(row.tags || '[]'),
    url:   blobUrl(row.sha256),
    thumb: blobUrl(row.thumb_sha256),
    music: row.music_id ? {
      id:     row.music_id,
      title:  row.music_title,
      artist: row.music_artist,
      url:    row.music_url,
    } : null,
  }))
}

function getStory(id) {
  initStoryDb()
  const row = getDb().prepare('SELECT * FROM stories WHERE id=?').get(id)
  if (!row) return null
  return {
    ...row,
    tags:  JSON.parse(row.tags || '[]'),
    url:   blobUrl(row.sha256),
    thumb: blobUrl(row.thumb_sha256),
    music: row.music_id ? {
      id:     row.music_id,
      title:  row.music_title,
      artist: row.music_artist,
      url:    row.music_url,
    } : null,
  }
}

module.exports = { publishStory, listStories, getStory, initStoryDb, highlightStory, listHighlights, deleteStory }
