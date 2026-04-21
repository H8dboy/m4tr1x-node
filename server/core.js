/**
 * M4TR1X - Metadata Scrubbing
 * Removes GPS/EXIF metadata from videos before upload.
 */

const { execSync, spawnSync } = require('child_process')
const fs = require('fs')

/**
 * Strips all EXIF/GPS metadata from the specified file.
 * Requires ExifTool installed on the system: https://exiftool.org/
 *
 * @param {string} filePath - Absolute path to the video file
 * @returns {boolean} - true if successful, false if ExifTool not available
 */
function cleanMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`[CORE] File not found: ${filePath}`)
    return false
  }

  console.log(`[CORE] Stripping metadata: ${filePath}`)

  try {
    // Usa spawnSync con array di argomenti — nessuna interpolazione shell (fix command injection)
    const result = spawnSync('exiftool', ['-all=', '-overwrite_original', filePath], { stdio: 'pipe' })
    if (result.status !== 0) throw new Error(result.stderr?.toString() || 'exiftool failed')
    console.log('[CORE] Metadata removed successfully.')
    return true
  } catch (err) {
    // ExifTool not installed — warn but do not block upload
    console.warn('[CORE] ExifTool not available. Metadata not stripped.')
    console.warn('[CORE] Install ExifTool: https://exiftool.org/')
    return false
  }
}

/**
 * Checks whether ExifTool is available on the system.
 */
function isExifToolAvailable() {
  try {
    execSync('exiftool -ver', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

module.exports = { cleanMetadata, isExifToolAvailable }
