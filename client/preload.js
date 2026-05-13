const { contextBridge, ipcRenderer } = require('electron')
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')

// ── Debug logging ────────────────────────────────────────────────────────────
const log = (...args) => console.log('[preload]', ...args)
const err = (...args) => console.error('[preload]', ...args)

// ── Player ID + login token ──────────────────────────────────────────────────
// Stored in ~/.idle-sys/player_id.txt and ~/.idle-sys/login_token.txt.
// The original code used process.cwd() which points to Program Files on
// packaged Windows builds → EACCES on write → the whole preload crashes →
// contextBridge never runs → window.electron is undefined → EVERY button
// in the game silently does nothing.
const ID_DIR     = path.join(os.homedir(), '.idle-sys')
const ID_FILE    = path.join(ID_DIR, 'player_id.txt')
const TOKEN_FILE = path.join(ID_DIR, 'login_token.txt')

function getPlayerID () {
  try {
    if (fs.existsSync(ID_FILE)) {
      const id = fs.readFileSync(ID_FILE, 'utf-8').trim()
      if (id) {
        log('Player ID loaded from', ID_FILE, '→', id.slice(0, 8) + '…')
        return id
      }
    }
    fs.mkdirSync(ID_DIR, { recursive: true })
    const id = crypto.randomUUID()
    fs.writeFileSync(ID_FILE, id)
    log('Player ID created at', ID_FILE, '→', id.slice(0, 8) + '…')
    return id
  } catch (e) {
    // NEVER let this throw — a thrown error here kills the ENTIRE preload,
    // which means contextBridge never runs, which means window.electron is
    // undefined, which means close/minimize/discord/update all silently break.
    err('getPlayerID failed:', e.message)
    err('Falling back to ephemeral UUID (will change on restart)')
    return crypto.randomUUID()
  }
}

// ── Migrate old player_id.txt from cwd if it exists ─────────────────────────
try {
  const oldFile = path.join(process.cwd(), 'player_id.txt')
  if (fs.existsSync(oldFile) && !fs.existsSync(ID_FILE)) {
    log('Migrating player_id.txt from', oldFile, '→', ID_FILE)
    fs.mkdirSync(ID_DIR, { recursive: true })
    fs.copyFileSync(oldFile, ID_FILE)
  }
} catch (e) {
  err('Migration of old player_id.txt failed (non-fatal):', e.message)
}

// ── Expose to renderer ──────────────────────────────────────────────────────
log('Exposing window.electron and window.api via contextBridge')

contextBridge.exposeInMainWorld('electron', {
  getVersion:     ()    => ipcRenderer.invoke('get-version'),
  getName:        ()    => ipcRenderer.invoke('get-name'),
  openExternal:   (url) => {
    log('openExternal called with:', url)
    return ipcRenderer.invoke('open-external', url)
  },
  minimize:         ()    => {
    log('minimize called')
    return ipcRenderer.invoke('window-minimize')
  },
  close:            ()    => {
    log('close called')
    return ipcRenderer.invoke('window-close')
  },
  platform:            process.platform,
  setDiscordActivity:  (data)  => ipcRenderer.invoke('set-discord-activity', data),
  toggleFullscreen: ()    => ipcRenderer.invoke('window-fullscreen'),
  downloadUpdate: (url) => {
    log('downloadUpdate called with:', url)
    return ipcRenderer.invoke('download-update', url)
  },
  onDownloadProgress: (cb) => {
    ipcRenderer.on('download-progress', (_event, pct) => cb(pct))
  },
  onRpcReady: (cb) => {
    ipcRenderer.on('rpc-ready', cb)
  },
})

function setPlayerID (id) {
  try {
    const trimmed = id.trim()
    if (!trimmed) return false
    fs.mkdirSync(ID_DIR, { recursive: true })
    fs.writeFileSync(ID_FILE, trimmed)
    log('Player ID updated at', ID_FILE, '→', trimmed.slice(0, 8) + '…')
    return true
  } catch (e) {
    err('setPlayerID failed:', e.message)
    return false
  }
}

function getLoginToken () {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim()
      if (t) return t
    }
    return null
  } catch (e) {
    err('getLoginToken failed:', e.message)
    return null
  }
}

function setLoginToken (token) {
  try {
    const trimmed = token.trim()
    if (!trimmed) return false
    fs.mkdirSync(ID_DIR, { recursive: true })
    fs.writeFileSync(TOKEN_FILE, trimmed)
    log('Login token saved at', TOKEN_FILE)
    return true
  } catch (e) {
    err('setLoginToken failed:', e.message)
    return false
  }
}

contextBridge.exposeInMainWorld('api', {
  getPlayerID,
  setPlayerID,
  getLoginToken,
  setLoginToken,
})

log('preload.js finished successfully ✓')