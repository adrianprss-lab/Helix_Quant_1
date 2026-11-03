"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Mode = "paper" | "bridge" | "metaapi";

interface Controls {
  mode: Mode;
  armed: boolean;
  killSwitch: boolean;
  confirmMode: string;
  minMetaProb: number;
  minConfidence: number;
  maxDailyOrders: number;
  maxDailyLossPct: number;
  maxNotionalPct: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  maxSpreadPoints: number;
  allowedSymbols: string | null;
  sessionStartUtc: number;
  sessionEndUtc: number;
  weekendHalt: boolean;
  cooldownSeconds: number;
  lotMultiplier: number;
  requireStopLoss: boolean;
  orderTtlSeconds: number;
  trailingAtrMult: number;
  breakevenAtR: number;
  partialFraction: number;
  partialAtR: number;
  metaApiAccountId: string | null;
  autopilot: boolean;
  autopilotMinutes: number;
  autopilotSymbols: string;
  autopilotPreset: string;
  autopilotTimeframe: string;
  autopilotTarget: number;
}

interface Bridge {
  id: number;
  name: string;
  tokenPrefix: string;
  adapter: string;
  status: string;
  mt5Login: string | null;
  mt5Server: string | null;
  mt5Build: string | null;
  accountMode: string | null;
  accountCurrency: string | null;
  balance: number | null;
  equity: number | null;
  marginFree: number | null;
  openPositions: number;
  online: boolean;
  staleSeconds: number | null;
  lastError: string | null;
  version: string | null;
  dryRun: boolean | null;
  eaVersion: string | null;
  feedSummary: string | null;
  feedUpdatedAt: string | null;
}

interface Order {
  id: number;
  action: string;
  symbol: string;
  side: string;
  volume: number;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  state: string;
  metaProb: number | null;
  alphaKey: string | null;
  retcode: number | null;
  retcodeText: string | null;
  errorText: string | null;
  fillPrice: number | null;
  fillVolume: number | null;
  slippagePoints: number | null;
  mt5Position: string | null;
  source: string;
  comment: string | null;
  createdAt: string;
}

interface Position {
  id: number;
  mt5Ticket: string;
  symbol: string;
  side: string;
  volume: number;
  openPrice: number;
  currentPrice: number | null;
  sl: number | null;
  tp: number | null;
  profit: number;
  swap: number;
  commission: number;
  comment: string | null;
  status: string;
}

interface Instrument {
  id: number;
  ticker: string;
  symbol: string;
  digits: number;
  point: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  stopsLevel: number;
  spreadPoints: number;
  tradeMode: number;
  active: boolean;
}

interface EventRow {
  id: number;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
}

interface StatusResponse {
  ok: boolean;
  controls: Controls;
  metaApiConfigured: boolean;
  metaApiRegion: string;
  weekend: boolean;
  bridges: Bridge[];
  onlineBridge: Bridge | null;
  lastKnock: { at: number; path: string; tokenPrefix: string; valid: boolean; count: number } | null;
  counts: { held: number; queued: number; dispatched: number; filled: number; failed: number; openPositions: number };
  openNotional: number;
  openPnl: number;
  orders: Order[];
  positions: { open: Position[]; closed: Position[] };
  events: EventRow[];
  instruments: Instrument[];
}

const STATE_TONE: Record<string, string> = {
  HELD: "text-amber-300 border-amber-500/40",
  PENDING: "text-sky-300 border-sky-500/30",
  DISPATCHED: "text-sky-400 border-sky-500/30",
  ACKED: "text-sky-300 border-sky-500/30",
  FILLED: "text-emerald-400 border-emerald-500/30",
  REJECTED: "text-rose-400 border-rose-500/30",
  CANCELLED: "text-slate-400 border-slate-600",
  EXPIRED: "text-slate-500 border-slate-700",
};

function Pill({ children, tone = "text-slate-300 border-slate-700" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone}`}>{children}</span>;
}

function Field({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
      />
    </label>
  );
}

const PRESET_CATALOG: { key: string; name: string }[] = [
  { key: "apex_hit_rate", name: "APEX HIT-RATE" },
  { key: "micro_scalper", name: "MICRO SCALPER" },
  { key: "balanced_core", name: "BALANCED CORE" },
  { key: "regime_trend", name: "REGIME TREND" },
  { key: "gold_daily_swing", name: "GOLD DAILY SWING" },
  { key: "capital_defense", name: "CAPITAL DEFENSE" },
];

export default function Execution() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [draft, setDraft] = useState<Controls | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [bridgeName, setBridgeName] = useState("mt5-primary");
  const [copied, setCopied] = useState<string | null>(null);
  const [metaAccounts, setMetaAccounts] = useState<{ id: string; name?: string; login?: number; state?: string }[]>([]);
  const [testToken, setTestToken] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "https://YOUR-HELIX-HOST";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/exec/status", { cache: "no-store" });
      const json = (await res.json()) as StatusResponse;
      setStatus(json);
      setDraft((prev) => prev ?? json.controls);
    } catch {
      /* status polling is best-effort */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const control = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/exec/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const json = (await res.json()) as Record<string, unknown> & { controls?: Controls; error?: string; message?: string };
      if (json.controls) {
        setDraft(json.controls);
        setStatus((s) => (s ? { ...s, controls: json.controls as Controls } : s));
      }
      setMsg(json.error ? `✗ ${json.error}` : json.message ? `✓ ${json.message}` : `✓ ${action} ok`);
      if (action === "metaapi:accounts") {
        setMetaAccounts((json.accounts as typeof metaAccounts) ?? []);
      }
      await load();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : "request failed"}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteBridge = async (id: number, name: string, online: boolean) => {
    const warn = online
      ? `Achtung: "${name}" ist gerade ONLINE. Wenn du sie löschst, bricht die laufende Verbindung ab und der Agent bekommt keine Orders mehr.`
      : `"${name}" wird dauerhaft entfernt. Order-Historie und Audit-Trail bleiben erhalten.`;
    if (!window.confirm(`${warn}\n\nBridge wirklich löschen?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/bridge/register?id=${id}`, { method: "DELETE", cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; removed?: number; error?: string };
      setMsg(json.ok ? `✓ Bridge "${name}" gelöscht` : `✗ ${json.error ?? "löschen fehlgeschlagen"}`);
      await load();
    } catch (e) {
      setMsg(`✗ ${e instanceof Error ? e.message : "löschen fehlgeschlagen"}`);
    } finally {
      setBusy(false);
    }
  };

  const registerBridge = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/bridge/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: bridgeName, adapter: "mt5_ea" }),
      });
      const json = (await res.json()) as { token: string; bridge: { name: string } };
      setNewToken({ name: json.bridge.name, token: json.token });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      setCopied(null);
    }
  };

  const c = draft ?? status?.controls ?? null;
  const bridge = status?.onlineBridge ?? status?.bridges[0] ?? null;
  const armed = Boolean(c?.armed && !c?.killSwitch);
  const banner = useMemo(() => {
    if (!c) return { text: "loading…", tone: "border-slate-700 text-slate-400" };
    if (c.killSwitch) return { text: "KILL SWITCH ENGAGED — all dispatch halted, flatten orders queued", tone: "border-rose-500/60 bg-rose-500/10 text-rose-300" };
    if (!c.armed) return { text: "DISARMED — research mode only, nothing will be sent to a broker", tone: "border-slate-600 bg-slate-800/40 text-slate-300" };
    if (c.mode === "paper") return { text: "ARMED but mode=paper — orders are simulated, no broker traffic", tone: "border-amber-500/50 bg-amber-500/10 text-amber-300" };
    if (!bridge?.online) {
      const k = status?.lastKnock;
      const ago = bridge?.staleSeconds !== null && bridge?.staleSeconds !== undefined ? `${Math.round(bridge.staleSeconds / 60)} min` : "nie";
      const detail = k
        ? ` · server DID receive something ${Math.max(0, Math.round((Date.now() - k.at) / 1000))}s ago from token ${k.tokenPrefix}… but rejected it → wrong token in the EA`
        : ` · server received NOTHING — the EA is calling a wrong/dead URL or MT5 blocks WebRequest (last heartbeat ${ago} ago)`;
      return { text: `ARMED but no bridge online${detail}`, tone: "border-amber-500/50 bg-amber-500/10 text-amber-200" };
    }
    return { text: `LIVE — mode=${c.mode}, confirm=${c.confirmMode}, bridge ${bridge?.name ?? "?"} online`, tone: "border-emerald-500/60 bg-emerald-500/10 text-emerald-300" };
  }, [c, bridge]);

  const eaSnippet = useMemo(() => {
    const token = newToken?.token ?? `<agent-token>`;
    return `InpServerUrl   = "${origin}"
InpAgentToken  = "${token}"
InpMagic       = 990011
InpPollSeconds = 3
InpDryRun      = true     // ← start with dry run, flip to false only after you watched it`;
  }, [origin, newToken]);

  if (!c) {
    return <div className="p-6 font-mono text-xs text-slate-500">loading execution state…</div>;
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- banner */}
      <div className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 font-mono text-[11px] ${banner.tone}`}>
        <span className="uppercase tracking-[0.16em]">{banner.text}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            disabled={busy || armed}
            onClick={() => control("arm")}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[10px] uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-30"
          >
            arm
          </button>
          <button
            disabled={busy || !c.armed}
            onClick={() => control("disarm")}
            className="rounded border border-slate-600 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-300 hover:bg-slate-800 disabled:opacity-30"
          >
            disarm
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm("Engage the kill switch? This queues CLOSE orders for every open position and cancels the pending queue.")) {
                void control("kill", { reason: "operator kill switch" });
              }
            }}
            className="rounded border border-rose-500/60 bg-rose-500/15 px-3 py-1 text-[10px] uppercase tracking-wider text-rose-300 hover:bg-rose-500/30"
          >
            ⛔ kill switch
          </button>
        </div>
      </div>

      {/* ------------------------------------------------- connection checklist */}
      {(() => {
        const now = Date.now();
        const knockBad =
          status?.lastKnock && !status.lastKnock.valid && now - status.lastKnock.at < 120_000
            ? status.lastKnock
            : null;
        const items: { label: string; state: "ok" | "warn" | "bad"; detail: string }[] = [
          {
            label: "Server & API",
            state: "ok",
            detail: status ? `Status geladen, ${status.bridges.length} Bridge(s) registriert` : "lädt…",
          },
          {
            label: "EA-Verbindung",
            state: bridge?.online ? "ok" : "bad",
            detail: bridge?.online
              ? `Heartbeat vor ${Math.round((bridge.staleSeconds ?? 0))}s · Login ${bridge.mt5Login ?? "?"} · ${bridge.mt5Server ?? "?"}`
              : bridge
                ? `letzter Heartbeat vor ${Math.round((bridge.staleSeconds ?? 0) / 60)} min — EA läuft nicht oder ruft eine alte URL`
                : "keine Bridge registriert",
          },
          (() => {
            const expectedPrefix = bridge?.tokenPrefix ?? "?";
            const lastPrefix = status?.lastKnock?.tokenPrefix ?? null;
            const mismatch = lastPrefix !== null && lastPrefix !== expectedPrefix;
            return {
              label: "Agent-Token",
              state: (mismatch || knockBad ? "bad" : "ok") as "ok" | "warn" | "bad",
              detail: mismatch
                ? `EA weist sich mit ${lastPrefix}… aus, Server erwartet ${expectedPrefix}… → aktuellen Token in InpAgentToken einfügen`
                : knockBad
                  ? `Versuch vor ${Math.max(0, Math.round((now - knockBad.at) / 1000))}s abgelehnt (Prefix ${knockBad.tokenPrefix}…) → Token verstümmelt oder rotiert`
                  : `Server erwartet Prefix ${expectedPrefix}… — keine abgelehnten Versuche`,
            };
          })(),
          {
            label: "Engine scharf",
            state: c.armed && !c.killSwitch ? "ok" : c.killSwitch ? "bad" : "warn",
            detail: c.killSwitch ? "Kill Switch aktiv — kein Dispatch möglich" : c.armed ? "ARMED" : "disarmed — nur Forschung",
          },
          {
            label: "Ausführungsmodus",
            state: c.mode === "paper" ? "warn" : "ok",
            detail:
              c.mode === "paper"
                ? "paper — Orders werden nur simuliert"
                : c.mode === "metaapi"
                  ? "metaapi Cloud-REST"
                  : "bridge — dein MT5 führt aus",
          },
          {
            label: "EA DryRun",
            state: bridge?.dryRun === false ? "ok" : bridge?.dryRun === true ? "warn" : "warn",
            detail:
              bridge?.dryRun === false
                ? "aus — der EA würde echt ausführen"
                : bridge?.dryRun === true
                  ? "AN — Generalprobe, Broker bekommt nichts (gewollt, bis du umschaltest)"
                  : "EA berichtet den Zustand noch nicht (Version < 1.07?)",
          },
          {
            label: "Handelsfenster",
            state: status?.weekend && c.weekendHalt ? "warn" : "ok",
            detail:
              status?.weekend && c.weekendHalt
                ? "Wochenende-Halt aktiv — Signale werden geblockt"
                : `Session ${c.sessionStartUtc}:00–${c.sessionEndUtc}:00 UTC`,
          },
          {
            label: "Order-Queue",
            state: status && status.counts.queued + status.counts.dispatched > 0 ? "warn" : "ok",
            detail: status
              ? `${status.counts.queued} wartend · ${status.counts.dispatched} unterwegs · ${status.counts.filled} gefüllt · ${status.counts.failed} fehlgeschlagen`
              : "—",
          },
        ];
        return (
          <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
              Verbindungs-Checkliste — was lebt, was nicht
            </h3>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {items.map((it) => (
                <div
                  key={it.label}
                  className={`flex items-start gap-2 rounded border px-2.5 py-2 ${
                    it.state === "ok"
                      ? "border-emerald-500/25 bg-emerald-500/[0.05]"
                      : it.state === "warn"
                        ? "border-amber-500/25 bg-amber-500/[0.05]"
                        : "border-rose-500/30 bg-rose-500/[0.06]"
                  }`}
                >
                  <span className={it.state === "ok" ? "text-emerald-400" : it.state === "warn" ? "text-amber-400" : "text-rose-400"}>
                    {it.state === "ok" ? "✓" : it.state === "warn" ? "!" : "✗"}
                  </span>
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-slate-300">{it.label}</div>
                    <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{it.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Token-Selbsttest:</span>
              <input
                value={testToken}
                onChange={(e) => setTestToken(e.target.value)}
                placeholder="hxb_… einfügen (Whitespace wird ignoriert)"
                className="min-w-[260px] flex-1 rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
              />
              <button
                onClick={async () => {
                  const clean = testToken.replace(/\s+/g, "");
                  if (!clean) return;
                  try {
                    const res = await fetch(`/api/bridge/whoami?token=${encodeURIComponent(clean)}`, { cache: "no-store" });
                    const text = await res.text();
                    setTestResult(res.ok ? `✓ ${text.split("\n").slice(0, 4).join(" · ")}` : `✗ ${text.replace(/\n/g, " ")}`);
                  } catch {
                    setTestResult("✗ Anfrage fehlgeschlagen");
                  }
                }}
                className="rounded border border-slate-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400"
              >
                prüfen
              </button>
              {testResult ? (
                <span className={`font-mono text-[10px] ${testResult.startsWith("✓") ? "text-emerald-400" : "text-rose-400"}`}>
                  {testResult}
                </span>
              ) : null}
            </div>
          </section>
        );
      })()}

      {msg ? <div className="rounded border border-slate-800 bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-300">{msg}</div> : null}

      {/* --------------------------------------------------- bridge status */}
      <section className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Execution bridges</h3>
          {status?.bridges.length ? (
            <div className="mt-3 space-y-2">
              {status.bridges.map((b) => (
                <div key={b.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-100">{b.name}</span>
                    <Pill tone={b.online ? "text-emerald-400 border-emerald-500/40" : "text-slate-500 border-slate-700"}>
                      {b.online ? "ONLINE" : "OFFLINE"}
                    </Pill>
                    <Pill>{b.adapter}</Pill>
                    {b.dryRun === true ? <Pill tone="text-amber-400 border-amber-500/40">EA DRY RUN</Pill> : null}
                    {b.dryRun === false ? <Pill tone="text-emerald-400 border-emerald-500/40">EA LIVE-READY</Pill> : null}
                    <Pill>v{b.eaVersion ?? b.version ?? "?"}</Pill>
                    <span className="ml-auto font-mono text-[10px] text-slate-500">
                      token {b.tokenPrefix}… ·{" "}
                      {b.staleSeconds !== null ? `${b.staleSeconds.toFixed(0)}s ago` : "never seen"}
                    </span>
                    <button
                      onClick={() => deleteBridge(b.id, b.name, b.online)}
                      disabled={busy}
                      title="Bridge dauerhaft entfernen"
                      className="rounded border border-slate-700 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500 transition hover:border-rose-500/50 hover:text-rose-400 disabled:opacity-40"
                    >
                      löschen
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] text-slate-400 md:grid-cols-4">
                    <span>login: <span className="text-slate-200">{b.mt5Login ?? "—"}</span></span>
                    <span>server: <span className="text-slate-200">{b.mt5Server ?? "—"}</span></span>
                    <span>mode: <span className="text-slate-200">{b.accountMode ?? "—"}</span></span>
                    <span>ccy: <span className="text-slate-200">{b.accountCurrency ?? "—"}</span></span>
                    <span>equity: <span className="text-emerald-400">{b.equity?.toFixed(2) ?? "—"}</span></span>
                    <span>free: <span className="text-slate-200">{b.marginFree?.toFixed(2) ?? "—"}</span></span>
                    <span>positions: <span className="text-slate-200">{b.openPositions}</span></span>
                    <span>build: <span className="text-slate-200">{b.mt5Build ?? "—"}</span></span>
                    <span className="col-span-2 md:col-span-4">
                      real-feed:{" "}
                      <span className={b.feedSummary ? "text-emerald-400" : "text-slate-500"}>
                        {b.feedSummary || "noch keine History gespiegelt (Bridge ≥ py-1.10 nötig)"}
                      </span>
                      {b.feedUpdatedAt ? (
                        <span className="text-slate-600"> · {new Date(b.feedUpdatedAt).toISOString().slice(11, 16)} UTC</span>
                      ) : null}
                    </span>
                  </div>
                  {b.lastError ? <p className="mt-1.5 font-mono text-[10px] text-rose-400">last error: {b.lastError}</p> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-slate-500">
              No agent registered yet. Create one below — you get a single-use token that goes into the EA.
            </p>
          )}

          <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/[0.06] p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-sky-300">
              Aktuelle OMS-Adresse — gehört an ZWEI Stellen in MT5
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-sky-200">{origin}</code>
              <button
                onClick={() => copy("origin", origin)}
                className="shrink-0 rounded border border-slate-700 px-2 py-1 font-mono text-[10px] text-slate-300 hover:border-sky-500/50"
              >
                {copied === "origin" ? "kopiert ✓" : "kopieren"}
              </button>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
              Dieselbe Zeichenkette ohne alles Drumherum in (a) das EA-Input-Feld <code>InpServerUrl</code> und (b) die
              WebRequest-Freigabeliste unter Tools → Options → Expert Advisors. Diese Adresse ändert sich bei jedem
              Rebuild der Sandbox — wenn der EA plötzlich wieder „unreachable" meldet, zuerst diese Zeile gegen
              InpServerUrl prüfen.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3">
            <label className="flex-1">
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">Agent name</span>
              <input
                value={bridgeName}
                onChange={(e) => setBridgeName(e.target.value)}
                className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
              />
            </label>
            <button
              onClick={registerBridge}
              disabled={busy}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
            >
              {status?.bridges.length ? "rotate token" : "register agent"}
            </button>
          </div>

          {newToken ? (
            <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
                Agent token — shown once, store it now
              </p>
              <code className="mt-1.5 block break-all rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-emerald-300">
                {newToken.token}
              </code>
              <button
                onClick={() => copy("token", newToken.token)}
                className="mt-2 rounded border border-slate-700 px-2 py-1 font-mono text-[10px] text-slate-300 hover:border-emerald-500/50"
              >
                {copied === "token" ? "copied ✓" : "copy token"}
              </button>
            </div>
          ) : null}
        </div>

        {/* -------------------------------------------------- risk controls */}
        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Pre-trade risk guard</h3>
            <button
              onClick={() => control("update", c as unknown as Record<string, unknown>)}
              disabled={busy}
              className="rounded border border-slate-700 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
            >
              save
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-3">
            <label className="col-span-2 block md:col-span-1">
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">Adapter mode</span>
              <select
                value={c.mode}
                onChange={(e) => setDraft({ ...c, mode: e.target.value as Mode })}
                className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
              >
                <option value="paper">paper (simulated)</option>
                <option value="bridge">bridge (MT5 EA agent)</option>
                <option value="metaapi">metaapi (cloud REST)</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">Confirm mode</span>
              <select
                value={c.confirmMode}
                onChange={(e) => setDraft({ ...c, confirmMode: e.target.value })}
                className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
              >
                <option value="manual">manual (queue for approval)</option>
                <option value="auto">auto (dispatch immediately)</option>
              </select>
            </label>
            <Field label="Min P(win)" value={c.minMetaProb} step={0.01} min={0} max={0.99} onChange={(v) => setDraft({ ...c, minMetaProb: v })} />
            <Field label="Min confidence" value={c.minConfidence} step={0.01} onChange={(v) => setDraft({ ...c, minConfidence: v })} />
            <Field label="Max orders / day" value={c.maxDailyOrders} onChange={(v) => setDraft({ ...c, maxDailyOrders: v })} />
            <Field label="Max daily loss %" value={c.maxDailyLossPct} step={0.005} onChange={(v) => setDraft({ ...c, maxDailyLossPct: v })} />
            <Field label="Max notional % eq" value={c.maxNotionalPct} step={0.05} onChange={(v) => setDraft({ ...c, maxNotionalPct: v })} />
            <Field label="Max open positions" value={c.maxOpenPositions} onChange={(v) => setDraft({ ...c, maxOpenPositions: v })} />
            <Field label="Max per symbol" value={c.maxPositionsPerSymbol} onChange={(v) => setDraft({ ...c, maxPositionsPerSymbol: v })} />
            <Field label="Max spread (pts)" value={c.maxSpreadPoints} onChange={(v) => setDraft({ ...c, maxSpreadPoints: v })} />
            <Field label="Cooldown (s)" value={c.cooldownSeconds} step={30} onChange={(v) => setDraft({ ...c, cooldownSeconds: v })} />
            <Field label="Lot multiplier" value={c.lotMultiplier} step={0.1} onChange={(v) => setDraft({ ...c, lotMultiplier: v })} />
            <Field label="Order TTL (s)" value={c.orderTtlSeconds} step={15} onChange={(v) => setDraft({ ...c, orderTtlSeconds: v })} />
            <Field label="Session start UTC" value={c.sessionStartUtc} min={0} max={23} onChange={(v) => setDraft({ ...c, sessionStartUtc: v })} />
            <Field label="Session end UTC" value={c.sessionEndUtc} min={0} max={24} onChange={(v) => setDraft({ ...c, sessionEndUtc: v })} />
            <Field label="Trail ATR ×" value={c.trailingAtrMult} step={0.1} onChange={(v) => setDraft({ ...c, trailingAtrMult: v })} />
            <Field label="Breakeven at R" value={c.breakevenAtR} step={0.1} onChange={(v) => setDraft({ ...c, breakevenAtR: v })} />
            <Field label="Partial at R" value={c.partialAtR} step={0.1} onChange={(v) => setDraft({ ...c, partialAtR: v })} />
            <Field label="Partial fraction" value={c.partialFraction} step={0.05} onChange={(v) => setDraft({ ...c, partialFraction: v })} />
            <label className="col-span-2 block md:col-span-3">
              <span className="block text-[10px] uppercase tracking-wider text-slate-500">
                Symbol allow list (comma separated, empty = all mapped symbols)
              </span>
              <input
                value={c.allowedSymbols ?? ""}
                onChange={(e) => setDraft({ ...c, allowedSymbols: e.target.value })}
                placeholder="EURUSD,XAUUSD,BTCUSD"
                className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            {(
              [
                ["weekendHalt", c.weekendHalt, "weekend halt"],
                ["requireStopLoss", c.requireStopLoss, "refuse orders without SL"],
              ] as const
            ).map(([key, value, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-slate-400">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => setDraft({ ...c, [key]: e.target.checked })}
                  className="accent-emerald-500"
                />
                {label}
              </label>
            ))}
            <span className="font-mono text-[10px] text-slate-500">
              weekend window now: <span className={status?.weekend ? "text-amber-400" : "text-emerald-400"}>{status?.weekend ? "CLOSED" : "open"}</span>
            </span>
          </div>

          <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-mono text-[11px] uppercase tracking-[0.16em] text-slate-300">
                Strategie-Konsole — was auf deinem Konto läuft
              </h4>
              {bridge ? (
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  <Pill tone={bridge.online ? "text-emerald-400 border-emerald-500/40" : "text-slate-500 border-slate-700"}>
                    Konto: {bridge.mt5Login ?? "?"} @ {bridge.mt5Server ?? "?"}
                  </Pill>
                  <Pill>{bridge.name}</Pill>
                  {bridge.dryRun === true ? <Pill tone="text-amber-400 border-amber-500/40">DRY RUN</Pill> : null}
                  {bridge.dryRun === false ? <Pill tone="text-emerald-400 border-emerald-500/40">LIVE-READY</Pill> : null}
                </span>
              ) : (
                <span className="ml-auto font-mono text-[10px] text-slate-500">kein Konto verbunden</span>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5 md:grid-cols-5">
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Strategie</span>
                <select
                  value={c.autopilotPreset}
                  onChange={(e) => setDraft({ ...c, autopilotPreset: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200"
                >
                  {PRESET_CATALOG.map((pp) => (
                    <option key={pp.key} value={pp.key}>{pp.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Timeframe</span>
                <select
                  value={c.autopilotTimeframe}
                  onChange={(e) => setDraft({ ...c, autopilotTimeframe: e.target.value })}
                  className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200"
                >
                  {["15m", "1h", "4h", "1d"].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <Field label="Ziel-Trefferquote" value={c.autopilotTarget} step={0.01} min={0.35} max={0.97} onChange={(v) => setDraft({ ...c, autopilotTarget: v })} />
              <Field label="Autopilot alle (min)" value={c.autopilotMinutes} min={1} onChange={(v) => setDraft({ ...c, autopilotMinutes: v })} />
              <label className="col-span-2 block md:col-span-1">
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Symbole (Komma, max 3)</span>
                <input
                  value={c.autopilotSymbols}
                  onChange={(e) => setDraft({ ...c, autopilotSymbols: e.target.value })}
                  placeholder="EURUSD,XAUUSD,BTCUSD"
                  className="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200"
                />
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-slate-800 pt-3">
              <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-emerald-400">
                <input
                  type="checkbox"
                  checked={c.autopilot}
                  onChange={(e) => setDraft({ ...c, autopilot: e.target.checked })}
                  className="accent-emerald-500"
                />
                Autopilot an
              </label>
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
                Freigabe:
                <select
                  value={c.confirmMode}
                  onChange={(e) => setDraft({ ...c, confirmMode: e.target.value })}
                  className="rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[10px] text-slate-200"
                >
                  <option value="manual">jeder Trade per Klick</option>
                  <option value="auto">vollautomatisch</option>
                </select>
              </label>
              <button
                onClick={() => control("update", c as unknown as Record<string, unknown>)}
                disabled={busy}
                className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
              >
                übernehmen
              </button>
              <button
                onClick={() => {
                  const syms = (c.autopilotSymbols || "EURUSD").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3);
                  void (async () => {
                    for (const sym of syms) {
                      await control("dispatch", {
                        ticker: sym,
                        timeframe: c.autopilotTimeframe,
                        preset: c.autopilotPreset,
                        targetWinRate: c.autopilotTarget,
                      });
                    }
                  })();
                }}
                disabled={busy}
                className="rounded border border-slate-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
              >
                signale jetzt scannen
              </button>
              <span className="font-mono text-[10px] text-slate-500">
                sichtbar: Queue unten · Audit-Trail · Autopilot scannt im Poll-Takt der Bridge
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ setup guide */}
      <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            Weg B (Fallback): Expert Advisor im Terminal
          </h3>
          <Link
            href="/mt5"
            className="ml-auto rounded border border-slate-700 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400"
          >
            full integration reference →
          </Link>
        </div>

        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-3.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300">
            Weg A — Python-Bridge · empfohlen · kein MetaEditor, kein EA, keine Freigabeliste, kein Token-Copy
          </p>
          <ol className="mt-2.5 space-y-1.5 text-[11px] leading-relaxed text-slate-400">
            <li>
              <span className="font-mono text-emerald-400">1</span> — Python installieren (python.org → Downloads →
              Installer → <strong className="text-slate-200">Haken bei „Add python.exe to PATH"</strong>).
            </li>
            <li>
              <span className="font-mono text-emerald-400">2</span> — Beide Dateien in <strong>einen</strong> Ordner
              legen (z. B. Desktop\helix):{" "}
              <a href="/mt5/start_bridge.bat" download className="text-emerald-400 underline decoration-dotted">start_bridge.bat</a>{" "}
              +{" "}
              <a href="/mt5/helix_bridge.py" download className="text-emerald-400 underline decoration-dotted">helix_bridge.py</a>
            </li>
            <li>
              <span className="font-mono text-emerald-400">3</span> — <strong>start_bridge.bat doppelklicken.</strong>{" "}
              Beim allerersten Start fragt das Fenster einmal nach der Server-URL (blaues Feld hier im Tab) — den
              Agent-Token registriert und speichert die Bridge <strong>selbst</strong>, du kopierst nie wieder einen
              Token.
            </li>
            <li>
              <span className="font-mono text-emerald-400">4</span> — MT5-Terminal geöffnet und eingeloggt lassen.
              Solange das schwarze Fenster läuft, läuft der Bot. Standard ist Dry Run; für echte Orders auf dem
              Demokonto: Fenster schließen und <code className="text-slate-200">start_bridge.bat --live</code> starten
              (oder dry_run=false in helix_config.ini).
            </li>
          </ol>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            URL geändert? Einfach nochmal doppelklicken: merkt das Fenster, dass die alte OMS-URL tot ist, fragt es
            einmal nach der neuen und speichert sie selbst. · Selbsttest ohne Trading:{" "}
            <code className="text-slate-300">python helix_bridge.py --test</code> · Symbolliste
            anpassen: <code className="text-slate-300">--symbols EURUSD,XAUUSD</code> · Die Bridge nutzt die offizielle
            MetaTrader5-Python-Schnittstelle (lokale Verbindung zum Terminal) und plain HTTPS zum Server — dadurch
            fallen WebRequest-Freigabeliste, .ex5-Compiles und Chart-States komplett weg.
          </p>
        </div>
        <ol className="mt-3 space-y-2.5 text-[11px] leading-relaxed text-slate-400">
          <li>
            <span className="font-mono text-emerald-400">01</span> — Register an agent above and copy the{" "}
            <code className="text-slate-200">hxb_…</code> token. It is shown once; the database only keeps a SHA-256
            hash of it.
          </li>
          <li>
            <span className="font-mono text-emerald-400">02</span> — Download{" "}
            <a href="/mt5/HelixBridgeEA.mq5" download className="text-emerald-400 underline decoration-dotted">
              HelixBridgeEA.mq5
            </a>{" "}
            oder, wenn die Verbindung klemmt, das Selbstdiagnose-Script{" "}
            <a href="/mt5/HelixDiagnose.mq5" download className="text-sky-400 underline decoration-dotted">
              HelixDiagnose.mq5
            </a>{" "}
            nach <code className="text-slate-300">MQL5/Scripts</code> legen, im MetaEditor mit F7 kompilieren und dann
            <strong className="text-slate-200"> im Terminal</strong> starten: Strg+N → Knoten „Scripts" → Rechtsklick →
            Aktualisieren → Doppelklick auf HelixDiagnose (Scripts laufen nie aus dem MetaEditor). Es sagt ohne EA und
            ohne Token, welche Schicht blockt.{" "}
            into <code className="text-slate-200">MQL5/Experts/</code> of your MT5 data folder (MT5 → File → Open Data
            Folder), then open it in MetaEditor and press <strong className="text-slate-200">Compile</strong>.
          </li>
          <li>
            <span className="font-mono text-emerald-400">03</span> — In MT5: Tools → Options → Expert Advisors →
            enable <strong className="text-slate-200">Algo Trading</strong> and add your OMS host to{" "}
            <strong className="text-slate-200">Allow WebRequest for listed URL</strong>:{" "}
            <button onClick={() => copy("origin", origin)} className="font-mono text-sky-400 underline decoration-dotted">
              {copied === "origin" ? "copied ✓" : origin}
            </button>
          </li>
          <li>
            <span className="font-mono text-emerald-400">04</span> — Drag the EA onto any chart of the account you want
            to trade and paste the inputs:
            <pre className="mt-2 overflow-x-auto rounded border border-slate-800 bg-slate-950 p-2.5 font-mono text-[10px] leading-relaxed text-slate-300">
              {eaSnippet}
            </pre>
          </li>
          <li>
            <span className="font-mono text-emerald-400">05</span> — The EA publishes your broker's real contract specs
            (digits, contract size, lot step, stop level, tick value) on the first tick. Check the symbol map below —
            that is what turns <code className="text-slate-200">BTCUSDT</code> into whatever your broker calls it.
          </li>
          <li>
            <span className="font-mono text-emerald-400">06</span> — Set <strong className="text-slate-200">Adapter
            mode = bridge</strong>, keep <strong className="text-slate-200">Confirm mode = manual</strong>, press{" "}
            <strong className="text-emerald-400">ARM</strong>, then use “dispatch signals” and approve orders one by one
            in the queue.
          </li>
          <li>
            <span className="font-mono text-emerald-400">07</span> — Only after you have watched several manual cycles
            behave correctly: flip the EA's <code className="text-slate-200">InpDryRun=false</code> and the confirm mode
            to <code className="text-slate-200">auto</code>.
          </li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
          <button
            onClick={() => {
              const syms = (c.autopilotSymbols || "EURUSD").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3);
              void (async () => {
                for (const sym of syms) {
                  await control("dispatch", {
                    ticker: sym,
                    timeframe: c.autopilotTimeframe,
                    preset: c.autopilotPreset,
                    targetWinRate: c.autopilotTarget,
                  });
                }
              })();
            }}
            disabled={busy}
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            signale scannen → queue
          </button>
          <span className="self-center font-mono text-[10px] text-slate-500">
            queued {status?.counts.queued ?? 0} · dispatched {status?.counts.dispatched ?? 0} · filled{" "}
            {status?.counts.filled ?? 0} · failed {status?.counts.failed ?? 0}
          </span>
        </div>
      </section>

      {/* ------------------------------------------------------- order queue */}
      <section className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Order queue (OMS)</h3>
        <div className="mt-3 max-h-[380px] overflow-auto">
          <table className="w-full font-mono text-[10px]">
            <thead className="sticky top-0 bg-[#080b14] text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-1.5 text-left">id</th>
                <th className="text-left">state</th>
                <th className="text-left">act</th>
                <th className="text-left">symbol</th>
                <th className="text-left">side</th>
                <th className="text-right">lots</th>
                <th className="text-right">entry</th>
                <th className="text-right">sl</th>
                <th className="text-right">tp</th>
                <th className="text-right">p(win)</th>
                <th className="text-right">fill</th>
                <th className="text-right">slip</th>
                <th className="text-left">rc / note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(status?.orders ?? []).map((o) => (
                <tr key={o.id} className="border-b border-slate-900/70">
                  <td className="py-1 text-slate-500">{o.id}</td>
                  <td>
                    <Pill tone={STATE_TONE[o.state] ?? "text-slate-400 border-slate-700"}>{o.state}</Pill>
                  </td>
                  <td className="text-slate-400">{o.action}</td>
                  <td className="text-slate-200">{o.symbol}</td>
                  <td className={o.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{o.side}</td>
                  <td className="text-right text-slate-300">{o.volume.toFixed(3)}</td>
                  <td className="text-right text-slate-400">{o.entryPrice?.toFixed(5) ?? "mkt"}</td>
                  <td className="text-right text-rose-400/70">{o.stopPrice ? o.stopPrice.toFixed(5) : "—"}</td>
                  <td className="text-right text-emerald-400/70">{o.targetPrice ? o.targetPrice.toFixed(5) : "—"}</td>
                  <td className="text-right text-amber-400/80">{o.metaProb ? (o.metaProb * 100).toFixed(0) + "%" : "—"}</td>
                  <td className="text-right text-slate-300">{o.fillPrice ? o.fillPrice.toFixed(5) : "—"}</td>
                  <td className="text-right text-slate-500">{o.slippagePoints ? o.slippagePoints.toFixed(1) : "—"}</td>
                  <td className="max-w-[220px] truncate pr-2 text-slate-500">
                    {o.retcode ? `${o.retcode} ` : ""}
                    {o.errorText ?? o.retcodeText ?? ""}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {o.state === "HELD" || o.state === "PENDING" ? (
                      <>
                        <button
                          onClick={() => control("approve", { id: o.id })}
                          className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[9px] text-emerald-300 hover:bg-emerald-500/15"
                        >
                          {o.state === "HELD" ? "approve → queue" : "re-queue"}
                        </button>{" "}
                        <button
                          onClick={() => control("cancel", { id: o.id, reason: "operator cancel" })}
                          className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] text-slate-400 hover:border-rose-500/50 hover:text-rose-400"
                        >
                          cancel
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!status?.orders.length ? (
                <tr>
                  <td colSpan={14} className="py-4 text-center text-[11px] text-slate-500">
                    Order queue is empty.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------- positions + symbol map */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Broker book (mirrored)</h3>
            <span className="font-mono text-[10px] text-slate-500">
              open P&amp;L <span className={status && status.openPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {(status?.openPnl ?? 0).toFixed(2)}
              </span>
            </span>
          </div>
          <table className="mt-3 w-full font-mono text-[10px]">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-1.5 text-left">ticket</th>
                <th className="text-left">symbol</th>
                <th className="text-left">side</th>
                <th className="text-right">lots</th>
                <th className="text-right">open</th>
                <th className="text-right">mark</th>
                <th className="text-right">sl</th>
                <th className="text-right">tp</th>
                <th className="text-right">p&amp;l</th>
              </tr>
            </thead>
            <tbody>
              {(status?.positions.open ?? []).map((p) => (
                <tr key={p.id} className="border-b border-slate-900/70">
                  <td className="py-1 text-slate-500">{p.mt5Ticket}</td>
                  <td className="text-slate-200">{p.symbol}</td>
                  <td className={p.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{p.side}</td>
                  <td className="text-right text-slate-300">{p.volume.toFixed(2)}</td>
                  <td className="text-right text-slate-400">{p.openPrice.toFixed(5)}</td>
                  <td className="text-right text-slate-400">{p.currentPrice?.toFixed(5) ?? "—"}</td>
                  <td className="text-right text-rose-400/70">{p.sl ? p.sl.toFixed(5) : "none"}</td>
                  <td className="text-right text-emerald-400/70">{p.tp ? p.tp.toFixed(5) : "none"}</td>
                  <td className={`text-right ${p.profit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {p.profit.toFixed(2)}
                  </td>
                </tr>
              ))}
              {!status?.positions.open.length ? (
                <tr>
                  <td colSpan={9} className="py-3 text-center text-[10px] text-slate-500">
                    No open positions reported by the terminal.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            Symbol map &amp; contract specification
          </h3>
          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
            Reported live by the EA. Sizing, lot-step rounding and stop-level compliance are all computed from these
            numbers, never guessed.
          </p>
          <div className="mt-2 max-h-[260px] overflow-auto">
            <table className="w-full font-mono text-[10px]">
              <thead className="sticky top-0 bg-[#080b14] text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="py-1.5 text-left">internal</th>
                  <th className="text-left">broker</th>
                  <th className="text-right">digits</th>
                  <th className="text-right">contract</th>
                  <th className="text-right">lot step</th>
                  <th className="text-right">min</th>
                  <th className="text-right">stops</th>
                  <th className="text-right">spread</th>
                </tr>
              </thead>
              <tbody>
                {(status?.instruments ?? []).map((s) => (
                  <tr key={s.id} className="border-b border-slate-900/70">
                    <td className="py-1 text-slate-300">{s.ticker}</td>
                    <td className="text-emerald-400/90">{s.symbol}</td>
                    <td className="text-right text-slate-400">{s.digits}</td>
                    <td className="text-right text-slate-400">{s.contractSize}</td>
                    <td className="text-right text-slate-400">{s.volumeStep}</td>
                    <td className="text-right text-slate-400">{s.minVolume}</td>
                    <td className="text-right text-slate-400">{s.stopsLevel}</td>
                    <td className="text-right text-slate-500">{s.spreadPoints.toFixed(0)}</td>
                  </tr>
                ))}
                {!status?.instruments.length ? (
                  <tr>
                    <td colSpan={8} className="py-3 text-center text-[10px] text-slate-500">
                      Nothing reported yet — defaults are used until the EA connects.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ metaapi + audit */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">
            MetaApi cloud adapter (no terminal required)
          </h3>
          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
            Alternative path for operators who do not want to run MT5 at all. Set{" "}
            <code className="text-slate-300">METAAPI_TOKEN</code> (and optionally{" "}
            <code className="text-slate-300">METAAPI_REGION</code>) as server-side environment variables — the token
            never reaches the browser.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Pill tone={status?.metaApiConfigured ? "text-emerald-400 border-emerald-500/40" : "text-amber-400 border-amber-500/40"}>
              {status?.metaApiConfigured ? `token present · ${status.metaApiRegion}` : "METAAPI_TOKEN not set"}
            </Pill>
            <button
              onClick={() => control("metaapi:accounts")}
              disabled={busy || !status?.metaApiConfigured}
              className="rounded border border-slate-700 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 disabled:opacity-40"
            >
              list accounts
            </button>
            <button
              onClick={() => control("metaapi:flush")}
              disabled={busy || !status?.metaApiConfigured}
              className="rounded border border-slate-700 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 disabled:opacity-40"
            >
              flush queue
            </button>
          </div>
          {metaAccounts.length ? (
            <div className="mt-3 space-y-1.5">
              {metaAccounts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5">
                  <span className="font-mono text-[10px] text-slate-200">{a.name ?? a.id}</span>
                  <span className="font-mono text-[10px] text-slate-500">login {a.login ?? "?"} · {a.state ?? "?"}</span>
                  <code className="ml-auto font-mono text-[9px] text-slate-500">{a.id.slice(0, 12)}…</code>
                  <button
                    onClick={() => {
                      setDraft({ ...c, metaApiAccountId: a.id });
                      void control("update", { ...c, metaApiAccountId: a.id, mode: "metaapi" });
                    }}
                    className="rounded border border-emerald-500/40 px-2 py-0.5 font-mono text-[9px] text-emerald-300 hover:bg-emerald-500/15"
                  >
                    use
                  </button>
                  <button
                    onClick={() => control("metaapi:sync", { accountId: a.id })}
                    className="rounded border border-slate-700 px-2 py-0.5 font-mono text-[9px] text-slate-300 hover:border-sky-500/50"
                  >
                    sync book
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {c.metaApiAccountId ? (
            <p className="mt-2 font-mono text-[10px] text-slate-500">
              bound account: <span className="text-slate-300">{c.metaApiAccountId}</span>
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#080b14] p-4">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-slate-400">Audit trail</h3>
          <div className="mt-2 max-h-[300px] space-y-1 overflow-auto font-mono text-[10px]">
            {(status?.events ?? []).map((e) => (
              <div key={e.id} className="flex gap-2 border-b border-slate-900/60 pb-1">
                <span
                  className={
                    e.level === "error"
                      ? "text-rose-400"
                      : e.level === "warn"
                        ? "text-amber-400"
                        : e.level === "audit"
                          ? "text-sky-400"
                          : "text-slate-500"
                  }
                >
                  {e.level}
                </span>
                <span className="text-slate-600">{e.scope}</span>
                <span className="flex-1 text-slate-400">{e.message}</span>
                <span className="text-slate-600">{new Date(e.createdAt).toISOString().slice(11, 19)}</span>
              </div>
            ))}
            {!status?.events.length ? <p className="text-slate-500">No events yet.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
