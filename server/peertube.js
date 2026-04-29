/**
 * M4TR1X - Video Module (local-first)
 *
 * Videos live on this node. No external PeerTube instances.
 * The protocol format is preserved so the frontend needs no changes.
 */

const path  = require('path')
const fs    = require('fs')
const { v4: uuidv4 } = require('uuid')
const db    = require('./db')

function videoToWire(v) {
  return {
    uuid:         v.id,
    instance:     'local',
    name:         v.title,
    description:  v.description,
    published_at: v.uploaded_at,
    duration:     v.duration,
    views:        v.views,
    likes:        v.likes,
    dislikes:     0,
    thumbnail:    v.thumbnail ? `/api/v1/media/${v.thumbnail}` : null,
    embed_url:    `/api/v1/video/embed/${v.id}`,
    watch_url:    `/api/v1/video/watch/${v.id}`,
    stream_url:   `/api/v1/video/stream/${v.id}`,
    channel: {
      name:   v.uploader_name || v.uploader_address,
      url:    `/profile/${v.uploader_address}`,
      avatar: null,
    },
    tags:     JSON.parse(v.tags || '[]'),
    language: null,
    category: v.category,
    nsfw:     false,
    local:    true,
  }
}

async function getVideos(instance, limit = 30) {
  return db.getVideos({ limit }).map(videoToWire)
}

async function searchVideos(query, instances, limit = 20) {
  return db.searchVideos(query, limit).map(videoToWire)
}

async function getChannelVideos(instance, channelName, limit = 20) {
  return db.getVideos({ limit }).filter(v =>
    v.uploader_address === channelName || v.uploader_name === channelName
  ).map(videoToWire)
}

async function getVideo(instance, id) {
  const v = db.getVideoById(id)
  if (!v) throw new Error('Video not found')
  db.incrementViews(id)
  return videoToWire(v)
}

async function discoverInstances() {
  return [{ host: 'local', name: 'M4TR1X Node', description: 'This node', videos: db.getVideos().length }]
}

async function uploadVideo(instance, token, videoPath, meta = {}) {
  const id  = uuidv4()
  const ext = path.extname(meta.originalname || videoPath) || '.mp4'
  const filename = id + ext

  const uploadDir = process.env.M4TR1X_DATA_DIR
    ? path.join(process.env.M4TR1X_DATA_DIR, 'uploads')
    : path.join(require('os').homedir(), '.config', 'm4tr1x', 'uploads')

  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  fs.renameSync(videoPath, path.join(uploadDir, filename))

  db.insertVideo({
    id,
    title:            meta.name || filename,
    description:      meta.description || '',
    filename,
    thumbnail:        '',
    uploader_address: meta.h8address || 'unknown',
    uploader_name:    meta.uploader_name || '',
    category:         meta.category || 'reels',
    tags:             meta.tags || [],
    duration:         meta.duration || 0,
  })

  return {
    uuid:      id,
    watch_url: `/api/v1/video/watch/${id}`,
    embed_url: `/api/v1/video/embed/${id}`,
  }
}

function getEmbedUrl(instance, id) {
  return `/api/v1/video/embed/${id}`
}

module.exports = {
  DEFAULT_INSTANCES: ['local'],
  getVideos,
  searchVideos,
  getChannelVideos,
  getVideo,
  getEmbedUrl,
  discoverInstances,
  uploadVideo,
}
