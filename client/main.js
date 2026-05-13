const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path  = require('path')
const https = require('https')
const http  = require('http')
const fs    = require('fs')
const os    = require('os')
const isDev = process.argv.includes('--dev')
const { installerName, platformUrl, needsChmod, skipAutoQuit, installerTempPath } = require('./platform')

// ── Debug logging ────────────────────────────────────────────────────────────
const log = (...args) => console.log('[main]', ...args)
const err = (...args) => console.error('[main]', ...args)

let mainWindow

function createWindow () {
  log('createWindow()')
  // Disable vsync and frame rate cap so the JS-side FPS cap is the only governor.
  // Without this, Chromium locks RAF to the display refresh rate even on "Unlimited".
  app.commandLine.appendSwitch('disable-frame-rate-limit')
  app.commandLine.appendSwitch('disable-gpu-vsync')
  mainWindow = new BrowserWindow({
    width:           1100,
    height:          780,
    minWidth:        900,
    minHeight:       600,
    backgroundColor: '#080c0a',
    titleBarStyle:   'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('ngrok')) {
      details.requestHeaders['ngrok-skip-browser-warning'] = 'true'
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  mainWindow.loadFile('index.html')
  mainWindow.setMenuBarVisibility(false)

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  log('Window created, preload:', path.join(__dirname, 'preload.js'))
}

// ── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.handle('get-version', () => {
  const v = app.getVersion()
  log('get-version →', v)
  return v
})

ipcMain.handle('get-name', () => {
  const n = app.getName()
  log('get-name →', n)
  return n
})

ipcMain.handle('open-external', async (_event, url) => {
  log('open-external called with:', url)
  // Specific prefix allowlist. No blanket 'https://' — that defeats the purpose.
  const allowed = [
    'https://discord.com/',
    'https://discord.gg/',
    'https://github.com/',
    'https://ko-fi.com/',
    'https://www.ko-fi.com/',
    'https://patreon.com/',
    'https://www.patreon.com/',
    'http://localhost',
    'https://localhost',
  ]
  const trimmed  = (url || '').trim()
  const lowerUrl = trimmed.toLowerCase()

  if (!allowed.some(prefix => lowerUrl.startsWith(prefix))) {
    err('open-external REJECTED:', trimmed, '(no matching prefix)')
    return { success: false, error: 'URL not allowed' }
  }

  try {
    log('open-external → shell.openExternal:', trimmed)
    await shell.openExternal(trimmed)
    log('open-external → success')
    return { success: true }
  } catch (e) {
    err('open-external → shell.openExternal THREW:', e.message)
    return { success: false, error: e.message }
  }
})

// Window controls
ipcMain.handle('window-minimize', () => {
  log('window-minimize called, window exists:', !!mainWindow, 'destroyed:', mainWindow?.isDestroyed())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize()
    log('window-minimize → done')
  }
})

ipcMain.handle('window-close', () => {
  log('window-close called, window exists:', !!mainWindow, 'destroyed:', mainWindow?.isDestroyed())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
    log('window-close → done')
  }
})

ipcMain.handle('window-fullscreen', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
  }
})

// ── Update download ─────────────────────────────────────────────────────────
ipcMain.handle('download-update', async (_event, url) => {
  log('download-update called with:', url)
  try {
    const destPath = installerTempPath()
    const destDir  = require('path').dirname(destPath)
    // Wipe any leftover installers from previous updates before writing the new one.
    try {
      for (const f of fs.readdirSync(destDir)) {
        try { fs.unlinkSync(require('path').join(destDir, f)) } catch (_) {}
      }
    } catch (_) {}
    fs.mkdirSync(destDir, { recursive: true })
    log('download-update → dest:', destPath, '| platform installer:', installerName)

    return new Promise((resolve) => {
      const doDownload = (downloadUrl) => {
        const client = downloadUrl.startsWith('https:') ? https : http

        let file
        try {
          file = fs.createWriteStream(destPath)
        } catch (e) {
          resolve({ success: false, error: e.message })
          return
        }

        const req = client.get(downloadUrl, (res) => {
          log('download-update → HTTP', res.statusCode)

          // Follow one redirect
          if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
            log('download-update → redirect to:', res.headers.location)
            file.close()
            doDownload(res.headers.location)
            return
          }

          if (res.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${res.statusCode}` })
            return
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0')
          let downloaded = 0
          log('download-update → total bytes:', totalBytes)

          res.on('data', (chunk) => {
            downloaded += chunk.length
            if (totalBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
              const pct = Math.round((downloaded / totalBytes) * 100)
              mainWindow.webContents.send('download-progress', pct)
            }
          })

          res.pipe(file)

          file.on('finish', () => {
            file.close((closeErr) => {
              if (closeErr) err('download-update → file close error:', closeErr.message)
              log('download-update → download complete, launching installer via shell.openPath')
              if (needsChmod) {
                try { fs.chmodSync(destPath, 0o755) } catch (_) {}
              }
              // shell.openPath avoids EBUSY — asks the OS to open the file
              // the same way double-clicking it in Explorer does.
              // macOS: opens the DMG in Finder; user drags to Applications — don't quit the running app.
              shell.openPath(destPath).then((errMsg) => {
                if (errMsg) err('download-update → shell.openPath error:', errMsg)
                if (!skipAutoQuit) {
                  setTimeout(() => {
                    log('download-update → closing app for installer')
                    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
                    app.quit()
                  }, 1500)
                }
              })
              resolve({ success: true, path: destPath })
            })
          })

          file.on('error', (e) => {
            err('download-update → file write error:', e.message)
            fs.unlink(destPath, () => {})
            resolve({ success: false, error: e.message })
          })
        })

        req.on('error', (e) => {
          err('download-update → request error:', e.message)
          resolve({ success: false, error: e.message })
        })

        req.setTimeout(300000, () => {
          err('download-update → timeout')
          req.destroy()
          resolve({ success: false, error: 'Download timeout' })
        })
      }

      doDownload(platformUrl(url))
    })
  } catch (e) {
    err('download-update → exception:', e.message)
    return { success: false, error: e.message }
  }
})

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  log('app ready')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  log('all windows closed, platform:', process.platform)
  if (process.platform !== 'darwin') app.quit()
})