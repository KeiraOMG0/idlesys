const path = require('path')
const os   = require('os')

const PLATFORM = process.platform  // 'win32' | 'darwin' | 'linux'

const INSTALLER_NAMES = {
  win32:  'IDLE.SYS-Setup.exe',
  darwin: 'IDLE.SYS.dmg',
  linux:  'IDLE.SYS.AppImage',
}

const installerName = INSTALLER_NAMES[PLATFORM] || INSTALLER_NAMES.win32

function platformUrl (url) {
  return (url || '').replace(/[^/\\]+$/, installerName)
}

const needsChmod   = PLATFORM === 'linux'
const skipAutoQuit = PLATFORM === 'darwin'

function installerTempPath () {
  // Unique per-download so a locked file from a previous run never blocks us.
  const stamp = Date.now()
  const ext   = path.extname(installerName)
  const base  = path.basename(installerName, ext)
  return path.join(os.tmpdir(), 'idle-sys-update', `${base}-${stamp}${ext}`)
}

module.exports = { PLATFORM, installerName, platformUrl, needsChmod, skipAutoQuit, installerTempPath }
