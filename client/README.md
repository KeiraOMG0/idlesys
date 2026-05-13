# IDLE.SYS — Client

The Electron desktop app. Connects to the game server over WebSocket, renders the entire UI, and handles Discord Rich Presence. It also runs as a plain web page when the server serves it via `/play`.

---

## Files

| File | What it does |
|---|---|
| `main.js` | Electron main process. Creates the window, handles IPC, manages auto-updater, Discord RPC init. |
| `renderer.js` | **All UI logic.** Every tab, every game action, WebSocket message handling. This is the main file. |
| `index.html` | HTML structure. Tabs, static elements, the DOM that `renderer.js` populates. |
| `preload.js` | The bridge between Electron's main process and the renderer. Exposes `window.api` and `window.electron`. |
| `connection.js` | Discord OAuth2 flow — opens the browser, listens for the callback, sends the token to the server. |
| `platform.js` | Platform detection (Windows/Mac/Linux) — installer name, download URL, update logic. |
| `package.json` | Build config and scripts. |
| `assets/` | Icons, images, sounds. |

---

## How to run (development)

```
cd client
npm install           # first time only
npm run dev           # opens Electron with DevTools
```

---

## How to build the installer

```
cd client
npm run pack          # builds IDLE.SYS-Setup.exe → dist/
```

The output lands in `../dist/`. Always build before restarting the server when bumping the version, so players can download the new installer.

---

## How the client connects

`renderer.js` reads the player's ID and login token from storage on startup, then opens a WebSocket to the server. On every reconnect it sends:

```json
{ "type": "login", "player_id": "...", "token": "..." }
```

The server responds with the player's full state. From there the client receives push updates on every tick, purchase, hack event, market trade, etc.

The `IS_WEB` flag (`renderer.js` top of file) is `true` when running in a browser (`/play`), `false` in Electron. A few things behave differently in each mode (e.g. player ID storage, window controls).

---

## Key constants in `renderer.js`

| Constant | What it controls |
|---|---|
| `CURRENT_VERSION` | Displayed in the client UI. Must match `server/main.py`. |
| `HEALTH_CHECK_INTERVAL` | How often (ms) the client checks if the WS is still alive. |
| `PING_INTERVAL` | How often (ms) the client sends a ping to keep the connection open. |
| `HACK_DURATION_MS` | Must match `HACK_DURATION` on the server (in milliseconds). |
| `HACK_COOLDOWN_MS` | Must match `HACK_COOLDOWN` on the server (in milliseconds). |
| `COST_SCALE` | Must match `COST_SCALE` on the server. |
| `DISCORD_LINK` | The invite link shown in the Network tab. |

**If you change a timing or scaling constant on the server, update the matching constant here too.**

---

## Tabs (defined in `index.html`, logic in `renderer.js`)

| Tab ID | What's in it |
|---|---|
| `tab-lb` | Leaderboard |
| `tab-profile` | Player profile, badges, achievements |
| `tab-hack` | Hack module — target selection, defense mini-games |
| `tab-network` | Discord link/unlink, gifting |
| `tab-casino` | Blackjack, roulette |
| `tab-ops` | Daily operations (contracts) |
| `tab-market` | Stock market |
| `tab-misc` | Misc upgrades, prestige |
| `tab-settings` | Settings (Rich Presence toggle, etc.) |

---

## Bumping the version

1. Update `CURRENT_VERSION` in `renderer.js` and its file header comment at the top.
2. Update `CURRENT_VERSION` in `server/main.py` and its file header comment.
3. Update `Version` in `package.json`.
4. Run `npm run pack` to build the new installer.
5. Restart the server.

---

## IPC (main ↔ renderer)

The renderer can't call Node APIs directly. `preload.js` exposes safe wrappers via `window.api` and `window.electron`:

| `window.api.*` | What it does |
|---|---|
| `getPlayerID()` | Returns the stored player UUID |
| `getLoginToken()` | Returns the stored login token |
| `setLoginToken(t)` | Saves the login token |
| `openExternal(url)` | Opens a URL in the browser |

| `window.electron.*` | What it does |
|---|---|
| `minimize()` | Minimizes the window |
| `close()` | Closes the window |
| `toggleFullscreen()` | Toggles fullscreen |

---

