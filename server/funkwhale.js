/**
 * M4TR1X - Music Module
 *
 * Local node first, then other m4tr1x nodes. No external instances.
 */

const path     = require('path')
const fs       = require('fs')
const { v4: uuidv4 } = require('uuid')
const db       = require('./db')
const nodeMgr  = require('./node_manager')

function trackToWire(t, nodeUrl = 'local') {
  const isLocal = nodeUrl === 'local'
  return {
    id:         t.id,
    instance:   nodeUrl,
    title:      t.title,
    duration:   t.duration,
    position:   null,
    stream_url: isLocal ? `/api/v1/music/stream/${t.id}` : `${nodeUrl}/api/v1/music/stream/${t.id}`,
    cover:      t.cover ? (isLocal ? `/api/v1/media/${t.cover}` : `${nodeUrl}/api/v1/media/${t.cover}`) : null,
    artist:     { id: null, instance: nodeUrl, name: t.artist, url: null },
    album:      t.album ? { id: null, instance: nodeUrl, title: t.album, url: null } : null,
    tags:       [],
    license:    null,
    created_at: t.uploaded_at || t.creation_date,
    listen_url: isLocal ? `/api/v1/music/stream/${t.id}` : `${nodeUrl}/api/v1/music/stream/${t.id}`,
    local:      isLocal,
    m4tr1x:     true,
    uploader:   t.uploader_name || t.uploader_address || t.artist,
  }
}

async function fetchFromM4tr1xNodes(query = null, limit = 20) {
  const apiPath = query
    ? `/api/v1/music/tracks?q=${encodeURIComponent(query)}&limit=${limit}`
    : `/api/v1/music/tracks?limit=${limit}`
  const results = await nodeMgr.fetchFromNodes('music', apiPath)
  return results.flatMap(({ node, data }) => {
    const tracks = Array.isArray(data) ? data : (data.results || [])
    return tracks.map(t => ({ ...t, instance: node.nodeUrl, m4tr1x: true, local: false }))
  })
}

async function getRecentTracks(instance, limit = 30) {
  const local   = db.getTracks({ limit }).map(t => trackToWire(t, 'local'))
  const network = await fetchFromM4tr1xNodes(null, limit)
  return [...local, ...network].slice(0, limit)
}

async function searchTracks(query, instances = [], limit = 20) {
  const local   = db.searchTracks(query, limit).map(t => trackToWire(t, 'local'))
  const network = await fetchFromM4tr1xNodes(query, limit)
  const seen = new Set()
  return [...local, ...network]
    .filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true })
    .slice(0, limit)
}

async function getRecentAlbums(instance, limit = 20) { return [] }

async function getArtist(instance, artistId) {
  return { id: artistId, instance: 'local', name: artistId, albums: [] }
}

async function getAlbumTracks(instance, albumId) {
  return db.getTracks({ limit: 100 }).filter(t => t.album === albumId).map(t => trackToWire(t, 'local'))
}

function getStreamUrl(instance, id) {
  if (!instance || instance === 'local') return `/api/v1/music/stream/${id}`
  return `${instance}/api/v1/music/stream/${id}`
}

async function getChannels(instance, limit = 20) { return [] }

async function discoverInstances() {
  const nodes = nodeMgr.discoverNodes('music')
  return [
    { host: 'local', name: 'M4TR1X Node', tracks: db.getTracks().length, m4tr1x: true },
    ...nodes
      .filter(n => n.nodeUrl && n.nodeUrl !== nodeMgr.getLocalUrl())
      .map(n => ({ host: n.nodeUrl, name: n.name || 'M4TR1X Node', m4tr1x: true }))
  ]
}

async function uploadTrack(trackPath, meta = {}) {
  const id  = uuidv4()
  const ext = path.extname(meta.originalname || trackPath) || '.mp3'
  const filename = id + ext
  const uploadDir = process.env.M4TR1X_DATA_DIR
    ? path.join(process.env.M4TR1X_DATA_DIR, 'uploads')
    : path.join(require('os').homedir(), '.config', 'm4tr1x', 'uploads')
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  fs.renameSync(trackPath, path.join(uploadDir, filename))
  db.insertTrack({
    id,
    title:            meta.title || filename,
    artist:           meta.artist || '',
    album:            meta.album  || '',
    filename,
    cover:            '',
    uploader_address: meta.h8address    || 'unknown',
    uploader_name:    meta.uploader_name || '',
    duration:         meta.duration      || 0,
  })
  nodeMgr.announceContent({ id, type: 'audio', title: meta.title || filename, category: 'music', uploader: meta.h8address }).catch(() => {})
  return { id, stream_url: `/api/v1/music/stream/${id}` }
}

module.exports = {
  DEFAULT_INSTANCES: ['local'],
  searchTracks,
  getRecentTracks,
  getRecentAlbums,
  getArtist,
  getAlbumTracks,
  getStreamUrl,
  getChannels,
  discoverInstances,
  uploadTrack,
}
