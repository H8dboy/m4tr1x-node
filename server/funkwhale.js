/**
 * M4TR1X - Music Module (local-first)
 *
 * Music lives on this node. No external Funkwhale instances.
 * Same API surface as before — frontend unchanged.
 */

const path = require('path')
const fs   = require('fs')
const { v4: uuidv4 } = require('uuid')
const db   = require('./db')

function trackToWire(t) {
  return {
    id:         t.id,
    instance:   'local',
    title:      t.title,
    duration:   t.duration,
    position:   null,
    stream_url: `/api/v1/music/stream/${t.id}`,
    cover:      t.cover ? `/api/v1/media/${t.cover}` : null,
    artist:     { id: null, instance: 'local', name: t.artist, url: null },
    album:      t.album ? { id: null, instance: 'local', title: t.album, url: null } : null,
    tags:       [],
    license:    null,
    created_at: t.uploaded_at,
    listen_url: `/api/v1/music/stream/${t.id}`,
    local:      true,
    uploader:   t.uploader_name || t.uploader_address,
  }
}

async function getRecentTracks(instance, limit = 30) {
  return db.getTracks({ limit }).map(trackToWire)
}

async function searchTracks(query, instances, limit = 20) {
  return db.searchTracks(query, limit).map(trackToWire)
}

async function getRecentAlbums(instance, limit = 20) {
  return []
}

async function getArtist(instance, artistId) {
  return { id: artistId, instance: 'local', name: artistId, albums: [] }
}

async function getAlbumTracks(instance, albumId) {
  return db.getTracks({ limit: 100 }).filter(t => t.album === albumId).map(trackToWire)
}

function getStreamUrl(instance, id) {
  return `/api/v1/music/stream/${id}`
}

async function getChannels(instance, limit = 20) {
  return []
}

async function discoverInstances() {
  return [{ host: 'local', name: 'M4TR1X Node', tracks: db.getTracks().length }]
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
