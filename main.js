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

// Wait until the local server is actually responding before loading the app
function waitForServer(port, maxMs = 15000) {
  const http = require('http')
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function attempt() {
      http.get(`http://localhost:${port}/app`, res => {
        res.resume()
        resolve()
      }).on('error', () => {
        if (Date.now() - start > maxMs) return reject(new Error('Server timeout'))
        setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

// ─── Content Security Policy ──────────────────────────────────────────────────
function setupCSP() {
  const _nodeOnion = (() => {
    try { return require('./server/node_manager').getOnionAddress() } catch { return null }
  })()
  const _publicUrl = process.env.PUBLIC_NODE_URL || ''
  const _onionOrigin = _nodeOnion ? `http://${_nodeOnion}` : ''
  const _onionWs     = _nodeOnion ? `ws://${_nodeOnion}:4848` : ''
  const _publicWss   = _publicUrl ? _publicUrl.replace(/^https?:\/\//, 'wss://') + '/relay' : ''

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            `default-src 'self' http://localhost:8080 ${_onionOrigin} ${_publicUrl}`.trim(),
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            `img-src 'self' data: blob: http://localhost:8080 ${_onionOrigin} ${_publicUrl} https:`.trim(),
            `media-src 'self' blob: http://localhost:8080 ${_onionOrigin} ${_publicUrl} https:`.trim(),
            `connect-src 'self' http://localhost:8080 ${_onionOrigin} ${_publicUrl} ws://localhost:4848 ${_onionWs} ${_publicWss} wss: https:`.trim(),
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
    show:      false,
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

  // Show loading screen immediately (file:// — no server needed)
  const loadingPath = path.join(__dirname, 'frontend', 'loading.html')
  await mainWindow.loadFile(loadingPath)
  mainWindow.show()

  // Start local API server
  try {
    const { startServer } = require('./server/index')
    await startServer(SERVER_PORT)
    console.log(`[M4TR1X] Local server running on port ${SERVER_PORT}`)
  } catch (err) {
    console.error('[M4TR1X] Failed to start server:', err)
  }

  // Wait until server is ready then switch to the app
  try {
    await waitForServer(SERVER_PORT)
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}/app`)
  } catch (err) {
    console.error('[M4TR1X] Server did not respond in time:', err)
    // Show error in loading screen
    mainWindow.webContents.executeJavaScript(
      `document.body.innerHTML='<div style="color:#ff4455;font-family:monospace;padding:40px;text-align:center">[ SERVER ERROR ]<br><br>${err.message}<br><br>Riavvia l\'app.</div>'`
    )
  }

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
ipcMain.handle('get-tor-status',     () => torStatus)
ipcMain.handle('get-node-config', () => {
  try {
    const nm = require('./server/node_manager')
    return {
      onion:       nm.getOnionAddress(),
      nodeUrl:     nm.getLocalUrl(),
      nodeName:    process.env.NODE_NAME || 'alpha',
      headNodeUrl: process.env.HEAD_NODE_URL || null,
    }
  } catch { return {} }
})

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
