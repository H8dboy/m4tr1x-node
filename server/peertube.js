/**
 * M4TR1X - Video Module
 *
 * Local node first, then other m4tr1x nodes. No external instances.
 */

const path    = require('path')
const fs      = require('fs')
const { v4: uuidv4 } = require('uuid')
const db      = require('./db')
const nodeMgr = require('./node_manager')

function videoToWire(v, nodeUrl = 'local') {
  const isLocal = nodeUrl === 'local'
  return {
    uuid:         v.id,
    instance:     nodeUrl,
    name:         v.title,
    description:  v.description,
    published_at: v.uploaded_at,
    duration:     v.duration,
    views:        v.views,
    likes:        v.likes,
    dislikes:     0,
    thumbnail:    v.thumbnail
      ? (isLocal ? `/api/v1/media/${v.thumbnail}` : `${nodeUrl}/api/v1/media/${v.thumbnail}`)
      : null,
    embed_url:    isLocal ? `/api/v1/video/embed/${v.id}` : `${nodeUrl}/api/v1/video/embed/${v.id}`,
    watch_url:    isLocal ? `/api/v1/video/watch/${v.id}` : `${nodeUrl}/api/v1/video/watch/${v.id}`,
    stream_url:   isLocal ? `/api/v1/video/stream/${v.id}` : `${nodeUrl}/api/v1/video/stream/${v.id}`,
    channel: {
      name:   v.uploader_name || v.uploader_address,
      url:    isLocal ? `/profile/${v.uploader_address}` : `${nodeUrl}/profile/${v.uploader_address}`,
      avatar: null,
    },
    tags:     JSON.parse(v.tags || '[]'),
    language: null,
    category: v.category,
    nsfw:     false,
    local:    isLocal,
    m4tr1x:   true,
  }
}

async function fetchFromM4tr1xNodes(query = null, limit = 20) {
  const apiPath = query
    ? `/api/v1/videos/list?q=${encodeURIComponent(query)}&limit=${limit}`
    : `/api/v1/videos/list?limit=${limit}`
  const results = await nodeMgr.fetchFromNodes('film', apiPath)
  return results.flatMap(({ node, data }) => {
    const videos = Array.isArray(data) ? data : (data.data || [])
    return videos.map(v => ({ ...v, instance: node.nodeUrl, m4tr1x: true, local: false }))
  })
}

async function getVideos(instance, limit = 30) {
  const local   = db.getVideos({ limit }).map(v => videoToWire(v, 'local'))
  const network = await fetchFromM4tr1xNodes(null, limit)
  return [...local, ...network].slice(0, limit)
}

async function searchVideos(query, instances = [], limit = 20) {
  const local   = db.searchVideos(query, limit).map(v => videoToWire(v, 'local'))
  const network = await fetchFromM4tr1xNodes(query, limit)
  const seen = new Set()
  return [...local, ...network]
    .filter(v => { if (seen.has(v.uuid)) return false; seen.add(v.uuid); return true })
    .slice(0, limit)
}

async function getChannelVideos(instance, channelName, limit = 20) {
  return db.getVideos({ limit }).filter(v =>
    v.uploader_address === channelName || v.uploader_name === channelName
  ).map(v => videoToWire(v, 'local'))
}

async function getVideo(instance, id) {
  const local = db.getVideoById(id)
  if (local) { db.incrementViews(id); return videoToWire(local, 'local') }
  const location = nodeMgr.locateContent(id)
  if (location) {
    try {
      const data = await nodeMgr.queryNode(location.nodeUrl, `/api/v1/peertube/video/${location.nodeUrl}/${id}`)
      return { ...data, instance: location.nodeUrl, m4tr1x: true }
    } catch {}
  }
  throw new Error('Video not found')
}

async function discoverInstances() {
  const nodes = nodeMgr.discoverNodes('film')
  return [
    { host: 'local', name: 'M4TR1X Node', description: 'This node', videos: db.getVideos().length, m4tr1x: true },
    ...nodes
      .filter(n => n.nodeUrl && n.nodeUrl !== nodeMgr.getLocalUrl())
      .map(n => ({ host: n.nodeUrl, name: n.name || 'M4TR1X Node', m4tr1x: true }))
  ]
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
  nodeMgr.announceContent({ id, type: 'video', title: meta.name || filename, category: meta.category || 'reels', uploader: meta.h8address }).catch(() => {})
  return {
    uuid:      id,
    watch_url: `/api/v1/video/watch/${id}`,
    embed_url: `/api/v1/video/embed/${id}`,
  }
}

function getEmbedUrl(instance, id) {
  if (!instance || instance === 'local') return `/api/v1/video/embed/${id}`
  return `${instance}/api/v1/video/embed/${id}`
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
