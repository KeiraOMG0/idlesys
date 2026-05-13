#!/usr/bin/env python3
# IDLE.SYS CLI/TUI — v1.0.0
# Single binary: scriptable CLI + live Textual dashboard.
#
# Run with no args  → self-install
# idlesys tui       → live dashboard
# idlesys <cmd>     → scriptable subcommands
#
# Build:
#   cd cli && .\build.ps1
import argparse
import asyncio
import json
import os
import subprocess
import sys
import textwrap
import time
import urllib.request
import uuid
from pathlib import Path

CLI_VERSION    = "1.0.0"
DEFAULT_SERVER = "wss://idlesys.xyz"

# ─── Dependency guard ─────────────────────────────────────────────────────────

def _check_deps():
    missing = []
    for pkg in ("websockets", "textual"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        sys.exit(f"Missing: pip install {' '.join(missing)}")

# ─── Config ───────────────────────────────────────────────────────────────────

CONFIG_DIR  = Path.home() / ".idlesys"
CONFIG_FILE = CONFIG_DIR / "config.json"

def _load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text())
    except Exception:
        return {}

def _save_config(cfg: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))

def _get_creds() -> tuple[str, str, str]:
    cfg    = _load_config()
    pid    = os.environ.get("IDLESYS_PLAYER_ID") or cfg.get("player_id", "")
    token  = os.environ.get("IDLESYS_TOKEN")     or cfg.get("login_token", "")
    server = os.environ.get("IDLESYS_SERVER")    or cfg.get("server", DEFAULT_SERVER)
    return pid, token, server

def _require_creds() -> tuple[str, str, str]:
    pid, token, server = _get_creds()
    if not pid:
        sys.exit("Not logged in.\n  New account:  idlesys register\n  Existing:     idlesys login <player_id> --token <token>")
    return pid, token, server

# ─── Self-installer ───────────────────────────────────────────────────────────

def _self_install():
    exe = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve()
    # Install to %LOCALAPPDATA%\IDLE.SYS — no admin rights needed
    install_dir = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "IDLE.SYS"
    dest        = install_dir / "idlesys.exe"
    print(f"IDLE.SYS CLI v{CLI_VERSION} — Installer")
    print(f"  From : {exe}")
    print(f"  To   : {dest}")
    print()
    script = f"""
$src = '{exe}'; $dir = '{install_dir}'; $dest = '{dest}'
if (-not (Test-Path $dir)) {{ New-Item -ItemType Directory -Force $dir | Out-Null }}
Copy-Item -Force $src $dest
$cur = [Environment]::GetEnvironmentVariable('PATH','User')
if ($cur -notlike "*$dir*") {{
    [Environment]::SetEnvironmentVariable('PATH', $cur + ';' + $dir, 'User')
    Write-Host "[+] Added to PATH: $dir"
}} else {{ Write-Host "[i] PATH already contains: $dir" }}
Write-Host "[+] Installed: $dest"
Write-Host ""
Write-Host "Open a new terminal and run:  idlesys tui"
"""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            text=True,
        )
        if r.returncode != 0:
            print("Install failed — try running as administrator.", file=sys.stderr)
            sys.exit(1)
    except FileNotFoundError:
        sys.exit("PowerShell not found. Copy idlesys.exe to a folder in your PATH manually.")

# ─── Formatting ───────────────────────────────────────────────────────────────

_SUFFIXES = [
    (10**303,"Ce"),(10**100,"Gg"),(10**63,"Vi"),(10**60,"No"),(10**57,"Oc"),
    (10**54,"Sp"),(10**51,"Sx"),(10**48,"Qi"),(10**45,"Qa"),(10**42,"Tg"),
    (10**39,"Dg"),(10**36,"Un"),(10**33,"Dc"),(10**30,"No"),(10**27,"Oc"),
    (10**24,"Sp"),(10**21,"Sx"),(10**18,"Qi"),(10**15,"Qa"),(10**12,"T"),
    (10**9,"B"),(10**6,"M"),(10**3,"K"),
]
def _fmt(n) -> str:
    n = int(n)
    for t, s in _SUFFIXES:
        if n >= t: return f"{n/t:.2f}{s}"
    return str(n)

def _ws_url(s: str) -> str:
    s = s.replace("https://","wss://").replace("http://","ws://")
    return s if s.startswith("ws") else "ws://" + s

def _http_url(s: str) -> str:
    s = s.replace("wss://","https://").replace("ws://","http://")
    return s if s.startswith("http") else "http://" + s

def _print_banner(srv_ver: str = ""):
    sv = f"  server v{srv_ver}" if srv_ver else ""
    print(f"IDLE.SYS CLI v{CLI_VERSION}{sv}")

# ─── WS session (CLI) ─────────────────────────────────────────────────────────

async def _ws_session(server: str, pid: str, token: str, messages: list[dict]) -> list[dict]:
    import websockets
    results = []
    async with websockets.connect(_ws_url(server), ping_interval=None) as ws:
        login = {"type": "login", "player_id": pid}
        if token: login["login_token"] = token
        await ws.send(json.dumps(login))

        login_ok = None
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            t   = msg.get("type")
            if t == "token_issued":
                cfg = _load_config(); cfg["login_token"] = msg["token"]; cfg["player_id"] = pid
                _save_config(cfg); token = msg["token"]
                print(f"[token saved → {CONFIG_FILE}]")
                continue
            if t == "require_tos":
                sys.exit(f"Accept TOS first: {_http_url(server)}/web/tos\nThen run: idlesys accept-tos")
            if t == "error":
                sys.exit(f"Login error: {msg.get('msg')}")
            if t == "login_ok":
                login_ok = msg
                ret = msg.get("login_token")
                if ret:
                    cfg = _load_config(); cfg["login_token"] = ret; _save_config(cfg)
                break
        results.append(login_ok)

        for m in messages:
            await ws.send(json.dumps(m))
            # Some actions (BJ, crash) may need multiple responses; collect until action_ok/error/result
            deadline = asyncio.get_event_loop().time() + 10
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0: break
                raw  = await asyncio.wait_for(ws.recv(), timeout=remaining)
                resp = json.loads(raw)
                results.append(resp)
                rt = resp.get("type", "")
                if rt in ("action_ok","error","bj_result","bj_state","roulette_result",
                          "crash_state","crash_result","chat_rate_limit","chat_msg"):
                    break
    return results

def _run(server, pid, token, messages):
    return asyncio.run(_ws_session(server, pid, token, messages))

# ─── CLI commands ─────────────────────────────────────────────────────────────

def cmd_login(args):
    pid    = args.player_id
    token  = args.token or ""
    server = args.server or DEFAULT_SERVER
    cfg    = _load_config()
    cfg.update({"player_id": pid, "server": server})
    if token: cfg["login_token"] = token
    _save_config(cfg)
    try:
        results = _run(server, pid, token, [])
    except Exception as e:
        sys.exit(f"Connection failed: {e}")
    lo    = results[0]
    state = lo.get("state", {})
    ret   = lo.get("login_token")
    if ret: cfg["login_token"] = ret; _save_config(cfg)
    _print_banner(lo.get("server_version", ""))
    print(f"Logged in as: {state.get('name') or '(unnamed)'}  [{pid}]")
    if lo.get("show_changelog"): print("New changelog — run: idlesys changelog")

def cmd_status(args):
    pid, token, server = _require_creds()
    lo    = _run(server, pid, token, [])[0]
    state = lo.get("state", {})
    _print_banner(lo.get("server_version", ""))
    print(f"\n  Player  : {state.get('name') or '(unnamed)'}")
    print(f"  Balance : ${_fmt(state.get('money',0))}  (+${_fmt(state.get('income_per_sec',0))}/s)")
    print(f"  Clicks  : {state.get('clicks',0)}   Prestiges: {state.get('prestige_count',0)}")
    print(f"  Streak  : {lo.get('login_streak',1)}d  bonus: {lo.get('streak_bonus',1.0):.0%}")
    if lo.get("offline_earned"): print(f"  Offline : +${_fmt(lo['offline_earned'])}")
    if lo.get("show_changelog"): print("\n  [!] New changelog — run: idlesys changelog")
    print()

def cmd_account(args):
    pid, token, server = _require_creds()
    cfg = _load_config()
    _print_banner()
    print("\n  ╔══ ACCOUNT ══╗")
    print(f"  Player ID  : {pid}")
    print(f"  Login token: {token or '(none saved)'}")
    print(f"  Server     : {server}")
    print()
    print("  To copy your ID/token, highlight the text above.")
    print("  To switch accounts: idlesys login <new-player-id> [--token <token>]")
    print("  To recover an account: idlesys login <your-old-uuid> --token <saved-token>")
    print()

def cmd_profile(args):
    _, _, server = _get_creds()
    server = server or DEFAULT_SERVER
    query  = args.query
    try:
        # Try by ID first, then by name search
        try:
            with urllib.request.urlopen(f"{_http_url(server)}/api/player/{query}", timeout=8) as r:
                p = json.loads(r.read())
        except Exception:
            with urllib.request.urlopen(f"{_http_url(server)}/api/search?q={urllib.request.quote(query)}", timeout=8) as r:
                p = json.loads(r.read())
    except Exception as e:
        sys.exit(f"Player not found: {e}")
    if "error" in p: sys.exit(f"Not found: {p['error']}")
    _print_banner()
    dot = "● ONLINE" if p.get("online") else "○ offline"
    print(f"\n  {p.get('name') or 'Anon'}  {dot}")
    print(f"  Balance : ${p.get('money_fmt','?')}  (+${p.get('income_fmt','?')}/s)")
    print(f"  Earned  : ${p.get('total_earned_fmt','?')}")
    print(f"  Clicks  : {p.get('clicks_fmt','?')}   Prestiges: {p.get('prestige_count','?')}")
    print(f"  Casino  : wagered ${p.get('casino_wagered_fmt','?')}  net {p.get('casino_net_fmt','?')}")
    print(f"  Hacks   : completed {p.get('hacks_completed',0)}  survived {p.get('hacks_survived',0)}  taken {p.get('hacks_taken',0)}")
    badges = " ".join(p.get("badges", []))
    if badges: print(f"  Badges  : {badges}")
    if p.get("achievements"): print(f"  Achieve : {', '.join(p['achievements'])}")
    print()

def cmd_click(args):
    pid, token, server = _require_creds()
    n   = max(1, args.n)
    res = _run(server, pid, token, [{"type":"action","action":"click"}]*n)
    last = next((r for r in reversed(res) if r.get("type")=="action_ok"), None)
    _print_banner()
    if last: print(f"Clicked {n}×  →  ${_fmt(last['state']['money'])}")

def cmd_buy(args):
    pid, token, server = _require_creds()
    res  = _run(server, pid, token, [{"type":"action","action":"buy_upgrade","upgrade_id":args.upgrade_id}]*max(1,args.count))
    oks  = [r for r in res[1:] if r.get("type")=="action_ok"]
    errs = [r for r in res[1:] if r.get("type")=="error"]
    _print_banner()
    if oks: print(f"Bought '{args.upgrade_id}' × {len(oks)}  →  ${_fmt(oks[-1]['state']['money'])}")
    for e in errs: print(f"Error: {e.get('msg')}")

def cmd_skill(args):
    pid, token, server = _require_creds()
    res = _run(server, pid, token, [{"type":"action","action":"buy_skill_node","node_id":args.node_id}])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok": print(f"Unlocked '{args.node_id}'  →  ${_fmt(r['state']['money'])}")

def cmd_prestige(args):
    pid, token, server = _require_creds()
    res = _run(server, pid, token, [{"type":"action","action":"prestige"}])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok":
            s = r["state"]; print(f"Prestige!  count={s.get('prestige_count')}  pp={s.get('prestige_points')}")

def cmd_hack(args):
    pid, token, server = _require_creds()
    sub = args.hack_cmd
    if sub == "start":
        msg = {"type":"start_hack"}
    elif sub == "buy-module":
        msg = {"type":"action","action":"buy_hack_module"}
    elif sub == "encrypt":
        msg = {"type":"action","action":"buy_encryption"}
    elif sub == "bypass-cd":
        msg = {"type":"action","action":"bypass_hack_cooldown"}
    else:
        sys.exit("Unknown hack subcommand. Try: start, buy-module, encrypt, bypass-cd")
    res = _run(server, pid, token, [msg])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok":
            s = r.get("state",{}); print(f"OK  →  ${_fmt(s.get('money',0))}")
            if r.get("action")=="buy_encryption": print(f"Encryption active until: {time.strftime('%H:%M:%S',time.localtime(r.get('expires',0)))}")

def cmd_blackjack(args):
    pid, token, server = _require_creds()
    sub = args.bj_cmd
    if sub == "deal":
        msg = {"type":"bj_deal","bet":args.bet}
    elif sub == "hit":
        msg = {"type":"bj_hit"}
    elif sub == "stand":
        msg = {"type":"bj_stand"}
    else:
        sys.exit("Unknown blackjack subcommand. Try: deal <bet>, hit, stand")
    res = _run(server, pid, token, [msg])
    _print_banner()
    for r in res[1:]:
        t = r.get("type","")
        if t == "error": print(f"Error: {r.get('msg')}")
        elif t == "bj_state":
            print(f"Your hand : {r.get('player_hand')}  = {r.get('player_val')}")
            print(f"Dealer    : {r.get('dealer_hand')}")
        elif t == "bj_result":
            result   = r.get("result","")
            winnings = r.get("winnings",0)
            print(f"Result    : {result.upper()}  winnings: ${_fmt(winnings)}")
            if "state" in r: print(f"Balance   : ${_fmt(r['state']['money'])}")

def cmd_roulette(args):
    pid, token, server = _require_creds()
    msg = {"type":"roulette_spin","bet":args.bet,"bet_type":args.bet_type}
    if args.number is not None: msg["number"] = args.number
    res = _run(server, pid, token, [msg])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="roulette_result":
            print(f"Spin      : {r.get('number')} {r.get('color','')}")
            print(f"Result    : {'WIN' if r.get('win') else 'LOSS'}  payout: ${_fmt(r.get('payout',0))}")
            if "state" in r: print(f"Balance   : ${_fmt(r['state']['money'])}")

def cmd_crash(args):
    pid, token, server = _require_creds()
    sub = args.crash_cmd
    if sub == "start":
        msg = {"type":"crash_start","bet":args.bet}
    elif sub == "cashout":
        msg = {"type":"crash_cashout"}
    else:
        sys.exit("Unknown crash subcommand. Try: start <bet>, cashout")
    res = _run(server, pid, token, [msg])
    _print_banner()
    for r in res[1:]:
        t = r.get("type","")
        if t == "error": print(f"Error: {r.get('msg')}")
        elif t == "crash_state": print(f"Multiplier: {r.get('multiplier','?')}×  (use: idlesys crash cashout)")
        elif t == "crash_result":
            print(f"Result    : {r.get('result','?')}  payout: ${_fmt(r.get('payout',0))}")
            if "state" in r: print(f"Balance   : ${_fmt(r['state']['money'])}")

def cmd_market(args):
    pid, token, server = _require_creds()
    res  = _run(server, pid, token, [{"type":"action","action":"get_market"}])
    lo   = res[0]; mr = next((r for r in res[1:] if r.get("action")=="get_market"), None)
    mkt  = lo.get("market",{})
    prices    = (mr or {}).get("prices")    or mkt.get("prices",{})
    portfolio = (mr or {}).get("portfolio") or mkt.get("portfolio",{})
    supply    = (mr or {}).get("supply")    or mkt.get("supply",{})
    _print_banner()
    print(f"\n  {'ASSET':<6} {'PRICE':>12} {'YOU':>6} {'AVAIL':>8} {'TOTAL':>8}")
    print("  " + "─"*44)
    for asset, price in prices.items():
        sup = supply.get(asset, {})
        print(f"  {asset:<6} ${_fmt(price):>11} {portfolio.get(asset,0):>6} {sup.get('available','?'):>8} {sup.get('total','?'):>8}")
    print()

def cmd_market_buy(args):
    pid, token, server = _require_creds()
    res = _run(server, pid, token, [{"type":"action","action":"market_buy","asset":args.asset.upper(),"qty":args.qty}])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok": print(f"Bought {args.qty}× {args.asset.upper()}  →  ${_fmt(r['state']['money'])}")

def cmd_market_sell(args):
    pid, token, server = _require_creds()
    res = _run(server, pid, token, [{"type":"action","action":"market_sell","asset":args.asset.upper(),"qty":args.qty}])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok": print(f"Sold {args.qty}× {args.asset.upper()}  →  ${_fmt(r['state']['money'])}")

def cmd_gift(args):
    pid, token, server = _require_creds()
    res = _run(server, pid, token, [{"type":"action","action":"send_money","target_id":args.target,"amount":args.amount}])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok": print(f"Sent ${_fmt(args.amount)}  →  balance: ${_fmt(r['state']['money'])}")

def cmd_badge(args):
    pid, token, server = _require_creds()
    sub = args.badge_cmd
    if sub == "redeem":
        msg = {"type":"action","action":"redeem_badge","code":args.code}
    elif sub == "set":
        msg = {"type":"action","action":"set_active_badge","badge":args.badge}
    elif sub == "list":
        res = _run(server, pid, token, [])
        _print_banner()
        state = res[0].get("state",{})
        badges = state.get("badges",[])
        active = state.get("badge","")
        print(f"\n  Badges: {', '.join(badges) if badges else '(none)'}")
        if active: print(f"  Active: {active}")
        print()
        return
    else:
        sys.exit("Unknown badge subcommand. Try: list, redeem <code>, set <badge>")
    res = _run(server, pid, token, [msg])
    _print_banner()
    for r in res[1:]:
        if r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="action_ok":
            state = r.get("state",{})
            print(f"OK  badges: {', '.join(state.get('badges',[]))}  active: {state.get('badge','')}")

def cmd_achievements(args):
    pid, token, server = _require_creds()
    res   = _run(server, pid, token, [])
    lo    = res[0]
    state = lo.get("state",{})
    _print_banner(lo.get("server_version",""))
    earned = state.get("achievements",[])
    all_ach = [
        ("phantom",   "Phantom",    "Complete 10 successful hacks"),
        ("vault",     "Vault",      "Accumulate $1Qa total earnings"),
        ("highroller","High Roller","Wager $1T at the casino"),
        ("kingpin",   "Kingpin",    "Reach #1 on the leaderboard"),
        ("ghost",     "Ghost",      "Survive 10 hack attempts"),
    ]
    print("\n  [ ACHIEVEMENTS ]")
    for key, name, desc in all_ach:
        status = "✓" if key in earned else "✗"
        print(f"  {status} {name:<14} — {desc}")
    print()

def cmd_changelog(args):
    _, _, server = _get_creds(); server = server or DEFAULT_SERVER
    try:
        with urllib.request.urlopen(f"{_http_url(server)}/api/changelog", timeout=8) as r:
            data = json.loads(r.read())
    except Exception as e:
        sys.exit(f"Failed: {e}")
    _print_banner()
    print("\n[ CHANGELOG ]")
    for version, entries in data.items():
        print(f"\n  v{version}")
        for entry in entries:
            for i, line in enumerate(textwrap.wrap(entry, 76)):
                print(f"    {'•' if i==0 else ' '} {line}")
    print()

def cmd_leaderboard(args):
    _, _, server = _get_creds(); server = server or DEFAULT_SERVER
    try:
        with urllib.request.urlopen(f"{_http_url(server)}/api/leaderboard?limit=10", timeout=8) as r:
            lb = json.loads(r.read())
    except Exception as e:
        sys.exit(f"Failed: {e}")
    _print_banner()
    print("\n[ LEADERBOARD ]")
    medals = ["1st","2nd","3rd"]
    for i, p in enumerate(lb):
        rk  = medals[i] if i < 3 else f" {i+1}."
        dot = "●" if p.get("online") else "○"
        print(f"  {rk:<4} {dot} {(p.get('name') or 'Anon')[:20]:<20}  ${p.get('money_fmt','?')}")
    print()

def cmd_chat(args):
    pid, token, server = _require_creds()
    _print_banner()
    print("Sending chat message…")
    res = _run(server, pid, token, [{"type":"chat_send","text":args.text}])
    for r in res[1:]:
        if r.get("type")=="chat_rate_limit": print("Rate limited — wait 2 seconds between messages.")
        elif r.get("type")=="error": print(f"Error: {r.get('msg')}")
        elif r.get("type")=="chat_msg": print(f"Sent: {r.get('text')}")

def cmd_register(args):
    server = args.server or DEFAULT_SERVER
    _print_banner()
    print("Creating a new account...")
    async def _go():
        import websockets
        # Generate a fresh UUID — server sees a new ID, issues token_issued then login_ok
        new_pid = str(uuid.uuid4())
        async with websockets.connect(_ws_url(server), ping_interval=None) as ws:
            await ws.send(json.dumps({"type": "login", "player_id": new_pid}))
            pid = new_pid; token = ""
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                t = m.get("type")
                if t == "token_issued":
                    token = m["token"]
                elif t == "require_tos":
                    print(f"\nAccept TOS at: {_http_url(server)}/web/tos")
                    print("Then run: idlesys accept-tos")
                    await ws.send(json.dumps({"type": "action", "action": "accept_tos"}))
                elif t == "login_ok":
                    state = m.get("state", {})
                    pid   = state.get("id", "")
                    ret   = m.get("login_token", token)
                    if ret: token = ret
                    if pid and token:
                        cfg = _load_config()
                        cfg.update({"player_id": pid, "login_token": token, "server": server})
                        _save_config(cfg)
                        print(f"\n  New account created!")
                        print(f"  Player ID : {pid}")
                        print(f"  Token     : {token}")
                        print(f"  Saved to  : {CONFIG_FILE}")
                        print(f"\n  Run: idlesys tui")
                    else:
                        sys.exit("Server did not return a player ID — try again.")
                    break
                elif t == "error":
                    sys.exit(f"Error: {m.get('msg')}")
    asyncio.run(_go())

def cmd_accept_tos(args):
    pid, token, server = _require_creds()
    async def _go():
        import websockets
        async with websockets.connect(_ws_url(server), ping_interval=None) as ws:
            login = {"type":"login","player_id":pid}
            if token: login["login_token"] = token
            await ws.send(json.dumps(login))
            tos_seen = False
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                t = m.get("type")
                if t == "require_tos":
                    tos_seen = True
                    await ws.send(json.dumps({"type":"action","action":"accept_tos"}))
                elif t == "action_ok" and m.get("action") == "accept_tos":
                    print("TOS accepted."); break
                elif t == "login_ok" and not tos_seen:
                    print("TOS already accepted."); break
                elif t == "error":
                    sys.exit(f"Error: {m.get('msg')}")
    _print_banner(); asyncio.run(_go())

def cmd_script(args):
    raw = sys.stdin.read() if args.file=="-" else Path(args.file).read_text()
    try: actions = json.loads(raw)
    except json.JSONDecodeError as e: sys.exit(f"Invalid JSON: {e}")
    if not isinstance(actions, list): sys.exit("Must be a JSON array.")
    pid, token, server = _require_creds()
    results = _run(server, pid, token, actions)
    print(json.dumps(results if args.verbose else results[1:], indent=2))

def cmd_raw(args):
    try: msg = json.loads(args.json)
    except json.JSONDecodeError as e: sys.exit(f"Invalid JSON: {e}")
    pid, token, server = _require_creds()
    print(json.dumps(_run(server, pid, token, [msg])[1:], indent=2))

# ─── TUI ──────────────────────────────────────────────────────────────────────

def cmd_tui(args):
    _check_deps()
    pid, token, server = _require_creds()

    from textual.app        import App, ComposeResult
    from textual.widgets    import (Static, Button, RichLog,
                                    TabbedContent, TabPane, Input)
    from textual.containers import Horizontal, Vertical
    from textual.reactive   import reactive
    from textual            import work
    from textual.binding    import Binding
    from textual.screen     import Screen
    import websockets

    _G = "#00ff6e"; _A = "#ffb700"; _B = "#4da6ff"; _R = "#ff3c3c"
    _M = "#3a6b4a"; _BG = "#080c0a"; _SF = "#0d1510"; _BR = "#1a3020"

    _BASE_CSS = f"""
Screen {{ background: {_BG}; color: #b8f0cb; }}
.section {{ color: {_M}; text-style: bold; margin-bottom: 1; }}
.green {{ color: {_G}; }} .amber {{ color: {_A}; }} .red {{ color: {_R}; }} .muted {{ color: {_M}; }}
Button {{ background: {_SF}; border: solid {_BR}; color: #b8f0cb; margin-bottom: 1; width: 100%; }}
Button:hover {{ border: solid {_M}; color: {_G}; }}
Button.-primary {{ border: solid #00a847; color: {_G}; }}
Button.-warning {{ border: solid {_A}; color: {_A}; }}
Button.-error   {{ border: solid {_R}; color: {_R}; }}
Input {{ background: {_BG}; border: solid {_BR}; color: #b8f0cb; margin-bottom: 1; }}
RichLog {{ border: solid {_BR}; background: #060a07; padding: 0 1; height: 1fr; }}
"""

    # ── Onboarding screen (TOS + name) ────────────────────────────────────
    class OnboardScreen(Screen):
        CSS = _BASE_CSS + f"""
OnboardScreen {{ align: center middle; }}
#ob-box {{ width: 60; border: solid {_G}; background: {_SF}; padding: 2 4; }}
#ob-title {{ color: {_G}; text-style: bold; text-align: center; margin-bottom: 1; }}
#ob-body  {{ color: #b8f0cb; margin-bottom: 2; }}
#ob-err   {{ color: {_R}; height: 1; margin-bottom: 1; }}
"""
        def __init__(self, need_tos: bool, need_name: bool, ws_send, **kw):
            super().__init__(**kw)
            self._need_tos  = need_tos
            self._need_name = need_name
            self._ws_send   = ws_send
            self._tos_done  = not need_tos

        def compose(self) -> ComposeResult:
            with Vertical(id="ob-box"):
                yield Static("[ IDLE.SYS ]  SETUP", id="ob-title")
                if self._need_tos and not self._tos_done:
                    yield Static(
                        f"Before playing you must accept the Terms of Service.\n\n"
                        f"  {_http_url(server)}/web/tos\n\n"
                        "Read the terms above, then click Accept.",
                        id="ob-body"
                    )
                    yield Static("", id="ob-err")
                    yield Button("ACCEPT TERMS OF SERVICE", id="btn-tos", variant="primary")
                    yield Button("QUIT",                    id="btn-ob-quit", variant="error")
                else:
                    yield Static(
                        "Choose a display name.\n\n"
                        "  2–20 characters, letters/numbers/spaces.\n"
                        "  Your first name change is free.",
                        id="ob-body"
                    )
                    yield Static("", id="ob-err")
                    yield Input(placeholder="Enter your name…", id="ob-name")
                    yield Button("SET NAME", id="btn-set-name", variant="primary")
                    yield Button("QUIT",     id="btn-ob-quit",  variant="error")

        def _err(self, msg: str):
            try: self.query_one("#ob-err", Static).update(f"[red]{msg}[/]")
            except Exception: pass

        def on_button_pressed(self, event: Button.Pressed):
            if event.button.id == "btn-ob-quit":
                self.app.exit()
            elif event.button.id == "btn-tos":
                self._ws_send({"type": "action", "action": "accept_tos"})
            elif event.button.id == "btn-set-name":
                name = ""
                try: name = self.query_one("#ob-name", Input).value.strip()
                except Exception: pass
                if len(name) < 2:
                    self._err("Name must be at least 2 characters.")
                    return
                self._ws_send({"type": "action", "action": "set_name", "name": name})

        def on_input_submitted(self, event: Input.Submitted):
            if event.input.id == "ob-name":
                name = event.value.strip()
                if len(name) < 2:
                    self._err("Name must be at least 2 characters.")
                    return
                self._ws_send({"type": "action", "action": "set_name", "name": name})

        def tos_accepted(self):
            self._tos_done = True
            if self._need_name:
                self.query_one("#ob-body", Static).update(
                    "TOS accepted!\n\nNow choose a display name.\n\n"
                    "  2–20 characters. First change is free."
                )
                self.query_one("#ob-err", Static).update("")
                try: self.query_one("#btn-tos", Button).remove()
                except Exception: pass
                self.mount(Input(placeholder="Enter your name…", id="ob-name"),     after="#ob-err")
                self.mount(Button("SET NAME", id="btn-set-name", variant="primary"), after="#ob-name")
            else:
                self.app.pop_screen()

    # ── Main app ──────────────────────────────────────────────────────────
    class IdleSysApp(App):
        CSS = _BASE_CSS + f"""
#topbar {{ height: 1; background: {_BG}; padding: 0 1; }}
TabbedContent {{ height: 1fr; }}
TabPane {{ padding: 1 2; }}
#main-split {{ layout: horizontal; height: 1fr; }}
#sidebar {{ width: 32; border-right: solid {_BR}; padding: 1 1; }}
#content {{ width: 1fr; }}
#balance {{ color: {_G}; text-style: bold; height: 2; }}
#income  {{ color: #00a847; height: 1; margin-bottom: 1; }}
#stats   {{ margin-bottom: 1; height: 6; }}
#mktpanel {{ margin-bottom: 1; }}
.casino-row {{ layout: horizontal; height: 3; margin-bottom: 1; }}
.casino-row Input  {{ width: 1fr; margin-right: 1; margin-bottom: 0; }}
.casino-row Button {{ width: auto; min-width: 12; margin-bottom: 0; }}
#bj-status    {{ height: 3; border: solid {_BR}; padding: 0 1; margin-bottom: 1; }}
#crash-status {{ height: 2; border: solid {_BR}; padding: 0 1; margin-bottom: 1; }}
#rl-status    {{ height: 2; border: solid {_BR}; padding: 0 1; margin-bottom: 1; }}
#casino-log   {{ height: 1fr; }}
#poker-log    {{ height: 1fr; }}
#hack-status  {{ height: 3; border: solid {_BR}; padding: 0 1; margin-bottom: 1; }}
"""

        BINDINGS = [
            Binding("c", "click_once",      "Click"),
            Binding("C", "click_ten",       "×10"),
            Binding("q", "quit",            "Quit"),
            Binding("?", "show_changelog",  "Changelog"),
            Binding("r", "refresh_market",  "Refresh market"),
        ]

        state:        reactive[dict] = reactive({})
        market:       reactive[dict] = reactive({})
        portfolio:    reactive[dict] = reactive({})
        connected:    reactive[bool] = reactive(False)
        srv_ver:      reactive[str]  = reactive("")
        login_streak: reactive[int]  = reactive(1)
        _ws = None
        _need_tos  = False
        _need_name = False

        # ── Layout ────────────────────────────────────────────────────────
        def compose(self) -> ComposeResult:
            yield Static("", id="topbar")
            with Horizontal(id="main-split"):
                with Vertical(id="sidebar"):
                    yield Static("BALANCE", classes="section")
                    yield Static("", id="balance")
                    yield Static("", id="income")
                    yield Static("STATS", classes="section")
                    yield Static("", id="stats")
                    yield Static("ACTIONS", classes="section")
                    yield Button("[ CLICK ]  c",      id="btn-click",   variant="primary")
                    yield Button("[ CLICK ×10 ]  C",  id="btn-click10")
                    yield Button("[ PRESTIGE ]",       id="btn-prestige")
                    yield Button("[ CHANGELOG ]  ?",   id="btn-cl")
                    yield Button("[ QUIT ]  q",        id="btn-quit",    variant="error")

                with Vertical(id="content"):
                    with TabbedContent(initial="tab-home"):

                        with TabPane("HOME", id="tab-home"):
                            yield Static("MARKET PRICES", classes="section")
                            yield Static("", id="mktpanel")
                            yield Static("EVENT LOG", classes="section")
                            yield RichLog(id="event-log", markup=True)

                        with TabPane("BLACKJACK", id="tab-bj"):
                            yield Static("BLACKJACK", classes="section")
                            yield Static("Awaiting deal…", id="bj-status")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Bet", id="bj-bet")
                                yield Button("DEAL",  id="btn-bj-deal",  variant="primary")
                                yield Button("HIT",   id="btn-bj-hit")
                                yield Button("STAND", id="btn-bj-stand", variant="warning")
                            yield Static("CASINO LOG", classes="section")
                            yield RichLog(id="casino-log", markup=True)

                        with TabPane("ROULETTE", id="tab-rl"):
                            yield Static("ROULETTE", classes="section")
                            yield Static("Place a bet and spin.", id="rl-status")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Bet", id="rl-bet")
                                yield Button("RED",   id="btn-rl-red",   variant="error")
                                yield Button("BLACK", id="btn-rl-black")
                                yield Button("EVEN",  id="btn-rl-even")
                                yield Button("ODD",   id="btn-rl-odd")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Number 0–36", id="rl-number")
                                yield Button("BET NUMBER", id="btn-rl-number", variant="warning")
                            yield Static("CASINO LOG", classes="section")
                            yield RichLog(id="casino-log2", markup=True)

                        with TabPane("CRASH", id="tab-crash"):
                            yield Static("CRASH", classes="section")
                            yield Static("Start a round — cash out before it crashes!", id="crash-status")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Bet", id="crash-bet")
                                yield Button("START",    id="btn-crash-start", variant="primary")
                                yield Button("CASH OUT", id="btn-crash-out",   variant="warning")
                            yield Static("CASINO LOG", classes="section")
                            yield RichLog(id="casino-log3", markup=True)

                        with TabPane("POKER", id="tab-poker"):
                            yield Static("POKER", classes="section")
                            yield Static("", id="poker-status")
                            with Horizontal(classes="casino-row"):
                                yield Button("LIST ROOMS",   id="btn-pk-list",   variant="primary")
                                yield Button("CREATE ROOM",  id="btn-pk-create")
                                yield Button("LEAVE ROOM",   id="btn-pk-leave",  variant="error")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Room name", id="pk-room-name")
                                yield Input(placeholder="Min bet",   id="pk-min-bet")
                                yield Button("START GAME", id="btn-pk-start", variant="primary")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Raise amount", id="pk-raise")
                                yield Button("FOLD",  id="btn-pk-fold",  variant="error")
                                yield Button("CHECK", id="btn-pk-check")
                                yield Button("CALL",  id="btn-pk-call",  variant="primary")
                                yield Button("RAISE", id="btn-pk-raise", variant="warning")
                            yield RichLog(id="poker-log", markup=True)

                        with TabPane("HACK", id="tab-hack"):
                            yield Static("HACKING", classes="section")
                            yield Static("", id="hack-status")
                            yield Button("BUY HACK MODULE  ($2.5M)",  id="btn-hack-module")
                            yield Button("START HACK",                 id="btn-hack-start", variant="primary")
                            yield Button("BUY ENCRYPTION  (20%)",      id="btn-hack-enc",   variant="warning")
                            yield Button("BYPASS COOLDOWN  (1 token)", id="btn-hack-cd")
                            yield RichLog(id="hack-log", markup=True)

                        with TabPane("MARKET", id="tab-market"):
                            yield Static("STOCK MARKET", classes="section")
                            yield Static("", id="mkt-full")
                            with Horizontal(classes="casino-row"):
                                yield Input(placeholder="Asset (GPU/SRV/…)", id="mkt-asset")
                                yield Input(placeholder="Qty (-1=all)",       id="mkt-qty")
                                yield Button("BUY",  id="btn-mkt-buy",  variant="primary")
                                yield Button("SELL", id="btn-mkt-sell", variant="warning")

                        with TabPane("CHAT", id="tab-chat"):
                            yield RichLog(id="chat-log", markup=True)
                            yield Input(placeholder="Type and press Enter…", id="chat-input")

                        with TabPane("ACCOUNT", id="tab-account"):
                            yield Static("", id="acct-info")
                            yield Input(placeholder="New name (costs 1 token after first)", id="acct-name")
                            yield Button("SET NAME", id="btn-acct-name", variant="primary")
                            yield Static("", id="acct-name-err")

        # ── Mount ─────────────────────────────────────────────────────────
        def on_mount(self):
            self._update_topbar("connecting…")
            self._connect()
            self.set_interval(1.0, self._tick_income)

        def _tick_income(self):
            if self.state and self.connected:
                s = dict(self.state)
                s["money"] = int(s.get("money", 0)) + int(s.get("income_per_sec", 0))
                self.state = s

        # ── WS connection ─────────────────────────────────────────────────
        @work(exclusive=True, thread=False)
        async def _connect(self):
            self._log("event-log", "[dim]Connecting…[/]")
            try:
                async with websockets.connect(_ws_url(server), ping_interval=20) as ws:
                    self._ws = ws
                    login = {"type": "login", "player_id": pid}
                    if token: login["login_token"] = token
                    await ws.send(json.dumps(login))
                    async for raw in ws:
                        self._handle_msg(json.loads(raw))
            except Exception as e:
                self._log("event-log", f"[red]Disconnected: {e}[/]")
                self.connected = False
                await asyncio.sleep(5)
                self._connect()

        # ── Message handler ───────────────────────────────────────────────
        def _handle_msg(self, msg: dict):
            t = msg.get("type", "")

            if t == "token_issued":
                cfg = _load_config()
                cfg["login_token"] = msg["token"]
                cfg["player_id"]   = pid
                _save_config(cfg)
                self._log("event-log", "[yellow]Token saved.[/]")

            elif t == "require_tos":
                self._need_tos = True
                self._maybe_push_onboard()

            elif t == "error":
                err = msg.get("msg", "")
                self._log("event-log", f"[red]Error: {err}[/]")
                # Surface errors inside onboard screen if it's active
                if self.screen_stack and isinstance(self.screen_stack[-1], OnboardScreen):
                    self.screen_stack[-1]._err(err)
                # Surface name errors in account tab
                try: self.query_one("#acct-name-err", Static).update(f"[red]{err}[/]")
                except Exception: pass

            elif t == "login_ok":
                self.connected = True
                self.srv_ver   = msg.get("server_version", "")
                self.state     = msg.get("state", {})
                mkt            = msg.get("market", {})
                self.market    = mkt.get("prices", {})
                self.portfolio = mkt.get("portfolio", {})
                name           = self.state.get("name") or ""
                offline        = msg.get("offline_earned", 0)
                streak         = msg.get("login_streak", 1)
                bonus          = msg.get("streak_bonus", 1.0)
                self.login_streak = streak
                self._log("event-log", f"[green]Connected as [bold]{name or '(unnamed)'}[/][/]")
                if offline: self._log("event-log", f"[cyan]Offline: +${_fmt(offline)}[/]")
                if bonus > 1.0: self._log("event-log", f"[yellow]Streak ×{bonus:.2f} — day {streak}[/]")
                if msg.get("show_changelog"): self._fetch_and_log_changelog()
                self._update_account_tab()
                for cm in msg.get("chat_history", []):
                    self._render_chat(cm)
                self._need_name = not bool(name)
                self._maybe_push_onboard()

            elif t == "action_ok":
                action = msg.get("action", "")
                if "state" in msg:
                    self.state = msg["state"]
                    self._update_account_tab()

                if action in ("market_buy", "market_sell", "get_market"):
                    self.market    = msg.get("prices",    self.market)
                    self.portfolio = msg.get("portfolio", self.portfolio)
                    if action == "market_buy":
                        self._log("event-log", f"[green]Bought {msg.get('qty')}× {msg.get('asset')}[/]")
                    elif action == "market_sell":
                        self._log("event-log", f"[cyan]Sold {msg.get('qty')}× {msg.get('asset')}[/]")

                elif action == "accept_tos":
                    if self.screen_stack and isinstance(self.screen_stack[-1], OnboardScreen):
                        self.screen_stack[-1].tos_accepted()
                    self._need_tos = False

                elif action == "set_name":
                    name = self.state.get("name", "")
                    self._log("event-log", f"[green]Name set to: {name}[/]")
                    self._need_name = False
                    # Dismiss onboard screen if it was showing for name
                    if self.screen_stack and isinstance(self.screen_stack[-1], OnboardScreen):
                        self.pop_screen()
                    try: self.query_one("#acct-name-err", Static).update("[green]Name updated![/]")
                    except Exception: pass

                elif action == "prestige":
                    self._log("event-log", f"[magenta]Prestige #{self.state.get('prestige_count')}![/]")
                elif action == "buy_encryption":
                    exp = time.strftime("%H:%M", time.localtime(msg.get("expires", 0)))
                    self._log("hack-log", f"[green]Encryption active until {exp}[/]")
                elif action == "buy_hack_module":
                    self._log("hack-log", "[green]Hack module installed.[/]")

            elif t == "chat_history":
                for cm in msg.get("messages", []):
                    self._render_chat(cm)

            elif t == "chat_msg":
                self._render_chat(msg)

            elif t == "bj_state":
                ph = msg.get("player_hand", "?")
                pv = msg.get("player_val",  "?")
                dh = msg.get("dealer_hand", "?")
                self.query_one("#bj-status", Static).update(
                    f"Your hand: {ph} = [green]{pv}[/]   Dealer: {dh}"
                )
                self._log("casino-log", f"[dim]BJ: your {pv} vs dealer {dh}[/]")

            elif t == "bj_result":
                result   = msg.get("result", "").upper()
                winnings = msg.get("winnings", 0)
                col      = "green" if result in ("WIN","BLACKJACK") else ("yellow" if result == "PUSH" else "red")
                self.query_one("#bj-status", Static).update(
                    f"[{col}]{result}[/]  —  winnings: ${_fmt(winnings)}"
                )
                self._log("casino-log", f"[{col}]BJ {result}: ${_fmt(winnings)}[/]")
                if "state" in msg: self.state = msg["state"]

            elif t == "roulette_result":
                number = msg.get("number", "?")
                color  = msg.get("color", "")
                payout = msg.get("payout", 0)
                win    = msg.get("win", False)
                col    = "green" if win else "red"
                self.query_one("#rl-status", Static).update(
                    f"[{col}]{number} {color.upper()}[/]  —  {'won' if win else 'lost'} ${_fmt(abs(payout))}"
                )
                self._log("casino-log2", f"[{col}]Roulette {number} {color}: {'WON' if win else 'LOST'} ${_fmt(abs(payout))}[/]")
                if "state" in msg: self.state = msg["state"]

            elif t == "crash_state":
                mult = msg.get("multiplier", "?")
                self.query_one("#crash-status", Static).update(
                    f"[yellow]● {mult}×[/]  — cash out now!"
                )

            elif t == "crash_result":
                result = msg.get("result", "?")
                payout = msg.get("payout", 0)
                col    = "green" if payout > 0 else "red"
                self.query_one("#crash-status", Static).update(
                    f"[{col}]{result.upper()}[/]  —  payout: ${_fmt(payout)}"
                )
                self._log("casino-log3", f"[{col}]Crash {result.upper()}: ${_fmt(payout)}[/]")
                if "state" in msg: self.state = msg["state"]

            elif t == "hack_started":
                self._log("hack-log", "[green]Hack started![/]")

            elif t == "hack_result":
                stolen = msg.get("stolen", 0)
                if stolen:
                    self._log("hack-log", f"[green]Hack complete — stole ${_fmt(stolen)}[/]")
                else:
                    self._log("hack-log", "[red]Hack failed / defended.[/]")
                if "state" in msg: self.state = msg["state"]

            elif t == "broadcast":
                self._log("event-log", f"[yellow][ SERVER ] {msg.get('msg')}[/]")

            elif t == "notification":
                self._log("event-log", f"[cyan][!] {msg.get('msg')}[/]")

            elif t == "market_update":
                self.market = msg.get("prices", self.market)

            elif t == "chat_rate_limit":
                self._log("chat-log", "[red]Rate limited — wait 2s[/]")

            elif t == "trade_offer":
                self._log("event-log",
                    f"[yellow]Trade offer from {msg.get('from_name','?')}: "
                    f"they offer ${_fmt(msg.get('offer_money',0))}, want ${_fmt(msg.get('request_money',0))}  "
                    f"(id: {msg.get('trade_id','')})[/]"
                )

            elif t == "poker_list_rooms":
                rooms = msg.get("rooms", [])
                self._log("poker-log", f"[green]Rooms ({len(rooms)}):[/]")
                for r in rooms:
                    self._log("poker-log",
                        f"  [dim]{r.get('id','')}[/] {r.get('name','?')} "
                        f"min_bet=${_fmt(r.get('min_bet',0))} "
                        f"players={r.get('player_count',0)}"
                    )
                if not rooms:
                    self._log("poker-log", "  [dim]No open rooms — create one![/]")
                self.query_one("#poker-status", Static).update(
                    f"[dim]{len(rooms)} open room(s)[/]"
                )

            elif t in ("poker_state", "poker_update"):
                self._handle_poker_state(msg)

        # ── Poker state display ───────────────────────────────────────────
        def _handle_poker_state(self, msg: dict):
            game = msg.get("game") or msg
            hand = game.get("your_hand", [])
            pot  = game.get("pot", 0)
            stage = game.get("stage", "")
            comm  = game.get("community_cards", [])
            self.query_one("#poker-status", Static).update(
                f"Stage: [green]{stage}[/]   Pot: ${_fmt(pot)}\n"
                f"Your hand: [green]{' '.join(hand) if hand else '—'}[/]   "
                f"Community: {' '.join(comm) if comm else '—'}"
            )
            self._log("poker-log", f"[dim]{stage}[/] pot=${_fmt(pot)} hand={hand}")

        # ── Onboarding ────────────────────────────────────────────────────
        def _maybe_push_onboard(self):
            if not (self._need_tos or self._need_name):
                return
            if self.screen_stack and isinstance(self.screen_stack[-1], OnboardScreen):
                return
            self.push_screen(OnboardScreen(
                need_tos=self._need_tos,
                need_name=self._need_name,
                ws_send=self._send,
            ))

        # ── Reactive watchers ─────────────────────────────────────────────
        def watch_state(self, s: dict):
            if not s: return
            try:
                self.query_one("#balance", Static).update(f"[bold green]${_fmt(s.get('money', 0))}[/]")
                self.query_one("#income",  Static).update(f"[dim]+${_fmt(s.get('income_per_sec', 0))}/s[/]")
                self.query_one("#stats",   Static).update(
                    f"Clicks   [green]{_fmt(s.get('clicks', 0))}[/]\n"
                    f"Prestige [green]{s.get('prestige_count', 0)}[/]\n"
                    f"Streak   [green]{self.login_streak}d[/]\n"
                    f"PP       [green]{_fmt(s.get('prestige_points', 0))}[/]\n"
                    f"Tokens   [green]{s.get('name_tokens', 0)}[/]"
                )
                enc = s.get("encryption_active", False)
                cd  = s.get("hack_cooldown_end")
                cd_str = (f"CD ends {time.strftime('%H:%M', time.localtime(cd))}" if cd and cd > time.time() else "ready")
                self.query_one("#hack-status", Static).update(
                    f"Module : {'[green]installed[/]' if s.get('hack_unlocked') else '[red]not installed[/]'}\n"
                    f"Encrypt: {'[green]ACTIVE[/]' if enc else '[dim]inactive[/]'}\n"
                    f"Status : [dim]{cd_str}[/]"
                )
            except Exception:
                pass

        def watch_connected(self, c: bool):
            name = (self.state or {}).get("name", "")
            dot  = "[green]●[/]" if c else "[red]●[/]"
            self._update_topbar(f"{dot} {'online' if c else 'offline'}" + (f"  [dim]{name}[/]" if name else ""))

        def _update_topbar(self, status: str):
            try:
                self.query_one("#topbar", Static).update(
                    f"[bold green]IDLE.SYS[/]  [dim]CLI v{CLI_VERSION}[/]  "
                    f"[dim]srv v{self.srv_ver}[/]  {status}"
                )
            except Exception:
                pass

        def watch_market(self, prices: dict):
            if not prices: return
            lines = []
            for asset, price in prices.items():
                held = self.portfolio.get(asset, 0)
                h    = f" [dim](×{held})[/]" if held else ""
                lines.append(f"  [green]{asset:<5}[/] ${_fmt(price):<10}{h}")
            mkt_str = "\n".join(lines)
            try: self.query_one("#mktpanel", Static).update(mkt_str)
            except Exception: pass
            try: self.query_one("#mkt-full", Static).update(mkt_str)
            except Exception: pass

        # ── Button handlers ───────────────────────────────────────────────
        def on_button_pressed(self, event: Button.Pressed):
            bid = event.button.id
            # Core
            if   bid == "btn-click":       self._send({"type":"action","action":"click"})
            elif bid == "btn-click10":     [self._send({"type":"action","action":"click"}) for _ in range(10)]
            elif bid == "btn-prestige":    self._send({"type":"action","action":"prestige"})
            elif bid == "btn-cl":          self._fetch_and_log_changelog()
            elif bid == "btn-quit":        self.action_quit()
            # Blackjack
            elif bid == "btn-bj-deal":     self._bj_deal()
            elif bid == "btn-bj-hit":      self._send({"type":"bj_hit"})
            elif bid == "btn-bj-stand":    self._send({"type":"bj_stand"})
            # Roulette
            elif bid == "btn-rl-red":      self._rl_spin("red")
            elif bid == "btn-rl-black":    self._rl_spin("black")
            elif bid == "btn-rl-even":     self._rl_spin("even")
            elif bid == "btn-rl-odd":      self._rl_spin("odd")
            elif bid == "btn-rl-number":   self._rl_spin("number")
            # Crash
            elif bid == "btn-crash-start": self._crash_start()
            elif bid == "btn-crash-out":   self._send({"type":"crash_cashout"})
            # Poker
            elif bid == "btn-pk-list":     self._send({"type":"poker_list_rooms"})
            elif bid == "btn-pk-create":   self._pk_create()
            elif bid == "btn-pk-leave":    self._send({"type":"poker_leave_room"})
            elif bid == "btn-pk-start":    self._send({"type":"poker_start_game"})
            elif bid == "btn-pk-fold":     self._send({"type":"poker_action","action":"fold"})
            elif bid == "btn-pk-check":    self._send({"type":"poker_action","action":"check"})
            elif bid == "btn-pk-call":     self._send({"type":"poker_action","action":"call"})
            elif bid == "btn-pk-raise":    self._pk_raise()
            # Hack
            elif bid == "btn-hack-module": self._send({"type":"action","action":"buy_hack_module"})
            elif bid == "btn-hack-start":  self._send({"type":"start_hack"})
            elif bid == "btn-hack-enc":    self._send({"type":"action","action":"buy_encryption"})
            elif bid == "btn-hack-cd":     self._send({"type":"action","action":"bypass_hack_cooldown"})
            # Market
            elif bid == "btn-mkt-buy":     self._mkt_trade("market_buy")
            elif bid == "btn-mkt-sell":    self._mkt_trade("market_sell")
            # Account
            elif bid == "btn-acct-name":   self._set_name()

        def on_input_submitted(self, event: Input.Submitted):
            if event.input.id == "chat-input":
                text = event.value.strip()
                if text:
                    self._send({"type":"chat_send","text":text})
                    event.input.clear()
            elif event.input.id in ("bj-bet",):
                self._bj_deal()
            elif event.input.id in ("crash-bet",):
                self._crash_start()
            elif event.input.id in ("rl-bet", "rl-number"):
                pass  # bet type chosen via button

        def action_click_once(self):     self._send({"type":"action","action":"click"})
        def action_click_ten(self):      [self._send({"type":"action","action":"click"}) for _ in range(10)]
        def action_refresh_market(self): self._send({"type":"action","action":"get_market"})
        def action_show_changelog(self): self._fetch_and_log_changelog()

        # ── Casino helpers ────────────────────────────────────────────────
        def _bet_val(self, widget_id: str) -> int | None:
            try:
                return int(self.query_one(f"#{widget_id}", Input).value.replace(",","").strip())
            except Exception:
                return None

        def _bj_deal(self):
            bet = self._bet_val("bj-bet")
            if not bet:
                self.query_one("#bj-status", Static).update("[red]Enter a bet amount.[/]")
                return
            self._send({"type":"bj_deal","bet":bet})

        def _rl_spin(self, bet_type: str):
            bet = self._bet_val("rl-bet")
            if not bet:
                self.query_one("#rl-status", Static).update("[red]Enter a bet amount.[/]")
                return
            msg: dict = {"type":"roulette_spin","bet":bet,"bet_type":bet_type}
            if bet_type == "number":
                num = self._bet_val("rl-number")
                if num is None or not (0 <= num <= 36):
                    self.query_one("#rl-status", Static).update("[red]Enter a number 0–36.[/]")
                    return
                msg["number"] = num
            self._send(msg)

        def _crash_start(self):
            bet = self._bet_val("crash-bet")
            if not bet:
                self.query_one("#crash-status", Static).update("[red]Enter a bet amount.[/]")
                return
            self._send({"type":"crash_start","bet":bet})

        def _pk_create(self):
            try:
                name    = self.query_one("#pk-room-name", Input).value.strip()
                min_bet = int(self.query_one("#pk-min-bet", Input).value or "0")
            except Exception:
                self._log("poker-log", "[red]Enter a room name and min bet.[/]")
                return
            if not name:
                self._log("poker-log", "[red]Room name required.[/]")
                return
            self._send({"type":"poker_create_room","name":name,"min_bet":min_bet})

        def _pk_raise(self):
            try:
                amount = int(self.query_one("#pk-raise", Input).value or "0")
            except Exception:
                self._log("poker-log", "[red]Enter raise amount.[/]")
                return
            self._send({"type":"poker_action","action":"raise","amount":amount})

        def _mkt_trade(self, action: str):
            try:
                asset = self.query_one("#mkt-asset", Input).value.strip().upper()
                qty   = int(self.query_one("#mkt-qty",   Input).value)
            except Exception:
                return
            if asset:
                self._send({"type":"action","action":action,"asset":asset,"qty":qty})

        def _set_name(self):
            try:
                name = self.query_one("#acct-name", Input).value.strip()
            except Exception:
                return
            if len(name) < 2:
                try: self.query_one("#acct-name-err", Static).update("[red]Name must be at least 2 characters.[/]")
                except Exception: pass
                return
            self._send({"type":"action","action":"set_name","name":name})

        # ── Chat ──────────────────────────────────────────────────────────
        def _render_chat(self, msg: dict):
            name  = msg.get("name", "Anon")
            badge = f" [{msg.get('badge','')}]" if msg.get("badge") else ""
            text  = msg.get("text", "")
            ts    = time.strftime("%H:%M", time.localtime(msg.get("ts") or time.time()))
            self._log("chat-log", f"[dim]{ts}[/] [green]{name}[/][dim]{badge}[/]: {text}")

        # ── Account tab ───────────────────────────────────────────────────
        def _update_account_tab(self):
            state       = self.state or {}
            cfg         = _load_config()
            saved_token = cfg.get("login_token", "")
            tokens      = state.get("name_tokens", 0)
            info = (
                f"[bold green]ACCOUNT[/]\n\n"
                f"  Name       : [green]{state.get('name') or '(unnamed)'}[/]\n"
                f"  Player ID  : {pid}\n"
                f"  Token      : [dim]{saved_token or '(none)'}[/]\n"
                f"  Name tokens: [green]{tokens}[/]  "
                f"{'(first rename is free)' if state.get('name_changes',0) == 0 else ''}\n\n"
                f"[dim]To switch accounts:  idlesys login <uuid> --token <token>[/]"
            )
            try: self.query_one("#acct-info", Static).update(info)
            except Exception: pass

        # ── Changelog ─────────────────────────────────────────────────────
        def _fetch_and_log_changelog(self):
            try:
                with urllib.request.urlopen(f"{_http_url(server)}/api/changelog", timeout=5) as r:
                    data = json.loads(r.read())
                self._log("event-log", "[bold green]=== CHANGELOG ===[/]")
                for ver, entries in data.items():
                    self._log("event-log", f"[green]v{ver}[/]")
                    for e in entries:
                        self._log("event-log", f"  [dim]•[/] {e[:80]}")
            except Exception as e:
                self._log("event-log", f"[red]Changelog fetch failed: {e}[/]")

        # ── Helpers ───────────────────────────────────────────────────────
        def _send(self, msg: dict):
            if self._ws is None: return
            asyncio.create_task(self._ws.send(json.dumps(msg)))

        def _log(self, widget_id: str, text: str):
            try:
                self.query_one(f"#{widget_id}", RichLog).write(text)
            except Exception:
                pass

    IdleSysApp().run()

# ─── Argument parser ──────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="idlesys",
        description=f"IDLE.SYS CLI/TUI  v{CLI_VERSION}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Scripting:
              idlesys script actions.json
              echo '[{"type":"action","action":"click"}]' | idlesys script -
              idlesys raw '{"type":"action","action":"click"}'

            Credentials:
              env  IDLESYS_PLAYER_ID, IDLESYS_TOKEN, IDLESYS_SERVER
              file ~/.idlesys/config.json

            API guide:  https://idlesys.xyz/web/api-guide
        """),
    )
    sub = p.add_subparsers(dest="cmd", metavar="<command>")

    sub.add_parser("tui",          help="Live terminal dashboard")
    sub.add_parser("status",       help="Show game state")
    sub.add_parser("account",      help="Show your player ID, token, switch account")
    sub.add_parser("changelog",    help="Show server changelog")
    sub.add_parser("leaderboard",  help="Top 10 players")
    sub.add_parser("prestige",     help="Prestige")
    sub.add_parser("accept-tos",   help="Accept Terms of Service")
    sub.add_parser("achievements", help="Show achievements")
    sub.add_parser("market",       help="Show market prices")

    sp = sub.add_parser("register", help="Create a new account")
    sp.add_argument("--server", help=f"Server URL (default: {DEFAULT_SERVER})")

    sp = sub.add_parser("login", help="Save credentials")
    sp.add_argument("player_id")
    sp.add_argument("--token",  help="Login token")
    sp.add_argument("--server", help=f"Server URL (default: {DEFAULT_SERVER})")

    sp = sub.add_parser("profile", help="View a player profile")
    sp.add_argument("query", help="Player UUID or name")

    sp = sub.add_parser("click", help="Send clicks")
    sp.add_argument("--n", type=int, default=1, metavar="N")

    sp = sub.add_parser("buy", help="Buy an upgrade")
    sp.add_argument("upgrade_id")
    sp.add_argument("--count", type=int, default=1, metavar="N")

    sp = sub.add_parser("skill", help="Unlock a skill node")
    sp.add_argument("node_id")

    sp = sub.add_parser("gift", help="Send money to a player")
    sp.add_argument("target")
    sp.add_argument("amount", type=int)

    sp = sub.add_parser("chat", help="Send a global chat message")
    sp.add_argument("text")

    # Market subcommands
    mkt = sub.add_parser("market-buy",  help="Buy a market asset")
    mkt.add_argument("asset"); mkt.add_argument("qty", type=int)
    mkt = sub.add_parser("market-sell", help="Sell a market asset")
    mkt.add_argument("asset"); mkt.add_argument("qty", type=int)

    # Hack subcommands
    hk = sub.add_parser("hack", help="Hack commands")
    hk.add_argument("hack_cmd", choices=["start","buy-module","encrypt","bypass-cd"],
                    metavar="start|buy-module|encrypt|bypass-cd")

    # Blackjack
    bj = sub.add_parser("blackjack", help="Blackjack (deal/hit/stand)")
    bj.add_argument("bj_cmd", choices=["deal","hit","stand"], metavar="deal|hit|stand")
    bj.add_argument("bet", type=int, nargs="?", default=0)

    # Roulette
    rl = sub.add_parser("roulette", help="Roulette spin")
    rl.add_argument("bet_type", metavar="red|black|even|odd|0-36")
    rl.add_argument("bet", type=int)
    rl.add_argument("--number", type=int, default=None)

    # Crash
    cr = sub.add_parser("crash", help="Crash game")
    cr.add_argument("crash_cmd", choices=["start","cashout"], metavar="start|cashout")
    cr.add_argument("bet", type=int, nargs="?", default=0)

    # Badge
    bg = sub.add_parser("badge", help="Badge commands (list/redeem/set)")
    bg.add_argument("badge_cmd", choices=["list","redeem","set"], metavar="list|redeem|set")
    bg.add_argument("code",  nargs="?", default="", help="Badge code (for redeem)")
    bg.add_argument("badge", nargs="?", default="", help="Badge name (for set)")

    sp = sub.add_parser("script", help="Run JSON action script (or - for stdin)")
    sp.add_argument("file")
    sp.add_argument("--verbose", action="store_true")

    sp = sub.add_parser("raw", help="Send a raw JSON message")
    sp.add_argument("json")

    return p

# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) == 1:
        _self_install()
        return

    parser = build_parser()
    args   = parser.parse_args()

    dispatch = {
        "tui":          cmd_tui,
        "register":     cmd_register,
        "login":        cmd_login,
        "status":       cmd_status,
        "account":      cmd_account,
        "profile":      cmd_profile,
        "click":        cmd_click,
        "buy":          cmd_buy,
        "skill":        cmd_skill,
        "prestige":     cmd_prestige,
        "gift":         cmd_gift,
        "chat":         cmd_chat,
        "hack":         cmd_hack,
        "blackjack":    cmd_blackjack,
        "roulette":     cmd_roulette,
        "crash":        cmd_crash,
        "market":       cmd_market,
        "market-buy":   cmd_market_buy,
        "market-sell":  cmd_market_sell,
        "badge":        cmd_badge,
        "achievements": cmd_achievements,
        "changelog":    cmd_changelog,
        "leaderboard":  cmd_leaderboard,
        "accept-tos":   cmd_accept_tos,
        "script":       cmd_script,
        "raw":          cmd_raw,
    }

    if args.cmd in dispatch:
        dispatch[args.cmd](args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
