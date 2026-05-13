# IDLE.SYS — API Reference

Live server: `wss://idlesys.xyz` (WebSocket) · `https://idlesys.xyz/web` (Web UI)

Use this document to build clients, bots, and automation tools against the live server.
The CLI source (`cli/idlesys_cli.py`) is the reference implementation — check it for working examples of every message type.

> **Contributors:** When adding a new endpoint or WS action, update this file **and** `cli/idlesys_cli.py` (add a subcommand + `_handle_msg` handler).

---

## HTTP Endpoints (public)

| Method | Path | Query / Body | Response |
|--------|------|-------------|----------|
| GET | `/api/version` | — | `{version: str, min_cli_version: str, cli_sha256: str}` |
| GET | `/api/changelog` | — | `{version: [entry_str, ...], ...}` |
| GET | `/api/stats` | — | `{online: int, total: int, version: str}` |
| GET | `/api/leaderboard` | `?limit=int (default 100, max 200)` | `[player_profile, ...]` |
| GET | `/api/player/<pid>` | — | `player_profile` or `{error: str}` (404) |
| GET | `/api/search` | `?q=str` (name or ID prefix) | `player_profile` or `{error: str}` (404) |
| GET | `/api/online` | — | `[{id, name, money, money_fmt, income, income_fmt, badge}, ...]` |
| GET | `/updates/IDLE.SYS-Setup.exe` | — | Binary installer download |

### player_profile shape
```json
{
  "id": "uuid-str",
  "name": "str",
  "badge": "str",
  "badges": ["str"],
  "money": int,
  "money_fmt": "str",
  "income": int,
  "income_fmt": "str",
  "total_earned": int,
  "total_earned_fmt": "str",
  "clicks": int,
  "clicks_fmt": "str",
  "prestige_count": int,
  "prestige_multiplier": float,
  "prestige_points": int,
  "play_time_seconds": int,
  "casino_wagered": int,
  "casino_wagered_fmt": "str",
  "casino_winnings": int,
  "casino_net_fmt": "str",
  "online": bool,
  "achievements": ["str"],
  "login_streak": int,
  "hacks_completed": int,
  "hacks_survived": int,
  "hacks_taken": int,
  "encryption_active": bool,
  "bounty_amount": int
}
```

---

## WebSocket Protocol

Connect to `wss://idlesys.xyz`. All messages are JSON objects.

### Login flow

```jsonc
// Client sends:
{"type": "login", "player_id": "uuid-str", "login_token": "hex-str"}

// Server replies — login_ok:
{
  "type": "login_ok",
  "state": { /* full player state — see player_state shape */ },
  "upgrades": [...],        // upgrade definitions
  "skill_tree": [...],      // skill tree node definitions
  "market": {
    "prices":     {"SRV": int, "GPU": int, "ZRO": int, "NET": int, "CPU": int},
    "prev_prices": {...},
    "assets":     [...],
    "portfolio":  {"SRV": int, ...},
    "supply":     {"SRV": {"available": int, "total": int}, ...}
  },
  "server_version":   "str",
  "min_cli_version":  "str",
  "show_changelog":   bool,
  "login_token":      "str",   // always persist the returned token
  "is_new":           bool,
  "offline_earned":   int,
  "login_streak":     int,
  "streak_bonus":     float    // 1.0 = no bonus, 1.1/1.25/1.5/2.0 at streak milestones
}

// New account (no token on file):
{"type": "token_issued", "token": "hex-str"}  // save immediately

// TOS gate (first login only):
{"type": "require_tos", "tos_url": "str", "privacy_url": "str"}
```

### player_state shape (inside action_ok.state)
```jsonc
{
  "id": "uuid-str",
  "name": "str",
  "money": int,
  "income": int,
  "click_value": int,
  "clicks": int,
  "prestige_count": int,
  "prestige_points": int,
  "prestige_multiplier": float,
  "upgrades_bought": {"upgrade_id": int},
  "skill_nodes": ["node_id"],
  "badges": ["str"],
  "badge": "str",
  "achievements": ["str"],
  "hack_unlocked": bool,
  "hack_target": "uuid-str | null",
  "hack_cooldown_end": float | null,
  "encryption_active": bool,
  "login_streak": int,
  "name_tokens": int
}
```

---

### Non-action message types (client → server)

| Type | Required fields | Optional fields | Notes |
|------|----------------|-----------------|-------|
| `login` | `player_id: str` | `login_token: str`, `version: str`, `is_web: bool` | Send a fresh UUID for `player_id` to create a new account; server replies with `token_issued` then `login_ok`. Include `version` (semver) so the server can send `update_available` if the client is outdated. `is_web: true` suppresses `update_available` for web clients. |
| `chat_send` | `text: str (max 200 chars)` | — | 2s rate limit per player |
| `report` | `target_id: str`, `reason: str` | `context: str (max 300 chars)` | `reason` must be one of: `"spam"`, `"hate_speech"`, `"cheating"`, `"harassment"`, `"inappropriate_name"`, `"other"` |
| `trade_offer` | `target_id: str`, `asset: str`, `shares: int`, `price: int` | — | `asset`: `"SRV"`, `"GPU"`, `"ZRO"`, `"NET"`, `"CPU"`; `shares` = how many you're selling; `price` = total asking price. Target must be online. You must hold enough shares. |
| `trade_counter` | `trade_id: str` | `shares: int`, `price: int` | Either party can counter; omitted fields keep current value |
| `trade_accept` | `trade_id: str` | — | Only the recipient (target) can accept; buyer's balance must cover `price` |
| `trade_reject` | `trade_id: str` | — | Either party can reject |
| `trade_message` | `trade_id: str`, `text: str` | — | — |
| `check_update` | — | — | Returns `update_available` if newer version exists |
| `ping` | — | — | No reply expected |

---

### Actions (`{"type": "action", "action": "...", ...}`)

All return `{"type": "action_ok", "action": "str", "state": {...}}` or `{"type": "error", "msg": "str"}`.

#### Core economy

| `action` | Required fields | Optional | Notes |
|----------|----------------|----------|-------|
| `click` | — | — | — |
| `buy_upgrade` | `upgrade_id: str` | — | Returns error if insufficient funds |
| `buy_skill_node` | `node_id: str` | — | Costs prestige points |
| `prestige` | — | — | Resets money/upgrades; keeps hack upgrades and skill nodes |
| `set_name` | `name: str` | — | Costs 1 name token; max 20 chars |
| `accept_tos` | — | — | One-time; required before any other actions on new accounts |

#### Hacking (top-level type — no `"action"` wrapper)

| `type` | Required fields | Optional | Notes |
|--------|----------------|----------|-------|
| `start_hack` | — | — | Server picks a random non-encrypted target |
| `stop_hack` | — | — | Defend yourself if currently being hacked |
| `buy_hack_module` | via `action` wrapper | — | One-time unlock; costs $2.5M |
| `buy_encryption` | via `action` wrapper | — | 2-hour shield; costs 20% of current balance (min $500K) |
| `bypass_hack_cooldown` | via `action` wrapper | — | Costs 1 name token |

#### Casino (top-level type — no `"action"` wrapper)

| `type` | Required fields | Optional | Valid values |
|--------|----------------|----------|-------------|
| `bj_deal` | `bet: int` | — | `bet` > 0, must have `bet + fee` in balance |
| `bj_hit` | — | — | Must have active BJ session |
| `bj_stand` | — | — | Must have active BJ session |
| `roulette_spin` | `bet: int`, `bet_type: str` | `number: int` | `bet_type`: `"red"`, `"black"`, `"even"`, `"odd"`, or `"number"`; if `"number"` then `number: 0–36` required |
| `crash_start` | `bet: int` | — | Starts a crash round; multiplier climbs until crash |
| `crash_cashout` | — | — | Must have active crash session |
| `loan_take` | `amount: int` | — | Max 50% of house balance; 20% flat interest; 24h term |
| `loan_repay` | — | — | Repays full outstanding loan |
| `blackmarket_buy` | `item_id: str` | — | Server-authoritative temporary boosts |
| `insurance_toggle` | — | — | Toggles insurance on/off before a bet; refunds 50% of losses if on |

#### Market (action wrapper)

| `action` | Required fields | Optional | Notes |
|----------|----------------|----------|-------|
| `get_market` | — | — | Returns current prices, portfolio, supply |
| `market_buy` | `asset: str`, `qty: int` | — | `asset`: `"SRV"`, `"GPU"`, `"ZRO"`, `"NET"`, `"CPU"`; `qty` > 0 |
| `market_sell` | `asset: str`, `qty: int` | — | `qty: -1` sells all held shares |

#### Social (action wrapper)

| `action` | Required fields | Optional | Notes |
|----------|----------------|----------|-------|
| `send_money` | `target_id: str`, `amount: int` | — | 10% tax (reducible via skill tree) |
| `redeem_badge` | `code: str` | — | Code is case-insensitive, converted to uppercase |
| `set_active_badge` | `badge: str` | — | Must already own the badge |
| `gen_link_code` | — | — | Returns a 6-char code valid 10 min; used for Discord linking |
| `discord_oauth_start` | — | — | Returns OAuth2 URL; open in browser |
| `delink_discord` | — | — | Removes Discord link |

#### Poker (top-level type — no `"action"` wrapper)

| `type` | Required fields | Optional | Notes |
|--------|----------------|----------|-------|
| `poker_list_rooms` | — | — | Returns list of open rooms |
| `poker_create_room` | `name: str`, `min_bet: int` | — | Creates and auto-joins |
| `poker_join_room` | `room_id: str` | — | — |
| `poker_leave_room` | — | — | — |
| `poker_start_game` | — | — | Room creator only; requires ≥2 players |
| `poker_action` | `action: str` | `amount: int` | `action`: `"fold"`, `"check"`, `"call"`, `"raise"`; `amount` required for `"raise"` |

---

## Server-sent push messages

| `type` | Key fields | Description |
|--------|-----------|-------------|
| `broadcast` | `msg: str` | Admin broadcast |
| `notification` | `msg: str` | Achievement unlock, bounty claim, hack result, season prize, etc. |
| `chat_msg` | `name, badge, text, ts, pid` | Global chat message |
| `chat_history` | `messages: [chat_msg]` | Last 50 messages sent on login |
| `chat_rate_limit` | — | Sent instead of echo when rate limited |
| `market_update` | `prices: {asset: int}` | Price change from another player's trade |
| `bj_state` | `player_hand, dealer_hand, player_val, dealer_val, bet, state` | Mid-hand state after hit |
| `bj_result` | `result: "win"\|"loss"\|"push"\|"blackjack"\|"bust", winnings: int, state` | Hand resolved |
| `roulette_result` | `number: int, color: str, win: bool, payout: int, state` | Spin result |
| `crash_state` | `multiplier: float` | Tick during active crash round |
| `crash_result` | `result: "cashout"\|"crashed", payout: int, state` | Round ended |
| `hack_started` | — | Your hack attempt began |
| `hack_result` | `stolen: int, state` | Hack completed (stolen=0 on failure) |
| `trade_sent` | `trade: {id, initiator, target, asset, shares, price, status}` | Confirmation sent to the offer initiator |
| `trade_incoming` | `trade: {id, initiator, target, asset, shares, price, status}` | Incoming trade offer sent to the target |
| `trade_updated` | `trade: {id, ..., shares, price}` | Sent to both parties when either counters |
| `trade_completed` | `trade: {id, ...}` | Trade accepted and executed; both parties receive updated state |
| `token_issued` | `token: str` | New login token — save immediately |
| `require_tos` | `tos_url, privacy_url` | Must call `accept_tos` before playing |
| `update_available` | `version, notes, url` | Sent on login or `check_update` when client `version` is behind server; not sent to web clients (`is_web: true`) |
| `up_to_date` | — | Response to `check_update` when client is already on the latest version |
