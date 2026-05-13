/**
 * IDLE.SYS — Renderer v2.7.0
 */

// ── Bind window controls IMMEDIATELY ─────────────────────────────────────────
// This runs before ANYTHING else. The <script> tag is at the end of <body>,
// so the DOM is parsed. If we wait until init(), any throw between here and
// there (getPlayerID, localStorage, etc.) silently kills these buttons.
;(function () {
  const dbg = (...args) => console.log('[idle.sys:early]', ...args)
  const fs   = document.getElementById('win-fullscreen')
  const min  = document.getElementById('win-minimize')
  const close= document.getElementById('win-close')
  dbg('early bind: fs=', !!fs, 'min=', !!min, 'close=', !!close,
      'window.electron=', typeof window.electron,
      'window.electron.close=', typeof window.electron?.close)
  if (fs) fs.addEventListener('click', (e) => {
    e.stopPropagation()
    dbg('fullscreen clicked')
    if (window.electron?.toggleFullscreen) window.electron.toggleFullscreen()
      .catch(err => console.error('[idle.sys] fullscreen failed:', err))
    else dbg('fullscreen → window.electron not available!')
  })
  if (min) min.addEventListener('click', (e) => {
    e.stopPropagation()
    dbg('minimize clicked')
    if (window.electron?.minimize) window.electron.minimize()
      .then(() => dbg('minimize → resolved'))
      .catch(err => console.error('[idle.sys] minimize failed:', err))
    else dbg('minimize → window.electron not available!')
  })
  if (close) close.addEventListener('click', (e) => {
    e.stopPropagation()
    dbg('close clicked')
    if (window.electron?.close) window.electron.close()
      .then(() => dbg('close → resolved'))
      .catch(err => console.error('[idle.sys] close failed:', err))
    else dbg('close → window.electron not available!')
  })
})()

// ── Config ────────────────────────────────────────────────────────────────────
const HEALTH_CHECK_INTERVAL = 15_000
const PING_INTERVAL         = 20_000
const DISCORD_HANDLE        = 'Keira'
const DISCORD_LINK          = 'https://discord.gg/s3EpTjXjGh'
const HACK_DURATION_MS      = 10 * 60 * 1000
const HACK_COOLDOWN_MS      = 3 * 60 * 60 * 1000
const COST_SCALE            = 1.35

// Debug helper
const dbg = (...args) => console.log('[idle.sys]', ...args)

// ── Environment ───────────────────────────────────────────────────────────────
// True when running in a browser (served via /play), false in Electron.
// location.protocol is 'file:' in Electron (loads index.html from disk).
const IS_WEB    = location.protocol !== 'file:'
const IS_MOBILE = IS_WEB && window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 768

// ── Player ID + login token ───────────────────────────────────────────────────
function getPlayerId () {
  if (window.api?.getPlayerID) {
    const id = window.api.getPlayerID()
    dbg('Player ID from preload:', id?.slice?.(0, 8) + '…')
    return id
  }
  dbg('window.api.getPlayerID unavailable — falling back to localStorage')
  let pid = localStorage.getItem('player_id')
  if (!pid) { pid = crypto.randomUUID(); localStorage.setItem('player_id', pid) }
  dbg('Player ID from localStorage:', pid.slice(0, 8) + '…')
  return pid
}

function getLoginToken () {
  if (window.api?.getLoginToken) return window.api.getLoginToken() || null
  return localStorage.getItem('login_token') || null
}

function saveLoginToken (token) {
  if (window.api?.setLoginToken) window.api.setLoginToken(token)
  localStorage.setItem('login_token', token)
}

let _tokenMaskTimer = null
function _showTokenBriefly (token) {
  const el = document.getElementById('acct-token-display')
  if (!el) return
  el.textContent = 'TOKEN ' + token.slice(0, 8) + '••••••••••••••••'
  el.style.color = 'var(--amber)'
  clearTimeout(_tokenMaskTimer)
  _tokenMaskTimer = setTimeout(() => {
    el.textContent = 'TOKEN ••••••••••••••••'
    el.style.color = ''
  }, 5000)
}

let PLAYER_ID   = getPlayerId()
let LOGIN_TOKEN = getLoginToken()

// ── Global mouse tracker (for particle spawn position) ────────────────────────
let _mouseX = window.innerWidth  / 2
let _mouseY = window.innerHeight / 2
document.addEventListener('mousemove',  e => { _mouseX = e.clientX; _mouseY = e.clientY })
document.addEventListener('touchmove',  e => { _mouseX = e.changedTouches[0].clientX; _mouseY = e.changedTouches[0].clientY }, { passive: true })
document.addEventListener('touchstart', e => { _mouseX = e.changedTouches[0].clientX; _mouseY = e.changedTouches[0].clientY }, { passive: true })

// ── State ─────────────────────────────────────────────────────────────────────
let ws             = null
const SERVER_URL   = 'wss://idlesys.xyz'
let serverUrl      = SERVER_URL
let httpBaseUrl    = ''
let serverVersion  = ''
let upgrades       = []
let skillTree      = []
let player         = {
  money: 0, income: 1, total_earned: 0, name: '', checksum: '',
  clicks: 0, click_value: 1, click_multiplier: 0,
  name_changes: 0, name_tokens: 0, upgrades_bought: {}, hack_unlocked: false,
  prestige_points: 0, prestige_multiplier: 1,
}
let healthTimer      = null
let pingTimer        = null
let rpcLastUpdate    = 0
let reconnectTimer   = null
let isConnected      = false
let failedChecks     = 0
let hackState        = { status: 'idle', target: null, targetName: null, startTime: null, endTime: null, cooldownEnd: null }
let hackTimerInt     = null
let defenseTimerInt  = null
let nameLocked       = false

// Upgrade category + buy quantity mode (1 | 10 | 100 | 'max')
let activeUpgradeCategory = 'click'
let upgradeQtyMode = 1

// Market state
let marketPrices     = {}
let marketPrevPrices = {}
let marketAssets     = []
let marketPortfolio  = {}
let marketSupply     = {}

// Trade state
let activeTrade      = null  // current trade session dict (or null)

// Poker state
let pokerRooms      = []    // lobby room list from server
let pokerRoomState  = null  // current room state (null if in lobby)
let pokerHoleCards  = []    // private hole cards
let pokerMyId       = null  // set on login

// Version — populated from Electron
let CURRENT_VERSION = '2.7.0'

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)
const el = {
  connDot:          $('conn-dot'),
  connLabel:        $('conn-label'),
  footerDot:        $('footer-dot'),
  footerStatus:     $('footer-status'),
  connectOverlay:   $('connect-overlay'),
  downOverlay:      $('down-overlay'),
  retryBtn:         $('retry-btn'),
  statMoney:        $('stat-money'),
  statIncome:       $('stat-income'),
  statTotal:        $('stat-total'),
  statClick:        $('stat-click'),
  clickerBtn:       $('clicker-btn'),
  clickerVal:       $('clicker-val'),
  clickerCount:     $('clicker-count'),
  upgradeList:      $('upgrade-list'),
  nameInput:        $('name-input'),
  nameBtn:          $('name-btn'),
  nameTokenBtn:     $('name-token-btn'),
  lbList:           $('lb-list'),
  logPanel:         $('log-panel'),
  logList:          $('log-list'),
  profId:           $('prof-id'),
  profName:         $('prof-name'),
  profMoney:        $('prof-money'),
  profIncome:       $('prof-income'),
  profTotal:        $('prof-total'),
  profClicks:       $('prof-clicks'),
  profUpgrades:     $('prof-upgrades'),
  profHack:         $('prof-hack'),
  profTokens:       $('prof-tokens'),
  profPrestigePoints: $('prof-prestige-points'),
  profPrestigeMult: $('prof-prestige-mult'),
  updateCheckBtn:   $('update-check-btn'),
  changelogBtn:     $('changelog-btn'),
  discordLink:      $('discord-link'),
  discordName:      $('discord-name'),
  netDiscordLink:   $('net-discord-link'),
  hackLocked:       $('hack-locked'),
  hackBuyBtn:       $('hack-buy-btn'),
  hackIdle:         $('hack-idle'),
  hackStartBtn:     $('hack-start-btn'),
  hackRunning:      $('hack-running'),
  hackTimer:        $('hack-timer'),
  hackProgressBar:  $('hack-progress-bar'),
  hackTargetInfo:   $('hack-target-info'),
  hackCooldown:     $('hack-cooldown'),
  hackCooldownTimer:$('hack-cooldown-timer'),
  hackTokenBtn:     $('hack-token-btn'),
  hackDefense:      $('hack-defense'),
  defenseTimer:     $('defense-timer'),
  defenseHacker:    $('defense-hacker'),
  hackStopBtn:      $('hack-stop-btn'),
  hackResultOverlay:$('hack-result-overlay'),
  hackResultTitle:  $('hack-result-title'),
  hackResultDetails:$('hack-result-details'),
  hackResultOk:     $('hack-result-ok'),
  updateOverlay:    $('update-overlay'),
  updateCurrent:    $('update-current'),
  updateNew:        $('update-new'),
  updateNotes:      $('update-notes'),
  updateSkipBtn:    $('update-skip-btn'),
  winFullscreen:      $('win-fullscreen'),
  winMinimize:        $('win-minimize'),
  winClose:           $('win-close'),
  namePromptOverlay:  $('name-prompt-overlay'),
  namePromptInput:    $('name-prompt-input'),
  namePromptBtn:      $('name-prompt-btn'),
  tutorialOverlay:    $('tutorial-overlay'),
  upgTabHack:         $('upg-tab-hack'),
  profStreak:         $('prof-streak'),
  profAchievements:   $('prof-achievements'),
  profPlaytime:       $('prof-playtime'),
  // Casino
  bjTableSelect:      $('bj-table-select'),
  bjTableLabel:       $('bj-table-label'),
  bjMaxDisplay:       $('bj-max-display'),
  bjLeaveBtn:         $('bj-leave-btn'),
  rlBetInput:         $('rl-bet-input'),
  rlSpinBtn:          $('rl-spin-btn'),
  rlResult:           $('rl-result'),
  rlNumber:           $('rl-number'),
  rlResultLabel:      $('rl-result-label'),
  rlResultDetail:     $('rl-result-detail'),
  rlAgainBtn:         $('rl-again-btn'),
  rlIdle:             $('rl-idle'),
  rlNumberInput:      $('rl-number-input'),
  rlStraightRow:      $('rl-straight-row'),
  // Defense mini-games
  rpsOverlay:         $('rps-overlay'),
  rpsPlayerScore:     $('rps-player-score'),
  rpsAiScore:         $('rps-ai-score'),
  rpsTimer:           $('rps-timer'),
  rpsResult:          $('rps-result'),
  mathOverlay:        $('math-overlay'),
  mathQuestion:       $('math-question'),
  mathAnswer:         $('math-answer'),
  mathTimer:          $('math-timer'),
  mathAttemptsLabel:  $('math-attempts-label'),
  snakeOverlay:       $('snake-overlay'),
  snakeScore:         $('snake-score'),
  snakeTimer:         $('snake-timer'),
  instantOverlay:     $('instant-overlay'),
  bjBetInput:       $('bj-bet-input'),
  bjDealBtn:        $('bj-deal-btn'),
  bjIdle:           $('bj-idle'),
  bjPlaying:        $('bj-playing'),
  bjDealerCards:    $('bj-dealer-cards'),
  bjDealerVal:      $('bj-dealer-val'),
  bjPlayerCards:    $('bj-player-cards'),
  bjPlayerVal:      $('bj-player-val'),
  bjBetDisplay:     $('bj-bet-display'),
  bjHitBtn:         $('bj-hit-btn'),
  bjStandBtn:       $('bj-stand-btn'),
  bjResult:         $('bj-result'),
  bjResultLabel:    $('bj-result-label'),
  bjResultDetail:   $('bj-result-detail'),
  bjAgainBtn:       $('bj-again-btn'),
  badgeCodeInput:     $('badge-code-input'),
  badgeRedeemBtn:     $('badge-redeem-btn'),
  badgePickerRow:     $('badge-picker-row'),
  badgePickerList:    $('badge-picker-list'),
  profCasinoWagered:  $('prof-casino-wagered'),
  profCasinoPl:       $('prof-casino-pl'),
  upgTabClick:        $('upg-tab-click'),
  upgTabAuto:         $('upg-tab-auto'),
  upgTabPrestige:     $('upg-tab-prestige'),
  upgTabSkill:        $('upg-tab-skill'),
  acctIdDisplay:      $('acct-id-display'),
  acctIdCopyBtn:      $('acct-id-copy-btn'),
  acctTokenCopyBtn:   $('acct-token-copy-btn'),
  recoverIdInput:     $('recover-id-input'),
  recoverTokenInput:  $('recover-token-input'),
  recoverIdBtn:       $('recover-id-btn'),
  chatLog:            $('chat-log'),
  chatInput:          $('chat-input'),
  chatSendBtn:        $('chat-send-btn'),
  chatRateMsg:        $('chat-rate-msg'),
  alwaysChatPanel:    $('always-chat-panel'),
  alwaysChatLog:      $('always-chat-log'),
  alwaysChatInput:    $('always-chat-input'),
  alwaysChatSend:     $('always-chat-send'),
  alwaysChatResize:   $('always-chat-resize'),
  settingAlwaysChat:  $('setting-always-chat'),
  // Trade overlay
  tradeOverlay:       $('trade-overlay'),
  tradeTitle:         $('trade-overlay-title'),
  tradeDetails:       $('trade-details'),
  tradeAssetSelect:   $('trade-asset-select'),
  tradeSharesInput:   $('trade-shares-input'),
  tradePriceInput:    $('trade-price-input'),
  tradeChatLog:       $('trade-chat-log'),
  tradeChatInput:     $('trade-chat-input'),
  tradeChatSend:      $('trade-chat-send'),
  tradeAcceptBtn:     $('trade-accept-btn'),
  tradeCounterBtn:    $('trade-counter-btn'),
  tradeRejectBtn:     $('trade-reject-btn'),
  tradeCloseBtn:      $('trade-close-btn'),
}

// ── Badge config — populated from server on login, not hardcoded ──────────────
let BADGE_CONFIG = {}

function badgeTag (badgeName, extraStyle = '') {
  const cfg = BADGE_CONFIG[badgeName]
  if (!cfg) return `<span class="lb-badge"${extraStyle ? ` style="${extraStyle}"` : ''}>${esc(badgeName.toUpperCase())}</span>`
  return `<span class="lb-badge ${cfg.cls}"${extraStyle ? ` style="${extraStyle}"` : ''}>${esc(cfg.text)}</span>`
}

// ── XOR decrypt ───────────────────────────────────────────────────────────────
let ENC_KEY = 'IDLE_SYS_V1_' + PLAYER_ID.slice(0, 8)

function xorDecrypt (b64, key) {
  try {
    const text = atob(b64)
    let out = ''
    for (let i = 0; i < text.length; i++)
      out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length))
    return out
  } catch { return null }
}

// ── Helper: Build HTTP base URL from WebSocket URL ────────────────────────────
// Server serves WS and HTTP on the SAME port. Do NOT change the port.
// This is what makes a single tunnel cover everything.
function setHttpBaseUrl(wsUrl) {
  let url = wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  if (url.endsWith('/')) url = url.slice(0, -1)
  try {
    const u = new URL(url)
    // u.origin has no trailing slash; u.toString() does → double-slash in paths
    httpBaseUrl = u.origin
  } catch {
    httpBaseUrl = url
  }
  if (httpBaseUrl.endsWith('/')) httpBaseUrl = httpBaseUrl.slice(0, -1)
  dbg('setHttpBaseUrl:', wsUrl, '→', httpBaseUrl)
}

// ── Changelog modal ───────────────────────────────────────────────────────────
async function fetchAndShowChangelog(version){
  const url = `${httpBaseUrl}/api/changelog`
  dbg('fetchAndShowChangelog: version=', version, 'url=', url)
  try {
    const resp = await fetch(url)
    dbg('fetchAndShowChangelog: HTTP', resp.status, resp.statusText)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const changelog = await resp.json()
    dbg('fetchAndShowChangelog: keys=', Object.keys(changelog))
    const changes = changelog[version] || ['No detailed changelog available.']
    showChangelogModal(version, changes, changelog)
  } catch (err) {
    console.warn('[idle.sys] Changelog fetch failed:', err)
    showChangelogModal(version, ['Changelog could not be loaded.'], {})
  }
}

function showChangelogModal(version, changes, fullChangelog = {}){
  // Older versions sorted newest → oldest, excluding current
  const older = Object.entries(fullChangelog)
    .filter(([v]) => v !== version)
    .sort(([a], [b]) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) {
        if ((pb[i]||0) !== (pa[i]||0)) return (pb[i]||0) - (pa[i]||0)
      }
      return 0
    })

  const olderHtml = older.map(([v, items]) => `
    <div style="margin-bottom:14px;">
      <div style="color:var(--blue);font-size:10px;letter-spacing:2px;margin-bottom:5px;">v${esc(v)}</div>
      <ul style="margin:0;padding-left:16px;color:#8ac4f0;font-size:11px;line-height:1.7;">
        ${items.map(c => `<li>${esc(c)}</li>`).join('')}
      </ul>
    </div>
  `).join('')

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-height:80vh;display:flex;flex-direction:column;gap:0;">
      <h2 style="color:var(--blue);flex-shrink:0;">WHAT'S NEW IN v${esc(version)}</h2>
      <ul style="text-align:left;margin:14px 0 10px;color:#c8e8ff;overflow-y:auto;max-height:240px;line-height:1.7;padding-right:4px;">
        ${changes.map(c => `<li style="margin-bottom:3px;">${esc(c)}</li>`).join('')}
      </ul>
      ${olderHtml ? `
        <button id="cl-hist-btn" class="btn" style="flex-shrink:0;font-size:10px;letter-spacing:2px;color:var(--blue-dim);background:transparent;border:1px solid var(--blue-dim);margin-bottom:8px;padding:6px;">
          ▼ OLDER VERSIONS
        </button>
        <div id="cl-hist" style="display:none;overflow-y:auto;max-height:260px;border-top:1px solid var(--blue-dim);padding-top:12px;margin-bottom:8px;">
          ${olderHtml}
        </div>
      ` : ''}
      <button class="btn modal-full" id="changelog-ok" style="flex-shrink:0;margin-top:4px;background:var(--blue-dim);color:#fff;border-color:var(--blue);">CONTINUE</button>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('#changelog-ok').onclick = () => overlay.remove()
  const histBtn = overlay.querySelector('#cl-hist-btn')
  const histDiv = overlay.querySelector('#cl-hist')
  if (histBtn && histDiv) {
    histBtn.addEventListener('click', () => {
      const open = histDiv.style.display !== 'none'
      histDiv.style.display = open ? 'none' : 'block'
      histBtn.textContent   = open ? '▼ OLDER VERSIONS' : '▲ HIDE OLDER VERSIONS'
    })
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init () {
  dbg('init() start')
  dbg('window.electron =', typeof window.electron, window.electron ? Object.keys(window.electron) : 'N/A')

  if (IS_MOBILE) {
    document.body.classList.add('mobile')
    document.getElementById('mobile-nav').style.display = 'flex'
    // Move log panel to #app level so LOG view can show it standalone
    const logPanel = document.getElementById('log-panel')
    const footer = document.getElementById('footer')
    if (logPanel && footer) footer.parentElement.insertBefore(logPanel, footer)
    // Hide the FPS settings block (no ID, find via child)
    document.getElementById('fps-cap-row')?.closest('.net-row')?.style.setProperty('display', 'none', 'important')
    // Raise tiny inline font-sizes (9px/10px labels) to a readable minimum
    document.querySelectorAll('[style]').forEach(el => {
      const size = parseFloat(el.style.fontSize)
      if (!isNaN(size) && size < 12) el.style.fontSize = '12px'
    })
  }

  // macOS or web: hide custom HTML title bar buttons
  if (IS_WEB || window.electron?.platform === 'darwin') {
    document.getElementById('win-minimize')?.remove()
    document.getElementById('win-fullscreen')?.remove()
    document.getElementById('win-close')?.remove()
  }
  dbg('window.api =', typeof window.api, window.api ? Object.keys(window.api) : 'N/A')

  // Log installed Electron version for debug, but keep CURRENT_VERSION as the
  // source-defined constant — overwriting it with Electron's version caused
  // infinite update loops when an old build ran against a newer server.
  if (window.electron?.getVersion) {
    try {
      const installedVer = await window.electron.getVersion()
      dbg('Installed app version (Electron):', installedVer)
    } catch (e) {
      console.warn('[idle.sys] Could not get app version from Electron:', e)
    }
  }
  el.updateCurrent.textContent = CURRENT_VERSION

  el.discordLink.textContent   = DISCORD_LINK
  if (el.netDiscordLink) el.netDiscordLink.textContent = DISCORD_LINK.replace('https://', '')


  // Window controls are bound at script entry (top of this file).
  // Do NOT re-bind here — that was the old code.
  if (!IS_WEB && !window.electron) {
    console.warn('[idle.sys] window.electron is UNDEFINED. Preload likely crashed. ' +
                 'Check DevTools → Console for [preload] errors.')
  }

  el.retryBtn.addEventListener('click', onRetryNow)

  if (IS_MOBILE) {
    el.clickerBtn.addEventListener('touchstart', (e) => {
      e.preventDefault()
      const t = e.changedTouches[0]
      doClick()
      spawnParticles(t.clientX, t.clientY, 10, '#39ff8a')
    }, { passive: false })
  } else {
    el.clickerBtn.addEventListener('click', doClick)
    el.clickerBtn.addEventListener('click', (e) => {
      spawnParticles(e.clientX, e.clientY, 10, '#39ff8a')
    })
  }

  el.nameBtn.addEventListener('click', setName)
  el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') setName() })
  el.nameTokenBtn.addEventListener('click', useNameToken)

  el.namePromptBtn.addEventListener('click', submitNamePrompt)
  el.namePromptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitNamePrompt()
    if (e.key === 'Escape') e.preventDefault()
  })

  document.getElementById('tutorial-next-btn')?.addEventListener('click', _tutorialNext)

  el.badgeRedeemBtn?.addEventListener('click', () => {
    const code = el.badgeCodeInput?.value.trim().toUpperCase()
    if (!code) return
    if (!isConnected) { log('Connect to a server first', 'warn'); return }
    send({ type: 'action', action: 'redeem_badge', code })
  })

  // Account ID copy
  el.acctIdCopyBtn?.addEventListener('click', () => {
    const id = PLAYER_ID
    if (!id) return
    navigator.clipboard.writeText(id).then(() => {
      el.acctIdCopyBtn.textContent = 'COPIED'
      setTimeout(() => { el.acctIdCopyBtn.textContent = 'COPY ID' }, 2000)
    }).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = id; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      el.acctIdCopyBtn.textContent = 'COPIED'
      setTimeout(() => { el.acctIdCopyBtn.textContent = 'COPY ID' }, 2000)
    })
  })

  // Token copy
  el.acctTokenCopyBtn?.addEventListener('click', () => {
    if (!LOGIN_TOKEN) return
    navigator.clipboard.writeText(LOGIN_TOKEN).then(() => {
      el.acctTokenCopyBtn.textContent = 'COPIED'
      setTimeout(() => { el.acctTokenCopyBtn.textContent = 'COPY TOKEN' }, 2000)
    }).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = LOGIN_TOKEN; document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      el.acctTokenCopyBtn.textContent = 'COPIED'
      setTimeout(() => { el.acctTokenCopyBtn.textContent = 'COPY TOKEN' }, 2000)
    })
  })

  // Account recovery
  el.recoverIdBtn?.addEventListener('click', async () => {
    const newId    = el.recoverIdInput?.value.trim()
    const newToken = el.recoverTokenInput?.value.trim()
    if (!newId)    { log('Enter a player ID to recover', 'warn'); return }
    if (!newToken) { log('Enter your login token to recover', 'warn'); return }
    if (newId === PLAYER_ID) { log('That is already your current account', 'warn'); return }
    if (!confirm(`Switch to account ${newId.slice(0, 8)}…?\nYour current session will reconnect.`)) return
    // Electron: persist via preload API. Web: write to localStorage directly.
    let idOk, tokenOk
    if (window.api?.setPlayerID) {
      idOk    = window.api.setPlayerID(newId)
      tokenOk = window.api.setLoginToken ? window.api.setLoginToken(newToken) : (localStorage.setItem('login_token', newToken), true)
    } else {
      localStorage.setItem('player_id',    newId)
      localStorage.setItem('login_token',  newToken)
      idOk = tokenOk = true
    }
    if (idOk && tokenOk) {
      PLAYER_ID   = newId
      LOGIN_TOKEN = newToken
      ENC_KEY     = 'IDLE_SYS_V1_' + newId.slice(0, 8)
      if (el.acctIdDisplay)   el.acctIdDisplay.textContent = newId
      if (el.recoverIdInput)  el.recoverIdInput.value = ''
      if (el.recoverTokenInput) el.recoverTokenInput.value = ''
      log('Account switched — reconnecting…', 'ok')
      if (ws) { try { ws.close() } catch (_) {} ws = null }
      connect(serverUrl)
    } else {
      log('Failed to save account credentials — try again', 'err')
    }
  })

  // Leaderboard sort tabs
  document.querySelectorAll('.lb-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lb-sort-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      lbSortKey = btn.dataset.sort
      renderSortedLeaderboard()
    })
  })

  el.bjDealBtn?.addEventListener('click', bjDeal)
  el.bjHitBtn?.addEventListener('click',  () => { if (isConnected) send({ type: 'action', action: 'bj_hit' }) })
  el.bjStandBtn?.addEventListener('click',() => { if (isConnected) send({ type: 'action', action: 'bj_stand' }) })
  el.bjAgainBtn?.addEventListener('click', bjReset)

  // Casino: table select buttons
  document.querySelectorAll('.bj-table-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const buyin  = parseFloat(btn.dataset.buyin)
      const maxbet = parseFloat(btn.dataset.maxbet)
      if (!isConnected) { log('Connect to a server first', 'warn'); return }
      if (player.money < buyin) { log(`Need $${fmt(buyin)} to sit at this table`, 'warn'); return }
      bjCurrentMaxBet = maxbet
      if (el.bjTableLabel)  el.bjTableLabel.textContent  = `$${fmt(buyin)} table`
      if (el.bjMaxDisplay)  el.bjMaxDisplay.textContent  = `$${fmt(maxbet)}`
      if (el.bjTableSelect) el.bjTableSelect.style.display = 'none'
      if (el.bjIdle)        el.bjIdle.style.display        = ''
    })
  })

  // Casino: leave table button
  el.bjLeaveBtn?.addEventListener('click', () => {
    bjCurrentMaxBet = 0
    if (el.bjTableSelect) el.bjTableSelect.style.display = ''
    if (el.bjIdle)        el.bjIdle.style.display         = 'none'
    if (el.bjPlaying)     el.bjPlaying.style.display      = 'none'
    if (el.bjResult)      el.bjResult.style.display       = 'none'
  })

  // Roulette: bet type buttons
  document.querySelectorAll('.rl-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rl-type-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      rlCurrentType = btn.dataset.type
      if (el.rlStraightRow) el.rlStraightRow.style.display = rlCurrentType === 'straight' ? '' : 'none'
    })
  })

  // Roulette: spin button
  el.rlSpinBtn?.addEventListener('click', () => {
    if (!isConnected) { log('Connect to a server first', 'warn'); return }
    const bet = parseShortNum(el.rlBetInput?.value || '0')
    if (!bet || bet <= 0)  { log('Enter a valid bet', 'warn'); return }
    if (bet * 1.05 > player.money) { log('Not enough money (bet + 5% house fee)', 'warn'); return }
    const num = rlCurrentType === 'straight' ? parseInt(el.rlNumberInput?.value || '-1', 10) : undefined
    if (rlCurrentType === 'straight' && (isNaN(num) || num < 0 || num > 36)) {
      log('Pick a number 0–36', 'warn'); return
    }
    send({ type: 'action', action: 'roulette_spin', bet, bet_type: rlCurrentType, number: num })
  })

  // Roulette: spin again button
  el.rlAgainBtn?.addEventListener('click', () => {
    if (el.rlResult) el.rlResult.style.display = 'none'
    if (el.rlIdle)   el.rlIdle.style.display   = ''
  })

  // RPS buttons
  $('rps-rock')?.addEventListener('click',     () => rpsPlay('rock'))
  $('rps-paper')?.addEventListener('click',    () => rpsPlay('paper'))
  $('rps-scissors')?.addEventListener('click', () => rpsPlay('scissors'))

  // Math submit
  $('math-submit')?.addEventListener('click', mathSubmit)
  el.mathAnswer?.addEventListener('keydown', e => { if (e.key === 'Enter') mathSubmit() })

  // Instant loss ok
  $('instant-ok')?.addEventListener('click', () => hideOverlay(el.instantOverlay))

  // Number format buttons
  document.querySelectorAll('.fmt-btn').forEach(btn => {
    if (btn.dataset.fmt === numFmtStyle) btn.classList.add('active')
    else btn.classList.remove('active')
    btn.addEventListener('click', () => {
      numFmtStyle = btn.dataset.fmt
      localStorage.setItem('numFmt', numFmtStyle)
      document.querySelectorAll('.fmt-btn').forEach(b => b.classList.toggle('active', b.dataset.fmt === numFmtStyle))
      applyState(player)
    })
  })

  // FPS settings
  const fpsShowEl = document.getElementById('setting-fps-show')
  const fpsWebNote = document.getElementById('fps-web-note')
  const fpsCapRow  = document.getElementById('fps-cap-row')
  if (IS_WEB) {
    document.querySelectorAll('.fps-cap-btn.electron-only').forEach(btn => { btn.style.display = 'none' })
  }
  document.querySelectorAll('.fps-cap-btn').forEach(btn => {
    const cap = parseInt(btn.dataset.cap, 10)
    btn.classList.toggle('active', cap === _fpsCap)
    btn.addEventListener('click', () => {
      _fpsCap = cap
      localStorage.setItem('fpsCap', String(cap))
      document.querySelectorAll('.fps-cap-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.cap, 10) === cap))
    })
  })
  if (fpsShowEl) {
    fpsShowEl.checked = _fpsShow
    fpsShowEl.addEventListener('change', () => {
      _fpsShow = fpsShowEl.checked
      localStorage.setItem('fpsShow', _fpsShow ? '1' : '0')
      if (_fpsEl && !_fpsShow) _fpsEl.textContent = ''
    })
  }

  // Chat visibility setting — off: no chat anywhere; on: always-visible panel below tabs (no CHAT tab)
  const alwaysChatEnabled = () => localStorage.getItem('alwaysChat') === '1'
  const chatTabBtn = document.querySelector('.tab-btn[data-tab="chat"]')
  const mobileChatBtn = document.getElementById('mobile-nav-chat')
  const applyAlwaysChatSetting = (on) => {
    if (el.alwaysChatPanel) el.alwaysChatPanel.style.display = on ? 'flex' : 'none'
    if (el.settingAlwaysChat) el.settingAlwaysChat.checked = on
    if (chatTabBtn) chatTabBtn.style.display = on ? 'none' : ''
    if (mobileChatBtn) mobileChatBtn.style.display = on ? 'none' : ''
    // If we're hiding the panel and currently on the chat tab, switch away
    if (!on && document.getElementById('tab-chat')?.classList.contains('active')) {
      switchTab('leaderboard')
    }
  }
  applyAlwaysChatSetting(alwaysChatEnabled())
  el.settingAlwaysChat?.addEventListener('change', () => {
    const on = el.settingAlwaysChat.checked
    localStorage.setItem('alwaysChat', on ? '1' : '0')
    applyAlwaysChatSetting(on)
  })

  // Always-chat send
  const sendAlwaysChatMsg = () => {
    const text = el.alwaysChatInput?.value.trim()
    if (!text || !isConnected) return
    send({ type: 'chat_send', text })
    el.alwaysChatInput.value = ''
  }
  el.alwaysChatSend?.addEventListener('click', sendAlwaysChatMsg)
  el.alwaysChatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendAlwaysChatMsg() })

  // Always-chat resize handle (drag to set height)
  if (el.alwaysChatResize && el.alwaysChatPanel) {
    let _dragStart = null
    let _startH = 0
    el.alwaysChatResize.addEventListener('mousedown', e => {
      _dragStart = e.clientY
      _startH = el.alwaysChatPanel.offsetHeight
      e.preventDefault()
    })
    document.addEventListener('mousemove', e => {
      if (_dragStart === null) return
      const delta = _dragStart - e.clientY
      const newH = Math.max(80, Math.min(400, _startH + delta))
      el.alwaysChatPanel.style.height = newH + 'px'
      localStorage.setItem('alwaysChatH', String(newH))
    })
    document.addEventListener('mouseup', () => { _dragStart = null })
    const savedH = parseInt(localStorage.getItem('alwaysChatH') || '140', 10)
    el.alwaysChatPanel.style.height = savedH + 'px'
  }

  if (IS_WEB) {
    el.updateCheckBtn.style.display = 'none'
  } else {
    el.updateCheckBtn.addEventListener('click', checkForUpdate)
  }
  el.changelogBtn?.addEventListener('click', () => {
    if (!isConnected) { log('Connect to a server first', 'warn'); return }
    fetchAndShowChangelog(serverVersion)
  })

  // Discord links — down-overlay and network tab
  el.discordLink.addEventListener('click', () => {
    dbg('Discord link clicked:', DISCORD_LINK)
    if (window.electron?.openExternal) {
      window.electron.openExternal(DISCORD_LINK)
        .then(r => dbg('openExternal result:', r))
        .catch(e => console.error('[idle.sys] openExternal error:', e))
    } else {
      dbg('window.electron.openExternal unavailable, trying window.open fallback')
      window.open(DISCORD_LINK, '_blank')
    }
  })
  if (el.netDiscordLink) {
    el.netDiscordLink.addEventListener('click', () => {
      dbg('Net discord link clicked:', DISCORD_LINK)
      if (window.electron?.openExternal) {
        window.electron.openExternal(DISCORD_LINK)
          .then(r => dbg('openExternal result:', r))
          .catch(e => console.error('[idle.sys] openExternal error:', e))
      } else {
        window.open(DISCORD_LINK, '_blank')
      }
    })
  }

  // Ko-fi support button
  const btnKofi = document.getElementById('btn-kofi')
  if (btnKofi) btnKofi.addEventListener('click', () => {
    if (window.electron?.openExternal) window.electron.openExternal('https://ko-fi.com/keiraomg0')
    else window.open('https://ko-fi.com/keiraomg0', '_blank')
  })

  el.hackBuyBtn.addEventListener('click', buyHackModule)
  el.hackStartBtn.addEventListener('click', startHack)
  el.hackStopBtn.addEventListener('click', stopHack)
  el.hackTokenBtn.addEventListener('click', bypassHackCooldown)
  el.hackResultOk.addEventListener('click', () => hideOverlay(el.hackResultOverlay))

  const encryptBtn = $('encrypt-buy-btn')
  if (encryptBtn) {
    encryptBtn.addEventListener('click', () => {
      send({ type: 'action', action: 'buy_encryption' })
    })
  }

  const giftBtn = $('gift-send-btn')
  if (giftBtn) {
    giftBtn.addEventListener('click', () => {
      const name   = ($('gift-target-input')?.value || '').trim()
      const amount = parseFloat($('gift-amount-input')?.value || '0')
      if (!name || !amount || amount <= 0) return
      send({ type: 'action', action: 'send_money', target_name: name, amount })
    })
  }

  // ── House-economy feature wiring ──────────────────────────────────────────

  // Insurance toggle
  $('insurance-toggle-btn')?.addEventListener('click', () => {
    if (!isConnected) { log('Not connected', 'warn'); return }
    send({ type: 'action', action: 'insurance_toggle' })
  })

  // Loan take
  $('loan-take-btn')?.addEventListener('click', () => {
    if (!isConnected) { log('Not connected', 'warn'); return }
    const amount = parseShortNum($('loan-amount-input')?.value || '0')
    if (!amount || amount <= 0) { log('Enter a valid loan amount', 'warn'); return }
    send({ type: 'action', action: 'loan_take', amount })
  })

  // Loan repay
  $('loan-repay-btn')?.addEventListener('click', () => {
    if (!isConnected) { log('Not connected', 'warn'); return }
    send({ type: 'action', action: 'loan_repay' })
  })

  // Black market items — rendered dynamically
  renderBlackMarket()

  // Start boost timer countdown display
  setInterval(renderBoostTimers, 1000)

  el.updateSkipBtn.addEventListener('click', () => hideOverlay(el.updateOverlay))

  // Sidebar tabs (only ones WITH data-tab)
  document.querySelectorAll('#tab-bar-panel .tab-btn').forEach(btn => {
    if (btn.dataset.tab) {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    }
  })

  // Market qty quick-select buttons
  $('mkt-qty-1')?.addEventListener('click', () => { const el = $('market-qty'); if (el) el.value = 1 })
  $('mkt-qty-10')?.addEventListener('click', () => { const el = $('market-qty'); if (el) el.value = 10 })
  $('mkt-qty-100')?.addEventListener('click', () => { const el = $('market-qty'); if (el) el.value = 100 })
  $('mkt-qty-max')?.addEventListener('click', () => {
    const el = $('market-qty')
    if (!el) return
    let minPrice = Infinity
    for (const [, price] of Object.entries(marketPrices)) {
      if (price < minPrice) minPrice = price
    }
    const maxQty = (minPrice < Infinity && player.money > 0) ? Math.floor(player.money / minPrice) : 1
    el.value = Math.max(1, maxQty)
  })

  // Upgrade qty quick-select — state-based, no manual input
  const _upgQtyBtnIds = { 1: 'upg-qty-1', 10: 'upg-qty-10', 100: 'upg-qty-100', max: 'upg-qty-max' }
  const _setUpgQty = (v) => {
    upgradeQtyMode = v
    Object.entries(_upgQtyBtnIds).forEach(([val, id]) => {
      $(id)?.classList.toggle('active', String(val) === String(v))
    })
    renderUpgrades()
  }
  $('upg-qty-1')?.addEventListener('click',   () => _setUpgQty(1))
  $('upg-qty-10')?.addEventListener('click',  () => _setUpgQty(10))
  $('upg-qty-100')?.addEventListener('click', () => _setUpgQty(100))
  $('upg-qty-max')?.addEventListener('click', () => _setUpgQty('max'))

  // Upgrade category tabs (separate logic, do NOT call switchTab)
  el.upgTabClick?.addEventListener('click', () => setActiveUpgradeTab('click'))
  el.upgTabAuto?.addEventListener('click', () => setActiveUpgradeTab('auto'))
  el.upgTabPrestige?.addEventListener('click', () => setActiveUpgradeTab('prestige'))
  el.upgTabSkill?.addEventListener('click', () => setActiveUpgradeTab('skill'))
  el.upgTabHack?.addEventListener('click', () => setActiveUpgradeTab('hack'))

  restoreHackState()

  // Wire trade overlay buttons
  _wireTradeButtons()

  if (IS_WEB) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${proto}//${location.host}/`
    dbg('init: web mode, auto-connecting to', wsUrl)
    hideOverlay(el.connectOverlay)
    connect(wsUrl)
  } else {
    dbg('init: auto-connecting to', SERVER_URL)
    hideOverlay(el.connectOverlay)
    connect(SERVER_URL)
  }
  function sendChatMsg() {
    const text = el.chatInput?.value.trim()
    if (!text || !isConnected) return
    send({ type: 'chat_send', text })
    el.chatInput.value = ''
  }
  el.chatSendBtn?.addEventListener('click', sendChatMsg)
  el.chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMsg() })

  if (IS_MOBILE) {
    // Snake D-pad touch controls
    const dpadMap = {
      'snake-up':    {x: 0, y: -1},
      'snake-down':  {x: 0, y:  1},
      'snake-left':  {x:-1, y:  0},
      'snake-right': {x: 1, y:  0},
    }
    Object.entries(dpadMap).forEach(([id, dir]) => {
      document.getElementById(id)?.addEventListener('touchstart', (e) => {
        e.preventDefault()
        if (!snakeState) return
        if (dir.x !== -snakeState.dir.x || dir.y !== -snakeState.dir.y) snakeState.nextDir = dir
      }, { passive: false })
    })
    // Snake swipe controls
    let _swipeX = null, _swipeY = null
    document.addEventListener('touchstart', e => { _swipeX = e.touches[0].clientX; _swipeY = e.touches[0].clientY }, { passive: true })
    document.addEventListener('touchend', e => {
      if (!snakeState || _swipeX === null) return
      const dx = e.changedTouches[0].clientX - _swipeX
      const dy = e.changedTouches[0].clientY - _swipeY
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return
      const dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? {x:1,y:0} : {x:-1,y:0})
        : (dy > 0 ? {x:0,y:1} : {x:0,y:-1})
      if (dir.x !== -snakeState.dir.x || dir.y !== -snakeState.dir.y) snakeState.nextDir = dir
      _swipeX = null
    }, { passive: true })
  }

  initPokerUI()
  dbg('init() complete')
}

function switchTab (name) {
  document.querySelectorAll('#tab-bar-panel .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name))
  if (name === 'market') {
    renderMarket()
    send({ type: 'action', action: 'get_market' })
  }
  if (name === 'poker') {
    if (pokerRoomState) {
      renderPokerTable()
    } else {
      send({ type: 'poker_list_rooms' })
    }
  }
}

function setActiveUpgradeTab (cat) {
  activeUpgradeCategory = cat
  el.upgTabClick?.classList.toggle('active', cat === 'click')
  el.upgTabAuto?.classList.toggle('active', cat === 'auto')
  el.upgTabPrestige?.classList.toggle('active', cat === 'prestige')
  el.upgTabSkill?.classList.toggle('active', cat === 'skill')
  el.upgTabHack?.classList.toggle('active', cat === 'hack')
  renderUpgrades()
}

// ── Connection ────────────────────────────────────────────────────────────────
function connect (url) {
  dbg('connect() →', url)
  serverUrl = url
  setHttpBaseUrl(url)
  dbg('connect() httpBaseUrl resolved to:', httpBaseUrl)
  el.footerStatus.textContent  = 'CONNECTING…'

  setConnStatus('connecting', 'CONNECTING…')
  log(`Connecting to server…`, 'warn')
  hideOverlay(el.downOverlay)

  if (ws) { try { ws.close() } catch (_) {} }

  ws = new WebSocket(url)

  const connectTimeout = setTimeout(() => {
    if (!isConnected) {
      log('Connection timed out', 'err')
      ws.close()
      showOverlay(el.connectOverlay)
    }
  }, 8000)

  ws.onopen = () => {
    clearTimeout(connectTimeout)
    isConnected  = true
    failedChecks = 0
    setConnStatus('online', 'ONLINE')
    log('Connection established', 'ok')
    if (typeof ConnectionModule !== 'undefined') ConnectionModule.init({ send: (msg) => ws.send(JSON.stringify(msg)) })
    const loginMsg = { type: 'login', player_id: PLAYER_ID, version: CURRENT_VERSION, is_web: IS_WEB, is_mobile: IS_MOBILE }
    if (LOGIN_TOKEN) loginMsg.login_token = LOGIN_TOKEN
    ws.send(JSON.stringify(loginMsg))
    startPing()
    startHealthCheck()
  }

  ws.onmessage = (e) => {
    failedChecks = 0
    hideOverlay(el.downOverlay)
    try {
      let msg = JSON.parse(e.data)
      if (msg.encrypted && msg.payload) {
        const dec = xorDecrypt(msg.payload, ENC_KEY)
        if (dec) msg = JSON.parse(dec)
        else { log('Decrypt failed', 'err'); return }
      }
      handleMessage(msg)
    } catch (err) { console.error(err) }
  }

  ws.onclose = (e) => {
    clearTimeout(connectTimeout)
    isConnected = false
    setConnStatus('offline', 'OFFLINE')
    const reason = e.reason ? ` (${e.reason})` : ''
    console.warn(`WS closed — code=${e.code}${reason}`)
    log('Disconnected from server', 'err')
    stopPing()
    scheduleReconnect()
  }

  ws.onerror = (e) => {
    console.error('WS error:', e)
    log('WebSocket error — check server URL', 'err')
  }
}

function send (msg) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(msg))
}


function onRetryNow () {
  failedChecks = 0
  hideOverlay(el.downOverlay)
  if (serverUrl) connect(serverUrl)
}

function scheduleReconnect () {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (!isConnected && serverUrl) { log('Auto-reconnecting…', 'warn'); connect(serverUrl) }
  }, 5000)
}

function startHealthCheck () {
  clearInterval(healthTimer)
  healthTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      failedChecks++
      log(`Server unreachable (check ${failedChecks})`, 'warn')
      if (failedChecks >= 1) showOverlay(el.downOverlay)
    } else {
      failedChecks = 0
    }
  }, HEALTH_CHECK_INTERVAL)
}

function startPing  () { clearInterval(pingTimer); pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL) }
function stopPing   () { clearInterval(pingTimer) }
function clearTimers () { clearInterval(healthTimer); clearInterval(pingTimer); clearTimeout(reconnectTimer) }

// ── Message handler ───────────────────────────────────────────────────────────
function handleMessage (msg) {
  switch (msg.type) {
    case 'login_ok':
      upgrades = msg.upgrades
      if (msg.skill_tree) skillTree = msg.skill_tree
      serverVersion = msg.server_version
      if (msg.badge_config) BADGE_CONFIG = msg.badge_config
      if (msg.login_token && msg.login_token !== LOGIN_TOKEN) {
        LOGIN_TOKEN = msg.login_token
        saveLoginToken(msg.login_token)
        dbg('Login token saved from login_ok ✓')
      }
      dbg('login_ok: serverVersion=', serverVersion, 'httpBaseUrl=', httpBaseUrl)
      // Sync hack state from server so reconnects don't leave stale client state
      {
        const now = Date.now() / 1000
        const s = msg.state
        if (s.hack_target) {
          const effectiveDurMs = (s.hack_duration || 600) * 1000
          hackState = { status: 'running', target: s.hack_target, targetName: null,
                        startTime: (s.hack_start || 0) * 1000,
                        endTime: (s.hack_start || 0) * 1000 + effectiveDurMs,
                        cooldownEnd: null }
        } else if (s.hack_cooldown_end && s.hack_cooldown_end > now) {
          hackState = { status: 'cooldown', target: null, targetName: null,
                        startTime: null, endTime: null,
                        cooldownEnd: s.hack_cooldown_end * 1000 }
        } else {
          hackState = { status: 'idle', target: null, targetName: null,
                        startTime: null, endTime: null, cooldownEnd: null }
        }
        saveHackState()
        renderHackUI()
        if (hackState.status === 'running' || hackState.status === 'cooldown') startHackTimer()
      }
      pokerMyId = msg.state.id || PLAYER_ID
      applyState(msg.state)
      renderUpgrades()
      if (msg.is_new) {
        log('New account created — welcome!', 'ok')
        el.namePromptOverlay.classList.remove('hidden')
        setTimeout(() => el.namePromptInput.focus(), 50)
      } else {
        log('State restored ✓', 'ok')
        if (msg.offline_earned > 0) {
          const streakInfo = msg.streak_bonus > 1 ? ` (${((msg.streak_bonus - 1) * 100).toFixed(0)}% streak bonus)` : ''
          log(`Offline bonus: +$${fmt(msg.offline_earned)} earned while away${streakInfo}`, 'ok')
        }
        if (msg.login_streak > 1)
          log(`Login streak: ${msg.login_streak} days 🔥`, 'ok')
      }
      log(`Logged in as ${msg.state.name || msg.state.id.slice(0, 8)}`, 'ok')
      if (msg.state.name) el.nameInput.value = msg.state.name
      updateNameUI()
      if (msg.show_changelog) {
        fetchAndShowChangelog(serverVersion)
      }
      if (msg.market) {
        marketPrices     = msg.market.prices     || {}
        marketPrevPrices = msg.market.prev_prices || {}
        marketAssets     = msg.market.assets      || []
        marketPortfolio  = msg.market.portfolio   || {}
        marketSupply     = msg.market.supply      || {}
      }
      break

    case 'token_issued':
      if (msg.token) {
        LOGIN_TOKEN = msg.token
        saveLoginToken(msg.token)
        dbg('Login token issued and saved ✓')
        _showTokenBriefly(msg.token)
      }
      break

    case 'require_tos': {
      const overlay = document.getElementById('tos-overlay')
      if (overlay) {
        overlay.classList.remove('hidden')
        const tosBtn     = document.getElementById('tos-link-btn')
        const privBtn    = document.getElementById('privacy-link-btn')
        const acceptBtn  = document.getElementById('tos-accept-btn')
        const openUrl = (url) => {
          if (window.electron?.openExternal) window.electron.openExternal(url)
          else window.open(url, '_blank')
        }
        if (tosBtn)    tosBtn.onclick    = () => openUrl(httpBaseUrl + msg.tos_url)
        if (privBtn)   privBtn.onclick   = () => openUrl(httpBaseUrl + msg.privacy_url)
        if (acceptBtn) acceptBtn.onclick = () => {
          send({ type: 'action', action: 'accept_tos' })
          overlay.classList.add('hidden')
        }
      }
      break
    }

    case 'hotfix':
      if (msg.script) {
        dbg('Applying hotfix from server')
        const blob   = new Blob([msg.script], { type: 'application/javascript' })
        const blobUrl = URL.createObjectURL(blob)
        const s = document.createElement('script')
        s.src = blobUrl
        s.onload = () => URL.revokeObjectURL(blobUrl)
        document.head.appendChild(s)
      }
      break

    case 'tick':
      applyState(msg.state)
      break

    case 'market_update':
      marketPrices     = msg.prices     || marketPrices
      marketPrevPrices = msg.prev_prices || marketPrevPrices
      if ($('tab-market')?.classList.contains('active')) renderMarket()
      break

    case 'achievement_unlocked':
      log(`Achievement unlocked: ${msg.name} — ${msg.desc}`, 'ok')
      renderAchievements()
      break

    case 'action_ok':
      if (msg.state) { applyState(msg.state); renderUpgrades() }
      if (msg.action === 'buy_upgrade') {
        const u = upgrades.find(u => u.id === msg.upgrade_id)
        log(`Bought: ${u ? u.name : msg.upgrade_id}`, 'ok')
        spawnParticles(_mouseX, _mouseY, 14, '#ffb700')
      }
      if (msg.action === 'buy_hack_module') {
        log('Hack Module installed!', 'ok')
        renderHackUI()
      }
      if (msg.action === 'set_name') {
        log(`Name set: ${msg.state.name}`, 'ok')
        el.nameInput.value = msg.state.name
        updateNameUI()
        if (!el.namePromptOverlay.classList.contains('hidden')) {
          hideOverlay(el.namePromptOverlay)
          startTutorial()
        }
      }
      if (msg.action === 'click')     { el.clickerCount.textContent = fmt(msg.state.clicks || 0) }
      if (msg.action === 'bypass_hack_cooldown') {
        log('Hack cooldown bypassed', 'ok')
        hackState = { status: 'idle', target: null, targetName: null,
                      startTime: null, endTime: null, cooldownEnd: null }
        saveHackState()
        stopHackTimer()
        renderHackUI()
      }
      if (msg.action === 'prestige') {
        log(`PRESTIGE! Gained ${msg.points_gained} skill point(s). Spend them in the SKILL tab.`, 'ok')
        renderUpgrades()
      }
      if (msg.action === 'buy_skill_node') {
        const node = skillTree.find(n => n.id === msg.node_id)
        log(`Skill unlocked: ${node ? node.name : msg.node_id}`, 'ok')
        spawnParticles(_mouseX, _mouseY, 10, '#4db8ff')
        renderUpgrades()
      }
      if (msg.action === 'redeem_badge') {
        const newBadge = msg.state.badges?.[msg.state.badges.length - 1] || msg.state.badge
        log(`Badge unlocked: ${newBadge || 'badge'}!`, 'ok')
        if (el.badgeCodeInput) el.badgeCodeInput.value = ''
        renderBadgePicker()
      }
      if (msg.action === 'set_active_badge') {
        log(`Active badge set: ${msg.state.badge || 'none'}`, 'ok')
        renderBadgePicker()
      }
      if (msg.action === 'gen_link_code' || msg.action === 'delink_discord' || msg.action === 'discord_oauth_start') {
        if (typeof ConnectionModule !== 'undefined') ConnectionModule.handleMessage(msg)
      }
      if (msg.action === 'delink_discord') {
        log('Discord account unlinked', 'ok')
      }
      if (msg.action === 'buy_encryption') {
        log(`Encryption shield active for 2h — cost $${fmt(msg.cost)}`, 'ok')
        renderHackUI()
      }
      if (msg.action === 'market_buy') {
        if (msg.portfolio) marketPortfolio = msg.portfolio
        log(`Bought ${msg.shares}× ${msg.asset_id} for $${fmt(msg.cost)}`, 'ok')
        renderMarket()
      }
      if (msg.action === 'market_sell') {
        if (msg.portfolio) marketPortfolio = msg.portfolio
        log(`Sold ${msg.shares}× ${msg.asset_id} for $${fmt(msg.proceeds)}`, 'ok')
        renderMarket()
      }
      if (msg.action === 'get_market') {
        if (msg.prices)      marketPrices     = msg.prices
        if (msg.prev_prices) marketPrevPrices = msg.prev_prices
        if (msg.assets)      marketAssets     = msg.assets
        if (msg.portfolio)   marketPortfolio  = msg.portfolio
        if (msg.supply)      marketSupply     = msg.supply
        renderMarket()
      }
      if (msg.action === 'send_money') {
        log(`Sent $${fmt(msg.net)} to ${msg.target_name} (${fmt(msg.tax)} fee)`, 'ok')
        const i1 = $('gift-target-input'); if (i1) i1.value = ''
        const i2 = $('gift-amount-input'); if (i2) i2.value = ''
      }
      break

    case 'leaderboard':
      renderLeaderboard(msg.data)
      break

    case 'hack_result':
      handleHackResult(msg)
      break

    case 'hack_defense_window':
      log(`⚠ INTRUSION DETECTED from ${msg.hacker_name}! [${(msg.defense_type||'classic').toUpperCase()}]`, 'err')
      launchDefenseMiniGame(msg.defense_type || 'classic', msg.hacker_name, msg.seconds || 60)
      break

    case 'hack_alert':
      hideDefenseWindow()
      log(msg.msg, msg.success ? 'err' : 'ok')
      break

    case 'bj_state':
      applyState(msg.state)
      renderBjPlaying(msg)
      break

    case 'bj_result':
      applyState(msg.state)
      renderBjResult(msg)
      break

    case 'roulette_result':
      applyState(msg.state)
      renderRouletteResult(msg)
      break

    case 'crash_started':
      handleCrashStarted(msg)
      break

    case 'crash_result':
      handleCrashResult(msg)
      break

    case 'update_available':
      dbg('update_available:', msg.version)
      if (!IS_WEB) showUpdateOverlay(msg.version, msg.notes)
      break

    case 'up_to_date':
      log('Game is up to date ✓', 'ok')
      break

    case 'server_msg':
      log(`📢 ${msg.msg}`, 'ok')
      showAnnouncement(msg.msg)
      break

    case 'error': {
      log(`ERR: ${msg.msg}`, 'err')
      // If name prompt is open, surface the error there instead
      const _npErr = document.getElementById('name-prompt-err')
      const _npOverlay = el.namePromptOverlay
      if (_npErr && _npOverlay && !_npOverlay.classList.contains('hidden')) {
        _npErr.textContent = msg.msg
        el.namePromptInput.focus()
      }
      break
    }

    case 'discord_linked':
      ConnectionModule.handleMessage(msg);
      break

    case 'pong':
      break

    case 'chat_history':
      if (el.chatLog) el.chatLog.innerHTML = ''
      msg.messages.forEach(m => appendChatMsg(m))
      break

    case 'chat_msg':
      appendChatMsg(msg)
      break

    case 'chat_rate_limit':
      if (el.chatRateMsg) { el.chatRateMsg.style.display = ''; setTimeout(() => { el.chatRateMsg.style.display = 'none' }, 2000) }
      break

    case 'report_ok':
      log('Report submitted. Thanks for keeping the game clean.', 'ok')
      break

    case 'trade_incoming': {
      const t = msg.trade
      const fromName = lbData.find(p => p.id === t.initiator)?.name || t.initiator.slice(0, 8)
      log(`Trade offer from ${fromName}: ${t.shares}× ${t.asset} for $${fmt(t.price)}`, 'ok')
      openTradeOverlay(t, false)
      if (el.tradeCounterBtn) el.tradeCounterBtn.textContent = 'COUNTER'
      if (el.tradeRejectBtn)  el.tradeRejectBtn.style.display = ''
      break
    }

    case 'trade_sent': {
      const t = msg.trade
      activeTrade = t
      const toName = lbData.find(p => p.id === t.target)?.name || t.target.slice(0, 8)
      log(`Trade offer sent to ${toName}: ${t.shares}× ${t.asset} for $${fmt(t.price)}`, 'ok')
      if (el.tradeTitle)      el.tradeTitle.textContent   = 'TRADE SENT'
      if (el.tradeDetails)    el.tradeDetails.textContent = `Awaiting response from ${toName}`
      if (el.tradeCounterBtn) el.tradeCounterBtn.textContent = 'COUNTER'
      if (el.tradeRejectBtn)  el.tradeRejectBtn.style.display = ''
      break
    }

    case 'trade_updated': {
      const t = msg.trade
      activeTrade = t
      const isInit = t.initiator === PLAYER_ID
      const otherName = isInit
        ? (lbData.find(p => p.id === t.target)?.name    || t.target.slice(0, 8))
        : (lbData.find(p => p.id === t.initiator)?.name || t.initiator.slice(0, 8))
      log(`Trade countered by ${otherName}: ${t.shares}× ${t.asset} @ $${fmt(t.price)}`, 'ok')
      if (el.tradeSharesInput) el.tradeSharesInput.value = t.shares
      if (el.tradePriceInput)  el.tradePriceInput.value  = t.price
      if (el.tradeDetails)     el.tradeDetails.textContent = `${otherName} countered: ${t.shares}× ${t.asset} for $${fmt(t.price)}`
      if (el.tradeAcceptBtn)   el.tradeAcceptBtn.disabled  = isInit
      break
    }

    case 'trade_completed': {
      const t = msg.trade
      const isInit = t.initiator === PLAYER_ID
      log(`Trade completed: ${isInit ? 'sold' : 'bought'} ${t.shares}× ${t.asset} for $${fmt(t.price)}`, 'ok')
      closeTradeOverlay()
      break
    }

    case 'trade_rejected': {
      const t = msg.trade
      log(`Trade ${t.status === 'expired' ? 'expired' : 'rejected'}: ${t.shares}× ${t.asset}`, 'warn')
      closeTradeOverlay()
      break
    }

    case 'trade_chat': {
      _appendTradeChat(msg.name, msg.text)
      if (!el.tradeOverlay || el.tradeOverlay.classList.contains('hidden')) {
        log(`Trade msg from ${msg.name}: ${msg.text}`, 'ok')
      }
      break
    }

    // ── House-economy messages ─────────────────────────────────────────────

    case 'jackpot_update': {
      const el2 = $('jackpot-amount')
      if (el2) el2.textContent = '$' + fmt(msg.jackpot_pool || 0)
      break
    }

    case 'server_event': {
      log(`SERVER EVENT: ${msg.msg}`, 'ok')
      showAnnouncement(msg.msg)
      if (msg.state) applyState(msg.state)
      break
    }

    case 'season_end': {
      const prizeLines = (msg.prizes || []).map(p => `#${p.rank} ${esc(p.name)}: +$${fmt(p.prize)}`).join(', ')
      log(`Season ${msg.season_number} ended! Prizes: ${prizeLines}`, 'ok')
      showAnnouncement(`Season ${msg.season_number} ended! ${prizeLines}`)
      break
    }

    case 'bounty_update': {
      const bnTarget = $('bounty-target-name')
      const bnAmount = $('bounty-amount')
      if (bnTarget) bnTarget.textContent = msg.target_name || '—'
      if (bnAmount) bnAmount.textContent = '$' + fmt(msg.amount || 0)
      log(`Bounty updated: $${fmt(msg.amount)} on ${msg.target_name}`, 'ok')
      break
    }

    case 'comp_reward': {
      log(`Casino comp: +$${fmt(msg.reward)} reward for $${fmt(msg.threshold)} wagered!`, 'ok')
      showAnnouncement(msg.msg)
      break
    }

    case 'loan_update': {
      if (msg.state) applyState(msg.state)
      log(msg.msg, 'ok')
      renderLoanPanel(msg.state || player)
      break
    }

    case 'blackmarket_result': {
      if (msg.state) applyState(msg.state)
      log(msg.msg, 'ok')
      renderBlackMarket()
      renderBoostTimers()
      break
    }

    case 'insurance_update': {
      if (msg.state) applyState(msg.state)
      renderInsuranceUI(msg.active)
      log(msg.msg, 'ok')
      break
    }

    // ── Poker messages ────────────────────────────────────────────────────

    case 'poker_rooms':
      pokerRooms = msg.rooms || []
      if ($('tab-poker')?.classList.contains('active') && !pokerRoomState) {
        renderPokerLobby()
      }
      break

    case 'poker_room_state':
      pokerRoomState = msg.room
      if ($('tab-poker')?.classList.contains('active')) {
        renderPokerTable()
      }
      break

    case 'poker_hole_cards':
      pokerHoleCards = msg.cards || []
      if ($('tab-poker')?.classList.contains('active') && pokerRoomState) {
        renderPokerTable()
      }
      break

    case 'poker_result': {
      const winnerName = esc(msg.winner_name || 'Someone')
      const handName   = esc(msg.hand || '')
      const amt        = fmt(msg.amount || 0)
      pokerLog(`${winnerName} wins $${amt}${handName ? ' with ' + handName : ''}`, 'ok')
      log(`Poker: ${winnerName} wins $${amt}${handName ? ' (' + handName + ')' : ''}`, 'ok')
      // Clear hole cards after hand completes
      pokerHoleCards = []
      break
    }

    case 'poker_error':
      pokerLog(msg.msg || 'Poker error', 'err')
      log(`Poker: ${msg.msg || 'error'}`, 'err')
      break

    default:
      console.warn('Unknown msg:', msg)
  }
}

// ── Clicker ───────────────────────────────────────────────────────────────────
function doClick () {
  if (!isConnected) return
  send({ type: 'action', action: 'click' })
  el.clickerBtn.style.transform = 'scale(0.95)'
  setTimeout(() => el.clickerBtn.style.transform = '', 80)
}

// ── Name ──────────────────────────────────────────────────────────────────────
function setName () {
  const name = el.nameInput.value.trim()
  if (!name) return
  if (nameLocked && player.name_tokens <= 0) { log('Name locked — need a token', 'warn'); return }
  send({ type: 'action', action: 'set_name', name })
}

function submitNamePrompt () {
  const errEl = document.getElementById('name-prompt-err')
  const name  = el.namePromptInput.value.trim()
  if (!name) {
    if (errEl) errEl.textContent = 'You must set a name before playing.'
    el.namePromptInput.focus()
    return
  }
  if (name.length < 2) {
    if (errEl) errEl.textContent = 'Name must be at least 2 characters.'
    el.namePromptInput.focus()
    return
  }
  if (errEl) errEl.textContent = ''
  send({ type: 'action', action: 'set_name', name })
}

function useNameToken () {
  if (player.name_tokens <= 0) { log('No name tokens', 'warn'); return }
  nameLocked = false
  el.nameInput.disabled = false
  el.nameInput.classList.remove('name-locked')
  el.nameBtn.style.display = ''
  el.nameTokenBtn.style.display = 'none'
  log('Token unlocked — set your new name and press SET', 'ok')
}

function updateNameUI () {
  const hasName  = !!player.name
  const isLocked = hasName && player.name_changes > 0 && player.name_tokens <= 0

  nameLocked = isLocked
  el.nameInput.disabled = isLocked
  el.nameInput.classList.toggle('name-locked', isLocked)
  el.nameBtn.style.display       = isLocked ? 'none' : ''
  el.nameTokenBtn.style.display  = isLocked ? ''     : 'none'
  el.nameTokenBtn.disabled       = player.name_tokens <= 0

  el.profName.textContent   = player.name || 'Unnamed'
  el.profTokens.textContent = player.name_tokens || 0
}

// ── Hack ──────────────────────────────────────────────────────────────────────
function buyHackModule () {
  if (!isConnected) { log('Not connected', 'err'); return }
  send({ type: 'action', action: 'buy_hack_module' })
}

function startHack () {
  if (!isConnected) { log('Not connected', 'err'); return }
  if (hackState.status !== 'idle') { log('Hack already active or on cooldown', 'warn'); return }
  send({ type: 'action', action: 'start_hack' })
}

function stopHack () {
  send({ type: 'action', action: 'stop_hack' })
  hideDefenseWindow()
  log('Stop hack signal sent', 'ok')
}

function bypassHackCooldown () {
  if (player.name_tokens <= 0) { log('No tokens', 'warn'); return }
  send({ type: 'action', action: 'bypass_hack_cooldown' })
}

function renderHackUI () {
  const unlocked = player.hack_unlocked
  el.hackLocked.style.display   = unlocked ? 'none' : ''
  el.hackIdle.style.display     = (unlocked && hackState.status === 'idle')     ? '' : 'none'
  el.hackRunning.style.display  = (unlocked && hackState.status === 'running')  ? '' : 'none'
  el.hackCooldown.style.display = (unlocked && hackState.status === 'cooldown') ? '' : 'none'
  el.profHack.textContent = unlocked ? 'INSTALLED' : 'NOT INSTALLED'
  const encryptSection = $('hack-encrypt-section')
  if (encryptSection) encryptSection.style.display = unlocked ? '' : 'none'
  const encryptStatus = $('encrypt-status')
  if (encryptStatus) {
    const active = player.encryption_active || (player.encryption_end > Date.now() / 1000)
    if (active) {
      const secsLeft = Math.max(0, Math.round((player.encryption_end || 0) - Date.now() / 1000))
      encryptStatus.textContent = `ACTIVE — ${fmtPlaytime(secsLeft)} remaining`
      encryptStatus.style.color = 'var(--green)'
    } else {
      const cost = Math.max(1_000_000, Math.round((player.money || 0) * 0.20))
      encryptStatus.textContent = `Cost: $${fmt(cost)}`
      encryptStatus.style.color = 'var(--dim)'
    }
  }
}

function handleHackResult (msg) {
  if (msg.started) {
    hackState = { status:'running', target:msg.target, targetName:msg.target_name, startTime:Date.now(), endTime:Date.now()+HACK_DURATION_MS, cooldownEnd:null }
    saveHackState()
    renderHackUI()
    el.hackTargetInfo.textContent = `Target: ${hackState.targetName || hackState.target || '---'}`
    log(`Hack initiated on ${msg.target_name || msg.target}`, 'warn')
    startHackTimer()

  } else if (msg.completed) {
    hackState = { status:'cooldown', target:null, targetName:null, startTime:null, endTime:null, cooldownEnd:Date.now()+HACK_COOLDOWN_MS }
    saveHackState()
    stopHackTimer()
    renderHackUI()
    startHackTimer()

    el.hackResultTitle.textContent = msg.success ? 'HACK SUCCESSFUL' : 'HACK BLOCKED'
    el.hackResultTitle.className   = msg.success ? 'hack-win' : 'hack-fail'
    el.hackResultDetails.innerHTML = msg.success
      ? `Target: <b>${esc(msg.target_name||'?')}</b><br>Stolen: <span class="amt">$${fmt(msg.amount)}</span><br>New balance: <span class="amt">$${fmt(msg.new_balance)}</span>`
      : `Target: <b>${esc(msg.target_name||'?')}</b><br>Reason: ${esc(msg.reason||'Target defended')}`
    showOverlay(el.hackResultOverlay)
    log(msg.success ? `Hack success! Stole $${fmt(msg.amount)}` : `Hack blocked: ${msg.reason}`, msg.success ? 'ok' : 'warn')
  }
}

function startHackTimer () {
  stopHackTimer()
  hackTimerInt = setInterval(() => {
    const now = Date.now()
    if (hackState.status === 'running') {
      const rem = Math.max(0, hackState.endTime - now)
      const pct = ((HACK_DURATION_MS - rem) / HACK_DURATION_MS) * 100
      el.hackProgressBar.style.width = pct + '%'
      el.hackTimer.textContent = fmtDuration(rem)
      if (rem <= 0) stopHackTimer()

    } else if (hackState.status === 'cooldown') {
      const rem = Math.max(0, hackState.cooldownEnd - now)
      el.hackCooldownTimer.textContent = fmtDuration(rem)
      el.hackTokenBtn.style.display    = player.name_tokens > 0 ? '' : 'none'
      if (rem <= 0) {
        hackState.status = 'idle'
        saveHackState()
        renderHackUI()
        stopHackTimer()
        log('Hack cooldown expired — system ready', 'ok')
      }
    }
  }, 1000)
}

function stopHackTimer () { clearInterval(hackTimerInt); hackTimerInt = null }

function showDefenseWindow (hackerName, seconds) {
  el.hackDefense.classList.add('visible')
  el.defenseHacker.textContent = `Attacker: ${hackerName}`
  let remaining = seconds
  clearInterval(defenseTimerInt)
  el.defenseTimer.textContent = fmtDuration(remaining * 1000)
  defenseTimerInt = setInterval(() => {
    remaining--
    el.defenseTimer.textContent = fmtDuration(Math.max(0, remaining * 1000))
    if (remaining <= 0) { clearInterval(defenseTimerInt); hideDefenseWindow() }
  }, 1000)
}

function hideDefenseWindow () {
  el.hackDefense.classList.remove('visible')
  clearInterval(defenseTimerInt)
}

function saveHackState ()    { localStorage.setItem('hack_state', JSON.stringify(hackState)) }
function restoreHackState () {
  const saved = localStorage.getItem('hack_state')
  if (!saved) return
  try {
    hackState = JSON.parse(saved)
    if (hackState.status === 'running' && Date.now() >= hackState.endTime) {
      hackState.status = 'cooldown'
      hackState.cooldownEnd = Date.now() + HACK_COOLDOWN_MS
      saveHackState()
    }
    if (hackState.status === 'running' || hackState.status === 'cooldown') startHackTimer()
  } catch { localStorage.removeItem('hack_state') }
}

function fmtDuration (ms) {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`
  return `${pad(m)}:${pad(sec)}`
}
const pad = n => String(Math.max(0, n)).padStart(2, '0')

// ── Update system ─────────────────────────────────────────────────────────────
async function checkForUpdate () {
  if (IS_WEB) { log('Updates are automatic on the web version', 'ok'); return }
  if (!isConnected) { log('Not connected', 'err'); return }
  if (!httpBaseUrl) { log('HTTP base URL not set', 'err'); return }
  try {
    const resp = await fetch(`${httpBaseUrl}/api/version`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    dbg('checkForUpdate: server=', data.version, 'client=', CURRENT_VERSION)
    if (data.version !== CURRENT_VERSION) {
      showUpdateOverlay(data.version, data.notes)
    } else {
      log('Game is up to date ✓', 'ok')
    }
  } catch (err) {
    log('Could not check version: ' + err.message, 'err')
  }
}

function showUpdateOverlay (version, notes) {
  el.updateNew.textContent = version
  el.updateNotes.textContent = notes || ''
  showOverlay(el.updateOverlay)
}

// ── Multi-purchase upgrade helpers ──────────────────────────────────────────────
function getUpgradeCount (uId) {
  return (player.upgrades_bought && player.upgrades_bought[uId]) || 0
}

// Returns the max qty affordable via geometric series inverse, capped by maxAllowed.
// Formula derived from: sum = base * scale^n * (scale^q - 1) / (scale - 1) <= money
function _maxAffordableQty (u, money, maxAllowed) {
  const count = getUpgradeCount(u.id)
  const scale = u.cost_scale ?? COST_SCALE
  const baseCostAtLevel = u.base_cost * Math.pow(scale, count)
  if (baseCostAtLevel <= 0 || money < baseCostAtLevel) return 0
  let qty
  if (Math.abs(scale - 1) < 1e-9) {
    qty = Math.floor(money / baseCostAtLevel)
  } else {
    qty = Math.floor(Math.log(money * (scale - 1) / baseCostAtLevel + 1) / Math.log(scale))
  }
  return Math.max(0, Math.min(qty, maxAllowed))
}

function getUpgradeCost (u) {
  const count = getUpgradeCount(u.id)
  const scale = u.cost_scale ?? COST_SCALE
  return Math.round(u.base_cost * Math.pow(scale, count))
}

function getUpgradeBulkCost (u, qty) {
  const scale = u.cost_scale ?? COST_SCALE
  const count = getUpgradeCount(u.id)
  if (qty <= 1) return getUpgradeCost(u)
  if (scale === 1.0) return Math.round(u.base_cost * qty)
  return Math.round(u.base_cost * Math.pow(scale, count) * (Math.pow(scale, qty) - 1) / (scale - 1))
}

function getTotalUpgradesBought () {
  if (!player.upgrades_bought) return 0
  return Object.values(player.upgrades_bought).reduce((a, b) => a + b, 0)
}

function getCategoryUpgradesBought (category) {
  if (!player.upgrades_bought) return 0
  return upgrades
    .filter(u => u.category === category)
    .reduce((sum, u) => sum + (player.upgrades_bought[u.id] || 0), 0)
}

// ── Discord RPC ───────────────────────────────────────────────────────────────
// ── State rendering ───────────────────────────────────────────────────────────
function applyState (s) {
  const prev = player.money
  const prevPrestige = player.prestige_count || 0
  player = { ...player, ...s }

  if (Math.floor(s.money) !== Math.floor(prev)) {
    el.statMoney.classList.remove('bump')
    void el.statMoney.offsetWidth
    el.statMoney.classList.add('bump')
  }

  el.statMoney.textContent   = fmt(player.money)
  el.statIncome.textContent  = fmt(player.income)
  el.statTotal.textContent   = fmt(player.total_earned)
  el.statClick.textContent   = '$' + fmt(player.click_value || 1)
  el.clickerVal.textContent  = '$' + fmt(player.click_value || 1)

  el.profId.textContent      = (player.id || '').slice(0, 12) + '…'
  el.profMoney.textContent   = '$' + fmt(player.money)
  el.profIncome.textContent  = '$' + fmt(player.income) + '/s'
  el.profTotal.textContent   = '$' + fmt(player.total_earned)
  el.profClicks.textContent  = fmt(player.clicks || 0)
  el.profUpgrades.textContent= getTotalUpgradesBought()
  el.profPrestigePoints.textContent = player.prestige_points || 0
  el.profPrestigeMult.textContent   = player.pp_available ?? (player.prestige_points || 0)
  if (el.profStreak) {
    const s = player.login_streak || 0
    const mult = s >= 30 ? '+100%' : s >= 14 ? '+50%' : s >= 7 ? '+25%' : s >= 3 ? '+10%' : ''
    el.profStreak.textContent = s + (s === 1 ? ' day' : ' days') + (mult ? ` (${mult})` : '')
  }
  if (el.profAchievements) {
    const achs = player.achievements || []
    const labels = {phantom:'PHANTOM',vault:'VAULT',high_roller:'HIGH ROLLER',kingpin:'KINGPIN',ghost:'GHOST'}
    el.profAchievements.textContent = achs.length ? achs.map(a => labels[a] || a.toUpperCase()).join(', ') : '—'
  }
  if (el.profPlaytime) el.profPlaytime.textContent = fmtPlaytime(player.play_time_seconds || 0)
  if (el.profCasinoWagered) el.profCasinoWagered.textContent = '$' + fmt(player.casino_wagered || 0)
  if (el.profCasinoPl) {
    const pl = (player.casino_winnings || 0) - (player.casino_wagered || 0)
    el.profCasinoPl.textContent = (pl >= 0 ? '+$' : '-$') + fmt(Math.abs(pl))
    el.profCasinoPl.style.color = pl >= 0 ? 'var(--green)' : 'var(--red)'
  }

  renderBadgePicker()

  const supporterRow    = document.getElementById('prof-supporter-row')
  const supporterStatus = document.getElementById('prof-supporter-status')
  if (supporterRow && supporterStatus) {
    const mo = player.patron_months_total || 0
    if (player.patron && mo >= 12) {
      supporterRow.style.display = ''
      supporterStatus.textContent = `❋ LEGEND — ${mo} months, +15% income, -20% hack CD`
      supporterStatus.style.color = '#f0c040'
    } else if (player.patron && mo >= 6) {
      supporterRow.style.display = ''
      supporterStatus.textContent = `✦ VETERAN — ${mo} months, +12% income, -15% hack CD`
      supporterStatus.style.color = '#8e9eab'
    } else if (player.patron && mo >= 3) {
      supporterRow.style.display = ''
      supporterStatus.textContent = `⬡ LOYAL — ${mo} months, +11% income, -12% hack CD`
      supporterStatus.style.color = '#b87333'
    } else if (player.patron) {
      supporterRow.style.display = ''
      supporterStatus.textContent = `♦ PATRON — ${mo} month${mo !== 1 ? 's' : ''}, +10% income, -10% hack CD`
      supporterStatus.style.color = '#9b59f7'
    } else if (player.supporter) {
      supporterRow.style.display = ''
      supporterStatus.textContent = '★ SUPPORTER — +5% income'
      supporterStatus.style.color = 'var(--green)'
    } else {
      supporterRow.style.display = 'none'
    }
  }

  el.footerDot.className = `conn-dot ${isConnected ? 'online' : ''}`

  updateNameUI()
  renderUpgrades()
  renderHackUI()
  ConnectionModule.updateStatus(player)
  if (el.acctIdDisplay && player.id) el.acctIdDisplay.textContent = player.id
  renderAchievements()
  renderHouseEconomyUI()
}

// ── Upgrades (MULTI-PURCHASE + CATEGORIES) ────────────────────────────────────
function renderUpgrades () {
  const container = el.upgradeList
  if (!container) return
  container.innerHTML = ''

  if (activeUpgradeCategory === 'prestige') {
    renderPrestigePanel(container)
    return
  }

  if (activeUpgradeCategory === 'skill') {
    renderSkillTree(container)
    return
  }

  const filtered = upgrades.filter(u => u.category === activeUpgradeCategory)

  filtered.forEach((u) => {
    const catBought  = getCategoryUpgradesBought(u.category)
    const count      = getUpgradeCount(u.id)
    const cost       = getUpgradeCost(u)
    const maxLevel   = u.max_level ?? Infinity
    const atMax      = count >= maxLevel
    let effQty
    if (upgradeQtyMode === 'max') {
      const maxAllowed = maxLevel === Infinity ? Infinity : maxLevel - count
      effQty = atMax ? 0 : _maxAffordableQty(u, player.money, maxAllowed === Infinity ? 1e9 : maxAllowed)
    } else {
      const qtyWanted = Math.max(1, upgradeQtyMode)
      const remaining = maxLevel === Infinity ? qtyWanted : Math.min(qtyWanted, maxLevel - count)
      effQty = atMax ? 0 : remaining
    }
    const totalCost  = effQty > 1 ? getUpgradeBulkCost(u, effQty) : cost
    const canAfford  = player.money >= totalCost && !atMax
    const isUnlocked = catBought >= u.req_count
    const isHidden   = u.hidden && !isUnlocked

    const card = document.createElement('div')
    card.className = `upgrade-card ${canAfford && isUnlocked ? 'affordable' : 'locked'} ${isHidden ? 'hidden-tier' : ''}`
    card.dataset.upgradeId = u.id

    if (isHidden) {
      card.innerHTML = `
        <div>
          <div class="upg-name" style="color:var(--muted);font-style:italic;font-size:11px;">[LOCKED]</div>
          <div class="upg-bonus" style="font-size:10px;">Buy ${u.req_count - catBought} more upgrades to unlock</div>
        </div>
        <div class="upg-cost" style="color:var(--muted);">???</div>
      `
    } else {
      const levelTag = count > 0 ? `<span style="color:var(--green-dim);font-size:10px;"> &nbsp;Lvl ${count}${maxLevel < Infinity ? '/'+maxLevel : ''}</span>` : ''
      const qtyTag   = effQty > 1 ? `<span style="color:var(--muted);font-size:9px;"> ×${effQty}</span>` : ''
      const costLabel = atMax
        ? `<div class="upg-cost" style="color:var(--muted);font-size:9px;letter-spacing:1px;">MAX</div>`
        : `<div class="upg-cost ${canAfford ? 'can-afford' : ''}">$${fmt(totalCost)}${qtyTag}</div>`
      card.innerHTML = `
        <div>
          <div class="upg-name" style="font-size:11px;">${esc(u.name)}${levelTag}</div>
          <div class="upg-bonus" style="font-size:10px;">${esc(u.desc || '')}</div>
        </div>
        ${costLabel}
      `
      if (!atMax) card.addEventListener('click', () => buyUpgrade(u.id))
    }

    container.appendChild(card)
  })
}

function updateUpgradeAffordability () {
  const container = el.upgradeList
  if (!container) return
  const cards = container.querySelectorAll('.upgrade-card')
  const filteredUpgrades = upgrades.filter(u => u.category === activeUpgradeCategory)

  cards.forEach((card, idx) => {
    const u = filteredUpgrades[idx]
    if (!u) return
    const catBought  = getCategoryUpgradesBought(u.category)
    const count      = getUpgradeCount(u.id)
    const cost       = getUpgradeCost(u)
    const maxLevel   = u.max_level ?? Infinity
    const atMax      = count >= maxLevel
    const isUnlocked = catBought >= u.req_count
    const isHidden   = u.hidden && !isUnlocked

    let effQty
    if (upgradeQtyMode === 'max') {
      const maxAllowed = maxLevel === Infinity ? Infinity : maxLevel - count
      effQty = atMax ? 0 : _maxAffordableQty(u, player.money, maxAllowed === Infinity ? 1e9 : maxAllowed)
    } else {
      const qtyWanted = Math.max(1, upgradeQtyMode)
      const remaining = maxLevel === Infinity ? qtyWanted : Math.min(qtyWanted, maxLevel - count)
      effQty = atMax ? 0 : remaining
    }
    const totalCost = effQty > 1 ? getUpgradeBulkCost(u, effQty) : cost
    const canAfford = player.money >= totalCost && !atMax

    card.className = `upgrade-card ${canAfford && isUnlocked ? 'affordable' : 'locked'} ${isHidden ? 'hidden-tier' : ''}`

    if (!isHidden) {
      const costEl = card.querySelector('.upg-cost')
      if (costEl) {
        if (atMax) {
          costEl.textContent = 'MAX'
          costEl.className   = 'upg-cost'
          costEl.style.color = 'var(--muted)'
          costEl.style.fontSize = '9px'
        } else {
          const qtyTag = effQty > 1 ? `<span style="color:var(--muted);font-size:9px;"> ×${effQty}</span>` : ''
          costEl.innerHTML   = `$${fmt(totalCost)}${qtyTag}`
          costEl.className   = `upg-cost ${canAfford ? 'can-afford' : ''}`
          costEl.style.color = ''
          costEl.style.fontSize = ''
        }
      }
      const nameEl = card.querySelector('.upg-name')
      if (nameEl) {
        const baseName = esc(u.name)
        const levelTag = count > 0 ? `<span style="color:var(--green-dim);font-size:10px;"> &nbsp;Lvl ${count}${maxLevel < Infinity ? '/'+maxLevel : ''}</span>` : ''
        nameEl.innerHTML = `${baseName}${levelTag}`
      }
    }
  })
}

function buyUpgrade (id) {
  let qty
  if (upgradeQtyMode === 'max') {
    const u = upgrades.find(u => u.id === id)
    if (!u) return
    const count    = getUpgradeCount(u.id)
    const maxLevel = u.max_level ?? Infinity
    const maxAllowed = maxLevel === Infinity ? 1e9 : maxLevel - count
    qty = _maxAffordableQty(u, player.money, maxAllowed)
  } else {
    qty = Math.max(1, upgradeQtyMode)
  }
  qty = Math.max(1, qty)
  send({ type: 'action', action: 'buy_upgrade', upgrade_id: id, qty })
}

// ── Prestige Panel ────────────────────────────────────────────────────────────
// Server sends next_prestige_cost in player state. Prestige costs money (not
// total_earned). Cost doubles each prestige. Points scale with overshoot.
const PRESTIGE_BASE_COST = 1_000_000_000
const PRESTIGE_COST_MULT = 1.8

function clientPrestigeCost () {
  // Prefer server-sent value; fallback to local calc
  if (player.next_prestige_cost) return player.next_prestige_cost
  return Math.floor(PRESTIGE_BASE_COST * Math.pow(PRESTIGE_COST_MULT, player.prestige_count || 0))
}

function prestige_points_gained (money, cost) {
  if (money < cost) return 0
  return Math.max(1, Math.floor(Math.sqrt(money / cost)))
}

function renderPrestigePanel (container) {
  container.innerHTML = ''
  const money       = player.money || 0
  const cost        = clientPrestigeCost()
  const canPrestige = money >= cost
  const pointsGain  = canPrestige ? prestige_points_gained(money, cost) : 0
  const pCount      = player.prestige_count || 0

  const div = document.createElement('div')
  div.className = 'hack-status'
  div.style.padding = '20px 0'
  div.innerHTML = `
    <div class="big" style="color:${canPrestige ? 'var(--green)' : 'var(--muted)'};">
      ${canPrestige ? 'PRESTIGE READY' : 'PRESTIGE LOCKED'}
    </div>
    <div class="sub" style="margin:12px 0;">${canPrestige
      ? `You have <b>$${fmt(money)}</b> on hand.<br>Prestiging resets money &amp; upgrades but grants skill points to spend in the SKILL tab.`
      : `Need <b>$${fmt(cost)}</b> on hand to prestige.<br>Current: <b>$${fmt(money)}</b>`}
    </div>
    ${canPrestige ? `
      <div class="sub" style="color:var(--amber);">Skill points gained: <b>+${pointsGain}</b></div>
      <button class="btn btn-amber hack-btn" id="prestige-action-btn" style="margin-top:16px;">PRESTIGE NOW</button>
    ` : ''}
    <div class="sub" style="margin-top:12px;">
      Prestiges: <b>${pCount}</b> &nbsp;|&nbsp;
      Total PP: <b>${player.prestige_points || 0}</b> &nbsp;|&nbsp;
      Available PP: <b>${player.pp_available ?? (player.prestige_points || 0)}</b>
    </div>
    <div class="sub" style="margin-top:4px; color:var(--amber); font-size:10px;">
      PP in skill tree: <b>${(player.pp_spent_skills || 0)}</b>
    </div>
    <div class="sub" style="margin-top:6px; color:var(--muted); font-size:10px;">
      Next cost: $${fmt(Math.floor(cost * PRESTIGE_COST_MULT))} &nbsp;|&nbsp; Open <b>SKILL</b> tab to spend PP
    </div>
  `
  container.appendChild(div)

  if (canPrestige) {
    document.getElementById('prestige-action-btn')?.addEventListener('click', doPrestige)
  }
}

// ── Skill Tree ────────────────────────────────────────────────────────────────
const SKILL_TREE_META = {
  overclock: { label: 'OVERCLOCK',    color: '#00ff88', desc: 'Amplify income, clicks, and offline earnings.' },
  ghost:     { label: 'GHOST OPS',    color: '#ff6b35', desc: 'Dominate hacking — faster, stealthier, and more lucrative.' },
  market:    { label: 'MARKET INTEL', color: '#4db8ff', desc: 'Master the economy — markets, casino, and trading.' },
  neural:    { label: 'NEURAL NET',   color: '#cc44ff', desc: 'Synapse income with clicks, auto-clicker bursts, and exponential amplification.' },
  darkweb:   { label: 'DARKWEB',      color: '#ff2255', desc: 'Underground economy — anonymous bonuses, black market gifts, and cosmetic laundering.' },
  quantum:   { label: 'QUANTUM',      color: '#00ccff', desc: 'Probabilistic spikes, entangled player bonuses, and random prestige multiplier boosts.' },
  botnet:    { label: 'BOTNET',       color: '#ffaa00', desc: 'Dominate offline — zombie nodes, AFK return bonuses, and accelerated idle ticks.' },
}

function _skillNodeOwned (nodeId) {
  return (player.skill_nodes || []).includes(nodeId)
}
function _skillPrereqsMet (node) {
  return (node.prereqs || []).every(rid => _skillNodeOwned(rid))
}
function _ppAvailable () {
  return player.pp_available ?? (player.prestige_points || 0)
}

function renderSkillTree (container) {
  container.innerHTML = ''

  if ((player.prestige_count || 0) < 1) {
    const lock = document.createElement('div')
    lock.className = 'hack-status'
    lock.style.padding = '24px 0'
    lock.innerHTML = `
      <div class="big" style="color:var(--muted);">SKILL TREE LOCKED</div>
      <div class="sub" style="margin-top:10px;">Prestige once to unlock all three skill paths.</div>
    `
    container.appendChild(lock)
    return
  }

  const ppAvail = _ppAvailable()
  const ppTotal = player.prestige_points || 0
  const ppSpent = player.pp_spent_skills || 0

  // Header
  const header = document.createElement('div')
  header.style.cssText = 'margin-bottom:10px; padding:8px; background:var(--panel-alt,rgba(0,255,136,0.05)); border:1px solid rgba(0,255,136,0.15); border-radius:4px;'
  header.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
      <div style="font-size:10px; color:var(--muted); letter-spacing:1px;">PRESTIGE SKILL TREE</div>
      <div style="font-size:11px;">
        <span style="color:var(--green);">Available: <b>${ppAvail} PP</b></span>
        &nbsp;|&nbsp;
        <span style="color:var(--amber);">In tree: <b>${ppSpent} PP</b></span>
        &nbsp;|&nbsp;
        <span style="color:var(--muted);">Total: <b>${ppTotal} PP</b></span>
      </div>
    </div>
    <div style="margin-top:4px; font-size:9px; color:var(--muted);">Spending PP removes it from your income multiplier. All nodes are permanent.</div>
  `
  container.appendChild(header)

  const trees = ['overclock', 'ghost', 'market', 'neural', 'darkweb', 'quantum', 'botnet']
  for (const treeKey of trees) {
    const meta = SKILL_TREE_META[treeKey]
    const treeNodes = skillTree.filter(n => n.tree === treeKey)
    if (!treeNodes.length) continue

    const section = document.createElement('div')
    section.style.cssText = 'margin-bottom:14px;'

    const titleBar = document.createElement('div')
    titleBar.style.cssText = `display:flex; align-items:center; gap:8px; margin-bottom:6px; padding:6px 8px; background:${meta.color}18; border-left:3px solid ${meta.color}; border-radius:2px;`
    titleBar.innerHTML = `
      <div style="font-size:12px; font-weight:bold; color:${meta.color}; letter-spacing:2px;">${meta.label}</div>
      <div style="font-size:9px; color:var(--muted); flex:1;">${esc(meta.desc)}</div>
    `
    section.appendChild(titleBar)

    const grid = document.createElement('div')
    grid.className = 'skill-tree-grid'
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:6px;'

    for (const node of treeNodes) {
      const owned      = _skillNodeOwned(node.id)
      const prereqsMet = _skillPrereqsMet(node)
      const canAfford  = ppAvail >= node.cost
      const isApex     = node.id.endsWith('_apex')
      const canBuy     = !owned && prereqsMet && canAfford

      const card = document.createElement('div')
      card.className = `skill-node-card${owned ? ' owned' : canBuy ? ' buyable' : ' locked'}`
      if (owned)        card.style.borderColor = meta.color + '55'
      else if (canBuy)  card.style.borderColor = meta.color + '44'
      if (isApex)       card.style.borderWidth = '2px'

      const costColor   = owned ? 'var(--muted)' : canAfford ? meta.color : '#ff4444'
      const nameColor   = owned ? meta.color : prereqsMet ? '#ddd' : 'var(--muted)'
      const statusIcon  = owned ? '✓' : (!prereqsMet ? '⊘' : (canAfford ? '' : ''))
      const prereqNames = (node.prereqs || []).map(pid => {
        const pn = skillTree.find(n => n.id === pid)
        return pn ? pn.name : pid
      })
      const reqHint = !prereqsMet && !owned
        ? `<div style="font-size:8px;color:#ff4444;margin-top:2px;" title="Requires: ${esc(prereqNames.join(', '))}">Req: ${esc(prereqNames.join(' + '))}</div>`
        : ''

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:4px;">
          <div style="font-size:10px;font-weight:bold;color:${nameColor};line-height:1.3;">${esc(node.name)}</div>
          <div style="font-size:10px;color:${owned ? 'var(--green)' : 'var(--muted)'};flex-shrink:0;">${statusIcon}</div>
        </div>
        <div style="font-size:9px;color:var(--muted);margin:3px 0;line-height:1.4;">${esc(node.desc)}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <div style="font-size:10px;color:${costColor};font-weight:bold;">${owned ? 'OWNED' : `${node.cost} PP`}</div>
        </div>
        ${reqHint}
      `

      if (canBuy) card.addEventListener('click', () => buySkillNode(node.id, node.name, node.cost))
      grid.appendChild(card)
    }
    section.appendChild(grid)
    container.appendChild(section)
  }
}

function buySkillNode (nodeId, nodeName, cost) {
  if (!isConnected) { log('Not connected', 'err'); return }
  const ppAvail = _ppAvailable()
  if (ppAvail < cost) {
    log(`Need ${cost} PP for ${nodeName} (have ${ppAvail})`, 'warn')
    return
  }
  send({ type: 'action', action: 'buy_skill_node', node_id: nodeId })
}

function doPrestige () {
  if (!isConnected) { log('Not connected', 'err'); return }
  const cost = clientPrestigeCost()
  if ((player.money || 0) < cost) {
    log(`Need $${fmt(cost)} on hand to prestige`, 'warn')
    return
  }
  send({ type: 'action', action: 'prestige' })
}

// ── Trade ─────────────────────────────────────────────────────────────────────
const ASSET_IDS = ['SRV', 'GPU', 'ZRO', 'NET', 'CPU']

function _populateAssetSelect (selectedAsset) {
  if (!el.tradeAssetSelect) return
  const assets = marketAssets.length ? marketAssets : ASSET_IDS.map(id => ({ id, name: id }))
  el.tradeAssetSelect.innerHTML = assets.map(a =>
    `<option value="${esc(a.id)}" ${a.id === selectedAsset ? 'selected' : ''}>${esc(a.id)}${a.name && a.name !== a.id ? ' — ' + esc(a.name) : ''}</option>`
  ).join('')
}

function openTradeOverlay (trade, isInitiator) {
  activeTrade = trade
  if (!el.tradeOverlay) return

  const otherName = isInitiator
    ? (lbData.find(p => p.id === trade.target)?.name  || trade.target.slice(0, 8))
    : (lbData.find(p => p.id === trade.initiator)?.name || trade.initiator.slice(0, 8))

  if (el.tradeTitle) el.tradeTitle.textContent = isInitiator ? 'TRADE SENT' : 'TRADE OFFER'
  if (el.tradeDetails) {
    el.tradeDetails.textContent = isInitiator
      ? `Offer sent to ${otherName} — waiting for response`
      : `${otherName} offers ${trade.shares} × ${trade.asset} for $${fmt(trade.price)}`
  }

  _populateAssetSelect(trade.asset)

  if (el.tradeSharesInput) el.tradeSharesInput.value = trade.shares
  if (el.tradePriceInput)  el.tradePriceInput.value  = trade.price

  // Only target can accept; both can reject; counter button label
  if (el.tradeAcceptBtn)  el.tradeAcceptBtn.disabled      = isInitiator
  if (el.tradeRejectBtn)  el.tradeRejectBtn.style.display  = ''
  if (el.tradeCounterBtn) el.tradeCounterBtn.textContent   = 'COUNTER'

  // Populate chat log from session history
  if (el.tradeChatLog) {
    el.tradeChatLog.innerHTML = ''
    ;(trade.messages || []).forEach(m => _appendTradeChat(m.name, m.text))
  }

  showOverlay(el.tradeOverlay)
}

function _appendTradeChat (name, text) {
  if (!el.tradeChatLog) return
  const div = document.createElement('div')
  div.style.cssText = 'padding:2px 0;border-bottom:1px solid rgba(255,255,255,.03);'
  div.innerHTML = `<span style="color:var(--green-dim);font-size:10px;">${esc(name)}:</span> <span style="color:var(--text);">${esc(text)}</span>`
  el.tradeChatLog.appendChild(div)
  el.tradeChatLog.scrollTop = el.tradeChatLog.scrollHeight
}

function closeTradeOverlay () {
  activeTrade = null
  if (el.tradeOverlay) hideOverlay(el.tradeOverlay)
}

function initiateTrade (targetId, targetName) {
  if (!isConnected) { log('Connect to a server first', 'warn'); return }
  // Open overlay in offer-compose mode: blank fields, asset picker visible
  const draftTrade = {
    id:        null,
    initiator: PLAYER_ID,
    target:    targetId,
    asset:     marketAssets[0]?.id || 'SRV',
    shares:    1,
    price:     0,
    messages:  [],
    status:    'draft',
  }
  activeTrade = draftTrade

  if (el.tradeTitle)   el.tradeTitle.textContent   = 'SEND TRADE OFFER'
  if (el.tradeDetails) el.tradeDetails.textContent = `To: ${targetName || targetId.slice(0, 8)}`

  _populateAssetSelect(draftTrade.asset)

  if (el.tradeSharesInput) el.tradeSharesInput.value = ''
  if (el.tradePriceInput)  el.tradePriceInput.value  = ''
  if (el.tradeChatLog)     el.tradeChatLog.innerHTML  = ''
  if (el.tradeChatInput)   el.tradeChatInput.value    = ''

  // In draft mode, only "SEND OFFER" (repurposed counter button) and close matter
  if (el.tradeAcceptBtn)  el.tradeAcceptBtn.disabled  = true
  if (el.tradeRejectBtn)  el.tradeRejectBtn.style.display = 'none'
  if (el.tradeCounterBtn) {
    el.tradeCounterBtn.textContent = 'SEND OFFER'
    el.tradeCounterBtn.style.display = ''
  }

  showOverlay(el.tradeOverlay)
}

function _wireTradeButtons () {
  if (!el.tradeOverlay) return

  el.tradeCloseBtn?.addEventListener('click', closeTradeOverlay)

  el.tradeAcceptBtn?.addEventListener('click', () => {
    if (!activeTrade || !activeTrade.id) return
    send({ type: 'trade_accept', trade_id: activeTrade.id })
  })

  el.tradeCounterBtn?.addEventListener('click', () => {
    if (!activeTrade) return
    const shares = parseInt(el.tradeSharesInput?.value || '0', 10)
    const price  = parseFloat(el.tradePriceInput?.value  || '0')
    if (!shares || shares <= 0) { log('Enter a valid share count', 'warn'); return }
    if (!price  || price  <= 0) { log('Enter a valid price', 'warn'); return }
    const asset = el.tradeAssetSelect?.value || activeTrade.asset || 'SRV'

    if (!activeTrade.id) {
      // Draft mode — send the initial offer
      send({ type: 'trade_offer', target_id: activeTrade.target, asset, shares, price })
    } else {
      // Counter existing trade
      send({ type: 'trade_counter', trade_id: activeTrade.id, shares, price })
    }
  })

  el.tradeRejectBtn?.addEventListener('click', () => {
    if (!activeTrade || !activeTrade.id) return
    send({ type: 'trade_reject', trade_id: activeTrade.id })
  })

  el.tradeChatSend?.addEventListener('click', _sendTradeChat)
  el.tradeChatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') _sendTradeChat() })
}

function _sendTradeChat () {
  if (!activeTrade || !activeTrade.id) return
  const text = el.tradeChatInput?.value.trim()
  if (!text) return
  send({ type: 'trade_message', trade_id: activeTrade.id, text })
  _appendTradeChat(player.name || 'You', text)
  if (el.tradeChatInput) el.tradeChatInput.value = ''
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
let lbData    = []
let lbSortKey = 'money'
let _lbCache  = {} // pid -> { rank, money, name, badge }

function renderLeaderboard (data) {
  lbData = data
  renderSortedLeaderboard()
}

function renderSortedLeaderboard () {
  if (!el.lbList) return
  if (!lbData.length) {
    el.lbList.innerHTML = '<div style="color:var(--dim);font-size:10px;padding:8px 0;">No players yet.</div>'
    _lbCache = {}
    return
  }

  const sorted = [...lbData].sort((a, b) => {
    let av, bv
    if (lbSortKey === 'casino_net') {
      av = (a.casino_winnings || 0) - (a.casino_wagered || 0)
      bv = (b.casino_winnings || 0) - (b.casino_wagered || 0)
    } else {
      av = a[lbSortKey] ?? 0
      bv = b[lbSortKey] ?? 0
    }
    return bv - av
  })

  const currentPids = new Set(sorted.slice(0, 100).map(p => p.id))

  // Remove rows for players no longer present
  for (const pid of Object.keys(_lbCache)) {
    if (!currentPids.has(pid)) {
      const oldRow = document.getElementById('lb-row-' + pid)
      if (oldRow) oldRow.remove()
      delete _lbCache[pid]
    }
  }

  sorted.slice(0, 100).forEach((entry, i) => {
    const rank     = i + 1
    const moneyVal = entry.online ? entry.money : (entry.last_seen_money ?? entry.money)
    const money    = moneyVal ?? 0
    const name     = entry.name || entry.id.slice(0, 8)
    const pid      = entry.id

    let row = document.getElementById('lb-row-' + pid)
    if (!row) {
      row = document.createElement('div')
      row.id = 'lb-row-' + pid
      row.className = 'lb-row'
      row.style.cursor = 'pointer'
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px;cursor:pointer;'
      row.innerHTML = `
        <span class="lb-rank" style="width:22px;color:var(--muted);font-size:10px;text-align:right;flex-shrink:0;"></span>
        <span class="lb-dot" style="width:7px;height:7px;border-radius:50%;flex-shrink:0;"></span>
        <span class="lb-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        <span class="lb-money" style="font-family:var(--display);font-size:10px;color:var(--green);flex-shrink:0;"></span>
        <button class="lb-trade-btn btn" style="font-size:8px;padding:1px 5px;flex-shrink:0;color:var(--muted);border-color:var(--border);display:none;">TRADE</button>
      `
      el.lbList.appendChild(row)
    }
    // Always update onclick so it reflects the current entry/rank snapshot
    row.onclick = (e) => { if (!e.defaultPrevented) showPlayerModal(entry, rank) }

    const cached = _lbCache[pid] || {}

    // Update rank
    const rankEl = row.querySelector('.lb-rank')
    if (rankEl && cached.rank !== rank) {
      rankEl.textContent = '#' + rank
      rankEl.style.color = rank === 1 ? 'var(--amber)' : 'var(--muted)'
    }

    // Update dot (online status)
    const dotEl = row.querySelector('.lb-dot')
    if (dotEl) {
      dotEl.style.background = entry.online ? 'var(--green)' : 'var(--border)'
      dotEl.style.boxShadow  = entry.online ? '0 0 5px var(--green)' : 'none'
    }

    // Update name + badge
    const nameEl = row.querySelector('.lb-name')
    if (nameEl && (cached.name !== name || cached.badge !== entry.badge)) {
      const badgeHtml = entry.badge ? badgeTag(entry.badge, 'font-size:8px;') : ''
      nameEl.innerHTML = esc(name) + badgeHtml
    }

    // Update money (animate if changed)
    const moneyEl = row.querySelector('.lb-money')
    if (moneyEl && cached.money !== money) {
      const moneyStr = '$' + fmt(money) + (entry.online ? '' : ' <span style="font-size:9px;color:var(--muted);">last</span>')
      moneyEl.innerHTML = moneyStr
      moneyEl.style.transition = 'color 0.3s'
      moneyEl.style.color = money > (cached.money || 0) ? '#7fff9a' : 'var(--green)'
      setTimeout(() => { moneyEl.style.color = 'var(--green)' }, 600)
    }

    // Show / wire TRADE button — only for other online players
    const tradeBtnEl = row.querySelector('.lb-trade-btn')
    if (tradeBtnEl) {
      const canTrade = pid !== PLAYER_ID && entry.online
      tradeBtnEl.style.display = canTrade ? '' : 'none'
      if (canTrade) {
        tradeBtnEl.onclick = (e) => {
          e.preventDefault()
          e.stopPropagation()
          initiateTrade(pid, name)
        }
      }
    }

    // Re-order row to correct position
    const rows = el.lbList.children
    if (rows[i] !== row) {
      el.lbList.insertBefore(row, rows[i] || null)
    }

    _lbCache[pid] = { rank, money, name, badge: entry.badge }
  })
}

function showPlayerModal (entry, rank) {
  const isMe    = entry.id === PLAYER_ID
  const online  = entry.online
  const moneyVal = online ? entry.money : (entry.last_seen_money ?? entry.money)
  const playtime = fmtPlaytime(entry.play_time_seconds ?? 0)
  const prestige = entry.prestige_count ?? 0

  const badgesArr  = Array.isArray(entry.badges) ? entry.badges : (entry.badge ? [entry.badge] : [])
  const badgeHtml  = badgesArr.length
    ? badgesArr.map(b => badgeTag(b, 'font-size:11px;padding:2px 7px;')).join(' ')
    : ''

  const row = (label, value, color = '') =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);">
       <span style="color:var(--muted);font-size:11px;">${label}</span>
       <span style="font-size:11px;${color ? `color:${color};` : ''}">${value}</span>
     </div>`

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = `
    <div class="modal" style="max-width:340px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
        <div class="${online ? 'lb-online' : 'lb-offline'}" style="flex-shrink:0;" title="${online ? 'online' : 'offline'}"></div>
        <div>
          <div style="font-family:var(--display);font-size:14px;letter-spacing:2px;">${esc(entry.name || 'Anon')}</div>
          <div style="font-size:10px;color:var(--muted);">Rank #${rank}${isMe ? ' <span style="color:var(--green-dim);">(you)</span>' : ''}</div>
        </div>
        <div style="margin-left:auto;">${badgeHtml}</div>
      </div>
      ${row('Status', online ? '🟢 Online' : '⚫ Offline', online ? 'var(--green)' : 'var(--muted)')}
      ${row('Money', '$' + fmt(moneyVal) + (online ? '' : ' <span style="font-size:9px;color:var(--muted);">(last seen)</span>'))}
      ${row('Total Earned', '$' + fmt(entry.total_earned ?? 0))}
      ${row('Income', '$' + fmt(entry.income ?? 0) + '/s')}
      ${row('Clicks', fmt(entry.clicks ?? 0))}
      ${row('Prestige', prestige > 0 ? `${prestige}×` : 'None', prestige > 0 ? 'var(--amber)' : '')}
      ${row('Play Time', playtime)}
      ${(() => {
        const achLabels = { phantom: 'PHANTOM', vault: 'VAULT', high_roller: 'HIGH ROLLER', kingpin: 'KINGPIN', ghost: 'GHOST' }
        const achs = Array.isArray(entry.achievements) ? entry.achievements : []
        const achStr = achs.length ? achs.map(a => `<span style="color:var(--amber);font-size:9px;border:1px solid var(--amber);padding:1px 4px;">${achLabels[a] || a.toUpperCase()}</span>`).join(' ') : '<span style="color:var(--muted);">None</span>'
        return row('Achievements', achStr)
      })()}
      ${entry.encryption_active ? row('Encryption', '<span style="color:var(--green);font-size:10px;">ACTIVE</span>') : ''}
      ${!isMe ? `<button class="btn" id="player-modal-report" style="margin-top:14px;width:100%;font-size:10px;letter-spacing:1px;color:var(--red);border-color:var(--red);">REPORT</button>` : ''}
      <button class="btn modal-full" id="player-modal-close" style="margin-top:6px;">CLOSE</button>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('#player-modal-close').onclick = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  const reportBtn = overlay.querySelector('#player-modal-report')
  if (reportBtn) {
    reportBtn.onclick = () => {
      overlay.remove()
      showReportModal(entry.id, entry.name || 'Anon', null)
    }
  }
}

// ── Report modal ─────────────────────────────────────────────────────────────
function showReportModal (targetId, targetName, messageText) {
  if (!isConnected) { log('Connect to a server first', 'warn'); return }
  const REASONS = [
    { id: 'inappropriate_name', label: 'Inappropriate name' },
    { id: 'hate_speech',        label: 'Hate speech / slurs' },
    { id: 'harassment',         label: 'Harassment' },
    { id: 'spam',               label: 'Spam' },
    { id: 'cheating',           label: 'Cheating' },
    { id: 'other',              label: 'Other' },
  ]
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  const ctxLabel = messageText ? 'Reported message (add more context below if needed):' : 'Additional context (optional):'
  const ctxPre   = messageText || ''
  overlay.innerHTML = `
    <div class="modal" style="max-width:320px;">
      <div style="font-family:var(--display);font-size:13px;letter-spacing:2px;margin-bottom:10px;">REPORT <span style="color:var(--red);">${esc(targetName)}</span></div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:8px;">Select a reason:</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
        ${REASONS.map(r => `<label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;"><input type="radio" name="report-reason" value="${r.id}" style="accent-color:var(--red);"> ${esc(r.label)}</label>`).join('')}
      </div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px;">${esc(ctxLabel)}</div>
      <textarea id="report-ctx" maxlength="300" style="width:100%;box-sizing:border-box;height:72px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px;font-size:10px;resize:vertical;font-family:inherit;" placeholder="Add any extra details..."></textarea>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="btn" id="report-cancel-btn" style="flex:1;font-size:10px;">CANCEL</button>
        <button class="btn" id="report-submit-btn" style="flex:1;font-size:10px;color:var(--red);border-color:var(--red);">SUBMIT</button>
      </div>
      <div id="report-err" style="font-size:10px;color:var(--red);margin-top:6px;display:none;"></div>
    </div>
  `
  document.body.appendChild(overlay)
  overlay.querySelector('#report-cancel-btn').onclick = () => overlay.remove()
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  overlay.querySelector('#report-submit-btn').onclick = () => {
    const reasonEl = overlay.querySelector('input[name="report-reason"]:checked')
    const errEl    = overlay.querySelector('#report-err')
    if (!reasonEl) { errEl.textContent = 'Pick a reason.'; errEl.style.display = ''; return }
    const extra = overlay.querySelector('#report-ctx').value.trim()
    send({ type: 'report', target_id: targetId, reason: reasonEl.value, context: extra.slice(0, 300), message_text: ctxPre || '' })
    overlay.remove()
  }
}

// ── Achievements ─────────────────────────────────────────────────────────────
function renderAchievements () {
  const listEl = $('ach-list')
  if (!listEl) return
  const ACHIEVEMENT_INFO = [
    { id: 'phantom',     name: 'PHANTOM',     desc: 'Complete 10 successful hacks',        bonus: '+1% steal bonus' },
    { id: 'vault',       name: 'VAULT',        desc: 'Never been hacked (need $1M earned)', bonus: 'Title only' },
    { id: 'high_roller', name: 'HIGH ROLLER',  desc: 'Wager $1B+ at the casino',            bonus: 'Title only' },
    { id: 'kingpin',     name: 'KINGPIN',      desc: 'Reach prestige 5',                    bonus: 'Title only' },
    { id: 'ghost',       name: 'GHOST',        desc: 'Survive 10+ incoming hacks',          bonus: '+1% auto-block' },
  ]
  const earned = new Set(player.achievements || [])
  listEl.innerHTML = ACHIEVEMENT_INFO.map(a => {
    const has = earned.has(a.id)
    const col = has ? 'var(--green)' : 'var(--muted)'
    const icon = has ? '✓' : '○'
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid ${has ? 'rgba(0,255,110,.2)' : 'var(--border)'};background:${has ? 'rgba(0,255,110,.04)' : 'transparent'};">
      <span style="color:${col};font-size:12px;min-width:14px;">${icon}</span>
      <div style="flex:1;">
        <div style="font-size:10px;letter-spacing:2px;color:${col};">${esc(a.name)}</div>
        <div style="font-size:9px;color:var(--muted);margin-top:1px;">${esc(a.desc)}</div>
      </div>
      <div style="font-size:9px;color:${has ? 'var(--amber)' : 'rgba(255,255,255,.2)'};">${esc(a.bonus)}</div>
    </div>`
  }).join('')
}

// ── Badge picker ──────────────────────────────────────────────────────────────
function renderBadgePicker () {
  const badges = Array.isArray(player.badges) ? player.badges : []
  if (!el.badgePickerRow || !el.badgePickerList) return
  el.badgePickerRow.style.display = badges.length ? '' : 'none'
  if (!badges.length) return
  el.badgePickerList.innerHTML = ''
  badges.forEach(badgeName => {
    const isActive = badgeName === player.badge
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;'
    row.innerHTML = `
      ${badgeTag(badgeName, 'font-size:10px;')}
      <button class="btn ${isActive ? 'btn-green' : 'btn-amber'}" style="font-size:9px;padding:2px 8px;" data-badge="${esc(badgeName)}">
        ${isActive ? 'ACTIVE' : 'SET'}
      </button>
    `
    if (!isActive) {
      row.querySelector('button').addEventListener('click', () => {
        if (!isConnected) { log('Connect to a server first', 'warn'); return }
        send({ type: 'action', action: 'set_active_badge', badge: badgeName })
      })
    }
    el.badgePickerList.appendChild(row)
  })
}

// ── Log ───────────────────────────────────────────────────────────────────────
function log (text, cls = '') {
  const ts    = new Date().toTimeString().slice(0, 8)
  const entry = document.createElement('div')
  entry.className = `log-entry ${cls}`
  entry.innerHTML = `<span class="ts">[${ts}]</span>${esc(text)}`
  el.logList.appendChild(entry)
  while (el.logList.children.length > 80) el.logList.removeChild(el.logList.firstChild)
  el.logPanel.scrollTop = el.logPanel.scrollHeight
}

// ── New-player tutorial ───────────────────────────────────────────────────────
const _TUTORIAL_STEPS = [
  {
    title: 'EARN MONEY',
    body:  'Click the <b style="color:var(--green);">[ EXECUTE ]</b> button in the main panel to earn money manually. Every click adds to your balance. This is how you fund your first upgrades.',
    hint:  'Tip: the clicker is your starting engine.',
  },
  {
    title: 'BUY UPGRADES',
    body:  'Open the <b style="color:var(--green);">UPGRADES</b> tab. Buy <b>Click</b> upgrades to earn more per click, and <b>Auto</b> upgrades to generate income passively — even when you\'re away.',
    hint:  'Upgrades unlock in sequence — each one reveals the next.',
  },
  {
    title: 'AUTO INCOME',
    body:  'Once you have Auto upgrades running, your balance grows on its own. You\'ll also earn <b>offline income</b> — up to 24 hours of auto income accumulates while you\'re logged out.',
    hint:  'Tip: check back daily to collect offline earnings.',
  },
  {
    title: 'PRESTIGE',
    body:  'When your balance reaches the <b style="color:var(--amber);">PRESTIGE</b> threshold, you can reset your money and upgrades in exchange for a <b>permanent income multiplier</b>. Each prestige makes you stronger.',
    hint:  'Prestige points scale with how far over the threshold you are.',
  },
  {
    title: 'HACK &amp; DEFEND',
    body:  'Unlock the <b style="color:var(--red);">HACK MODULE</b> in the Upgrades tab. You can then target other players and steal a cut of their balance. They can defend with mini-games — so can you when you\'re attacked.',
    hint:  'Encryption Shield protects you for 2 hours when you\'re vulnerable.',
  },
  {
    title: 'WHAT ELSE?',
    body:  '<b style="color:var(--green);">MARKET</b> — trade 5 live assets whose prices shift with player activity.<br><br><b style="color:var(--amber);">CASINO</b> — Blackjack, Roulette, and Crash with real wagers.<br><br><b style="color:var(--blue);">LEADERBOARD</b> — compete for the top spot on the global board.',
    hint:  'Good luck. Numbers go up.',
  },
]

let _tutorialStep = 0

function startTutorial () {
  _tutorialStep = 0
  _renderTutorialStep()
  showOverlay(el.tutorialOverlay)
}

function _renderTutorialStep () {
  const step  = _TUTORIAL_STEPS[_tutorialStep]
  const total = _TUTORIAL_STEPS.length
  document.getElementById('tutorial-step-label').textContent = `STEP ${_tutorialStep + 1} / ${total}`
  document.getElementById('tutorial-title').innerHTML        = step.title
  document.getElementById('tutorial-body').innerHTML         = step.body
  document.getElementById('tutorial-hint').textContent       = step.hint
  const btn = document.getElementById('tutorial-next-btn')
  btn.textContent = _tutorialStep === total - 1 ? 'LETS GO ▶' : 'NEXT →'
}

function _tutorialNext () {
  _tutorialStep++
  if (_tutorialStep >= _TUTORIAL_STEPS.length) {
    hideOverlay(el.tutorialOverlay)
  } else {
    _renderTutorialStep()
  }
}

// ── Overlay helpers ───────────────────────────────────────────────────────────
function showOverlay (o) { o.classList.remove('hidden') }
function hideOverlay (o) { o.classList.add('hidden') }

// ── Announcement banner ───────────────────────────────────────────────────────
let _announceTimer = null
function showAnnouncement (msg) {
  const banner = document.getElementById('announce-banner')
  const text   = document.getElementById('announce-text')
  if (!banner || !text) return
  text.textContent = '📢  ' + msg
  banner.style.display = 'block'
  if (_announceTimer) clearTimeout(_announceTimer)
  _announceTimer = setTimeout(() => { banner.style.display = 'none' }, 12000)
}
document.getElementById('announce-close')?.addEventListener('click', () => {
  const banner = document.getElementById('announce-banner')
  if (banner) banner.style.display = 'none'
  if (_announceTimer) { clearTimeout(_announceTimer); _announceTimer = null }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
const FMT_SUFFIXES = [
  '','K','M','B','T',
  'Qa','Qi','Sx','Sp','Oc','No',          // 1e15–1e33
  'Dc','UnDc','DuDc','TrDc','QdDc','QnDc','SdDc','StDc','OdDc','NdDc', // 1e33–1e63
  'Vi','UnVi','DuVi','TrVi','QdVi','QnVi','SdVi','StVi','OdVi','NdVi', // 1e63–1e93
  'Tg','UnTg','DuTg','TrTg','QdTg','QnTg','SdTg','StTg','OdTg','NdTg', // 1e93–1e123
  'Qag','UnQag','DuQag','TrQag','QdQag','QnQag','SdQag','StQag','OdQag','NdQag', // 1e123–1e153
  'Qig','UnQig','DuQig','TrQig','QdQig','QnQig','SdQig','StQig','OdQig','NdQig', // 1e153–1e183
  'Sxg','UnSxg','DuSxg','TrSxg','QdSxg','QnSxg','SdSxg','StSxg','OdSxg','NdSxg', // 1e183–1e213
  'Spg','UnSpg','DuSpg','TrSpg','QdSpg','QnSpg','SdSpg','StSpg','OdSpg','NdSpg', // 1e213–1e243
  'Ocg','UnOcg','DuOcg','TrOcg','QdOcg','QnOcg','SdOcg','StOcg','OdOcg','NdOcg', // 1e243–1e273
  'Nog','UnNog','DuNog','TrNog','QdNog','QnNog','SdNog','StNog','OdNog','NdNog', // 1e273–1e303
  'Ce', // 1e303 centillion — JS Number.MAX_VALUE ~1.8e308, so this is the last safe tier
]
let numFmtStyle = localStorage.getItem('numFmt') || 'letter'

function fmt (n) {
  if (n == null) return '0'
  n = Math.floor(n)
  if (numFmtStyle === 'scientific') {
    if (n === 0) return '0'
    return n.toExponential(2).replace('e+','e')
  }
  if (numFmtStyle === 'full') return n.toLocaleString()
  // letter mode
  if (n < 1000) return String(n)
  for (let i = FMT_SUFFIXES.length - 1; i >= 1; i--) {
    const threshold = Math.pow(1000, i)
    if (n >= threshold) return (n / threshold).toFixed(2) + FMT_SUFFIXES[i]
  }
  return String(n)
}

function esc (s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function appendChatMsg (m) {
  const BADGE_LABELS = { alpha: 'α', investor: '💰', supporter: '★', patron: '♦', loyal: '⬡', veteran: '✦', legend: '❋' }
  const badgePart = m.badge ? ` <span style="font-size:9px;color:var(--amber)">${esc(BADGE_LABELS[m.badge] || m.badge.toUpperCase())}</span>` : ''
  const isOwnMsg = m.pid && m.pid === PLAYER_ID
  const reportBtn = !isOwnMsg && m.pid
    ? `<button class="chat-report-btn" title="Report message" style="flex-shrink:0;background:none;border:none;cursor:pointer;color:var(--muted);font-size:9px;padding:0 2px;line-height:1;" data-pid="${esc(m.pid)}" data-name="${esc(m.name || 'Anon')}" data-text="${esc(m.text)}">⚑</button>`
    : ''
  const makeRow = (small) => {
    const div = document.createElement('div')
    div.style.cssText = `font-size:${small ? '10' : '11'}px;line-height:1.5;word-break:break-word;display:flex;align-items:baseline;gap:4px;`
    div.innerHTML = `<span style="flex:1;min-width:0;"><span style="color:var(--green-dim)">${esc(m.name || 'Anon')}</span>${badgePart}<span style="color:var(--muted)">: </span>${esc(m.text)}</span>${reportBtn}`
    if (!isOwnMsg && m.pid) {
      const btn = div.querySelector('.chat-report-btn')
      if (btn) btn.addEventListener('click', () => showReportModal(btn.dataset.pid, btn.dataset.name, btn.dataset.text))
    }
    return div
  }
  if (el.chatLog) {
    el.chatLog.appendChild(makeRow(false))
    el.chatLog.scrollTop = el.chatLog.scrollHeight
  }
  if (el.alwaysChatLog) {
    el.alwaysChatLog.appendChild(makeRow(true))
    el.alwaysChatLog.scrollTop = el.alwaysChatLog.scrollHeight
  }
}

function setConnStatus (state, label) {
  el.connDot.className = `conn-dot ${state==='online'?'online':state==='connecting'?'connecting':''}`
  el.connLabel.textContent = label
  el.footerDot.className   = `conn-dot ${state==='online'?'online':''}`
  el.footerStatus.textContent = state === 'online' ? 'ONLINE' : label
}

// ── Blackjack ─────────────────────────────────────────────────────────────────
function bjDeal () {
  if (!isConnected) { log('Connect to a server first', 'warn'); return }
  const bet = parseShortNum(el.bjBetInput?.value || '0')
  if (!bet || bet <= 0) { log('Enter a valid bet', 'warn'); return }
  if (bet * 1.05 > player.money) { log('Not enough money (bet + 5% house fee)', 'warn'); return }
  if (bjCurrentMaxBet > 0 && bet > bjCurrentMaxBet) { log(`Max bet at this table is $${fmt(bjCurrentMaxBet)}`, 'warn'); return }
  send({ type: 'action', action: 'bj_deal', bet })
}

function bjReset () {
  if (el.bjIdle)    el.bjIdle.style.display    = ''
  if (el.bjPlaying) el.bjPlaying.style.display = 'none'
  if (el.bjResult)  el.bjResult.style.display  = 'none'
}

function renderBjPlaying (msg) {
  if (el.bjIdle)    el.bjIdle.style.display    = 'none'
  if (el.bjPlaying) el.bjPlaying.style.display = ''
  if (el.bjResult)  el.bjResult.style.display  = 'none'
  if (el.bjDealerCards) el.bjDealerCards.textContent = msg.dealer_hand.join(' ')
  if (el.bjDealerVal)   el.bjDealerVal.textContent   = msg.dealer_val
  if (el.bjPlayerCards) el.bjPlayerCards.textContent = msg.player_hand.join(' ')
  if (el.bjPlayerVal)   el.bjPlayerVal.textContent   = msg.player_val
  if (el.bjBetDisplay)  el.bjBetDisplay.textContent  = fmt(msg.bet)
}

function renderBjResult (msg) {
  if (el.bjIdle)    el.bjIdle.style.display    = 'none'
  if (el.bjPlaying) el.bjPlaying.style.display = 'none'
  if (el.bjResult)  el.bjResult.style.display  = ''
  const labels = { blackjack: 'BLACKJACK! 🎉', win: 'YOU WIN!', push: 'PUSH', bust: 'BUST', lose: 'DEALER WINS' }
  const colors = { blackjack: 'var(--amber)', win: 'var(--green)', push: 'var(--muted)', bust: 'var(--red)', lose: 'var(--red)' }
  if (el.bjResultLabel) {
    el.bjResultLabel.textContent = labels[msg.result] || msg.result.toUpperCase()
    el.bjResultLabel.style.color = colors[msg.result] || 'var(--text)'
  }
  const dealerStr = msg.dealer_hand.join(' ') + ` (${msg.dealer_val})`
  const playerStr = msg.player_hand.join(' ') + ` (${msg.player_val})`
  if (el.bjResultDetail) el.bjResultDetail.innerHTML =
    `You: ${playerStr}<br>Dealer: ${dealerStr}<br>` +
    (msg.winnings > 0 ? `Won: <span style="color:var(--green)">$${fmt(msg.winnings)}</span>` : 'Lost your bet')
  log(`Blackjack: ${labels[msg.result] || msg.result} ${msg.winnings > 0 ? '+$'+fmt(msg.winnings) : ''}`, msg.result==='win'||msg.result==='blackjack'?'ok':msg.result==='push'?'':'err')
}

// ── Roulette ──────────────────────────────────────────────────────────────────
function renderRouletteResult (msg) {
  if (el.rlIdle)   el.rlIdle.style.display   = 'none'
  if (el.rlResult) el.rlResult.style.display = ''
  const colorMap = { red: '#ff6060', black: 'var(--text)', green: 'var(--green)' }
  if (el.rlNumber) {
    el.rlNumber.textContent  = msg.number
    el.rlNumber.style.color  = colorMap[msg.color] || 'var(--text)'
  }
  const label = msg.won ? 'YOU WIN!' : 'NO LUCK'
  if (el.rlResultLabel) {
    el.rlResultLabel.textContent = label
    el.rlResultLabel.style.color = msg.won ? 'var(--green)' : 'var(--red)'
  }
  const detail = msg.won
    ? `Won: <span style="color:var(--green)">$${fmt(msg.winnings)}</span>`
    : `Lost: <span style="color:var(--red)">$${fmt(msg.bet)}</span>`
  if (el.rlResultDetail) el.rlResultDetail.innerHTML = detail
  log(`Roulette: ${msg.number} (${msg.color}) — ${msg.won ? '+$' + fmt(msg.winnings) : '-$' + fmt(msg.bet)}`, msg.won ? 'ok' : 'err')
}

// ── Play time format ──────────────────────────────────────────────────────────
function fmtPlaytime (s) {
  s = Math.floor(s || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ── Poker ─────────────────────────────────────────────────────────────────────

// Parse a money string like "1k", "500", "5m" into a number
function parseMoneyInput (s) {
  s = String(s).trim().toLowerCase().replace(/,/g, '').replace(/\$/g, '')
  const m = s.match(/^(\d+\.?\d*)(k|m|b|t)?$/)
  if (!m) return NaN
  const n = parseFloat(m[1])
  const suffixes = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }
  return m[2] ? n * (suffixes[m[2]] || 1) : n
}

// Append a line to the poker action log panel
function pokerLog (text, cls = '') {
  const container = $('poker-action-log')
  if (!container) return
  const div = document.createElement('div')
  div.className = `poker-log-entry${cls ? ' ' + cls : ''}`
  div.textContent = text
  container.appendChild(div)
  while (container.children.length > 60) container.removeChild(container.firstChild)
  container.scrollTop = container.scrollHeight
}

// Build a card element from a card object {rank, suit, code} or null (face-down)
function makeCardEl (card) {
  const div = document.createElement('div')
  div.className = 'poker-card'
  if (!card) {
    div.classList.add('face-down')
    div.textContent = '?'
    return div
  }
  const suit = card.suit || ''
  const rank = card.rank || ''
  const isRed = suit === '♥' || suit === '♦'
  if (isRed) div.classList.add('red')
  const rSpan = document.createElement('span')
  rSpan.className = 'poker-card-rank'
  rSpan.textContent = rank
  const sSpan = document.createElement('span')
  sSpan.className = 'poker-card-suit'
  sSpan.textContent = suit
  div.appendChild(rSpan)
  div.appendChild(sSpan)
  return div
}

// Render the lobby view (room list + create form)
function renderPokerLobby () {
  const lobbyEl = $('poker-lobby')
  const tableEl = $('poker-table')
  if (lobbyEl) lobbyEl.style.display = ''
  if (tableEl) tableEl.style.display = 'none'

  const list = $('poker-room-list')
  if (!list) return

  if (!pokerRooms.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:16px 0;">No open rooms. Create one!</div>'
    return
  }

  list.innerHTML = pokerRooms.map(room => {
    const seats  = `${room.player_count || 0}/${room.max_players || 9}`
    const blinds = `$${fmt(room.small_blind || 0)}/$${fmt(room.big_blind || 0)}`
    const buyIn  = `$${fmt(room.min_buy_in || 0)}–$${fmt(room.max_buy_in || 0)}`
    const status = room.status === 'playing' ? '<span style="color:var(--amber);">IN GAME</span>' : '<span style="color:var(--green);">WAITING</span>'
    return `
      <div class="poker-room-row">
        <span class="poker-room-name">${esc(room.name || 'Unnamed')}</span>
        <span class="poker-room-meta">${blinds} &nbsp;${seats} &nbsp;${status}</span>
        <button class="btn btn-green poker-join-btn" style="font-size:9px;padding:2px 8px;flex-shrink:0;"
          data-room-id="${esc(room.id)}"
          data-min-bi="${room.min_buy_in || 0}"
          data-max-bi="${room.max_buy_in || 0}"
          ${room.status === 'playing' ? 'disabled' : ''}>JOIN</button>
      </div>`
  }).join('')

  list.querySelectorAll('.poker-join-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.roomId
      const minBi  = Number(btn.dataset.minBi)
      const maxBi  = Number(btn.dataset.maxBi)
      const raw    = prompt(`Buy-in amount ($${fmt(minBi)} – $${fmt(maxBi)}):`)
      if (raw === null) return
      const amount = parseMoneyInput(raw)
      if (isNaN(amount) || amount < minBi || amount > maxBi) {
        log(`Invalid buy-in (min $${fmt(minBi)}, max $${fmt(maxBi)})`, 'warn')
        return
      }
      send({ type: 'poker_join_room', room_id: roomId, buy_in: amount })
    })
  })
}

// Render the full poker table view
function renderPokerTable () {
  const lobbyEl = $('poker-lobby')
  const tableEl = $('poker-table')
  if (lobbyEl) lobbyEl.style.display = 'none'
  if (tableEl) tableEl.style.display = ''

  const room = pokerRoomState
  if (!room) return

  // Room title
  const titleEl = $('poker-room-title')
  if (titleEl) titleEl.textContent = `// ${esc(room.name || 'poker table')}`

  // Phase + pot + current bet
  const phaseEl = $('poker-phase')
  const potEl   = $('poker-pot')
  const betEl   = $('poker-current-bet')
  if (phaseEl) phaseEl.textContent = (room.phase || 'waiting').toUpperCase()
  if (potEl)   potEl.textContent   = '$' + fmt(room.pot || 0)
  if (betEl)   betEl.textContent   = '$' + fmt(room.current_bet || 0)

  // Community cards
  const commEl = $('poker-community-cards')
  if (commEl) {
    commEl.innerHTML = ''
    const comm = room.community_cards || []
    for (let i = 0; i < 5; i++) {
      commEl.appendChild(makeCardEl(comm[i] || null))
    }
  }

  // My hole cards
  const holeEl = $('poker-hole-cards')
  if (holeEl) {
    holeEl.innerHTML = ''
    if (pokerHoleCards.length) {
      pokerHoleCards.forEach(c => holeEl.appendChild(makeCardEl(c)))
    } else {
      holeEl.appendChild(makeCardEl(null))
      holeEl.appendChild(makeCardEl(null))
    }
  }

  // My stack
  const myPlayer  = (room.players || []).find(p => p.id === pokerMyId)
  const myStackEl = $('poker-my-stack')
  if (myStackEl) myStackEl.textContent = '$' + fmt(myPlayer?.stack || 0)

  // Other players
  const playersEl = $('poker-players-list')
  if (playersEl) {
    playersEl.innerHTML = ''
    const players = room.players || []
    players.forEach((p, idx) => {
      const isMe      = p.id === pokerMyId
      const isActive  = room.current_player === p.id
      const isFolded  = p.status === 'folded' || p.status === 'out'
      const isDealer  = room.dealer_index === idx
      const isSB      = room.sb_index     === idx
      const isBB      = room.bb_index     === idx

      const slot = document.createElement('div')
      slot.className = 'poker-player-slot' +
        (isActive ? ' active-turn' : '') +
        (isFolded  ? ' folded'      : '') +
        (isMe      ? ' is-me'       : '')

      let markers = ''
      if (isDealer) markers += '<span class="poker-marker dealer">D</span>'
      if (isSB)     markers += '<span class="poker-marker sb">SB</span>'
      if (isBB)     markers += '<span class="poker-marker bb">BB</span>'

      const lastAction = p.last_action ? `<span class="poker-player-action">[${esc(p.last_action)}]</span>` : ''
      const nameText   = esc(p.name || p.id?.slice(0, 8) || '?') + (isMe ? ' (you)' : '')

      slot.innerHTML = `
        <span class="poker-player-name">${nameText}${markers}</span>
        <span class="poker-player-stack">$${fmt(p.stack || 0)}</span>
        ${lastAction}`

      // Show face-down cards for other players who haven't folded, if in a hand
      if (!isMe && !isFolded && room.phase && room.phase !== 'waiting') {
        const cardRow = document.createElement('div')
        cardRow.style.cssText = 'display:flex;gap:2px;margin-left:4px;'
        cardRow.appendChild(makeCardEl(null))
        cardRow.appendChild(makeCardEl(null))
        slot.insertBefore(cardRow, slot.firstChild)
      }

      playersEl.appendChild(slot)
    })
  }

  // Action buttons (only shown when it's my turn and game is playing)
  const actionsEl  = $('poker-actions')
  const isMyTurn   = room.current_player === pokerMyId && room.phase && room.phase !== 'waiting'
  if (actionsEl) actionsEl.style.display = isMyTurn ? '' : 'none'

  // Call button label
  const callBtn = $('poker-call-btn')
  if (callBtn && room.current_bet > 0) {
    const myBet  = myPlayer?.current_bet || 0
    const toCall = Math.max(0, (room.current_bet || 0) - myBet)
    callBtn.textContent = toCall > 0 ? `CALL $${fmt(toCall)}` : 'CALL'
  } else if (callBtn) {
    callBtn.textContent = 'CALL'
  }

  // Check button — disabled if there's a bet to call
  const checkBtn = $('poker-check-btn')
  if (checkBtn) {
    const myBet  = myPlayer?.current_bet || 0
    const toCall = Math.max(0, (room.current_bet || 0) - myBet)
    checkBtn.disabled = toCall > 0
    checkBtn.style.opacity = toCall > 0 ? '0.35' : ''
  }

  // Start button (host only, waiting phase)
  const startRow = $('poker-start-row')
  if (startRow) {
    const isHost    = room.host === pokerMyId
    const isWaiting = !room.phase || room.phase === 'waiting'
    const hasPlayers = (room.players || []).length >= 2
    startRow.style.display = (isHost && isWaiting) ? '' : 'none'
    const startBtn = $('poker-start-btn')
    if (startBtn) startBtn.disabled = !hasPlayers
  }

  // Leave button (between hands / waiting)
  const leaveBtn = $('poker-leave-btn')
  if (leaveBtn) {
    const canLeave = !room.phase || room.phase === 'waiting' || room.phase === 'showdown'
    leaveBtn.style.display = canLeave ? '' : 'none'
  }
}

// Wire up all poker button event listeners (called once from init)
function initPokerUI () {
  // Refresh lobby
  $('poker-refresh-btn')?.addEventListener('click', () => {
    send({ type: 'poker_list_rooms' })
  })

  // Toggle create form
  $('poker-create-toggle-btn')?.addEventListener('click', () => {
    const form = $('poker-create-form')
    if (!form) return
    form.classList.toggle('visible')
  })

  // Cancel create
  $('poker-create-cancel-btn')?.addEventListener('click', () => {
    const form = $('poker-create-form')
    if (form) form.classList.remove('visible')
  })

  // Submit create room
  $('poker-create-submit-btn')?.addEventListener('click', () => {
    const name   = ($('poker-create-name')?.value   || '').trim()
    const sbRaw  =  $('poker-create-sb')?.value    || ''
    const bbRaw  =  $('poker-create-bb')?.value    || ''
    const minRaw =  $('poker-create-minbi')?.value || ''
    const maxRaw =  $('poker-create-maxbi')?.value || ''

    if (!name)                           { log('Room name required', 'warn'); return }
    const sb  = parseMoneyInput(sbRaw)
    const bb  = parseMoneyInput(bbRaw)
    const min = parseMoneyInput(minRaw)
    const max = parseMoneyInput(maxRaw)

    if (isNaN(sb) || sb <= 0)           { log('Invalid small blind', 'warn'); return }
    if (isNaN(bb) || bb <= sb)          { log('Big blind must be > small blind', 'warn'); return }
    if (isNaN(min) || min <= 0)         { log('Invalid min buy-in', 'warn'); return }
    if (isNaN(max) || max < min)        { log('Max buy-in must be >= min', 'warn'); return }

    send({ type: 'poker_create_room', name, small_blind: sb, big_blind: bb,
           min_buy_in: min, max_buy_in: max })

    const form = $('poker-create-form')
    if (form) form.classList.remove('visible')
    // Clear fields
    ;['poker-create-name','poker-create-sb','poker-create-bb',
      'poker-create-minbi','poker-create-maxbi'].forEach(id => {
      const inp = $(id); if (inp) inp.value = ''
    })
  })

  // Leave table
  $('poker-leave-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    send({ type: 'poker_leave_room', room_id: pokerRoomState.id })
    pokerRoomState = null
    pokerHoleCards = []
    renderPokerLobby()
    send({ type: 'poker_list_rooms' })
  })

  // Start game
  $('poker-start-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    send({ type: 'poker_start_game', room_id: pokerRoomState.id })
  })

  // Action: Fold
  $('poker-fold-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    send({ type: 'poker_action', room_id: pokerRoomState.id, action: 'fold' })
  })

  // Action: Check
  $('poker-check-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    send({ type: 'poker_action', room_id: pokerRoomState.id, action: 'check' })
  })

  // Action: Call
  $('poker-call-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    send({ type: 'poker_action', room_id: pokerRoomState.id, action: 'call' })
  })

  // Action: Raise — toggle input row visibility
  $('poker-raise-btn')?.addEventListener('click', () => {
    const row = $('poker-raise-row')
    if (!row) return
    const hidden = row.style.display === 'none' || row.style.display === ''
    row.style.cssText = hidden
      ? 'display:flex;gap:6px;align-items:center;margin-top:4px;'
      : 'display:none;'
    if (hidden) $('poker-raise-input')?.focus()
  })

  // Action: Submit raise
  $('poker-raise-submit-btn')?.addEventListener('click', () => {
    if (!pokerRoomState) return
    const raw = $('poker-raise-input')?.value || ''
    const amount = parseMoneyInput(raw)
    if (isNaN(amount) || amount <= 0) { log('Invalid raise amount', 'warn'); return }
    send({ type: 'poker_action', room_id: pokerRoomState.id, action: 'raise', amount })
    const row = $('poker-raise-row')
    if (row) row.style.display = 'none'
    const inp = $('poker-raise-input')
    if (inp) inp.value = ''
  })

  // Allow enter key on raise input
  $('poker-raise-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('poker-raise-submit-btn')?.click()
  })
}

// ── Casino state ──────────────────────────────────────────────────────────────
let bjCurrentMaxBet = 0
let rlCurrentType   = 'red'

// ── Crash game ────────────────────────────────────────────────────────────────
let _crashMinBet   = 0
let _crashMult     = 1.0
let _crashTick     = null
let _crashBet      = 0
let _crashActive   = false

function _crashSection (id) {
  ['crash-table-select','crash-idle','crash-playing','crash-result'].forEach(s => {
    const el = $(s); if (el) el.style.display = s === id ? '' : 'none'
  })
}

// ── House-economy UI render functions ─────────────────────────────────────────

const BLACK_MARKET_DEFS = {
  prod_2x_1h:       { name: '2× Production',  desc: 'Doubles income for 1 hour',        cost_pct: 0.001, duration: 3600 },
  prod_3x_30m:      { name: '3× Production',  desc: 'Triples income for 30 min',        cost_pct: 0.003, duration: 1800 },
  hack_immunity_2h: { name: 'Hack Shield',     desc: 'Immune to hacks for 2 hours',     cost_pct: 0.002, duration: 7200 },
  click_2x_30m:     { name: '2× Clicks',       desc: 'Doubles click value for 30 min',  cost_pct: 0.001, duration: 1800 },
}

function renderBlackMarket () {
  const container = $('blackmarket-items')
  if (!container) return
  container.innerHTML = ''
  for (const [id, item] of Object.entries(BLACK_MARKET_DEFS)) {
    const cost = Math.max(1000, Math.floor((player.money || 0) * item.cost_pct))
    const expiry = (player.active_boosts || {})[id] || 0
    const isActive = expiry > Date.now() / 1000
    const secsLeft = isActive ? Math.max(0, Math.round(expiry - Date.now() / 1000)) : 0
    const div = document.createElement('div')
    div.style.cssText = 'border:1px solid var(--border);border-radius:4px;padding:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;'
    div.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:var(--amber);">${esc(item.name)}</div>
        <div style="font-size:9px;color:var(--muted);">${esc(item.desc)}</div>
        <div style="font-size:9px;color:var(--muted);">Cost: 0.${Math.round(item.cost_pct * 1000)}% of balance (~$${fmt(cost)})</div>
        ${isActive ? `<div style="font-size:9px;color:var(--green);" id="bm-timer-${id}">ACTIVE — ${fmtDuration(secsLeft * 1000)} remaining</div>` : ''}
      </div>
      <button class="btn ${isActive ? '' : 'btn-amber'}" style="font-size:10px;white-space:nowrap;" data-item="${id}" ${isActive ? 'disabled' : ''}>${isActive ? 'ACTIVE' : 'BUY'}</button>
    `
    const btn = div.querySelector('button[data-item]')
    if (btn && !isActive) {
      btn.addEventListener('click', () => {
        if (!isConnected) { log('Not connected', 'warn'); return }
        if ((player.money || 0) < cost) { log(`Need $${fmt(cost)} for ${item.name}`, 'warn'); return }
        send({ type: 'action', action: 'blackmarket_buy', item_id: id })
      })
    }
    container.appendChild(div)
  }
}

function renderBoostTimers () {
  const now = Date.now() / 1000
  const boosts = player.active_boosts || {}
  for (const id of Object.keys(BLACK_MARKET_DEFS)) {
    const el2 = $(`bm-timer-${id}`)
    if (!el2) continue
    const expiry = boosts[id] || 0
    if (expiry > now) {
      el2.textContent = `ACTIVE — ${fmtDuration(Math.max(0, Math.round(expiry - now)) * 1000)} remaining`
    } else {
      // Boost expired — re-render the whole list
      renderBlackMarket()
      return
    }
  }
}

function renderLoanPanel (s) {
  const noLoan   = $('loan-no-loan')
  const active   = $('loan-active')
  const principal = $('loan-principal')
  const owed     = $('loan-owed')
  const due      = $('loan-due')
  const state    = s || player
  if (!noLoan || !active) return
  const hbEl = $('loan-house-balance')
  if (hbEl) hbEl.textContent = '$' + fmt(state.house_balance || 0)
  if ((state.loan_amount || 0) > 0) {
    noLoan.style.display = 'none'
    active.style.display = ''
    if (principal) principal.textContent = '$' + fmt(state.loan_amount)
    if (owed) owed.textContent = '$' + fmt(Math.round(state.loan_amount * (1 + (state.loan_rate || 0.2))))
    if (due) {
      const dueSecs = (state.loan_due_ts || 0) - Date.now() / 1000
      if (dueSecs > 0) {
        const h = Math.floor(dueSecs / 3600)
        const m = Math.floor((dueSecs % 3600) / 60)
        due.textContent = `${h}h ${m}m`
        due.style.color = dueSecs < 3600 ? 'var(--red)' : 'var(--muted)'
      } else {
        due.textContent = 'OVERDUE'
        due.style.color = 'var(--red)'
      }
    }
  } else {
    noLoan.style.display = ''
    active.style.display = 'none'
  }
}

function renderInsuranceUI (active) {
  const btn    = $('insurance-toggle-btn')
  const status = $('insurance-status')
  const isOn   = active !== undefined ? active : (player.insurance_active || false)
  if (btn) {
    btn.textContent = isOn ? 'ON' : 'OFF'
    btn.style.color = isOn ? 'var(--green)' : 'var(--muted)'
    btn.style.borderColor = isOn ? 'var(--green)' : ''
  }
  if (status) {
    status.textContent = isOn ? 'Next loss refunds 50% of bet' : 'Insurance inactive'
    status.style.color = isOn ? 'var(--green)' : 'var(--muted)'
  }
}

function renderCompsUI () {
  const wageredEl  = $('comps-wagered')
  const barEl      = $('comps-bar')
  const nextLabel  = $('comps-next-label')
  const wagered    = player.casino_comps_threshold || 0
  const TIERS = [[10000, 500], [100000, 5000], [1000000, 50000], [10000000, 500000]]
  let nextTier = TIERS.find(([t]) => wagered < t)
  if (!nextTier) nextTier = TIERS[TIERS.length - 1]
  const pct = Math.min(100, (wagered / nextTier[0]) * 100)
  if (wageredEl) wageredEl.textContent = '$' + fmt(wagered)
  if (barEl) barEl.style.width = pct.toFixed(1) + '%'
  if (nextLabel) nextLabel.textContent = `Next: $${fmt(nextTier[0])} wagered for $${fmt(nextTier[1])} comp`
}

function renderHouseEconomyUI () {
  renderInsuranceUI()
  renderLoanPanel()
  renderBlackMarket()
  renderCompsUI()
  // Jackpot
  const jpEl = $('jackpot-amount')
  if (jpEl && player.jackpot_pool !== undefined) jpEl.textContent = '$' + fmt(player.jackpot_pool)
  // Bounty
  const bnTarget = $('bounty-target-name')
  const bnAmount = $('bounty-amount')
  // bounty_target_pid is in player state but we need the name from LB
  if (bnAmount && player.bounty_amount !== undefined) bnAmount.textContent = '$' + fmt(player.bounty_amount)
}

function _crashTickStart () {
  clearInterval(_crashTick)
  _crashMult = 1.0
  _crashActive = true
  const multEl = $('crash-mult')
  _crashTick = setInterval(() => {
    _crashMult = Math.round((_crashMult * 1.01) * 10000) / 10000
    if (_crashMult >= 200) { _crashMult = 200; _crashTickStop() }
    if (multEl) {
      multEl.textContent = _crashMult.toFixed(2) + '×'
      multEl.style.color = _crashMult < 1.5 ? 'var(--green)' : _crashMult < 3 ? 'var(--amber)' : 'var(--red)'
    }
  }, 100)
}

function _crashTickStop () {
  clearInterval(_crashTick)
  _crashTick = null
  _crashActive = false
}

;(function () {
  document.querySelectorAll('.crash-table-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!isConnected) { log('Connect to a server first', 'warn'); return }
      _crashMinBet = parseFloat(btn.dataset.minbet)
      if ($('crash-table-label')) $('crash-table-label').textContent = btn.dataset.label + ' table'
      _crashSection('crash-idle')
    })
  })
  $('crash-leave-btn')?.addEventListener('click', () => _crashSection('crash-table-select'))
  $('crash-start-btn')?.addEventListener('click', () => {
    if (!isConnected) { log('Connect to a server first', 'warn'); return }
    _crashBet = parseShortNum($('crash-bet-input')?.value || '0') || 0
    if (_crashBet <= 0) { log('Enter a valid bet', 'warn'); return }
    if (_crashBet < _crashMinBet) { log(`Minimum bet is $${fmt(_crashMinBet)}`, 'warn'); return }
    if (_crashBet * 1.05 > player.money) { log('Not enough money (bet + 5% house fee)', 'warn'); return }
    send({ type: 'action', action: 'crash_start', bet: _crashBet, minbet: _crashMinBet })
  })
  $('crash-cashout-btn')?.addEventListener('click', () => {
    if (!_crashActive) return
    _crashTickStop()
    send({ type: 'action', action: 'crash_cashout', multiplier: _crashMult })
  })
  $('crash-again-btn')?.addEventListener('click', () => {
    _crashSection('crash-idle')
  })
})()

function handleCrashStarted (msg) {
  applyState(msg.state)
  if ($('crash-bet-display')) $('crash-bet-display').textContent = fmt(_crashBet)
  _crashSection('crash-playing')
  _crashTickStart()
}

function handleCrashResult (msg) {
  _crashTickStop()
  applyState(msg.state)
  const multEl   = $('crash-mult')
  const labelEl  = $('crash-result-label')
  const detailEl = $('crash-result-detail')
  if (msg.jackpot) {
    if (multEl)   { multEl.textContent = '200.00×'; multEl.style.color = 'var(--amber)' }
    if (labelEl)  { labelEl.textContent = 'JACKPOT!'; labelEl.style.color = 'var(--amber)' }
    if (detailEl) detailEl.innerHTML =
      `Survived to <b>200×</b> — maximum payout!<br>` +
      `Won: <span style="color:var(--amber)">$${fmt(msg.winnings)}</span>`
    log(`Crash: JACKPOT! +$${fmt(msg.winnings)} (200×)`, 'ok')
  } else if (msg.won) {
    if (multEl)   { multEl.textContent = msg.crash_at.toFixed(2) + '×'; multEl.style.color = 'var(--green)' }
    if (labelEl)  { labelEl.textContent = 'CASHED OUT!'; labelEl.style.color = 'var(--green)' }
    if (detailEl) detailEl.innerHTML =
      `Cashed out at <b>${msg.cashed_at.toFixed(2)}×</b> (crashed at ${msg.crash_at.toFixed(2)}×)<br>` +
      `Won: <span style="color:var(--green)">$${fmt(msg.winnings)}</span>`
    log(`Crash: +$${fmt(msg.winnings)} (cashed ${msg.cashed_at.toFixed(2)}×, crashed ${msg.crash_at.toFixed(2)}×)`, 'ok')
  } else {
    if (multEl)   { multEl.textContent = msg.crash_at.toFixed(2) + '×'; multEl.style.color = 'var(--red)' }
    if (labelEl)  { labelEl.textContent = 'CRASHED!'; labelEl.style.color = 'var(--red)' }
    if (detailEl) detailEl.innerHTML =
      `Crashed at <b>${msg.crash_at.toFixed(2)}×</b><br>` +
      `Lost: <span style="color:var(--red)">$${fmt(msg.bet)}</span>`
    log(`Crash: lost $${fmt(msg.bet)} (crashed at ${msg.crash_at.toFixed(2)}×)`, 'err')
  }
  _crashSection('crash-result')
}

// ── Defense mini-game router ──────────────────────────────────────────────────
function launchDefenseMiniGame (type, hackerName, seconds) {
  switch (type) {
    case 'rps':     startRPS(seconds);    break
    case 'math':    startMath(seconds);   break
    case 'snake':   startSnake(seconds);  break
    case 'instant': startInstant();       break
    default:        startRPS(seconds);    break
  }
}

// ── RPS mini-game ─────────────────────────────────────────────────────────────
let rpsState = null

function startRPS (seconds) {
  rpsState = { playerScore: 0, aiScore: 0, timer: seconds, interval: null }
  el.rpsPlayerScore.textContent = '0'
  el.rpsAiScore.textContent     = '0'
  el.rpsTimer.textContent       = seconds
  el.rpsResult.textContent      = ''
  showOverlay(el.rpsOverlay)
  rpsState.interval = setInterval(() => {
    rpsState.timer--
    el.rpsTimer.textContent = rpsState.timer
    if (rpsState.timer <= 0) endRPS(false)
  }, 1000)
}

function rpsPlay (choice) {
  if (!rpsState) return
  const choices = ['rock', 'paper', 'scissors']
  const ai = choices[Math.floor(Math.random() * 3)]
  let result = ''
  if (choice === ai) {
    result = `TIE — both chose ${ai}`
  } else if (
    (choice === 'rock'     && ai === 'scissors') ||
    (choice === 'paper'    && ai === 'rock')     ||
    (choice === 'scissors' && ai === 'paper')
  ) {
    rpsState.playerScore++
    el.rpsPlayerScore.textContent = rpsState.playerScore
    result = `WIN — you: ${choice} | AI: ${ai}`
  } else {
    rpsState.aiScore++
    el.rpsAiScore.textContent = rpsState.aiScore
    result = `LOSE — you: ${choice} | AI: ${ai}`
  }
  el.rpsResult.textContent = result
  if (rpsState.playerScore >= 3)      endRPS(true)
  else if (rpsState.aiScore >= 3)     endRPS(false)
}

function endRPS (won) {
  if (!rpsState) return
  clearInterval(rpsState.interval)
  hideOverlay(el.rpsOverlay)
  rpsState = null
  if (won) { send({ type: 'action', action: 'stop_hack' }); log('Defense successful! Hack blocked.', 'ok') }
  else     { log('Defense failed — hack completed.', 'err') }
}

// ── Math mini-game ─────────────────────────────────────────────────────────────
let mathState = null

function _rand (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function startMath (seconds) {
  const ops = ['+', '-', '*']
  const op = ops[Math.floor(Math.random() * ops.length)]
  let a, b, answer
  if (op === '+')      { a = _rand(10, 99); b = _rand(10, 99); answer = a + b }
  else if (op === '-') { a = _rand(20, 99); b = _rand(1, a);   answer = a - b }
  else                 { a = _rand(2,  12); b = _rand(2, 12);  answer = a * b }
  mathState = { answer, attempts: 3, timer: seconds, interval: null }
  el.mathQuestion.textContent    = `${a} ${op} ${b} = ?`
  el.mathAnswer.value            = ''
  el.mathTimer.textContent       = seconds
  el.mathAttemptsLabel.textContent = '3 attempts left.'
  showOverlay(el.mathOverlay)
  setTimeout(() => el.mathAnswer.focus(), 50)
  mathState.interval = setInterval(() => {
    mathState.timer--
    el.mathTimer.textContent = mathState.timer
    if (mathState.timer <= 0) endMath(false)
  }, 1000)
}

function mathSubmit () {
  if (!mathState) return
  const val = parseInt(el.mathAnswer.value, 10)
  if (isNaN(val)) return
  if (val === mathState.answer) {
    endMath(true)
  } else {
    mathState.attempts--
    el.mathAnswer.value = ''
    if (mathState.attempts <= 0) {
      endMath(false)
    } else {
      el.mathAttemptsLabel.textContent = `${mathState.attempts} attempt${mathState.attempts === 1 ? '' : 's'} left.`
    }
  }
}

function endMath (won) {
  if (!mathState) return
  clearInterval(mathState.interval)
  hideOverlay(el.mathOverlay)
  mathState = null
  if (won) { send({ type: 'action', action: 'stop_hack' }); log('Defense successful! Hack blocked.', 'ok') }
  else     { log('Defense failed — hack completed.', 'err') }
}

// ── Snake mini-game ───────────────────────────────────────────────────────────
let snakeState = null
const SNAKE_CELL = 20
const SNAKE_COLS = 15
const SNAKE_ROWS = 15
const SNAKE_GOAL = 5

function startSnake (seconds) {
  const canvas = document.getElementById('snake-canvas')
  if (!canvas) return
  snakeState = {
    canvas, ctx: canvas.getContext('2d'),
    snake: [{x: 7, y: 7}], dir: {x: 1, y: 0}, nextDir: {x: 1, y: 0},
    food: null, score: 0, timer: seconds,
    stepInt: null, timerInt: null,
  }
  snakeSpawnFood()
  el.snakeScore.textContent = '0'
  el.snakeTimer.textContent = seconds
  showOverlay(el.snakeOverlay)
  if (IS_MOBILE) { const d = document.getElementById('snake-dpad'); if (d) d.style.display = 'block' }
  document.addEventListener('keydown', snakeKeyHandler)
  snakeState.stepInt  = setInterval(snakeStep, 150)
  snakeState.timerInt = setInterval(() => {
    snakeState.timer--
    el.snakeTimer.textContent = snakeState.timer
    if (snakeState.timer <= 0) endSnake(false)
  }, 1000)
  snakeDraw()
}

function snakeKeyHandler (e) {
  if (!snakeState) return
  const map = {
    ArrowUp:    {x:0,y:-1}, ArrowDown: {x:0,y:1}, ArrowLeft: {x:-1,y:0}, ArrowRight: {x:1,y:0},
    w:{x:0,y:-1}, s:{x:0,y:1}, a:{x:-1,y:0}, d:{x:1,y:0},
    W:{x:0,y:-1}, S:{x:0,y:1}, A:{x:-1,y:0}, D:{x:1,y:0},
  }
  const d = map[e.key]
  if (!d) return
  if (d.x !== -snakeState.dir.x || d.y !== -snakeState.dir.y) snakeState.nextDir = d
  e.preventDefault()
}

function snakeSpawnFood () {
  if (!snakeState) return
  let pos
  do {
    pos = { x: _rand(0, SNAKE_COLS - 1), y: _rand(0, SNAKE_ROWS - 1) }
  } while (snakeState.snake.some(s => s.x === pos.x && s.y === pos.y))
  snakeState.food = pos
}

function snakeStep () {
  if (!snakeState) return
  snakeState.dir = snakeState.nextDir
  const head = { x: snakeState.snake[0].x + snakeState.dir.x, y: snakeState.snake[0].y + snakeState.dir.y }
  if (head.x < 0 || head.x >= SNAKE_COLS || head.y < 0 || head.y >= SNAKE_ROWS) { snakeDraw(); endSnake(false); return }
  if (snakeState.snake.some(s => s.x === head.x && s.y === head.y))              { snakeDraw(); endSnake(false); return }
  snakeState.snake.unshift(head)
  if (head.x === snakeState.food.x && head.y === snakeState.food.y) {
    snakeState.score++
    el.snakeScore.textContent = snakeState.score
    if (snakeState.score >= SNAKE_GOAL) { snakeDraw(); endSnake(true); return }
    snakeSpawnFood()
  } else {
    snakeState.snake.pop()
  }
  snakeDraw()
}

function snakeDraw () {
  if (!snakeState) return
  const { ctx, snake, food } = snakeState
  ctx.fillStyle = '#080c0a'
  ctx.fillRect(0, 0, SNAKE_COLS * SNAKE_CELL, SNAKE_ROWS * SNAKE_CELL)
  if (food) {
    ctx.fillStyle = '#ff3c3c'
    ctx.fillRect(food.x * SNAKE_CELL + 2, food.y * SNAKE_CELL + 2, SNAKE_CELL - 4, SNAKE_CELL - 4)
  }
  snake.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? '#00ff6e' : '#00a847'
    ctx.fillRect(s.x * SNAKE_CELL + 1, s.y * SNAKE_CELL + 1, SNAKE_CELL - 2, SNAKE_CELL - 2)
  })
}

function endSnake (won) {
  if (!snakeState) return
  clearInterval(snakeState.stepInt)
  clearInterval(snakeState.timerInt)
  document.removeEventListener('keydown', snakeKeyHandler)
  const dpad = document.getElementById('snake-dpad')
  if (dpad) dpad.style.display = 'none'
  hideOverlay(el.snakeOverlay)
  snakeState = null
  if (won) { send({ type: 'action', action: 'stop_hack' }); log('Defense successful! Hack blocked.', 'ok') }
  else     { log('Defense failed — hack completed.', 'err') }
}

// ── Instant loss ──────────────────────────────────────────────────────────────
function startInstant () {
  showOverlay(el.instantOverlay)
  log('CRITICAL BREACH — no defense possible!', 'err')
}

// ── Market ────────────────────────────────────────────────────────────────────
function renderMarket () {
  const assetEl = $('market-assets')
  const portEl  = $('market-portfolio')
  if (!assetEl) return

  if (!marketAssets.length) {
    assetEl.innerHTML = '<div style="color:var(--dim);font-size:10px;">Loading market data…</div>'
    return
  }

  assetEl.innerHTML = ''
  marketAssets.forEach(asset => {
    const price     = marketPrices[asset.id]     ?? asset.base_price
    const prevPrice = marketPrevPrices[asset.id] ?? price
    const change    = price - prevPrice
    const changePct = prevPrice > 0 ? ((change / prevPrice) * 100).toFixed(2) : '0.00'
    const up        = change >= 0
    const arrowCol  = up ? 'var(--green)' : 'var(--red)'
    const arrow     = up ? '▲' : '▼'
    const held      = marketPortfolio[asset.id] ?? 0

    const supData   = marketSupply[asset.id]
    const supplyHtml = supData ? (() => {
      const pct       = supData.pct      ?? 0
      const avail     = supData.available ?? 0
      const total     = supData.total     ?? 0
      const barColor  = pct >= 0.95 ? 'var(--red)' : pct >= 0.85 ? 'var(--amber)' : pct >= 0.70 ? '#e8b84b' : 'var(--green)'
      const scarcityLabel = pct >= 0.95 ? ' ⚠ SCARCE' : pct >= 0.85 ? ' ⚠ TIGHT' : ''
      return `<div style="font-size:8px;color:var(--muted);margin-top:3px;display:flex;align-items:center;gap:5px;">
        <div style="flex:1;background:rgba(255,255,255,.08);height:3px;border-radius:2px;overflow:hidden;">
          <div style="width:${Math.min(100, pct*100).toFixed(1)}%;height:100%;background:${barColor};transition:width .4s;"></div>
        </div>
        <span style="white-space:nowrap;color:${barColor};">You: ${fmtSupply(held)} · ${fmtSupply(avail)} / 5T remaining${scarcityLabel}</span>
      </div>`
    })() : ''

    const row = document.createElement('div')
    row.style.cssText = 'border:1px solid var(--border);padding:8px 10px;margin-bottom:6px;'
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;">
          <div style="font-family:var(--display);font-size:11px;letter-spacing:1px;">${esc(asset.id)}</div>
          <div style="font-size:9px;color:var(--muted);">${esc(asset.name)}</div>
        </div>
        <div style="text-align:right;flex:1;">
          <div style="font-size:11px;">$${fmtDecimals(price)}</div>
          <div style="font-size:9px;color:${arrowCol};">${arrow} ${Math.abs(changePct)}%</div>
        </div>
        <div style="text-align:right;min-width:60px;font-size:10px;color:var(--dim);">
          Held: <span style="color:var(--fg);">${held}</span>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn" style="font-size:9px;padding:2px 7px;" data-mkt-buy="${esc(asset.id)}">BUY</button>
          <button class="btn btn-red" style="font-size:9px;padding:2px 7px;" data-mkt-sell="${esc(asset.id)}" ${held < 1 ? 'disabled' : ''}>SELL</button>
          <button class="btn btn-red" style="font-size:9px;padding:2px 7px;" data-mkt-sellall="${esc(asset.id)}" ${held < 1 ? 'disabled' : ''}>ALL</button>
        </div>
      </div>
      ${supplyHtml}
    `
    assetEl.appendChild(row)
  })

  assetEl.querySelectorAll('[data-mkt-buy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.mktBuy
      const qty = Math.max(1, parseShortNum($('market-qty')?.value || '1') || 1)
      send({ type: 'action', action: 'market_buy', asset_id: id, qty })
    })
  })
  assetEl.querySelectorAll('[data-mkt-sell]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.mktSell
      const qty = Math.max(1, parseShortNum($('market-qty')?.value || '1') || 1)
      send({ type: 'action', action: 'market_sell', asset_id: id, qty })
    })
  })
  assetEl.querySelectorAll('[data-mkt-sellall]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.mktSellall
      const qty = marketPortfolio[id] ?? 0
      if (qty > 0) send({ type: 'action', action: 'market_sell', asset_id: id, qty })
    })
  })

  if (portEl) {
    const entries = Object.entries(marketPortfolio).filter(([, v]) => v > 0)
    if (!entries.length) {
      portEl.innerHTML = '<div style="color:var(--dim);font-size:10px;">No positions held.</div>'
    } else {
      let totalVal = 0
      const rows = entries.map(([id, qty]) => {
        const price = marketPrices[id] ?? 0
        const val   = price * qty
        totalVal   += val
        return `<div style="display:flex;justify-content:space-between;font-size:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);">
          <span>${esc(id)}</span><span>${qty} × $${fmtDecimals(price)} = <span style="color:var(--green);">$${fmtDecimals(val)}</span></span>
        </div>`
      }).join('')
      portEl.innerHTML = rows + `<div style="text-align:right;font-size:10px;color:var(--amber);margin-top:6px;">Total value: $${fmtDecimals(totalVal)}</div>`
    }
  }
}

const _FMT_TIERS = [
  // Centillion is the practical JS ceiling (~1e303, Number.MAX_VALUE ~1.8e308)
  [1e303,'Ce'],
  // Nongentillion group (1e267–1e303)
  [1e300,'NdNog'],[1e297,'OdNog'],[1e294,'StNog'],[1e291,'SdNog'],[1e288,'QnNog'],
  [1e285,'QdNog'],[1e282,'TrNog'],[1e279,'DuNog'],[1e276,'UnNog'],[1e273,'Nog'],
  // Octingentillion group (1e243–1e270)
  [1e270,'NdOcg'],[1e267,'OdOcg'],[1e264,'StOcg'],[1e261,'SdOcg'],[1e258,'QnOcg'],
  [1e255,'QdOcg'],[1e252,'TrOcg'],[1e249,'DuOcg'],[1e246,'UnOcg'],[1e243,'Ocg'],
  // Septingentillion group (1e213–1e240)
  [1e240,'NdSpg'],[1e237,'OdSpg'],[1e234,'StSpg'],[1e231,'SdSpg'],[1e228,'QnSpg'],
  [1e225,'QdSpg'],[1e222,'TrSpg'],[1e219,'DuSpg'],[1e216,'UnSpg'],[1e213,'Spg'],
  // Sextingentillion group (1e183–1e210)
  [1e210,'NdSxg'],[1e207,'OdSxg'],[1e204,'StSxg'],[1e201,'SdSxg'],[1e198,'QnSxg'],
  [1e195,'QdSxg'],[1e192,'TrSxg'],[1e189,'DuSxg'],[1e186,'UnSxg'],[1e183,'Sxg'],
  // Quintingentillion group (1e153–1e180)
  [1e180,'NdQig'],[1e177,'OdQig'],[1e174,'StQig'],[1e171,'SdQig'],[1e168,'QnQig'],
  [1e165,'QdQig'],[1e162,'TrQig'],[1e159,'DuQig'],[1e156,'UnQig'],[1e153,'Qig'],
  // Quadringentillion group (1e123–1e150)
  [1e150,'NdQag'],[1e147,'OdQag'],[1e144,'StQag'],[1e141,'SdQag'],[1e138,'QnQag'],
  [1e135,'QdQag'],[1e132,'TrQag'],[1e129,'DuQag'],[1e126,'UnQag'],[1e123,'Qag'],
  // Tringentillion group (1e93–1e120)
  [1e120,'NdTg'],[1e117,'OdTg'],[1e114,'StTg'],[1e111,'SdTg'],[1e108,'QnTg'],
  [1e105,'QdTg'],[1e102,'TrTg'],[1e99,'DuTg'],[1e96,'UnTg'],[1e93,'Tg'],
  // Vigintillion group (1e63–1e90)
  [1e90,'NdVi'],[1e87,'OdVi'],[1e84,'StVi'],[1e81,'SdVi'],[1e78,'QnVi'],
  [1e75,'QdVi'],[1e72,'TrVi'],[1e69,'DuVi'],[1e66,'UnVi'],[1e63,'Vi'],
  // Decillion group (1e33–1e60)
  [1e60,'NdDc'],[1e57,'OdDc'],[1e54,'StDc'],[1e51,'SdDc'],[1e48,'QnDc'],
  [1e45,'QdDc'],[1e42,'TrDc'],[1e39,'DuDc'],[1e36,'UnDc'],[1e33,'Dc'],
  // Base named numbers
  [1e30,'No'],[1e27,'Oc'],[1e24,'Sp'],[1e21,'Sx'],[1e18,'Qi'],
  [1e15,'Qa'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K'],
]

function fmtDecimals (n) {
  if (n === undefined || n === null) return '0.00'
  for (const [thresh, suffix] of _FMT_TIERS) {
    if (n >= thresh) return (n / thresh).toFixed(2) + suffix
  }
  return Number(n).toFixed(2)
}

function fmtSupply (n) {
  if (n === undefined || n === null) return '0'
  for (const [thresh, suffix] of _FMT_TIERS) {
    if (n >= thresh) return (n / thresh).toFixed(1) + suffix
  }
  return String(Math.round(n))
}

function parseShortNum (s) {
  if (!s && s !== 0) return NaN
  const str = String(s).trim().toLowerCase().replace(/,/g, '')
  const m = str.match(/^([0-9.]+)\s*(k|m|b|t|qa|qi|sx|sp|oc|no|dc)?$/)
  if (!m) return parseFloat(str) || NaN
  const n = parseFloat(m[1])
  const mult = { k:1e3, m:1e6, b:1e9, t:1e12, qa:1e15, qi:1e18, sx:1e21, sp:1e24, oc:1e27, no:1e30, dc:1e33 }
  return m[2] ? Math.floor(n * mult[m[2]]) : Math.floor(n)
}

// ── Particle system ───────────────────────────────────────────────────────────
const _pCanvas = document.getElementById('particle-canvas')
const _pCtx    = _pCanvas?.getContext('2d')
let   _particles = []

function _resizeParticleCanvas () {
  if (!_pCanvas) return
  _pCanvas.width  = window.innerWidth
  _pCanvas.height = window.innerHeight
}
_resizeParticleCanvas()
window.addEventListener('resize', _resizeParticleCanvas)

function spawnParticles (x, y, count = 10, color = '#39ff8a') {
  if (!_pCtx) return
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = 1.5 + Math.random() * 3
    _particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1,
      life: 1,
      decay: 0.03 + Math.random() * 0.03,
      size: 2 + Math.random() * 3,
      color,
    })
  }
}

// -- FPS counter + frame cap ---------------------------------------------------
let _fpsCap        = parseInt(localStorage.getItem('fpsCap') || '0', 10)   // 0 = unlimited
let _fpsShow       = localStorage.getItem('fpsShow') !== '0'               // default on
let _fpsFrameCount = 0
let _fpsLastTime   = performance.now()
let _fpsLastFrame  = 0   // timestamp of previous frame (for cap)
const _fpsEl       = document.getElementById('fps-counter')

function _particleTick (now) {
  // Frame cap — skip frame if too soon
  if (_fpsCap > 0 && now - _fpsLastFrame < 1000 / _fpsCap - 1) {
    requestAnimationFrame(_particleTick)
    return
  }
  _fpsLastFrame = now

  // FPS measurement — average over 1-second windows
  _fpsFrameCount++
  if (now - _fpsLastTime >= 1000) {
    if (_fpsEl) _fpsEl.textContent = _fpsShow ? `${_fpsFrameCount} FPS` : ''
    _fpsFrameCount = 0
    _fpsLastTime   = now
  }

  if (!_pCtx || !_pCanvas) { requestAnimationFrame(_particleTick); return }
  _pCtx.clearRect(0, 0, _pCanvas.width, _pCanvas.height)
  _particles = _particles.filter(p => p.life > 0)
  for (const p of _particles) {
    p.x    += p.vx
    p.y    += p.vy
    p.vy   += 0.08
    p.life -= p.decay
    _pCtx.globalAlpha = Math.max(0, p.life)
    _pCtx.fillStyle   = p.color
    _pCtx.beginPath()
    _pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    _pCtx.fill()
  }
  _pCtx.globalAlpha = 1
  requestAnimationFrame(_particleTick)
}
_particleTick(0)

// ── Mobile nav wiring (runs at script load, outside init, so buttons always work) ──
function mobileNavActivate (btn) {
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
}
document.getElementById('mobile-nav-game')?.addEventListener('click', () => {
  mobileNavActivate(document.getElementById('mobile-nav-game'))
  document.body.classList.remove('tab-active', 'log-active')
  window.scrollTo({ top: 0, behavior: 'smooth' })
})
document.getElementById('mobile-nav-log')?.addEventListener('click', () => {
  mobileNavActivate(document.getElementById('mobile-nav-log'))
  document.body.classList.remove('tab-active')
  document.body.classList.add('log-active')
  window.scrollTo({ top: 0, behavior: 'instant' })
})
document.querySelectorAll('.mobile-nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab)
    document.body.classList.remove('log-active')
    document.body.classList.add('tab-active')
    window.scrollTo({ top: 0, behavior: 'instant' })
  })
})

// ── Boot ──────────────────────────────────────────────────────────────────────
init()