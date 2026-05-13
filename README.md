# IDLE.SYS

A multiplayer incremental idle game with a hacking theme. Earn money, upgrade your rig, hack other players, gamble at the casino, trade on the stock market, and climb the leaderboard.

Built with **Electron** (desktop client) and a **Python/aiohttp** WebSocket server.

---

## What's in this repo

| Directory | What it is |
|-----------|-----------|
| `client/` | Electron desktop client — all UI, game logic rendering, Discord RPC |
| `cli/` | `idlesys.exe` — terminal CLI + live TUI dashboard, scriptable automation |

The game server, Discord bot, and deploy tooling are **not** open-sourced. See [API.md](API.md) for the full WebSocket and HTTP API so you can build clients, bots, and tools against the live server at `wss://idlesys.xyz`. Web UI is at `https://idlesys.xyz/web`.

---

## Playing the game

Download the latest release from the **#releases** channel in the [Discord server](https://discord.gg/s3EpTjXjGh).

- `IDLE.SYS-Setup.exe` — Windows installer (Electron desktop client)
- `idlesys.exe` — Terminal CLI / TUI (run once to install, then `idlesys tui`)

Verify the SHA256 hashes posted alongside each file before running.

---

## Client (Electron)

```
cd client
npm install       # first time only
npm run dev       # run in dev mode with DevTools
npm run pack      # build installer → dist/
```

See [client/README.md](client/README.md) for full details on the file structure, tabs, IPC, and build process.

**Stack:** Electron 29, plain JS/HTML/CSS, WebSocket to game server.

---

## CLI / TUI

A single compiled Windows binary. Source is in `cli/idlesys_cli.py`.

```
# First time — set up the venv and install deps
cd cli
python -m venv venv
venv\Scripts\pip install -r requirements.txt

# Build
build.bat

# Or if you have the binary already installed:
idlesys register        # create a new account
idlesys tui             # live dashboard
idlesys --help          # all commands
```

**Stack:** Python 3.11+, [Textual](https://textual.textualize.io/), websockets, compiled with PyInstaller.

---

## Contributing

Contributions to the client and CLI are welcome.

1. Fork the repo and create a branch (`git checkout -b feature/my-thing`)
2. Make your changes
3. Open a pull request with a clear description of what changed and why

Please keep PRs focused — one feature or fix per PR. If you're planning something large, open an issue first to discuss it.

**What to work on:**
- Client UI improvements (see open issues)
- CLI commands and TUI enhancements
- Bug fixes
- The API surface is documented in [API.md](API.md) — if you find a discrepancy, open an issue

**What not to touch:**
- Server-side game logic (not in this repo)
- Anything that would break the WebSocket protocol compatibility

---

## License

AGPL-3.0 with an additional commercial use restriction — see [LICENSE](LICENSE) for details.

**Short version:** free to use, modify, and contribute. You may not sell it or monetise a hosted version without written permission from the author.
