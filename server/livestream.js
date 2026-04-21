/**
 * M4TR1X — Live Streaming (WebRTC + Nostr signaling)
 *
 * Architecture:
 *  - Streamer publishes a Nostr kind-1 event tagged [t, m4tr1x-live] with stream metadata
 *  - Viewers discover streams by subscribing to [t, m4tr1x-live] events
 *  - WebRTC signaling (offer/answer/ICE) is exchanged via encrypted Nostr DMs
 *  - Media flows P2P via WebRTC — no central media server needed
 *  - The Express HTTP server handles /api/v1/stream/* for the Electron frontend
 *    (the actual WebRTC negotiation happens in the browser via the frontend JS)
 */

const { publishNote, sendEncryptedDM, getCurrentPubkey, loadSavedKeys } = require('./nostr')

const LIVE_TAG   = 'm4tr1x-live'
const LIVE_KIND  = 1

// Active streams known to this node
const activeStreams = new Map()

// ─── Start a live stream (streamer side) ─────────────────────────────────────
async function startStream({ title, category = 'reels', pubkey }) {
  const streamId = `${pubkey}-${Date.now()}`
  const startedAt = Math.floor(Date.now() / 1000)

  // Publish stream announcement to Nostr
  const content = JSON.stringify({ type: LIVE_TAG, streamId, title: title || 'Live Stream', category, startedAt })
  const keys = loadSavedKeys()
  if (keys) {
    await publishNote(content, keys.privkey, [
      ['t', LIVE_TAG],
      ['t', `m4tr1x-live-${category}`],
      ['stream-id', streamId],
      ['title', title || 'Live Stream'],
      ['category', category],
    ])
  }

  const stream = { streamId, title, category, pubkey, startedAt, viewerCount: 0 }
  activeStreams.set(streamId, stream)
  console.log(`[LIVE] Stream started: ${streamId}`)
  return stream
}

// ─── Stop a live stream ───────────────────────────────────────────────────────
async function stopStream(streamId) {
  const stream = activeStreams.get(streamId)
  if (!stream) return false

  const keys = loadSavedKeys()
  if (keys) {
    await publishNote(JSON.stringify({ type: 'm4tr1x-live-end', streamId }), keys.privkey, [
      ['t', 'm4tr1x-live-end'],
      ['stream-id', streamId],
    ])
  }

  activeStreams.delete(streamId)
  console.log(`[LIVE] Stream stopped: ${streamId}`)
  return true
}

// ─── Send WebRTC signal via encrypted DM ─────────────────────────────────────
// signal: { type: 'offer'|'answer'|'ice', sdp?, candidate? }
async function sendSignal(toPubkey, signal) {
  const payload = JSON.stringify({ m4tr1x_webrtc: true, ...signal })
  await sendEncryptedDM(toPubkey, payload)
}

// ─── Register a stream discovered from Nostr ─────────────────────────────────
function registerRemoteStream(ev) {
  try {
    const data = JSON.parse(ev.content)
    if (data.type !== LIVE_TAG) return
    activeStreams.set(data.streamId, {
      streamId:    data.streamId,
      title:       data.title,
      category:    data.category,
      pubkey:      ev.pubkey,
      startedAt:   data.startedAt,
      viewerCount: 0,
    })
  } catch {}
}

function removeRemoteStream(ev) {
  try {
    const data = JSON.parse(ev.content)
    if (data.type === 'm4tr1x-live-end') activeStreams.delete(data.streamId)
  } catch {}
}

// ─── List active streams ──────────────────────────────────────────────────────
function listStreams(category) {
  const streams = [...activeStreams.values()]
  return category ? streams.filter(s => s.category === category) : streams
}

module.exports = {
  startStream,
  stopStream,
  sendSignal,
  registerRemoteStream,
  removeRemoteStream,
  listStreams,
  LIVE_TAG,
}
