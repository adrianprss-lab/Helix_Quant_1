"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ================= types ================= */
interface PositionRow {
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
  comment: string | null;
  status: string;
}
interface OrderRow {
  id: number;
  action: string;
  symbol: string;
  side: string;
  volume: number;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  state: string;
  alphaKey: string | null;
  createdAt: string;
  errorText: string | null;
}
interface EventRow {
  id: number;
  level: string;
  scope: string;
  message: string;
  createdAt: string;
}
interface InstrumentRow {
  ticker: string;
  symbol: string;
  digits: number;
  point: number;
  spreadPoints: number;
  tradeMode: number;
}
interface Controls {
  armed: boolean;
  killSwitch: boolean;
  mode: string;
  confirmMode: string;
  autopilot: boolean;
  autopilotPreset: string;
  autopilotTimeframe: string;
  autopilotSymbols: string;
  autopilotMinutes: number;
  maxDailyLossPct: number;
  riskPerTrade: number;
  maxSpreadPoints: number;
}
interface Status {
  bridges: {
    id: number;
    name: string;
    online: boolean;
    mt5Login: string | null;
    mt5Server: string | null;
    equity: number | null;
    balance: number | null;
    margin: number | null;
    marginFree: number | null;
    marginLevel: number | null;
    dryRun: boolean | null;
    staleSeconds: number | null;
  }[];
  controls: Controls;
  counts: { held: number; queued: number; dispatched: number; filled: number; failed: number };
  positions: { open: PositionRow[]; closed: PositionRow[] };
  orders: OrderRow[];
  events: EventRow[];
  instruments: InstrumentRow[];
}
interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const GOLD_PIP = 0.1; // XAUUSD: 1 Pip = 0.10 $
const PIP_VALUE_PER_LOT = 10; // 1 Lot (100 oz) → $10 pro Pip

/* ================= small ui atoms ================= */
function Flash({ v, children, className = "" }: { v: number | string; children: React.ReactNode; className?: string }) {
  const prev = useRef(v);
  const [dir, setDir] = useState<0 | 1 | -1>(0);
  useEffect(() => {
    if (v !== prev.current) {
      const up = typeof v === "number" && typeof prev.current === "number" ? v > prev.current : true;
      prev.current = v;
      setDir(up ? 1 : -1);
      const t = setTimeout(() => setDir(0), 130);
      return () => clearTimeout(t);
    }
  }, [v]);
  return <span className={`${dir === 1 ? "flash-up" : dir === -1 ? "flash-dn" : ""} ${className}`}>{children}</span>;
}

function Metric({
  label,
  value,
  tone = "text-[#c9d1d9]",
  alarm = "",
  mono = true,
}: {
  label: string;
  value: string;
  tone?: string;
  alarm?: string;
  mono?: boolean;
}) {
  return (
    <div className={`flex min-w-[92px] flex-col px-3 py-1.5 ${alarm}`}>
      <span className="text-[9px] uppercase tracking-[0.14em] text-[#6e7681]">{label}</span>
      <span className={`mono text-[13px] leading-tight ${tone}`}>
        <Flash v={value}>{value}</Flash>
      </span>
    </div>
  );
}

const NAV: { key: string; label: string; icon: React.ReactNode }[] = [
  {
    key: "desk",
    label: "Dashboard",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
        <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
        <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
        <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
      </svg>
    ),
  },
  {
    key: "bots",
    label: "Bot-Fabrik",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="3" y="4" width="10" height="8" rx="2" />
        <path d="M6 8h4M8 6v4M8 1.5V4M8 12v2.5" />
      </svg>
    ),
  },
  {
    key: "market",
    label: "Marktanalyse",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M3 13V8M6.5 13V3M10 13V6M13.5 13V9" />
      </svg>
    ),
  },
  {
    key: "api",
    label: "API-Keys",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="5" cy="8" r="2.5" />
        <path d="M7.5 8h7M12 8v2.5M14.5 8v1.8" />
      </svg>
    ),
  },
  {
    key: "billing",
    label: "Billing",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
        <path d="M1.5 6.5h13" />
      </svg>
    ),
  },
  {
    key: "settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
      </svg>
    ),
  },
];

const BOTS: { key: string; name: string; preset: string; tf: string; desc: string }[] = [
  { key: "smc", name: "GOLD-SCALPER V2", preset: "smc_gold_m15", tf: "5m", desc: "SMC Liquidity · BoS/POI · M5-M15" },
  { key: "edge", name: "XAU-SWING CARRY", preset: "real_gold_swing", tf: "1d", desc: "Real-Edge Daily · Trend-Swings" },
  { key: "apex", name: "XAU-INTRADAY APEX", preset: "apex_hit_rate", tf: "1h", desc: "Meta-labeling · High-Hitrate" },
];

/* ================= chart ================= */
function GoldChart({
  candles,
  positions,
  trades,
}: {
  candles: Candle[];
  positions: PositionRow[];
  trades: PositionRow[];
}) {
  const W = 1000;
  const H = 460;
  const padR = 62;
  const padT = 12;
  const padB = 22;
  if (candles.length < 2) return <div className="mono p-6 text-[11px] text-[#6e7681]">warte auf XAUUSD-Feed …</div>;
  const view = candles.slice(-140);
  let min = Infinity;
  let max = -Infinity;
  for (const c of view) {
    min = Math.min(min, c.low);
    max = Math.max(max, c.high);
  }
  for (const p of positions) {
    for (const lvl of [p.openPrice, p.sl ?? 0, p.tp ?? 0]) {
      if (lvl > 0) {
        min = Math.min(min, lvl);
        max = Math.max(max, lvl);
      }
    }
  }
  const span = max - min || 1;
  min -= span * 0.06;
  max += span * 0.06;
  const x = (i: number) => (i / Math.max(1, view.length - 1)) * (W - padR);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const cw = Math.max(1.6, ((W - padR) / view.length) * 0.62);
  const idxOfTs = (ts: number) => {
    let best = 0;
    let bd = Infinity;
    view.forEach((c, i) => {
      const d = Math.abs(c.ts - ts);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  const gridVals = Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none">
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={0} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#10141b" strokeWidth="1" />
          <text x={W - padR + 6} y={y(v) + 3} fontSize="9.5" fill="#6e7681" className="mono">
            {v.toFixed(2)}
          </text>
        </g>
      ))}
      {view.map((c, i) => {
        const up = c.close >= c.open;
        const col = up ? "#00e676" : "#ff1744";
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        return (
          <g key={c.ts}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" opacity="0.75" />
            <rect x={x(i) - cw / 2} y={bodyTop} width={cw} height={bodyH} fill={up ? "#0b1410" : "#170b0e"} stroke={col} strokeWidth="1" />
          </g>
        );
      })}
      {/* offene positionen: entry/sl/tp gestrichelt */}
      {positions.map((p) => (
        <g key={p.id}>
          <line x1={0} x2={W - padR} y1={y(p.openPrice)} y2={y(p.openPrice)} stroke="#d4af37" strokeDasharray="5 4" strokeWidth="1" opacity="0.85" />
          {p.sl ? <line x1={0} x2={W - padR} y1={y(p.sl)} y2={y(p.sl)} stroke="#ff1744" strokeDasharray="3 4" strokeWidth="1" opacity="0.8" /> : null}
          {p.tp ? <line x1={0} x2={W - padR} y1={y(p.tp)} y2={y(p.tp)} stroke="#00e676" strokeDasharray="3 4" strokeWidth="1" opacity="0.8" /> : null}
          <text x={4} y={y(p.openPrice) - 3} fontSize="9" fill="#d4af37" className="mono">
            {p.side.toUpperCase()} {p.volume.toFixed(2)} @ {p.openPrice.toFixed(2)}
          </text>
        </g>
      ))}
      {/* historische bot-trades als marker (nur im Sichtfenster) */}
      {trades
        .map((t) => ({ t, ts: Number((t as unknown as { closedTs?: number | null }).closedTs ?? 0) }))
        .filter((m) => m.ts >= view[0].ts && m.ts <= view[view.length - 1].ts)
        .slice(-24)
        .map(({ t, ts }) => {
          const xi = x(idxOfTs(ts));
          const buy = t.side === "buy";
          return (
            <g key={t.id} opacity="0.9">
              <path
                d={buy ? `M ${xi} ${y(t.openPrice) + 8} l 4 6 l -8 0 Z` : `M ${xi} ${y(t.openPrice) - 8} l 4 -6 l -8 0 Z`}
                fill={buy ? "#00e676" : "#ff1744"}
              />
            </g>
          );
        })}
      <line x1={0} x2={W - padR} y1={H - padB} y2={H - padB} stroke="#161b22" />
    </svg>
  );
}

/* ================= main ================= */
export default function ProTerminal() {
  const [status, setStatus] = useState<Status | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<"live" | "demo">("live");
  const [tab, setTab] = useState<"trades" | "pending" | "history" | "events">("trades");
  const [nav, setNav] = useState("desk");
  const [riskPct, setRiskPct] = useState(1.0);
  const [stopPips, setStopPips] = useState(30);
  const [manualLots, setManualLots] = useState(0.1);
  const [lotMode, setLotMode] = useState<"auto" | "manual">("auto");
  const [maxSlippage, setMaxSlippage] = useState(2);
  const [cli, setCli] = useState<{ ts: string; level: string; text: string }[]>([]);
  const cliRef = useRef<HTMLDivElement>(null);
  const seenEvents = useRef(0);

  const load = useCallback(async () => {
    const t0 = performance.now();
    try {
      const [s, m] = await Promise.all([
        fetch("/api/exec/status", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/market?ticker=XAUUSD&timeframe=15m&limit=160", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setLatency(Math.round(performance.now() - t0));
      setStatus(s as Status);
      setCandles(((m.candles ?? []) as Candle[]).map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close })));
    } catch {
      /* poll bleibt still */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // CLI-Stream aus Events füttern
  useEffect(() => {
    if (!status) return;
    const evs = status.events ?? [];
    const fresh = evs.filter((e) => e.id > seenEvents.current).slice(0, 12);
    if (fresh.length) {
      seenEvents.current = Math.max(seenEvents.current, ...fresh.map((e) => e.id));
      setCli((prev) =>
        [
          ...prev,
          ...fresh.map((e) => ({
            ts: new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 23),
            level: e.level,
            text: `[${e.scope.toUpperCase()}] ${e.message}`,
          })),
        ].slice(-60),
      );
    }
  }, [status]);
  useEffect(() => {
    cliRef.current?.scrollTo({ top: cliRef.current.scrollHeight });
  }, [cli]);

  const bridge = status?.bridges.find((b) => b.online) ?? status?.bridges[0] ?? null;
  const controls = status?.controls;
  const equity = workspace === "live" ? bridge?.equity ?? 0 : 100_000;
  const balance = workspace === "live" ? bridge?.balance ?? 0 : 100_000;
  const margin = bridge?.margin ?? 0;
  const free = bridge?.marginFree ?? 0;
  const marginLevel = bridge?.marginLevel ?? 0;
  const last = candles[candles.length - 1];
  const prevLast = useRef<number | null>(null);
  const priceDir = prevLast.current === null || !last ? 0 : last.close > prevLast.current ? 1 : last.close < prevLast.current ? -1 : 0;
  useEffect(() => {
    if (last) prevLast.current = last.close;
  }, [last]);

  const xau = status?.instruments.find((i) => i.ticker === "XAUUSD");
  const spreadPips = useMemo(() => {
    if (!xau) return null;
    let pips = (xau.spreadPoints * xau.point) / GOLD_PIP;
    if (pips > 50) pips = (xau.spreadPoints * (xau.point / 100)) / GOLD_PIP; // Broker-Punkt-Konvention korrigieren
    return pips;
  }, [xau]);
  const spreadHot = spreadPips !== null && spreadPips > 3.5;

  const dynamicLots = useMemo(() => {
    const riskUsd = equity * (riskPct / 100);
    return riskUsd / Math.max(1, stopPips * PIP_VALUE_PER_LOT);
  }, [equity, riskPct, stopPips]);

  const panic = async () => {
    if (!window.confirm("PANIC: Alle offenen Positionen schließen, Queue canceln und Bots stoppen?")) return;
    await fetch("/api/exec/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "kill", reason: "PANIC button (pro desk)" }) });
    await fetch("/api/exec/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update", autopilot: false }) });
    setCli((p) => [...p, { ts: new Date().toISOString().replace("T", " ").slice(0, 23), level: "error", text: "[RISK] PANIC ausgeführt: flatten + queue-cancel + bots off" }]);
    void load();
  };

  const setBot = async (preset: string, tf: string, on: boolean) => {
    await fetch("/api/exec/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update", autopilot: on, autopilotPreset: preset, autopilotTimeframe: tf, autopilotSymbols: "XAUUSD" }),
    });
    void load();
  };

  const saveRisk = async () => {
    await fetch("/api/exec/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update",
        riskPerTrade: lotMode === "auto" ? riskPct / 100 : controls?.riskPerTrade ?? 0.0075,
        maxDailyLossPct: controls?.maxDailyLossPct ?? 0.03,
        maxSpreadPoints: Math.round(maxSlippage * 10),
      }),
    });
    setCli((p) => [...p, { ts: new Date().toISOString().replace("T", " ").slice(0, 23), level: "info", text: `[RISK] Controller gespeichert: mode=${lotMode} risk=${riskPct}% stop=${stopPips}pips slippage<=${maxSlippage}pips` }]);
    void load();
  };

  const marginAlarm = marginLevel > 0 && marginLevel < 100 ? "margin-crit" : marginLevel > 0 && marginLevel < 200 ? "margin-warn" : "";
  const winRateOf = (preset: string) => (preset === "real_gold_swing" ? 58.3 : preset === "smc_gold_m15" ? 55.0 : 78.1);

  return (
    <div className="hx-pro grid h-screen w-screen grid-cols-[64px_1fr_368px] grid-rows-[46px_1fr_22px] overflow-hidden">
      {/* ================= SÄULE A ================= */}
      <aside className="row-span-3 flex flex-col items-center gap-1 border-r hair bg-[#0b0e14] py-2">
        <button
          onClick={() => setWorkspace(workspace === "live" ? "demo" : "live")}
          title="Workspace wechseln"
          className={`mono mb-2 grid h-9 w-9 place-items-center rounded-md border text-[10px] font-bold ${
            workspace === "live" ? "border-[#d4af37]/60 bg-[#d4af37]/10 text-[#f3c63f]" : "border-[#00b0ff]/50 bg-[#00b0ff]/10 text-[#00b0ff]"
          }`}
        >
          {workspace === "live" ? "LIVE" : "DEMO"}
        </button>
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => setNav(n.key)}
            title={n.label}
            className={`grid h-10 w-10 place-items-center rounded-md border border-transparent transition ${
              nav === n.key ? "border-[#161b22] bg-[#10141b] text-[#f3c63f]" : "text-[#6e7681] hover:text-[#c9d1d9]"
            }`}
          >
            {n.icon}
          </button>
        ))}
        <div className="mt-auto flex flex-col items-center gap-2 pb-1">
          <div className="grid h-8 w-8 place-items-center rounded-full border border-[#00e676]/40 bg-[#00e676]/10" title="2FA aktiv">
            <svg viewBox="0 0 16 16" className="h-4 w-4 text-[#00e676]" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M8 1.8l5 2v4c0 3.2-2.1 5.6-5 6.4-2.9-.8-5-3.2-5-6.4v-4l5-2z" />
              <path d="M5.8 8l1.6 1.6L10.4 6.4" />
            </svg>
          </div>
          <span className="mono text-[9px] text-[#6e7681]">AD</span>
        </div>
      </aside>

      {/* ================= TOP-BAR ================= */}
      <header className="col-span-2 flex items-stretch gap-0 overflow-hidden border-b hair bg-[#0b0e14]">
        <div className="flex items-center gap-2 border-r hair px-3">
          <span className="mono text-[13px] font-bold tracking-tight text-[#f3c63f]">XAUUSD</span>
          <span className={`mono text-[15px] font-semibold ${priceDir > 0 ? "text-[#00e676]" : priceDir < 0 ? "text-[#ff1744]" : "text-[#c9d1d9]"}`}>
            <Flash v={last?.close ?? 0}>{last ? last.close.toFixed(2) : "—"}</Flash>
          </span>
          <span className={`rounded border px-1.5 py-0.5 mono text-[9px] ${spreadHot ? "spread-hot border-[#ffc400]/40 text-[#ffc400]" : "border-[#161b22] text-[#6e7681]"}`}>
            SPREAD {spreadPips === null ? "—" : spreadPips.toFixed(1)} PIPS
          </span>
        </div>
        <div className="flex items-stretch divide-x divide-[#161b22] overflow-x-auto">
          <Metric label="Balance" value={balance ? balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"} />
          <Metric label="Equity" value={equity ? equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"} tone="text-[#f3c63f]" />
          <Metric label="Margin" value={margin ? margin.toFixed(2) : "0.00"} />
          <Metric label="Free Margin" value={free ? free.toFixed(2) : "0.00"} />
          <Metric
            label="Margin Level"
            value={marginLevel ? `${marginLevel.toFixed(1)}%` : "—"}
            tone={marginLevel && marginLevel < 100 ? "text-[#ff1744]" : marginLevel && marginLevel < 200 ? "text-[#ffc400]" : "text-[#00e676]"}
            alarm={marginAlarm}
          />
        </div>
        <div className="ml-auto flex items-center gap-3 pr-3">
          <span className="mono text-[10px] text-[#6e7681]">
            {bridge?.mt5Server ?? "kein broker"} · #{bridge?.mt5Login ?? "—"} ·{" "}
            <span className={latency !== null && latency < 250 ? "text-[#00e676]" : "text-[#ffc400]"}>{latency === null ? "—" : `${latency}ms`}</span>
          </span>
          <span className={`mono text-[10px] ${bridge?.online ? "text-[#00e676]" : "text-[#ff1744]"}`}>{bridge?.online ? "BRIDGE ONLINE" : "BRIDGE OFFLINE"}</span>
          <button onClick={panic} className="panic mono rounded-md border border-[#ff1744] bg-[#ff1744]/15 px-3 py-1.5 text-[10px] font-bold tracking-wider text-[#ff1744]">
            ⛔ PANIC: CLOSE ALL & STOP BOTS
          </button>
        </div>
      </header>

      {/* ================= SÄULE B ================= */}
      <main className="grid min-h-0 grid-rows-[1fr_minmax(180px,38%)] gap-px bg-[#161b22]">
        {/* chart */}
        <section className="relative flex min-h-0 flex-col bg-[#0b0e14]">
          <div className="flex items-center justify-between border-b hair px-3 py-1.5">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-[#6e7681]">XAUUSD · M15 · Broker-Feed</span>
            <span className="mono text-[9px] text-[#6e7681]">overlays: open orders / SL / TP · marker: bot-fills</span>
          </div>
          <div className="min-h-0 flex-1">
            <GoldChart candles={candles} positions={status?.positions.open ?? []} trades={status?.positions.closed ?? []} />
          </div>
        </section>
        {/* positions / orders / history / events */}
        <section className="flex min-h-0 flex-col bg-[#0b0e14]">
          <div className="flex items-center gap-1 border-b hair px-2 py-1">
            {(
              [
                ["trades", `Aktive Trades (${status?.positions.open.length ?? 0})`],
                ["pending", `Schwebende Orders (${(status?.counts.queued ?? 0) + (status?.counts.held ?? 0)})`],
                ["history", `Historie (${status?.positions.closed.length ?? 0})`],
                ["events", "Bot-Ereignisse"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`mono rounded px-2 py-1 text-[10px] ${tab === k ? "bg-[#10141b] text-[#f3c63f]" : "text-[#6e7681] hover:text-[#c9d1d9]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full mono text-[10.5px]">
              <thead className="sticky top-0 bg-[#0b0e14] text-[#6e7681]">
                {tab === "trades" && (
                  <tr className="border-b hair text-left">
                    <th className="px-2 py-1">Ticket</th>
                    <th>Bot</th>
                    <th>Richtung</th>
                    <th className="text-right">Lots</th>
                    <th className="text-right">Einstieg</th>
                    <th className="text-right">Preis</th>
                    <th className="text-right">SL</th>
                    <th className="text-right">TP</th>
                    <th className="text-right">Swap</th>
                    <th className="text-right">P&L ($)</th>
                    <th className="text-right">P&L (Pips)</th>
                  </tr>
                )}
                {tab === "pending" && (
                  <tr className="border-b hair text-left">
                    <th className="px-2 py-1">Order</th>
                    <th>State</th>
                    <th>Seite</th>
                    <th className="text-right">Lots</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">SL</th>
                    <th className="text-right">TP</th>
                    <th>Bot</th>
                  </tr>
                )}
                {tab === "history" && (
                  <tr className="border-b hair text-left">
                    <th className="px-2 py-1">Ticket</th>
                    <th>Seite</th>
                    <th className="text-right">Lots</th>
                    <th className="text-right">Open</th>
                    <th className="text-right">Close</th>
                    <th className="text-right">P&L</th>
                  </tr>
                )}
                {tab === "events" && (
                  <tr className="border-b hair text-left">
                    <th className="px-2 py-1">Zeit</th>
                    <th>Level</th>
                    <th>Meldung</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {tab === "trades" &&
                  (status?.positions.open ?? []).map((p) => {
                    const pips = p.currentPrice ? ((p.currentPrice - p.openPrice) * (p.side === "buy" ? 1 : -1)) / GOLD_PIP : 0;
                    return (
                      <tr key={p.id} className="border-b border-[#10141b]">
                        <td className="px-2 py-1 text-[#6e7681]">{p.mt5Ticket}</td>
                        <td className="text-[#f3c63f]">GOLD-BOT</td>
                        <td className={p.side === "buy" ? "text-[#00e676]" : "text-[#ff1744]"}>{p.side.toUpperCase()}</td>
                        <td className="text-right">{p.volume.toFixed(2)}</td>
                        <td className="text-right">{p.openPrice.toFixed(2)}</td>
                        <td className="text-right">
                          <Flash v={p.currentPrice ?? 0}>{(p.currentPrice ?? 0).toFixed(2)}</Flash>
                        </td>
                        <td className="text-right text-[#ff1744]/80">{p.sl?.toFixed(2) ?? "—"}</td>
                        <td className="text-right text-[#00e676]/80">{p.tp?.toFixed(2) ?? "—"}</td>
                        <td className="text-right text-[#6e7681]">{(p.swap ?? 0).toFixed(2)}</td>
                        <td className={`text-right ${p.profit >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>
                          <Flash v={Math.round(p.profit * 100) / 100}>{p.profit.toFixed(2)}</Flash>
                        </td>
                        <td className={`text-right ${pips >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>{pips.toFixed(1)}</td>
                      </tr>
                    );
                  })}
                {tab === "trades" && !(status?.positions.open ?? []).length && (
                  <tr>
                    <td colSpan={11} className="px-2 py-4 text-center text-[#6e7681]">
                      keine offenen positionen
                    </td>
                  </tr>
                )}
                {tab === "pending" &&
                  (status?.orders ?? [])
                    .filter((o) => ["HELD", "PENDING", "DISPATCHED"].includes(o.state))
                    .map((o) => (
                      <tr key={o.id} className="border-b border-[#10141b]">
                        <td className="px-2 py-1 text-[#6e7681]">#{o.id}</td>
                        <td className={o.state === "HELD" ? "text-[#ffc400]" : "text-[#00b0ff]"}>{o.state}</td>
                        <td className={o.side === "buy" ? "text-[#00e676]" : "text-[#ff1744]"}>{o.side.toUpperCase()}</td>
                        <td className="text-right">{o.volume.toFixed(2)}</td>
                        <td className="text-right">{o.entryPrice?.toFixed(2) ?? "mkt"}</td>
                        <td className="text-right text-[#ff1744]/80">{o.stopPrice?.toFixed(2) ?? "—"}</td>
                        <td className="text-right text-[#00e676]/80">{o.targetPrice?.toFixed(2) ?? "—"}</td>
                        <td className="text-[#f3c63f]">{o.alphaKey ?? "—"}</td>
                      </tr>
                    ))}
                {tab === "history" &&
                  (status?.positions.closed ?? []).slice(0, 40).map((p) => (
                    <tr key={p.id} className="border-b border-[#10141b]">
                      <td className="px-2 py-1 text-[#6e7681]">{p.mt5Ticket}</td>
                      <td className={p.side === "buy" ? "text-[#00e676]" : "text-[#ff1744]"}>{p.side.toUpperCase()}</td>
                      <td className="text-right">{p.volume.toFixed(2)}</td>
                      <td className="text-right">{p.openPrice.toFixed(2)}</td>
                      <td className="text-right">{(p.currentPrice ?? 0).toFixed(2)}</td>
                      <td className={`text-right ${p.profit >= 0 ? "text-[#00e676]" : "text-[#ff1744]"}`}>{p.profit.toFixed(2)}</td>
                    </tr>
                  ))}
                {tab === "events" &&
                  (status?.events ?? []).slice(0, 40).map((e) => (
                    <tr key={e.id} className="border-b border-[#10141b]">
                      <td className="px-2 py-1 text-[#6e7681]">{new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 19)}</td>
                      <td className={e.level === "error" ? "text-[#ff1744]" : e.level === "warn" ? "text-[#ffc400]" : e.level === "audit" ? "text-[#00b0ff]" : "text-[#6e7681]"}>{e.level}</td>
                      <td className="pr-2 text-[#c9d1d9]">{e.message}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* ================= SÄULE C ================= */}
      <aside className="grid min-h-0 grid-rows-[auto_auto_1fr] gap-px overflow-hidden border-l hair bg-[#161b22]">
        {/* fleet */}
        <section className="bg-[#0b0e14] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-[#6e7681]">Flotten-Manager</span>
            <span className="mono text-[9px] text-[#6e7681]">{controls?.autopilot ? "autopilot aktiv" : "autopilot aus"}</span>
          </div>
          <div className="space-y-1.5">
            {BOTS.map((b) => {
              const on = controls?.autopilot === true && controls?.autopilotPreset === b.preset;
              return (
                <div key={b.key} className="flex items-center gap-2 rounded-md border hair bg-[#0e1219] px-2 py-1.5">
                  <button
                    onClick={() => setBot(b.preset, b.tf, !on)}
                    className={`relative h-4 w-8 shrink-0 rounded-full border transition ${on ? "border-[#00e676]/60 bg-[#00e676]/20" : "border-[#161b22] bg-[#10141b]"}`}
                    title={on ? "Bot stoppen" : "Bot starten"}
                  >
                    <span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full transition-all ${on ? "left-[18px] bg-[#00e676]" : "left-[2px] bg-[#6e7681]"}`} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="mono truncate text-[10.5px] text-[#c9d1d9]">{b.name}</div>
                    <div className="truncate text-[9px] text-[#6e7681]">{b.desc}</div>
                  </div>
                  <span className="mono text-[10px] text-[#00e676]">{winRateOf(b.preset).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </section>
        {/* risk controller */}
        <section className="bg-[#0b0e14] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-[#6e7681]">Lot-Size & Risk-Controller</span>
            <div className="flex overflow-hidden rounded border hair">
              {(["auto", "manual"] as const).map((m) => (
                <button key={m} onClick={() => setLotMode(m)} className={`mono px-2 py-0.5 text-[9px] ${lotMode === m ? "bg-[#d4af37]/15 text-[#f3c63f]" : "text-[#6e7681]"}`}>
                  {m === "auto" ? "COMPOUND" : "MANUAL"}
                </button>
              ))}
            </div>
          </div>
          {lotMode === "auto" ? (
            <div className="space-y-2">
              <label className="block">
                <span className="mono text-[9px] text-[#6e7681]">Risiko pro Trade: {riskPct.toFixed(2)}% der Equity</span>
                <input type="range" min={0.1} max={3} step={0.05} value={riskPct} onChange={(e) => setRiskPct(Number(e.target.value))} className="w-full accent-[#d4af37]" />
              </label>
              <label className="block">
                <span className="mono text-[9px] text-[#6e7681]">Bot-Stop-Loss: {stopPips} Pips</span>
                <input type="range" min={10} max={120} step={5} value={stopPips} onChange={(e) => setStopPips(Number(e.target.value))} className="w-full accent-[#d4af37]" />
              </label>
              <div className="mono rounded border hair bg-[#0e1219] px-2 py-1.5 text-[10px] text-[#6e7681]">
                [ {equity.toFixed(0)}$ × {riskPct.toFixed(2)}% ] / [ {stopPips} Pips × {PIP_VALUE_PER_LOT}$ ] ={" "}
                <span className="text-[13px] font-bold text-[#f3c63f]">{dynamicLots.toFixed(2)} Lots</span>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step={0.01}
                  value={manualLots}
                  onChange={(e) => setManualLots(Number(e.target.value))}
                  className="mono w-full rounded border hair bg-[#0e1219] px-2 py-1 text-[13px] text-[#f3c63f]"
                />
              </div>
              <div className="flex gap-1">
                {[0.01, 0.1, 1].map((d) => (
                  <button key={d} onClick={() => setManualLots((v) => Math.round((v + d) * 100) / 100)} className="mono flex-1 rounded border hair bg-[#0e1219] py-1 text-[9px] text-[#c9d1d9]">
                    +{d.toFixed(2)}
                  </button>
                ))}
              </div>
              <div className="mono text-[9px] text-[#6e7681]">fixe lot-größe · unabhängig von equity</div>
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mono text-[9px] text-[#6e7681]">Max Daily DD %</span>
              <input
                type="number"
                step={0.5}
                defaultValue={((controls?.maxDailyLossPct ?? 0.03) * 100).toFixed(1)}
                className="mono mt-0.5 w-full rounded border hair bg-[#0e1219] px-2 py-1 text-[10px] text-[#c9d1d9]"
              />
            </label>
            <label className="block">
              <span className="mono text-[9px] text-[#6e7681]">Max Slippage (Pips)</span>
              <input type="number" step={0.5} value={maxSlippage} onChange={(e) => setMaxSlippage(Number(e.target.value))} className="mono mt-0.5 w-full rounded border hair bg-[#0e1219] px-2 py-1 text-[10px] text-[#c9d1d9]" />
            </label>
          </div>
          <button onClick={saveRisk} className="mono mt-2 w-full rounded border border-[#d4af37]/50 bg-[#d4af37]/10 py-1.5 text-[10px] font-bold tracking-wider text-[#f3c63f]">
            RISK-PROFILE SPEICHERN
          </button>
        </section>
        {/* cli */}
        <section className="flex min-h-0 flex-col bg-[#080a0f]">
          <div className="flex items-center justify-between border-b hair px-3 py-1">
            <span className="mono text-[10px] uppercase tracking-[0.16em] text-[#6e7681]">Terminal-Stream</span>
            <span className="mono text-[9px] text-[#00b0ff]">● live</span>
          </div>
          <div ref={cliRef} className="mono min-h-0 flex-1 overflow-auto px-2 py-1 text-[9.5px] leading-[1.5]">
            {cli.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                <span className="text-[#3d444d]">{l.ts}</span>{" "}
                <span className={l.level === "error" ? "text-[#ff1744]" : l.level === "warn" ? "text-[#ffc400]" : l.level === "audit" ? "text-[#00b0ff]" : "text-[#6e7681]"}>
                  [{l.level.toUpperCase()}]
                </span>{" "}
                <span className="text-[#9aa4b2]">{l.text}</span>
              </div>
            ))}
            {!cli.length && <div className="text-[#3d444d]">warte auf engine-events …</div>}
          </div>
        </section>
      </aside>

      {/* ================= FOOTER ================= */}
      <footer className="col-span-2 flex items-center justify-between border-t hair bg-[#0b0e14] px-3">
        <span className="mono text-[8.5px] text-[#3d444d]">
          HELIX QUANT SaaS · Trading involves substantial risk of loss and is not suitable for every investor · Past performance is not indicative of future results ·
          No investment advice
        </span>
        <span className="mono text-[8.5px] text-[#3d444d]">build 2026.11 · region eu-central · feed: bridge-mirrored broker data</span>
      </footer>
    </div>
  );
}
