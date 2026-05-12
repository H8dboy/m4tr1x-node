'use strict'

/**
 * Head node DB backup — runs on the HEAD NODE only.
 * Copies head.db to a timestamped backup file every 6 hours.
 * Set M4TR1X_BACKUP_DIR env to override default backup location.
 */

const fs   = require('fs')
const path = require('path')

const BACKUP_INTERVAL = 6 * 60 * 60 * 1000  // 6 hours

function _getHeadDbPath() {
  return process.env.HEAD_DB_PATH || path.join(process.env.M4TR1X_DATA_DIR || process.cwd(), 'head.db')
}

function _getBackupDir() {
  const d = process.env.M4TR1X_BACKUP_DIR || path.join(process.env.M4TR1X_DATA_DIR || process.cwd(), 'backups')
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

function runBackup() {
  const src = _getHeadDbPath()
  if (!fs.existsSync(src)) {
    console.warn('[BACKUP] head.db not found at', src)
    return
  }

  const dir  = _getBackupDir()
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(dir, `head_${ts}.db`)

  try {
    fs.copyFileSync(src, dest)
    console.log(`[BACKUP] head.db → ${dest}`)
    _pruneOldBackups(dir)
  } catch (e) {
    console.error('[BACKUP] Failed:', e.message)
  }
}

// Keep only the 24 most recent backups (6h × 24 = 6 days)
function _pruneOldBackups(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('head_') && f.endsWith('.db'))
      .sort()
    if (files.length > 24) {
      files.slice(0, files.length - 24).forEach(f => {
        try { fs.unlinkSync(path.join(dir, f)) } catch {}
      })
    }
  } catch {}
}

function startBackup() {
  if (process.env.HEAD_NODE !== 'true') return
  console.log(`[BACKUP] DB backup enabled — every ${BACKUP_INTERVAL / 3600000}h`)
  runBackup()
  setInterval(runBackup, BACKUP_INTERVAL)
}

module.exports = { startBackup, runBackup }
