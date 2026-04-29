/**
 * M4TR1X - Forum/Topic Module (local Nostr relay)
 *
 * Posts live on this node's embedded Nostr relay (ws://localhost:4848).
 * No external Mastodon/ActivityPub federation.
 * Same API surface — frontend unchanged.
 */

const { subscribeToFilter, publishNote, loadSavedKeys } = require('./nostr')

// ─── Read posts from local relay ─────────────────────────────────────────────

function nostrEventToPost(ev) {
  const tags    = ev.tags || []
  const subject = tags.find(t => t[0] === 'subject')?.[1] || ''
  const topic   = tags.find(t => t[0] === 't')?.[1] || ''
  return {
    id:         ev.id,
    instance:   'local',
    url:        `/topic/${ev.id}`,
    content:    ev.content,
    created_at: new Date(ev.created_at * 1000).toISOString(),
    account: {
      id:          ev.pubkey,
      instance:    'local',
      username:    ev.pubkey.slice(0, 12),
      displayName: subject || ev.pubkey.slice(0, 8),
      avatar:      null,
      url:         `/profile/${ev.pubkey}`,
      followers:   0,
      following:   0,
      note:        '',
    },
    favourites: 0,
    reblogs:    0,
    replies:    0,
    media:      [],
    tags:       topic ? [topic] : [],
    sensitive:  false,
    spoiler:    '',
    local:      true,
  }
}

async function getPublicTimeline(instance, limit = 40) {
  return new Promise(resolve => {
    const posts = []
    const timeout = setTimeout(() => resolve(posts), 1500)

    subscribeToFilter(
      [{ kinds: [1], limit }],
      ev => {
        posts.push(nostrEventToPost(ev))
        if (posts.length >= limit) { clearTimeout(timeout); resolve(posts) }
      }
    ).catch(() => { clearTimeout(timeout); resolve([]) })
  })
}

async function searchHashtag(hashtag, instances, limit = 20) {
  return new Promise(resolve => {
    const posts = []
    const timeout = setTimeout(() => resolve(posts), 1500)

    subscribeToFilter(
      [{ kinds: [1], '#t': [hashtag], limit }],
      ev => {
        posts.push(nostrEventToPost(ev))
        if (posts.length >= limit) { clearTimeout(timeout); resolve(posts) }
      }
    ).catch(() => { clearTimeout(timeout); resolve([]) })
  })
}

async function search(query) {
  return { accounts: [], statuses: [] }
}

async function publishPost(instance, accessToken, content, options = {}) {
  const keys = loadSavedKeys()
  if (!keys) throw new Error('No Nostr identity')
  const tags = []
  if (options.topic) tags.push(['t', options.topic])
  if (options.subject) tags.push(['subject', options.subject])
  if (options.inReplyToId) tags.push(['e', options.inReplyToId, '', 'reply'])
  await publishNote(content, keys.privkey, tags)
  return { ok: true }
}

async function getHomeTimeline(instance, accessToken, limit = 40) {
  return getPublicTimeline(instance, limit)
}

function getAuthUrl() { return null }
async function registerApp() { return {} }

module.exports = {
  DEFAULT_INSTANCES: ['local'],
  getPublicTimeline,
  searchHashtag,
  search,
  publishPost,
  getHomeTimeline,
  getAuthUrl,
  registerApp,
}
