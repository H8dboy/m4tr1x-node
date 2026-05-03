/**
 * M4TR1X — Photo Posts (NIP-68 kind:20)
 *
 * Instagram-style photo posts, fully self-hosted.
 *
 * Pipeline:
 *   1. Upload image (JPEG/PNG/WebP/GIF)
 *   2. Strip EXIF metadata (ExifTool)
 *   3. Resize → max 1920px, generate 640px thumbnail
 *   4. Store both via Blossom (SHA-256 addressed)
 *   5. Publish Nostr kind:20 (NIP-68) with imeta tags (NIP-92)
 *
 * Routes (registered by index.js):
 *   POST /api/v1/photo/publish   — upload + publish
 *   GET  /api/v1/photo/list      — feed foto del nodo
 *   GET  /api/v1/photo/:id       — singola foto (JSON)
 *   GET  /p/:sha256              — immagine grezza (redirect a /blossom/:sha256)
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

function initPhotoDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS photos (
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
      likes        INTEGER DEFAULT 0
    )
  `)
  // Add music columns if upgrading from older schema
  const cols = getDb().prepare("PRAGMA table_info(photos)").all().map(r => r.name)
  if (!cols.includes('music_id')) {
    getDb().exec(`
      ALTER TABLE photos ADD COLUMN music_id     TEXT DEFAULT '';
      ALTER TABLE photos ADD COLUMN music_title  TEXT DEFAULT '';
      ALTER TABLE photos ADD COLUMN music_artist TEXT DEFAULT '';
      ALTER TABLE photos ADD COLUMN music_url    TEXT DEFAULT '';
    `)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sha256File(filePath) {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function blobPath(sha256) {
  return path.join(BLOBS_DIR, sha256)
}

function getPublicBase() {
  return (process.env.PRIVATE_NODE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '')
}

function blobUrl(sha256) {
  return `${getPublicBase()}/blossom/${sha256}`
}

// ─── Strip EXIF ───────────────────────────────────────────────────────────────
function stripExif(filePath) {
  try {
    spawnSync('exiftool', ['-all=', '-overwrite_original', filePath], { stdio: 'pipe' })
  } catch {}
}

// ─── Process image ────────────────────────────────────────────────────────────
async function processImage(srcPath, mime) {
  // 1. Leggi metadata originali
  const meta = await sharp(srcPath).metadata()
  const origW = meta.width  || 0
  const origH = meta.height || 0

  // 2. Versione full — max 1920px lato lungo, qualità 88
  const fullBuf = await sharp(srcPath)
    .rotate()                           // rispetta orientazione EXIF prima di strippare
    .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, progressive: true })
    .toBuffer()

  const fullSha = crypto.createHash('sha256').update(fullBuf).digest('hex')
  fs.writeFileSync(blobPath(fullSha), fullBuf)

  // 3. Thumbnail — 640px lato lungo, qualità 75
  const thumbBuf = await sharp(srcPath)
    .rotate()
    .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, progressive: true })
    .toBuffer()

  const thumbSha = crypto.createHash('sha256').update(thumbBuf).digest('hex')
  fs.writeFileSync(blobPath(thumbSha), thumbBuf)

  // 4. Dimensioni reali dell'immagine processata
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

// ─── Publish to Nostr (NIP-68 kind:20 + NIP-92 imeta) ────────────────────────
async function publishPhotoNostr({ sha256, thumbSha256, width, height, size, mime, caption, alt, tags, created_at, music }) {
  try {
    const nostr = require('./nostr')
    const keys  = nostr.loadSavedKeys()
    if (!keys) return null

    const url      = blobUrl(sha256)
    const thumbUrl = blobUrl(thumbSha256)
    const dim      = `${width}x${height}`

    // NIP-92 imeta tag — full image
    const imetaFull = [
      'imeta',
      `url ${url}`,
      `m ${mime}`,
      `dim ${dim}`,
      `size ${size}`,
      `x ${sha256}`,
      alt ? `alt ${alt}` : null,
    ].filter(Boolean).join(' ')

    // NIP-92 imeta tag — thumbnail
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
      ...tags.map(t => ['t', t]),
      ['t', 'm4tr1x'],
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
    console.error('[PHOTO] Nostr publish failed:', err.message)
    return null
  }
}

// ─── Core: publish a photo ────────────────────────────────────────────────────
async function publishPhoto(srcPath, { caption = '', alt = '', tags = [], uploader = '', music_id = '' }) {
  initPhotoDb()

  const id    = crypto.randomBytes(12).toString('hex')
  const now   = Math.floor(Date.now() / 1000)
  const music = resolveMusicTrack(music_id)

  stripExif(srcPath)

  console.log(`[PHOTO] Processing photo id=${id}`)
  const img = await processImage(srcPath, 'image/jpeg')

  const tagsJson = JSON.stringify(tags)
  getDb().prepare(`
    INSERT INTO photos
      (id, sha256, thumb_sha256, caption, alt, tags,
       music_id, music_title, music_artist, music_url,
       width, height, size_bytes, mime, uploader, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, img.sha256, img.thumbSha256, caption, alt, tagsJson,
    music ? music.id     : '',
    music ? music.title  : '',
    music ? music.artist : '',
    music ? music.url    : '',
    img.width, img.height, img.size, img.mime, uploader, now
  )

  const nostrId = await publishPhotoNostr({
    sha256:      img.sha256,
    thumbSha256: img.thumbSha256,
    width:       img.width,
    height:      img.height,
    size:        img.size,
    mime:        img.mime,
    caption, alt, tags, created_at: now, music,
  })

  if (nostrId) {
    getDb().prepare('UPDATE photos SET nostr_event=? WHERE id=?').run(nostrId, id)
    console.log(`[PHOTO] Published to Nostr kind:20 — ${nostrId}`)
  }

  return {
    id,
    url:       blobUrl(img.sha256),
    thumb:     blobUrl(img.thumbSha256),
    sha256:    img.sha256,
    width:     img.width,
    height:    img.height,
    caption,
    tags,
    music:     music || null,
    nostr_event: nostrId,
    created_at: now,
  }
}

// ─── List & get ───────────────────────────────────────────────────────────────
function _mapPhoto(row) {
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

function listPhotos(limit = 50, offset = 0) {
  initPhotoDb()
  return getDb().prepare(
    'SELECT * FROM photos ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset).map(_mapPhoto)
}

function getPhoto(id) {
  initPhotoDb()
  const row = getDb().prepare('SELECT * FROM photos WHERE id=?').get(id)
  if (!row) return null
  return _mapPhoto(row)
}

module.exports = { publishPhoto, listPhotos, getPhoto, initPhotoDb }
