/**
 * M4TR1X - Electron Main Process
 * Application entry point
 *
 * Security:
 *  - contextIsolation: true  → renderer cannot access Node.js APIs
 *  - nodeIntegration: false  → no Node.js access from frontend
 *  - webSecurity: true       → same-origin policy enforced
 *  - CSP via onHeadersReceived → blocks XSS and injection
 *  - setWindowOpenHandler    → external links open in system browser, never in-app
 *  - Tor auto-detect         → if Tor is running, ALL traffic is routed through it
 */

const { app, BrowserWindow, ipcMain, shell, Menu, session } = require('electron')
const path   = require('path')
const fs     = require('fs')
const crypto = require('crypto')
const { setupTorIfAvailable } = require('./server/tor')

// ─── Generazione automatica segreti al primo avvio ───────────────────────────
// In produzione .env non è nel bundle; le chiavi vengono generate e salvate
// in userData (cartella privata dell'app, fuori dal .asar).
function ensureSecrets() {
  const userDataPath = app.getPath('userData')
  const envPath      = path.join(userDataPath, '.env.runtime')
  if (!fs.existsSync(envPath)) {
    const secret    = crypto.randomBytes(32).toString('hex')
    const adminKey  = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(envPath, `APP_SECRET=${secret}\nADMIN_KEY=${adminKey}\n`, { mode: 0o600 })
    console.log('[M4TR1X] Secrets generated at first launch →', envPath)
  }
  // Carica nel processo
  const raw = fs.readFileSync(envPath, 'utf8')
  raw.split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  })
}

// Carica .env locale se presente (dev), altrimenti genera in userData (prod)
const localEnv = path.join(__dirname, '.env')
if (fs.existsSync(localEnv)) {
  require('dotenv').config({ path: localEnv })
} else {
  ensureSecrets()
}

let mainWindow
let torStatus = { torEnabled: false, port: null, source: null }
const SERVER_PORT = 8080

// ─── Content Security Policy ──────────────────────────────────────────────────
function setupCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self' http://localhost:8080",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: https:",
            "media-src 'self' https:",
            "connect-src 'self' http://localhost:8080 ws://localhost:4848 wss: https:",
            "frame-src https:",
            "object-src 'none'",
            "base-uri 'self'",
          ].join('; '),
        ],
      },
    })
  })
}

// ─── Finestra principale ──────────────────────────────────────────────────────
async function createWindow() {
  // Detect Tor BEFORE opening any network connections
  // If Tor Browser or tor daemon is running, all traffic is routed through it
  // — invisible to ISPs and governments
  torStatus = await setupTorIfAvailable(session.defaultSession)
  if (torStatus.torEnabled) {
    console.log(`[M4TR1X] 🧅 Tor active (${torStatus.source}) — maximum privacy`)
  }

  setupCSP()

  mainWindow = new BrowserWindow({
    width:     420,
    height:    900,
    minWidth:  375,
    minHeight: 667,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      true,
      sandbox:          true,
    },
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#000000',
    title:           torStatus.torEnabled
                       ? 'M4TR1X 🧅 — The Unfiltered Eye (Tor)'
                       : 'M4TR1X — The Unfiltered Eye',
    icon: path.join(__dirname, 'assets/icon.png'),
  })

  // Start local API server
  try {
    const { startServer } = require('./server/index')
    await startServer(SERVER_PORT)
    console.log(`[M4TR1X] Local server running on port ${SERVER_PORT}`)
  } catch (err) {
    console.error('[M4TR1X] Failed to start server:', err)
  }

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}/app`)

  // SECURITY: external links → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // SECURITY: block navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${SERVER_PORT}`)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-app-version',    () => app.getVersion())
ipcMain.handle('get-platform',       () => process.platform)
ipcMain.handle('get-user-data-path', () => app.getPath('userData'))
ipcMain.handle('get-tor-status',     () => torStatus)   // frontend can show the 🧅 icon

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})

app.on('before-quit', () => {
  try { require('./server/index').stopServer() } catch (_) {}
})
