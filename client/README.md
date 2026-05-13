# IDLE.SYS — Client

The Electron desktop app. Connects to the game server over WebSocket, renders the entire UI, and handles Discord Rich Presence. Also runs as a plain web page when the server serves it via `/play`.

Current version: **2.7.0**

> **⚠️ Work in Progress**
>
> The client is actively being developed and may have bugs or incomplete features. Download the latest stable release from **#releases** in the [Discord server](https://discord.gg/s3EpTjXjGh) rather than building from source if you just want to play.

---

## Files

| File | What it does |
|------|-------------|
| `main.js` | Electron main process. Creates the window, handles IPC, manages update downloads, Discord RPC init. |
| `renderer.js` | **All UI logic.** Every tab, every game action, WebSocket message handling. This is the main file. |
| `index.html` | HTML structure and CSS. Tabs, static elements, the DOM that `renderer.js` populates. |
| `preload.js` | Bridge between Electron's main process and the renderer. Exposes `window.api` and `window.electron`. |
| `connection.js` | Discord OAuth2 flow — opens the browser, listens for the callback, sends the token to the server. |
| `platform.js` | Platform detection (Windows/Mac/Linux) — installer name, download URL, update logic. |
| `package.json` | Build config, version, and npm scripts. |
| `prebuild.ps1` | Pre-build script — syncs version from `server/config.json` into `package.json` and `renderer.js`. |
| `assets/` | Icons and images. |

---

## How to run (development)

```
cd client
npm install       # first time only
npm run dev       # opens Electron with DevTools
```

---

## How to build the installer

```
cd client
npm run pack      # builds IDLE.SYS-Setup.exe → dist/
```

`npm run pack` does three things in order:
1. Runs `prebuild.ps1` — syncs the version number from `server/config.json`
2. Runs `electron-builder` — produces `IDLE.SYS-Setup.exe` in `../dist/`
3. Runs `cli/build.bat` — builds `idlesys.exe` and copies it to `../dist/`

Both output files land in `dist/` ready for `/admin release` in Discord.

---

## How the client connects

On startup `renderer.js` reads the player's UUID and login token from storage, then opens a WebSocket to the server. On every connect it sends:

```json
{ "type": "login", "player_id": "...", "login_token": "..." }
```

The server responds with the full player state, upgrade definitions, skill tree, and market data. From there the client receives push updates on every tick, purchase, hack event, chat message, market trade, etc.

The `IS_WEB` flag is `true` when running in a browser (`/play`), `false` in Electron. Player ID and token storage, window controls, and update behaviour differ between the two modes.

---

## Key constants in `renderer.js`

| Constant | What it controls |
|----------|-----------------|
| `CURRENT_VERSION` | Displayed in the client UI. Must match `server/main.py`. |
| `HEALTH_CHECK_INTERVAL` | How often (ms) the client checks if the WS is still alive. |
| `PING_INTERVAL` | How often (ms) the client sends a ping to keep the connection alive. |
| `HACK_DURATION_MS` | Must match `HACK_DURATION` on the server (in milliseconds). |
| `HACK_COOLDOWN_MS` | Must match `HACK_COOLDOWN` on the server (in milliseconds). |
| `COST_SCALE` | Upgrade cost scaling factor. Must match server. |
| `DISCORD_LINK` | The invite link shown in the Network tab. |

**If you change a timing or scaling constant on the server, update the matching constant here too.**

---

## Tabs

Tabs are defined in `index.html` and all logic lives in `renderer.js`.

| Tab | ID | What's in it |
|-----|----|-------------|
| LB | `leaderboard` | Live leaderboard with DOM-diffing (no flash on update) |
| PROFILE | `profile` | Player stats, badges, achievements, prestige info |
| HACK | `hack` | Hack module — target selection, defense mini-games (math, RPS, snake) |
| NETWORK | `network` | Discord link/unlink, player gifting |
| CASINO | `casino` | Blackjack, roulette, crash, loans, black market, insurance |
| POKER | `poker` | Multiplayer poker — create/join rooms, full hand logic |
| MARKET | `market` | Stock market — 5 assets (SRV/GPU/ZRO/NET/CPU), buy/sell, supply curve |
| MISC | `misc` | Prestige upgrades |
| SETTINGS | `settings` | FPS cap, number format |
| ? | `help` | In-game help / keybinds |

The CHAT tab is hidden by default and shown when the server pushes a chat message.

---

## Upgrade categories

Upgrades are split into sub-tabs inside the main upgrades panel:

| Sub-tab | What it contains |
|---------|-----------------|
| CLICK | Click value upgrades |
| AUTO | Auto-income upgrades |
| PRESTIGE | Prestige multiplier upgrades |
| SKILL | Skill tree (costs prestige points, persists across prestiges) |
| HACK | Hack module, encryption, steal % upgrades |

---

## IPC (main ↔ renderer)

The renderer cannot call Node APIs directly. `preload.js` exposes safe wrappers via `window.api` and `window.electron`:

| `window.api.*` | What it does |
|---------------|-------------|
| `getPlayerID()` | Returns the stored player UUID |
| `getLoginToken()` | Returns the stored login token |
| `setLoginToken(t)` | Saves the login token |
| `openExternal(url)` | Opens a URL in the default browser (allowlisted domains only) |

| `window.electron.*` | What it does |
|--------------------|-------------|
| `minimize()` | Minimises the window |
| `close()` | Closes the window |
| `toggleFullscreen()` | Toggles fullscreen |

The allowlist for `openExternal` is in `main.js` — add domains there if new OAuth or external links are needed.

---

## Updates

| Client | How updates work |
|--------|-----------------|
| Electron | Server sends `update_available` over WS → client shows a banner → user clicks to download and install |
| CLI / TUI | Server sends `update_available` over WS → TUI shows a warning → user downloads new `idlesys.exe` from Discord |
| Web (`/play`) | Always served the latest version — just refresh the page |

**Where to get releases:** the **#releases** channel in the [Discord server](https://discord.gg/s3EpTjXjGh). Both `IDLE.SYS-Setup.exe` and `idlesys.exe` are posted there with SHA256 hashes.

When the Electron client downloads an update it:
1. Downloads the installer to a temp directory
2. Streams progress back to the renderer
3. Opens the installer via `shell.openPath` and quits so it can replace itself

Platform installer names are defined in `platform.js`:

| Platform | Installer |
|----------|----------|
| Windows | `IDLE.SYS-Setup.exe` |
| macOS | `IDLE.SYS.dmg` |
| Linux | `IDLE.SYS.AppImage` |

---

## Bumping the version

1. Update `version` in `server/config.json` — `prebuild.ps1` syncs it into `package.json` and `renderer.js` automatically on the next build.
2. Run `npm run pack` from `client/`.
3. Run `/admin release` in Discord — the bot posts both `IDLE.SYS-Setup.exe` and `idlesys.exe` with SHA256s.

---

## Security notes

- `contextIsolation: true` and `nodeIntegration: false` are enforced — the renderer has no direct Node access.
- `open-external` IPC uses a prefix allowlist; arbitrary URLs are rejected.
- The Content Security Policy in `index.html` restricts scripts to `'self'` and `blob:` only.
