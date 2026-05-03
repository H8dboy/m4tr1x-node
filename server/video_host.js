/**
 * M4TR1X — Native Video Hosting
 *
 * Self-hosted video streaming built into the node.
 * No PeerTube dependency — this IS the protocol.
 *
 * Stack:
 *   • HLS (HTTP Live Streaming) — universal player support
 *   • ffmpeg (bundled) — transcoding + thumbnails
 *   • SQLite — video metadata
 *   • Nostr NIP-71 (kind:34235) — federated discovery
 *   • ExifTool — metadata scrubbing before storage
 *
 * Routes (registered by index.js):
 *   POST /api/v1/video/publish    — upload + transcode + publish
 *   GET  /v/:id                   — HTML player page
 *   GET  /v/:id/index.m3u8        — HLS manifest
 *   GET  /v/:id/:segment          — HLS segments (.ts)
 *   GET  /v/:id/thumb.jpg         — thumbnail
 *   GET  /api/v1/video/list       — JSON list of hosted videos
 *   DELETE /api/v1/video/:id      — remove video (admin only)
 */

const fs      = require('fs')
const path    = require('path')
const crypto  = require('crypto')
const { spawnSync, execFileSync } = require('child_process')
const Database = require('better-sqlite3')

// ─── Binaries ─────────────────────────────────────────────────────────────────
let ffmpegBin  = 'ffmpeg'
let ffprobeBin = 'ffprobe'
try {
  ffmpegBin  = require('ffmpeg-static')
  ffprobeBin = require('ffprobe-static').path
} catch {}

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR   = process.env.M4TR1X_DATA_DIR || path.join(require('os').homedir(), '.m4tr1x')
const VIDEOS_DIR = path.join(DATA_DIR, 'videos')
const DB_PATH    = path.join(DATA_DIR, 'm4tr1x.db')

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true })

// ─── Database ─────────────────────────────────────────────────────────────────
let _db = null
function getDb() {
  if (!_db) _db = new Database(DB_PATH)
  return _db
}

function initDb() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hosted_videos (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT DEFAULT '',
      tags         TEXT DEFAULT '[]',
      duration     INTEGER DEFAULT 0,
      size_bytes   INTEGER DEFAULT 0,
      width        INTEGER DEFAULT 0,
      height       INTEGER DEFAULT 0,
      mime         TEXT DEFAULT 'video/mp4',
      uploader     TEXT DEFAULT '',
      nostr_event  TEXT DEFAULT '',
      created_at   INTEGER DEFAULT (strftime('%s','now')),
      views        INTEGER DEFAULT 0
    )
  `)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateId() {
  return crypto.randomBytes(12).toString('hex')
}

function videoDir(id) {
  return path.join(VIDEOS_DIR, id)
}

function getPublicBase() {
  const base = process.env.PRIVATE_NODE_URL || `http://localhost:${process.env.PORT || 8080}`
  return base.replace(/\/$/, '')
}

// ─── ffprobe metadata ─────────────────────────────────────────────────────────
function probeVideo(filePath) {
  const result = spawnSync(ffprobeBin, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath
  ], { encoding: 'utf8' })

  if (result.status !== 0) return null
  try {
    const info = JSON.parse(result.stdout)
    const vs   = info.streams?.find(s => s.codec_type === 'video') || {}
    return {
      duration: Math.round(parseFloat(info.format?.duration || 0)),
      size:     parseInt(info.format?.size || 0),
      width:    parseInt(vs.width  || 0),
      height:   parseInt(vs.height || 0),
    }
  } catch { return null }
}

// ─── Scrub metadata (ExifTool) ────────────────────────────────────────────────
function scrubMetadata(filePath) {
  try {
    spawnSync('exiftool', ['-all=', '-overwrite_original', filePath], { stdio: 'pipe' })
  } catch {}
}

// ─── Transcode → HLS ─────────────────────────────────────────────────────────
/**
 * Converts a raw video to HLS (720p, 2Mbps) and generates a thumbnail.
 * Output: <VIDEOS_DIR>/<id>/index.m3u8 + seg_*.ts + thumb.jpg
 */
function transcodeToHLS(srcPath, id) {
  const outDir = videoDir(id)
  fs.mkdirSync(outDir, { recursive: true })

  const manifest  = path.join(outDir, 'index.m3u8')
  const segPat    = path.join(outDir, 'seg_%03d.ts')
  const thumbPath = path.join(outDir, 'thumb.jpg')

  // HLS transcode — 720p max, 2M video bitrate, AAC audio
  const transcode = spawnSync(ffmpegBin, [
    '-i', srcPath,
    '-vf', 'scale=-2:min(720\\,ih)',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-maxrate', '2M', '-bufsize', '4M',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-hls_time', '10',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', segPat,
    '-hls_flags', 'independent_segments',
    '-movflags', '+faststart',
    manifest,
    '-y'
  ], { stdio: 'pipe', timeout: 600000 })

  if (transcode.status !== 0) {
    const err = transcode.stderr?.toString() || 'transcode failed'
    throw new Error(`[VIDEO] Transcode failed: ${err.slice(-300)}`)
  }

  // Thumbnail — frame at 5s (or 1s if shorter)
  spawnSync(ffmpegBin, [
    '-i', srcPath,
    '-ss', '5',
    '-vframes', '1',
    '-vf', 'scale=640:-2',
    thumbPath, '-y'
  ], { stdio: 'pipe' })

  // Fallback: first frame if 5s didn't work
  if (!fs.existsSync(thumbPath)) {
    spawnSync(ffmpegBin, [
      '-i', srcPath,
      '-vframes', '1',
      '-vf', 'scale=640:-2',
      thumbPath, '-y'
    ], { stdio: 'pipe' })
  }

  return manifest
}

// ─── Publish to Nostr (NIP-71 kind:34235) ────────────────────────────────────
async function publishVideoNostr(meta) {
  try {
    const nostr  = require('./nostr')
    const keys   = nostr.loadSavedKeys()
    if (!keys) return null

    const base = getPublicBase()
    const tags = [
      ['d',            meta.id],
      ['title',        meta.title],
      ['published_at', String(meta.created_at)],
      ['url',          `${base}/v/${meta.id}/index.m3u8`],
      ['m',            'application/x-mpegURL'],
      ['thumb',        `${base}/v/${meta.id}/thumb.jpg`],
      ['image',        `${base}/v/${meta.id}/thumb.jpg`],
      ['summary',      meta.description || ''],
      ['duration',     String(meta.duration)],
      ['dim',          `${meta.width}x${meta.height}`],
      ['size',         String(meta.size_bytes)],
      ['r',            `${base}/v/${meta.id}`],
      ...JSON.parse(meta.tags || '[]').map(t => ['t', t]),
      ['t', 'm4tr1x'],
    ]

    const event = await nostr.publishEvent({
      kind: 34235,
      created_at: meta.created_at,
      tags,
      content: meta.description || meta.title,
    }, keys.privkey)

    return event.id
  } catch (err) {
    console.error('[VIDEO] Nostr publish failed:', err.message)
    return null
  }
}

// ─── HTML Player Page ─────────────────────────────────────────────────────────
function buildPlayerPage(video) {
  const base    = getPublicBase()
  const hlsUrl  = `${base}/v/${video.id}/index.m3u8`
  const thumbUrl = `${base}/v/${video.id}/thumb.jpg`
  const tags    = Array.isArray(video.tags) ? video.tags : JSON.parse(video.tags || '[]')
  const duration = video.duration ? `${Math.floor(video.duration/60)}:${String(video.duration%60).padStart(2,'0')}` : ''

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta property="og:title" content="${escHtml(video.title)}">
  <meta property="og:image" content="${thumbUrl}">
  <meta property="og:video" content="${hlsUrl}">
  <meta property="og:type" content="video.other">
  <meta name="description" content="${escHtml(video.description||'')}">
  <title>${escHtml(video.title)} — M4TR1X</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh}
    header{background:#111;border-bottom:1px solid #222;padding:12px 24px;display:flex;align-items:center;gap:12px}
    header a{color:#ff3c00;text-decoration:none;font-weight:700;font-size:1.1rem;letter-spacing:.05em}
    .container{max-width:960px;margin:0 auto;padding:24px 16px}
    .player-wrap{background:#000;border-radius:8px;overflow:hidden;aspect-ratio:16/9;position:relative}
    video{width:100%;height:100%;display:block}
    h1{font-size:1.4rem;margin:20px 0 8px;line-height:1.3}
    .meta{display:flex;gap:16px;font-size:.85rem;color:#888;margin-bottom:12px;flex-wrap:wrap}
    .desc{color:#bbb;font-size:.95rem;line-height:1.6;white-space:pre-wrap;margin-bottom:16px}
    .tags{display:flex;flex-wrap:wrap;gap:8px}
    .tag{background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:3px 10px;font-size:.8rem;color:#aaa}
    .embed-box{margin-top:24px;background:#111;border-radius:6px;padding:16px}
    .embed-box h3{font-size:.9rem;color:#666;margin-bottom:8px}
    .embed-box textarea{width:100%;background:#0a0a0a;border:1px solid #222;color:#888;font-family:monospace;font-size:.75rem;padding:8px;border-radius:4px;resize:vertical}
    .nostr-id{margin-top:8px;font-size:.75rem;color:#555;word-break:break-all}
    .nostr-id a{color:#ff3c00}
  </style>
</head>
<body>
  <header>
    <a href="/">◈ M4TR1X</a>
    <span style="color:#444">/ video</span>
  </header>
  <div class="container">
    <div class="player-wrap">
      <video id="v" controls playsinline poster="${thumbUrl}"></video>
    </div>
    <h1>${escHtml(video.title)}</h1>
    <div class="meta">
      <span>${new Date(video.created_at*1000).toLocaleDateString('it-IT')}</span>
      ${duration ? `<span>⏱ ${duration}</span>` : ''}
      ${video.views ? `<span>👁 ${video.views} visualizzazioni</span>` : ''}
      ${video.width ? `<span>${video.width}×${video.height}</span>` : ''}
    </div>
    ${video.description ? `<div class="desc">${escHtml(video.description)}</div>` : ''}
    <div class="tags">${tags.map(t=>`<span class="tag">#${escHtml(t)}</span>`).join('')}</div>

    <div class="embed-box">
      <h3>Incorpora</h3>
      <textarea rows="2" readonly>&lt;video src="${hlsUrl}" controls&gt;&lt;/video&gt;</textarea>
      ${video.nostr_event ? `<div class="nostr-id">Nostr: <a href="https://njump.me/${video.nostr_event}" target="_blank">nevent1…</a></div>` : ''}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
  <script>
    const v = document.getElementById('v');
    const src = ${JSON.stringify(hlsUrl)};
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    }
  </script>
</body>
</html>`
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── Core: publish a video ────────────────────────────────────────────────────
/**
 * Full pipeline: scrub → probe → transcode → store DB → publish Nostr.
 * Returns the video metadata object.
 */
async function publishVideo(srcPath, { title, description = '', tags = [], uploader = '' }) {
  initDb()

  const id = generateId()
  console.log(`[VIDEO] Publishing video id=${id} title="${title}"`)

  // 1. Scrub metadata
  scrubMetadata(srcPath)

  // 2. Probe
  const probe = probeVideo(srcPath)
  if (!probe) throw new Error('Cannot read video file — is it a valid video?')

  // 3. Transcode → HLS
  console.log(`[VIDEO] Transcoding ${probe.duration}s ${probe.width}x${probe.height}...`)
  transcodeToHLS(srcPath, id)
  console.log(`[VIDEO] Transcode done → /v/${id}/index.m3u8`)

  // 4. Count segment sizes
  const outDir = videoDir(id)
  const totalSize = fs.readdirSync(outDir)
    .filter(f => f.endsWith('.ts'))
    .reduce((acc, f) => acc + fs.statSync(path.join(outDir, f)).size, 0)

  // 5. Store in DB
  const now = Math.floor(Date.now() / 1000)
  const tagsJson = JSON.stringify(tags)
  getDb().prepare(`
    INSERT INTO hosted_videos (id, title, description, tags, duration, size_bytes, width, height, uploader, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, description, tagsJson, probe.duration, totalSize, probe.width, probe.height, uploader, now)

  // 6. Publish to Nostr (NIP-71)
  const meta = { id, title, description, tags: tagsJson, duration: probe.duration, size_bytes: totalSize, width: probe.width, height: probe.height, created_at: now }
  const nostrId = await publishVideoNostr(meta)
  if (nostrId) {
    getDb().prepare('UPDATE hosted_videos SET nostr_event=? WHERE id=?').run(nostrId, id)
    console.log(`[VIDEO] Published to Nostr: ${nostrId}`)
  }

  return { id, title, description, tags, duration: probe.duration, nostr_event: nostrId, url: `${getPublicBase()}/v/${id}` }
}

// ─── List videos ──────────────────────────────────────────────────────────────
function listVideos(limit = 50, offset = 0) {
  initDb()
  return getDb().prepare(
    'SELECT id, title, description, tags, duration, width, height, created_at, views, nostr_event FROM hosted_videos ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset).map(v => ({
    ...v,
    tags: JSON.parse(v.tags || '[]'),
    thumb: `${getPublicBase()}/v/${v.id}/thumb.jpg`,
    url: `${getPublicBase()}/v/${v.id}`,
    stream: `${getPublicBase()}/v/${v.id}/index.m3u8`,
  }))
}

function getVideo(id) {
  initDb()
  const v = getDb().prepare('SELECT * FROM hosted_videos WHERE id=?').get(id)
  if (!v) return null
  return { ...v, tags: JSON.parse(v.tags || '[]') }
}

function incrementViews(id) {
  initDb()
  getDb().prepare('UPDATE hosted_videos SET views=views+1 WHERE id=?').run(id)
}

function deleteVideo(id) {
  initDb()
  const dir = videoDir(id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  getDb().prepare('DELETE FROM hosted_videos WHERE id=?').run(id)
}

module.exports = {
  publishVideo,
  listVideos,
  getVideo,
  deleteVideo,
  incrementViews,
  buildPlayerPage,
  videoDir,
  VIDEOS_DIR,
}
