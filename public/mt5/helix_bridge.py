# -*- coding: utf-8 -*-
"""
HELIX QUANT — Python Execution Bridge (official MetaTrader5 integration)
=========================================================================

This is the SIMPLE path. No MetaEditor, no compile, no .ex5, no chart,
no WebRequest allow list, no EA inputs dialog. It talks to:

  * your MT5 terminal   via the official MetaTrader5 python package (local IPC)
  * the HELIX OMS       via plain HTTPS (requests)

First start:   start_bridge.bat          (installs deps, registers itself, saves config)
Every start:   start_bridge.bat          (reads helix_config.ini, runs)
Self test:     python helix_bridge.py --test

The agent token is created AUTOMATICALLY on first run by calling
/api/bridge/register and is stored in helix_config.ini next to this file.
You never copy a token by hand again.
"""

import argparse
import configparser
import ctypes
import os
import sys
import time
import socket
import traceback
from datetime import datetime, timedelta

import urllib.request
import urllib.error


def http(method, url, data=None, timeout=15):
    """Stdlib-only HTTP so the bridge needs exactly ONE third-party package."""
    body = data.encode("utf-8") if isinstance(data, str) else data
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "text/plain; charset=utf-8", "User-Agent": "helix-bridge/" + PY_VERSION},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, exc.read().decode("utf-8", "replace")
        except Exception:
            return exc.code, ""
    except Exception as exc:  # DNS, TLS, firewall, timeout ...
        return 0, str(exc)

MAGIC = 990011
PY_VERSION = "py-1.12"
SUCCESS_RETCODES = (10008, 10009, 10010)

CFG_NAME = "helix_config.ini"
LOCK_NAME = "helix_bridge.lock"

# --------------------------------------------------------------------------- UI
def c(text, color):
    codes = {"g": "92", "r": "91", "y": "93", "c": "96", "b": "97", "d": "90"}
    return "\033[%sm%s\033[0m" % (codes.get(color, "0"), text)

def log(msg, color="b"):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), c(msg, color)))

def ok(msg):
    log("[OK]      " + msg, "g")

def err(msg):
    log("[FEHLER]  " + msg, "r")

def hint(msg):
    log("[HINWEIS] " + msg, "y")

def banner(server):
    print()
    print(c("==============================================================", "c"))
    print(c("   HELIX QUANT  ·  PYTHON EXECUTION BRIDGE  ·  " + PY_VERSION, "c"))
    print(c("   OMS: " + server, "d"))
    print(c("==============================================================", "c"))
    print()

# ----------------------------------------------------------------------- config
def cfg_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), CFG_NAME)

def load_cfg():
    """Read helix_config.ini tolerantly.

    Windows PowerShell 5.1 writes UTF-8 files WITH a byte order mark when asked
    for '-Encoding UTF8'; configparser then dies on the invisible character in
    line 1. We read with utf-8-sig (strips a BOM if present) and, if the file is
    damaged beyond that, repair it in place so the bridge never strands the
    operator with a traceback.
    """
    cp = configparser.ConfigParser()
    path = cfg_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as fh:
                cp.read_file(fh)
        except Exception:
            try:
                with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
                    raw = fh.read()
                idx = raw.find("[bridge]")
                if idx < 0:
                    idx = raw.find("[")
                fixed = raw[idx:] if idx >= 0 else "[bridge]\n"
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(fixed)
                cp.read_string(fixed)
                hint("helix_config.ini wurde automatisch repariert (BOM/Zeichenmuell entfernt).")
            except Exception:
                cp = configparser.ConfigParser()
    if not cp.has_section("bridge"):
        cp.add_section("bridge")
    return cp

def save_cfg(cp):
    # always BOM-free: a BOM at the start of the ini breaks naive readers
    with open(cfg_path(), "w", encoding="utf-8", newline="\n") as fh:
        cp.write(fh)

def norm_url(u):
    u = (u or "").strip().strip('"').strip("'")
    while u.endswith("/"):
        u = u[:-1]
    return u

def ensure_config(cp, args):
    server = norm_url(args.server or cp.get("bridge", "server", fallback=""))
    token = (args.token or cp.get("bridge", "token", fallback="")).strip()
    name = args.name or cp.get("bridge", "name", fallback="") or ("pc-" + socket.gethostname()[:18])

    if not server:
        print()
        hint("Keine Server-Adresse konfiguriert.")
        server = norm_url(input("Bitte OMS-URL aus dem Execution-Tab einfuegen (z.B. https://3000-...e2b.app): "))
        if not server:
            err("Keine URL eingegeben - Abbruch.")
            sys.exit(1)
    if not server.startswith("http"):
        server = "https://" + server

    if not token:
        log("Kein Agent-Token gefunden - registriere diesen Rechner automatisch beim Server ...")
        import json as _json
        status, text = http(
            "POST",
            server + "/api/bridge/register",
            _json.dumps({"name": name, "adapter": "python"}),
            timeout=20,
        )
        if status == 200:
            token = _json.loads(text or "{}").get("token", "")
        else:
            token = ""
        if status == 0:
            err("Server nicht erreichbar unter %s (%s)" % (server, text[:160]))
            err("Pruefe die URL im Execution-Tab (blaues Kopier-Feld) und starte neu.")
            sys.exit(1)
        if not token:
            err("Server hat keinen Token zurueckgegeben (HTTP %d): %s" % (status, text[:200]))
            sys.exit(1)
        ok("Agent automatisch registriert als '%s'. Token lokal gespeichert - du musst ihn nie wieder kopieren." % name)

    cp.set("bridge", "server", server)
    cp.set("bridge", "token", token)
    cp.set("bridge", "name", name)
    if not cp.get("bridge", "magic", fallback=""):
        cp.set("bridge", "magic", str(MAGIC))
    if not cp.get("bridge", "dry_run", fallback=""):
        cp.set("bridge", "dry_run", "true")
    if not cp.get("bridge", "symbols", fallback=""):
        cp.set("bridge", "symbols", "auto,EURUSD,XAUUSD,US500,BTCUSD,ETHUSD,SOLUSD,BNBUSD,XRPUSD,LTCUSD")
    if not cp.get("bridge", "poll_seconds", fallback=""):
        cp.set("bridge", "poll_seconds", "3")
    if not cp.get("bridge", "manage_seconds", fallback=""):
        cp.set("bridge", "manage_seconds", "5")
    if not cp.get("bridge", "history_minutes", fallback=""):
        cp.set("bridge", "history_minutes", "30")
    if not cp.get("bridge", "history_timeframes", fallback=""):
        cp.set("bridge", "history_timeframes", "1h,1d")
    save_cfg(cp)
    return cp

# ------------------------------------------------------------------ single lock
class SingleInstance:
    def __init__(self):
        self.fh = None

    def acquire(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), LOCK_NAME)
        self.fh = open(path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            err("Es laeuft bereits eine HELIX-Bridge auf diesem Rechner.")
            err("Zweites Fenster schliessen oder Task beenden, dann neu starten.")
            sys.exit(1)

# --------------------------------------------------------------------- http io
class Oms:
    def __init__(self, server, token):
        self.server = server
        self.token = token
        self.last_err = ""

    def kv_body(self, pairs):
        return "".join("%s=%s\n" % (k, v) for k, v in pairs if v is not None)

    def post(self, path, pairs, patient=False):
        status, text = http("POST", self.server + path, self.kv_body(pairs))
        if status == 0 and patient:
            # The host may be cold-starting (sandbox sleep). One long, quiet
            # retry absorbs the wake-up instead of alarming the operator.
            status, text = http("POST", self.server + path, self.kv_body(pairs), timeout=75)
        if status in (401, 403):
            self.last_err = "Token abgelehnt (HTTP %d)" % status
            return None
        if status == 0:
            self.last_err = text
            return None
        self.last_err = ""
        return text

    def get(self, path, patient=False):
        status, text = http("GET", self.server + path)
        if status == 0 and patient:
            status, text = http("GET", self.server + path, timeout=75)
        if status in (401, 403):
            self.last_err = "Token abgelehnt (HTTP %d)" % status
            return None
        if status == 0:
            self.last_err = text
            return None
        self.last_err = ""
        return text

    def whoami(self):
        return http("GET", self.server + "/api/bridge/whoami?token=" + self.token)

# ------------------------------------------------------------------ line proto
def kv_get(body, key, default=""):
    for line in (body or "").splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            return line[len(key) + 1:]
    return default

def parse_order_line(line):
    f = line.split("|")
    if len(f) < 10:
        return None
    num = lambda i, fb=0.0: float(f[i]) if i < len(f) and f[i].replace(".", "", 1).replace("-", "", 1).isdigit() else fb
    return {
        "id": int(num(1)),
        "action": f[2],
        "symbol": f[3],
        "side": f[4].lower(),
        "volume": num(5),
        "price": num(6),
        "sl": num(7),
        "tp": num(8),
        "comment": f[9],
        "trail": num(10, 1.6),
        "beR": num(11, 0.5),
        "pF": num(12, 0.5),
        "pR": num(13, 1.0),
        "ttl": int(num(14, 90)),
    }

# --------------------------------------------------------------------- mt5 io
class Terminal:
    def __init__(self, magic):
        import MetaTrader5 as mt5  # late import: --test can run without it
        self.mt5 = mt5
        self.magic = magic
        self.connected = False

    def connect(self):
        if not self.mt5.initialize():
            code, desc = self.mt5.last_error()
            err("MT5-Verbindung fehlgeschlagen: %s (%s)" % (desc, code))
            hint("Loesung: MetaTrader5-Terminal installieren ODER oeffnen und eingeloggt lassen.")
            hint("Falls das Terminal laeuft: einmal manuell starten und eingeloggt bleiben, dann Bridge neu starten.")
            return False
        info = self.mt5.account_info()
        if info is None:
            err("MT5 laeuft, aber kein Konto eingeloggt. Bitte im Terminal einloggen, dann Bridge neu starten.")
            self.mt5.shutdown()
            return False
        self.connected = True
        return True

    def account(self):
        a = self.mt5.account_info()
        return a

    def positions(self):
        out = []
        for p in self.mt5.positions_get() or []:
            if p.magic != self.magic:
                continue
            out.append(p)
        return out

    def find_position(self, symbol, marker):
        for p in self.positions():
            if symbol and p.symbol != symbol:
                continue
            if marker and marker in (p.comment or ""):
                return p
        for p in self.positions():
            if symbol and p.symbol == symbol:
                return p
        return None

    def already_executed(self, order_id, symbol):
        marker = "HX-%d" % order_id
        for p in self.positions():
            if marker in (p.comment or ""):
                return p
        now = int(time.time())
        # The python package has no history_select(); date-range getters are
        # the select step already. Guarded so a broker quirk can never kill us.
        deals = None
        try:
            deals = self.mt5.history_deals_get(now - 3 * 86400, now + 60)
        except Exception:
            deals = None
        if deals:
            for d in deals:
                if getattr(d, "magic", 0) == self.magic and marker in (getattr(d, "comment", "") or ""):
                    return True
        return None

    def atr(self, symbol, period=14):
        rates = self.mt5.copy_rates_from_pos(symbol, self.mt5.TIMEFRAME_H1, 0, period + 2)
        if rates is None or len(rates) < period + 1:
            return 0.0
        trs = []
        for i in range(1, len(rates)):
            h, l, pc = rates[i]["high"], rates[i]["low"], rates[i - 1]["close"]
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
        return sum(trs[-period:]) / period

    def filling_for(self, symbol):
        order = [self.mt5.ORDER_FILLING_IOC, self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_RETURN]
        si = self.mt5.symbol_info(symbol)
        mode = getattr(si, "filling_mode", 0) if si else 0
        if mode & 1:
            order = [self.mt5.ORDER_FILLING_FOK, self.mt5.ORDER_FILLING_IOC, self.mt5.ORDER_FILLING_RETURN]
        return order

    def market_price(self, symbol, side):
        tick = self.mt5.symbol_info_tick(symbol)
        if tick is None:
            return 0.0
        return tick.ask if side == "buy" else tick.bid

    def open_order(self, o):
        mt5 = self.mt5
        symbol = o["symbol"]
        if not mt5.symbol_select(symbol, True):
            return False, 0, "symbol not available on this terminal", 0.0, 0.0, "", "", 0.0
        side = o["side"]
        price = self.market_price(symbol, side)
        if price <= 0:
            return False, 0, "no tick data for " + symbol, 0.0, 0.0, "", "", 0.0
        last_err = ""
        for filling in self.filling_for(symbol):
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": o["volume"],
                "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                "price": price,
                "sl": o["sl"] if o["sl"] > 0 else 0.0,
                "tp": o["tp"] if o["tp"] > 0 else 0.0,
                "deviation": 20,
                "magic": self.magic,
                "comment": o["comment"],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": filling,
            }
            res = mt5.order_send(request)
            if res is None:
                last_err = "order_send returned None: %s" % (mt5.last_error(),)
                continue
            if res.retcode in SUCCESS_RETCODES:
                pos = self.find_position(symbol, o["comment"])
                ticket = str(pos.ticket) if pos else str(res.order)
                slip = 0.0
                si = mt5.symbol_info(symbol)
                if si and si.point > 0:
                    slip = abs(res.price - price) / si.point
                return True, res.retcode, "done", res.price, res.volume or o["volume"], ticket, str(res.deal or ""), slip
            last_err = "retcode %d: %s" % (res.retcode, getattr(res, "comment", ""))
            if res.retcode != 10030:  # invalid fill -> try next, else stop
                break
        return False, 0, last_err or "order rejected", 0.0, 0.0, "", "", 0.0

    def close_position(self, pos, volume=None):
        mt5 = self.mt5
        vol = volume or pos.volume
        side = "sell" if pos.type == mt5.POSITION_TYPE_BUY else "buy"
        price = self.market_price(pos.symbol, side)
        for filling in self.filling_for(pos.symbol):
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "position": pos.ticket,
                "symbol": pos.symbol,
                "volume": vol,
                "type": mt5.ORDER_TYPE_SELL if side == "sell" else mt5.ORDER_TYPE_BUY,
                "price": price,
                "deviation": 20,
                "magic": self.magic,
                "comment": "HX-close",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": filling,
            }
            res = mt5.order_send(request)
            if res and res.retcode in SUCCESS_RETCODES:
                return True, res.retcode, res.price
            if res and res.retcode != 10030:
                return False, res.retcode, getattr(res, "comment", "")
        return False, 0, "close failed"

    def modify(self, pos, sl, tp):
        mt5 = self.mt5
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": pos.ticket,
            "symbol": pos.symbol,
            "sl": sl,
            "tp": tp,
        }
        res = mt5.order_send(request)
        return bool(res and res.retcode in SUCCESS_RETCODES)

# --------------------------------------------------------------------- bridge
class Bridge:
    def __init__(self, cp, dry_override=None):
        self.cp = cp
        self.server = cp.get("bridge", "server")
        self.token = cp.get("bridge", "token")
        self.magic = int(cp.get("bridge", "magic", fallback=str(MAGIC)))
        self.dry = cp.getboolean("bridge", "dry_run", fallback=True)
        if dry_override is not None:
            self.dry = dry_override
        self.symbols = [s.strip() for s in cp.get("bridge", "symbols", fallback="").split(",") if s.strip()]
        self.poll_s = max(1, cp.getint("bridge", "poll_seconds", fallback=3))
        self.manage_s = max(1, cp.getint("bridge", "manage_seconds", fallback=5))
        self.history_min = max(1, cp.getint("bridge", "history_minutes", fallback=30))
        self.history_tfs = [t.strip() for t in cp.get("bridge", "history_timeframes", fallback="1h,1d").split(",") if t.strip()]
        self.last_ingest = 0.0
        self.feed_summary = ""
        self.resolved_symbols = []
        self.oms = Oms(self.server, self.token)
        self.term = Terminal(self.magic)
        self.partial_done = {}
        self.fail_streak = 0
        self.reregistered = False
        self.executed = 0
        self.rejected = 0

    def re_register(self):
        """Server-side resets can invalidate a stored token. Heal automatically."""
        import json as _json
        name = self.cp.get("bridge", "name", fallback="pc") + "-r" + str(int(time.time()))[-4:]
        status, text = http("POST", self.server + "/api/bridge/register", _json.dumps({"name": name, "adapter": "python"}), timeout=20)
        token = _json.loads(text or "{}").get("token", "") if status == 200 else ""
        if not token:
            return False
        self.token = token
        self.oms.token = token
        self.cp.set("bridge", "token", token)
        self.cp.set("bridge", "name", name)
        save_cfg(self.cp)
        ok("Token vom Server zurueckgesetzt erkannt - automatisch neu registriert als '%s'." % name)
        return True

    # ------------------------------------------------------------ server side
    def heartbeat(self):
        a = self.term.account()
        pairs = [
            ("type", "heartbeat"),
            ("token", self.token),
            ("version", PY_VERSION),
            ("eaversion", PY_VERSION),
            ("login", str(a.login) if a else ""),
            ("server", a.server if a else ""),
            ("build", "python"),
            ("mode", "hedging" if (a and getattr(a, "margin_mode", 0) == 1) else "netting"),
            ("currency", a.currency if a else ""),
            ("equity", "%.2f" % a.equity if a else "0"),
            ("balance", "%.2f" % a.balance if a else "0"),
            ("margin", "%.2f" % a.margin if a else "0"),
            ("free", "%.2f" % a.margin_free if a else "0"),
            ("marginlevel", "%.2f" % a.margin_level if a else "0"),
            ("positions", str(len(self.term.positions()))),
            ("dryrun", "1" if self.dry else "0"),
            ("feed", self.feed_summary or None),
            ("capabilities", "OPEN,CLOSE,MODIFY,PARTIAL,TRAIL,SYNCSPEC,FEED"),
        ]
        body = self.oms.post("/api/bridge/heartbeat", pairs, patient=self.fail_streak == 0)
        if body is None:
            self.fail_streak += 1
            if self.oms.last_err and "Token" in self.oms.last_err:
                if not self.reregistered:
                    self.reregistered = True
                    err("Server lehnt den Token ab (%s) - versuche automatische Heilung ..." % self.oms.last_err)
                    if self.re_register():
                        return self.heartbeat()
                err("Server lehnt den Token ab: %s" % self.oms.last_err)
                hint("Loesche die Datei %s und starte neu - die Bridge registriert sich dann selbst neu." % CFG_NAME)
            elif self.fail_streak == 1 or self.fail_streak % 10 == 0:
                err("Server nicht erreichbar (%s)" % self.oms.last_err)
                hint("Moegliche Ursachen, in dieser Reihenfolge pruefen:")
                hint("  1) Server schlaeft (Sandbox-Kaltstart) - bis 75 s warten, kommt von allein")
                hint("  2) URL ist alt - Fenster schliessen, neu starten, neue URL aus dem Execution-Tab eingeben")
                hint("  3) Fuer Dauerbetrieb: auf eigenen Server deployen (Docker-Kit liegt im Projekt)")
            return None
        self.fail_streak = 0
        return body

    def discover_symbols(self):
        """Ask the broker what it actually offers: everything tradable whose
        name maps to our universe or looks like a major crypto cross."""
        crypto = ("BTC", "ETH", "SOL", "BNB", "XRP", "LTC", "ADA", "DOGE", "AVAX", "DOT")
        found = []
        for si in self.term.mt5.symbols_get() or []:
            name = getattr(si, "name", "") or ""
            if getattr(si, "trade_mode", 0) != 4:
                continue
            base = name.upper()
            is_crypto = base.startswith(crypto) and ("USD" in base or "EUR" in base)
            is_known = any(base.startswith(k) for k in ("EURUSD", "XAUUSD", "US500", "US100", "SPX500", "NAS100"))
            if is_crypto or is_known:
                found.append(name)
            if len(found) >= 60:
                break
        return found

    TF_CONST = {"15m": "TIMEFRAME_M15", "1h": "TIMEFRAME_H1", "4h": "TIMEFRAME_H4", "1d": "TIMEFRAME_D1"}
    TF_COUNT = {"15m": 2500, "1h": 5000, "4h": 3000, "1d": 2600}

    def ingest_history(self):
        """Mirror the broker's REAL candles into the research database."""
        import json as _json
        mt5 = self.term.mt5
        parts = []
        written = 0
        for sym in self.resolved_symbols or self.symbols:
            for tf in self.history_tfs:
                const = getattr(mt5, self.TF_CONST.get(tf, ""), None)
                if const is None:
                    continue
                try:
                    rates = mt5.copy_rates_from_pos(sym, const, 0, self.TF_COUNT.get(tf, 2000))
                except Exception:
                    rates = None
                if rates is None or len(rates) < 50:
                    continue
                rows = [
                    [int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
                    for r in rates
                ]
                status, text = http(
                    "POST",
                    self.server + "/api/market/ingest",
                    _json.dumps({"token": self.token, "symbol": sym, "timeframe": tf, "candles": rows}),
                    timeout=45,
                )
                if status == 200:
                    n = len(rows)
                    written += n
                    parts.append("%s/%s:%d" % (sym, tf, n))
                else:
                    hint("History-Ingest %s %s fehlgeschlagen: HTTP %d %s" % (sym, tf, status, text[:80]))
        self.feed_summary = ";".join(parts)
        if written:
            ok("Echte Broker-History gespiegelt: %d Kerzen (%s)" % (written, self.feed_summary))
        return written

    def publish_instruments(self):
        lines = []
        wanted = list(self.symbols)
        if "auto" in [w.lower() for w in wanted]:
            wanted = [w for w in wanted if w.lower() != "auto"]
            for extra in self.discover_symbols():
                if extra not in wanted:
                    wanted.append(extra)
            if wanted:
                self.cp.set("bridge", "symbols_resolved", ",".join(wanted))
                save_cfg(self.cp)
                ok("Broker-Angebot automatisch erkannt: %s" % ", ".join(wanted[:14]))
        self.resolved_symbols = wanted
        for sym in wanted:
            if not self.term.mt5.symbol_select(sym, True):
                continue
            si = self.term.mt5.symbol_info(sym)
            if si is None:
                continue
            lines.append(
                "s=%s|%.8f|%.8f|%.8f|%.8f|%.8f|%d|%d|%d|%d|%.1f|%s|%.8f"
                % (
                    sym,
                    si.point,
                    si.trade_contract_size,
                    si.volume_min,
                    si.volume_max,
                    si.volume_step,
                    si.digits,
                    si.trade_stops_level,
                    si.trade_freeze_level,
                    si.trade_mode,
                    float(si.spread or 0),
                    si.currency_margin or "",
                    si.trade_tick_value or 0.0,
                )
            )
        if not lines:
            return
        body = ("type=symbols\ntoken=%s\n" % self.token) + "\n".join(lines) + "\ncount=%d\n" % len(lines)
        status, _ = http("POST", self.server + "/api/bridge/instruments", body)
        if status == 200:
            ok("%d Broker-Symbole an den Server gemeldet: %s" % (len(lines), ", ".join(self.symbols)))
        else:
            hint("Symbol-Meldung fehlgeschlagen (HTTP %d)" % status)

    def report_positions(self):
        rows = []
        for p in self.term.positions():
            rows.append(
                "p=%d|%s|%s|%.8f|%.8f|%.8f|%.8f|%.8f|%.2f|%.2f|%.2f|%d|%s|%d"
                % (
                    p.ticket,
                    p.symbol,
                    "buy" if p.type == 0 else "sell",
                    p.volume,
                    p.price_open,
                    p.price_current,
                    p.sl,
                    p.tp,
                    p.profit,
                    p.swap,
                    p.commission,
                    p.magic,
                    (p.comment or "").replace("|", "/"),
                    int(p.time),
                )
            )
        body = ("type=positions\ntoken=%s\n" % self.token) + "\n".join(rows) + "\ncount=%d\n" % len(rows)
        http("POST", self.server + "/api/bridge/positions", body)

    def ack(self, order_id, state, retcode, text, price=0.0, volume=0.0, slip=0.0, position="", deal=""):
        self.oms.post(
            "/api/bridge/ack",
            [
                ("type", "ack"),
                ("token", self.token),
                ("order", str(order_id)),
                ("state", state),
                ("retcode", "%d" % retcode),
                ("text", (text or "").replace("\n", " ").replace("|", "/")),
                ("price", "%.8f" % price),
                ("volume", "%.8f" % volume),
                ("slippage", "%.1f" % slip),
                ("position", position),
                ("deal", deal),
            ],
        )

    # ------------------------------------------------------------- order flow
    def poll(self):
        body = self.oms.get("/api/bridge/poll?fmt=ea&token=" + self.token, patient=self.fail_streak == 0)
        if body is None:
            return
        if kv_get(body, "ok") != "1":
            return
        n = int(kv_get(body, "orders", "0") or 0)
        if n <= 0:
            return
        done = 0
        for line in body.splitlines():
            line = line.strip()
            if not line.startswith("order="):
                continue
            done += 1
            o = parse_order_line(line[len("order="):])
            if o:
                try:
                    self.execute(o)
                except Exception as exc:
                    err("Order #%d lief auf einen Bridge-Fehler: %s" % (o["id"], exc))
                    self.ack(o["id"], "REJECTED", 0, "bridge exception: %s" % exc)
            if done >= n:
                break

    def execute(self, o):
        mt5 = self.term.mt5
        tag = "#%d %s %s %.2f" % (o["id"], o["action"], o["symbol"], o["volume"])
        existing = self.term.already_executed(o["id"], o["symbol"])
        if existing:
            if hasattr(existing, "ticket"):
                self.ack(o["id"], "FILLED", 10009, "reconciled after missed ack", existing.price_open, existing.volume, 0.0, str(existing.ticket))
            else:
                self.ack(o["id"], "FILLED", 10009, "executed earlier, position already closed")
            hint("%s -> bereits ausgefuehrt, Reconciliation-Ack gesendet" % tag)
            return

        if o["action"] == "CLOSE":
            pos = self.term.find_position(o["symbol"], o["comment"])
            if not pos:
                self.ack(o["id"], "REJECTED", 0, "no matching open position")
                return
            if self.dry:
                hint("DRY RUN: wuerde %s schliessen (Ticket %d)" % (tag, pos.ticket))
                self.ack(o["id"], "REJECTED", 0, "dry run - no order sent")
                return
            good, rc, px = self.term.close_position(pos)
            self.ack(o["id"], "FILLED" if good else "REJECTED", rc, "closed" if good else "close failed", px, pos.volume, 0.0, str(pos.ticket))
            return

        if o["action"] == "PARTIAL":
            pos = self.term.find_position(o["symbol"], o["comment"])
            if not pos or o["volume"] >= pos.volume:
                self.ack(o["id"], "REJECTED", 0, "invalid partial volume")
                return
            if self.dry:
                hint("DRY RUN: wuerde %s teilweise schliessen (%.2f)" % (tag, o["volume"]))
                self.ack(o["id"], "REJECTED", 0, "dry run - no order sent")
                return
            good, rc, px = self.term.close_position(pos, o["volume"])
            self.ack(o["id"], "ACKED" if good else "REJECTED", rc, "partial close" if good else "partial failed", px, o["volume"], 0.0, str(pos.ticket))
            return

        if o["action"] == "MODIFY":
            pos = self.term.find_position(o["symbol"], o["comment"])
            if not pos:
                self.ack(o["id"], "REJECTED", 0, "no position")
                return
            good = self.term.modify(pos, o["sl"], o["tp"])
            self.ack(o["id"], "ACKED" if good else "REJECTED", 0, "modified" if good else "modify failed")
            return

        # OPEN
        si = self.term.mt5.symbol_info(o["symbol"])
        if si is None or not self.term.mt5.symbol_select(o["symbol"], True):
            err("%s -> Symbol kennt dieser Broker nicht" % tag)
            self.ack(o["id"], "REJECTED", 0, "symbol not available on this terminal")
            self.rejected += 1
            return
        if self.dry:
            px = self.term.market_price(o["symbol"], o["side"])
            hint("DRY RUN: %s @ %.5f SL %.5f TP %.5f  (nichts gesendet)" % (tag, px, o["sl"], o["tp"]))
            self.ack(o["id"], "REJECTED", 0, "dry run - no order sent")
            return
        good, rc, text, price, vol, ticket, deal, slip = self.term.open_order(o)
        if good:
            self.executed += 1
            ok("%s -> FILLED @ %.5f (retcode %d, slip %.1f pts, ticket %s)" % (tag, price, rc, slip, ticket))
        else:
            self.rejected += 1
            err("%s -> REJECTED: %s" % (tag, text))
        self.ack(o["id"], "FILLED" if good else "REJECTED", rc, text, price, vol, slip, ticket, deal)

    # ------------------------------------------------------------ protection
    def manage(self):
        mt5 = self.term.mt5
        for p in self.term.positions():
          try:
            si = mt5.symbol_info(p.symbol)
            if si is None:
                continue
            point = si.point or 0.00001
            digits = si.digits or 5
            is_buy = p.type == mt5.POSITION_TYPE_BUY
            mark = self.term.market_price(p.symbol, "buy" if is_buy else "sell")
            risk = abs(p.price_open - p.sl) if p.sl > 0 else point * 100
            if risk <= 0:
                continue
            r_now = ((mark - p.price_open) if is_buy else (p.price_open - mark)) / risk
            new_sl, new_tp, changed = p.sl, p.tp, False
            be = p.price_open + (point if is_buy else -point)
            if r_now >= 0.5 and (new_sl == 0 or (new_sl < be if is_buy else new_sl > be)):
                new_sl, changed = be, True
            atr = self.term.atr(p.symbol)
            if atr > 0:
                trail = mark - 1.6 * atr if is_buy else mark + 1.6 * atr
                min_d = max(si.trade_stops_level, si.trade_freeze_level) * point + 2 * point
                if is_buy and trail > new_sl and mark - trail >= min_d:
                    new_sl, changed = trail, True
                if (not is_buy) and (new_sl == 0 or trail < new_sl) and trail - mark >= min_d:
                    new_sl, changed = trail, True
            key = p.ticket
            if r_now >= 1.0 and self.partial_done.get(key) is None and p.volume > si.volume_min * 1.5:
                cut = max(si.volume_min, round(p.volume * 0.5 / si.volume_step) * si.volume_step)
                if 0 < cut < p.volume:
                    if not self.dry:
                        good, rc, _ = self.term.close_position(p, cut)
                        if good:
                            self.partial_done[key] = time.time()
                            ok("Partial-Scale-out %d: %.2f Lots bei R=%.2f" % (p.ticket, cut, r_now))
                    else:
                        self.partial_done[key] = time.time()
            if changed and not self.dry:
                if self.term.modify(p, round(new_sl, digits), round(new_tp, digits)):
                    ok("%s: SL nachgezogen auf %.5f (R=%.2f)" % (p.symbol, new_sl, r_now))
          except Exception as exc:
            err("Position %s konnte nicht verwaltet werden: %s" % (getattr(p, "ticket", "?"), exc))

    # ------------------------------------------------------------------ loop
    def run(self):
        banner(self.server)
        if not self.term.connect():
            sys.exit(1)
        a = self.term.account()
        ok("MT5 verbunden: Login %d @ %s" % (a.login, a.server))
        status, text = self.oms.whoami()
        if status in (401, 403) and not self.reregistered:
            hint("Gespeicherter Token ist serverseitig ungultig (Reset?) - registriere automatisch neu ...")
            self.reregistered = True
            if self.re_register():
                status, text = self.oms.whoami()
        if status == 200:
            ok("Server erreichbar, Token gueltig.")
        else:
            err("Token-Check fehlgeschlagen (HTTP %d): %s" % (status, text[:120]))
            hint("Loesche %s und starte neu." % CFG_NAME)
            sys.exit(1)
        self.publish_instruments()
        self.ingest_history()
        self.last_ingest = time.time()
        if self.dry:
            hint("DRY RUN aktiv: es wird NICHTS an den Broker gesendet. (helix_config.ini -> dry_run=false fuer echt)")
        else:
            err("LIVE-MODUS: Orders werden wirklich an den Broker gesendet!")
        log("Schleife laeuft. Strg+C beendet sauber.", "d")
        last_poll = last_manage = last_hb = 0
        try:
            while True:
                now = time.time()
                if now - last_hb >= self.poll_s:
                    last_hb = now
                    body = self.heartbeat()
                    if body is not None:
                        ks = kv_get(body, "killswitch", "0") == "1"
                        armed = kv_get(body, "armed", "0") == "1"
                        if ks:
                            err("KILL SWITCH vom Server: flattening ...")
                            for p in self.term.positions():
                                self.term.close_position(p)
                if now - last_poll >= self.poll_s:
                    last_poll = now
                    self.poll()
                if now - last_manage >= self.manage_s:
                    last_manage = now
                    self.manage()
                    self.report_positions()
                if now - self.last_ingest >= self.history_min * 60:
                    self.last_ingest = now
                    self.ingest_history()
                time.sleep(0.4)
        except KeyboardInterrupt:
            log("Bridge sauber beendet.", "y")
        finally:
            self.term.mt5.shutdown()

def confirm_server(cp):
    """If the stored OMS URL is dead (sandbox rebuilds rotate the host), ask for
    the new one right here in the console and persist it. No flags needed."""
    server = cp.get("bridge", "server", fallback="")
    for _ in range(3):
        status, text = http("GET", server + "/api/health", timeout=6)
        if status == 200:
            ok("Server erreichbar: %s" % server)
            return cp
        err("Server nicht erreichbar: %s  (%s)" % (server, text[:90]))
        print()
        hint("Die OMS-URL aendert sich, wenn am Server gebaut wurde.")
        hint("Neue URL steht im Browser im Execution-Tab (blaues Kopier-Feld).")
        try:
            new = input("Neue OMS-URL einfuegen (Enter = gleichen Versuch nochmal): ").strip()
        except EOFError:
            new = ""
        if new:
            server = norm_url(new)
            if not server.startswith("http"):
                server = "https://" + server
            cp.set("bridge", "server", server)
            save_cfg(cp)
            ok("URL gespeichert: %s" % server)
    return cp


# ----------------------------------------------------------------------- test
def self_test(cp):
    print()
    print(c("=========== HELIX SELBSTTEST ===========", "c"))
    server = cp.get("bridge", "server", fallback="")
    token = cp.get("bridge", "token", fallback="")
    if not server:
        err("Keine Server-URL in %s" % CFG_NAME)
        return
    ok("Konfig gefunden: %s" % server)
    oms = Oms(server, token)
    code, text = oms.whoami()
    if code == 200:
        ok("Server + Token: HTTP 200 (%s)" % text.splitlines()[1] if len(text.splitlines()) > 1 else "ok")
    else:
        err("Server/Token-Check: HTTP %d -> %s" % (code, text[:160]))
        hint("Falls 'invalid token': %s loeschen und neu starten (Bridge registriert sich selbst)." % CFG_NAME)
        hint("Falls Verbindung fehlschlaegt: URL im Execution-Tab (blaues Feld) pruefen.")
    try:
        import MetaTrader5 as mt5
        if mt5.initialize():
            a = mt5.account_info()
            if a:
                ok("MT5 verbunden: Login %d @ %s" % (a.login, a.server))
            else:
                err("MT5 laeuft, aber kein Login.")
            mt5.shutdown()
        else:
            err("MT5-Initialisierung fehlgeschlagen: %s" % (mt5.last_error(),))
            hint("Terminal oeffnen und einloggen, dann Test wiederholen.")
    except ImportError:
        err("Paket MetaTrader5 fehlt -> start_bridge.bat starten (installiert es automatisch).")
    print(c("========================================", "c"))
    print()

# ----------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="HELIX QUANT python execution bridge")
    ap.add_argument("--server", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--name", default="")
    ap.add_argument("--symbols", default="")
    ap.add_argument("--set-server", default="", help="neue OMS-URL speichern und beenden")
    ap.add_argument("--live", action="store_true", help="dry run abschalten (echte Orders)")
    ap.add_argument("--test", action="store_true", help="nur Verbindung testen")
    args = ap.parse_args()

    lock = SingleInstance()
    lock.acquire()

    cp = load_cfg()
    if args.symbols:
        cp.set("bridge", "symbols", args.symbols)
    if args.set_server:
        u = norm_url(args.set_server)
        if not u.startswith("http"):
            u = "https://" + u
        cp.set("bridge", "server", u)
        save_cfg(cp)
        ok("Server-URL gespeichert: %s" % u)
        return
    cp = ensure_config(cp, args)
    if not args.test:
        cp = confirm_server(cp)
    if args.test:
        self_test(cp)
        return
    dry = None if not args.live else False
    Bridge(cp, dry_override=dry).run()

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        err("Unerwarteter Fehler:")
        traceback.print_exc()
        input("Enter druecken zum Schliessen ...")
