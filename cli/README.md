# IDLE.SYS — CLI / TUI

A single Windows binary (`idlesys.exe`) that lets you play IDLE.SYS from the terminal. Includes a live Textual dashboard (`idlesys tui`) and scriptable subcommands for automation.

> **⚠️ Work in Progress**
>
> The CLI and TUI are functional but still buggy and incomplete. Some features may not work correctly or at all. The Electron desktop client is the stable, fully-featured way to play. The CLI is best suited for scripting and automation right now — the TUI is usable but rough around the edges.
>
> Bug reports and contributions are welcome — see the main [CONTRIBUTING](#contributing) section below.

---

## Installation

Download `idlesys.exe` from the **#releases** channel in the [Discord server](https://discord.gg/s3EpTjXjGh).

Run it once with no arguments to install:

```
idlesys.exe
```

This copies the binary to `%LOCALAPPDATA%\IDLE.SYS\` and adds it to your user PATH. Open a new terminal and you can run `idlesys` from anywhere.

---

## Getting started

```
# New player — create an account
idlesys register

# Existing player — save your credentials
idlesys login <player-id> --token <token>

# Your player ID and token are in the Electron client:
# Open DevTools (F12) → Console → run:
#   localStorage.getItem('player_id')
#   localStorage.getItem('login_token')

# Launch the live TUI dashboard
idlesys tui

# Or use subcommands
idlesys status
idlesys --help
```

---

## All commands

| Command | Description |
|---------|-------------|
| `tui` | Live terminal dashboard (persistent WebSocket) |
| `register` | Create a new account |
| `login <id>` | Save credentials for an existing account |
| `status` | Show balance, income, streak |
| `account` | Show player ID, token, switch accounts |
| `profile <name\|id>` | View any player's profile |
| `click [--n N]` | Send N clicks |
| `buy <upgrade_id>` | Buy an upgrade |
| `skill <node_id>` | Unlock a skill tree node |
| `prestige` | Prestige reset |
| `gift <pid> <amount>` | Send money to a player |
| `hack <start\|buy-module\|encrypt\|bypass-cd>` | Hacking commands |
| `blackjack <deal\|hit\|stand> [bet]` | Blackjack |
| `roulette <type> <bet>` | Roulette spin |
| `crash <start\|cashout> [bet]` | Crash game |
| `market` | Show market prices |
| `market-buy <asset> <qty>` | Buy stock |
| `market-sell <asset> <qty>` | Sell stock (-1 = all) |
| `badge <list\|redeem\|set>` | Badge commands |
| `achievements` | Show achievements |
| `leaderboard` | Top 10 players |
| `changelog` | Show server changelog |
| `accept-tos` | Accept Terms of Service |
| `chat <text>` | Send a global chat message |
| `script <file\|->` | Run a JSON action list |
| `raw '<json>'` | Send a raw WebSocket message |

---

## Scripting

The CLI is designed to be scriptable. Pass a JSON array of actions to `idlesys script`:

```bash
# From a file
idlesys script actions.json

# From stdin
echo '[{"type":"action","action":"click"}]' | idlesys script -

# Single raw message
idlesys raw '{"type":"action","action":"prestige"}'
```

See `examples/` for sample scripts.

---

## Credentials

Credentials are saved to `~/.idlesys/config.json` after login. Environment variables override the config file — useful for bots and CI:

```
IDLESYS_PLAYER_ID=<uuid>
IDLESYS_TOKEN=<login-token>
IDLESYS_SERVER=wss://idlesys.xyz
```

---

## Building from source

Requires Python 3.11+ and the venv set up:

```
cd cli
python -m venv venv
venv\Scripts\pip install -r requirements.txt
build.bat
```

Output: `cli/dist/idlesys.exe`, copied automatically to `dist/`.

**Dependencies:** `websockets`, `textual`, `rich`, `pyinstaller` — see `requirements.txt`.

---

## Known issues

- TUI gambling tabs (blackjack, roulette, crash) may have display glitches
- Poker tab in TUI is UI-only — room state display is incomplete  
- Some server error messages don't surface cleanly in the TUI
- First-run onboarding (TOS + name) flow is new and may have edge cases
- Windows only — macOS/Linux builds are untested

---

## Contributing

The source is `cli/idlesys_cli.py` — a single file. The WebSocket protocol is documented in [API.md](../API.md).

When adding a new command:
1. Add the `cmd_*` function
2. Add the subparser entry in `build_parser()`
3. Add the dispatch entry in `main()`
4. Update `API.md` if it touches a new WS message type
