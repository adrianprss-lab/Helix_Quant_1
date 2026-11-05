"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BacktestMetrics,
  Candle,
  EquityPoint,
  MonteCarloReport,
  OptimizationTrialRecord,
  PboReport,
  RegimeAttribution,
  StrategyAttribution,
  Trade,
  WalkForwardReport,
} from "@/lib/quant/types";
import Execution from "./Execution";
import {
  DrawdownChart,
  EquityChart,
  FanChart,
  MiniPriceChart,
  MonthlyBars,
  RollingWinRateChart,
  TrialsScatter,
} from "./charts";

export interface RunResponse {
  ok: boolean;
  error?: string;
  runId: number;
  label: string;
  ticker: string;
  timeframe: string;
  dataSource: string;
  preset: string;
  bars: number;
  targetWinRate: number;
  achievedWinRate: number;
  durationMs: number;
  diagnostics: string[];
  metrics: BacktestMetrics;
  oosMetrics: BacktestMetrics | null;
  attribution: StrategyAttribution[];
  regimeAttribution: RegimeAttribution[];
  equityCurve: EquityPoint[];
  oosEquityCurve: EquityPoint[];
  trades: Trade[];
  monthlyReturns: { label: string; return: number }[];
  rolledWinRate: { ts: number; winRate: number; trades: number }[];
  walkForward: WalkForwardReport | null;
  monteCarlo: MonteCarloReport | null;
  pbo: PboReport | null;
  optimization: {
    enabled: boolean;
    trials: OptimizationTrialRecord[];
    bestObjective: number;
    generations: number;
    evaluations: number;
  };
  candles: Candle[];
}

interface SignalCandidateView {
  ticker: string;
  price: number;
  regime: string;
  atrPct: number;
  threshold: number;
  source: string;
  candidates: {
    ticker: string;
    direction: string;
    alphaKey: string;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    metaProb: number;
    score: number;
    regime: string;
    trendFilter: string;
    expectedHoldBars: number;
  }[];
  votes: Record<string, number>;
  health: { metaAccuracy?: number; infoCoefficient?: number; metaRefits?: number };
  featureImportance: { name: string; weight: number }[];
}

interface PaperView {
  account: { equity: number; cash: number; realizedPnl: number; feesPaid: number; maxDrawdown: number };
  open: {
    id: number;
    ticker: string;
    side: string;
    qty: number;
    entryPrice: number;
    markPrice: number;
    stopPrice: number;
    targetPrice: number;
    unrealizedPnl: number;
    rMultipleLive: number;
    alphaKey: string;
  }[];
  closed: { id: number; ticker: string; side: string; realizedPnl: number; rMultiple: number | null; exitReason: string | null }[];
  stats: { closedTrades: number; winRate: number; realizedPnl: number; unrealized: number };
}

export const PRESET_CATALOG: { key: string; name: string; tagline: string; target: number }[] = [
  { key: "apex_hit_rate", name: "APEX HIT-RATE", tagline: "Meta-labelled mean reversion, engineered for ≥85% hit rate", target: 0.86 },
  { key: "real_gold_swing", name: "REAL EDGE · GOLD DAILY", tagline: "Auf echten Kerzen getunt — XAUUSD 1d, Profit vor Winrate", target: 0.6 },
  { key: "smc_gold_m15", name: "SMC GOLD · M15 LIQUIDITY", tagline: "Dein Blueprint: BoS-Bias, POI-Tap, 15m-Confirm, Liquidity-Targets", target: 0.55 },
  { key: "capital_defense", name: "CAPITAL DEFENSE", tagline: "Drawdown first, ultra-selective, low size", target: 0.72 },
];

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
const TICKERS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "EURUSD", "XAUUSD", "SPX500", "NDX100"];

type Tab = "overview" | "attribution" | "validation" | "ledger" | "signals" | "paper" | "execution";

function fmtPct(v: number, dp = 1): string {
  return `${(v * 100).toFixed(dp)}%`;
}
function fmtNum(v: number, dp = 2): string {
  return Number.isFinite(v) ? v.toFixed(dp) : "—";
}
function fmtMoney(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—";
}

interface PulseState {
  bridges: { name: string; online: boolean; feedUpdatedAt: string | null }[];
  controls: { autopilot: boolean; autopilotMinutes: number; autopilotTimeframe: string; mode: string; confirmMode: string };
  counts: { held: number; queued: number };
}

function SystemPulse() {
  const [st, setSt] = useState<PulseState | null>(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      try {
        const r = await fetch("/api/exec/status", { cache: "no-store" });
        const j = (await r.json()) as PulseState;
        if (on) setSt(j);
      } catch {
        /* pulse ist dekorativ */
      }
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  const b = st.bridges.find((x) => x.online) ?? st.bridges[0];
  const chips: { k: string; v: string; ok: boolean }[] = [
    { k: "bridge", v: b?.online ? `online · ${b.name}` : "offline", ok: Boolean(b?.online) },
    {
      k: "feed",
      v: b?.feedUpdatedAt ? `${new Date(b.feedUpdatedAt).toISOString().slice(11, 16)} UTC` : "—",
      ok: Boolean(b?.feedUpdatedAt),
    },
    {
      k: "autopilot",
      v: st.controls.autopilot ? `an · ${st.controls.autopilotMinutes} min · ${st.controls.autopilotTimeframe}` : "aus",
      ok: st.controls.autopilot,
    },
    { k: "queue", v: `${st.counts.held} held · ${st.counts.queued} queued`, ok: true },
    { k: "modus", v: `${st.controls.mode} · ${st.controls.confirmMode}`, ok: st.controls.mode !== "paper" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.k}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] ${
            chip.ok ? "border-white/[0.08] bg-white/[0.03] text-slate-300" : "border-[#eb5757]/30 bg-[#eb5757]/[0.06] text-[#eb5757]"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${chip.ok ? "bg-[#4cb782]" : "bg-[#eb5757]"}`} />
          {chip.k}: {chip.v}
        </span>
      ))}
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const toneClass =
    tone === "good"
      ? "text-[#4cb782]"
      : tone === "bad"
        ? "text-[#eb5757]"
        : tone === "warn"
          ? "text-[#f5a524]"
          : "text-white";
  return (
    <div className="gcard lift rounded-xl px-4 py-3.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold leading-none tracking-tight tabular-nums ${toneClass}`}>{value}</div>
      {sub ? <div className="mt-2 text-[10px] leading-snug text-slate-500">{sub}</div> : null}
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNodeLike; children: React.ReactNode }) {
  return (
    <section className="gcard rounded-2xl">
      <header className="flex items-center justify-between px-5 py-3">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{title}</h2>
        {right}
      </header>
      <div className="border-t border-white/[0.06] px-5 py-4">{children}</div>
    </section>
  );
}
type ReactNodeLike = React.ReactNode;

export interface RunSummary {
  id: number;
  label: string;
  ticker: string;
  timeframe: string;
  preset: string;
  winRate: number;
  profitFactor: number;
  netReturn: number;
  sharpe: number;
  maxDrawdown: number;
  tradeCount: number;
  createdAt: string;
}

export default function Terminal({
  initialRuns,
  initialRun = null,
}: {
  initialRuns: RunSummary[];
  initialRun?: RunResponse | null;
}) {
  const [ticker, setTicker] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<string>("1h");
  const [bars, setBars] = useState(3200);
  const [preset, setPreset] = useState("apex_hit_rate");
  const [target, setTarget] = useState(0.85);
  const [optimize, setOptimize] = useState(true);
  const [walkForward, setWalkForward] = useState(true);
  const [monteCarlo, setMonteCarlo] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunResponse | null>(initialRun);
  const [runs, setRuns] = useState(initialRuns);
  const [error, setError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [signals, setSignals] = useState<SignalCandidateView[]>([]);
  const [paper, setPaper] = useState<PaperView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = PRESET_CATALOG.find((x) => x.key === preset);
    if (p) setTarget(p.target);
  }, [preset]);

  const loadSignals = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/signals?tickers=${ticker},ETHUSDT,SOLUSDT&timeframe=${timeframe}&preset=${preset}&target=${target}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as { scans: SignalCandidateView[] };
      setSignals(json.scans ?? []);
    } catch {
      setSignals([]);
    } finally {
      setBusy(false);
    }
  }, [ticker, timeframe, preset, target]);

  const loadPaper = useCallback(async () => {
    try {
      const res = await fetch("/api/paper", { cache: "no-store" });
      const json = (await res.json()) as PaperView;
      setPaper(json);
    } catch {
      setPaper(null);
    }
  }, []);

  useEffect(() => {
    if (tab === "signals") void loadSignals();
    if (tab === "paper") void loadPaper();
  }, [tab, loadSignals, loadPaper]);

  const execute = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticker,
          timeframe,
          bars,
          preset,
          targetWinRate: target,
          optimize,
          walkForward,
          monteCarlo,
        }),
      });
      const json = (await res.json()) as RunResponse;
      if (!json.ok) throw new Error(json.error ?? "backtest failed");
      setRun(json);
      setTab("overview");
      const listRes = await fetch("/api/backtest", { cache: "no-store" });
      const listJson = (await listRes.json()) as { runs: RunSummary[] };
      setRuns(listJson.runs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown failure");
    } finally {
      setRunning(false);
    }
  };

  const paperAction = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await fetch("/api/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const json = (await res.json()) as PaperView;
      if (json.account) setPaper(json);
    } finally {
      setBusy(false);
    }
  };

  const m = run?.metrics;
  const oos = run?.oosMetrics ?? null;
  const equity = run?.equityCurve ?? [];
  const oosBoundary = useMemo(() => {
    if (!run || !run.oosEquityCurve.length) return null;
    return run.oosEquityCurve[0]?.ts ?? null;
  }, [run]);

  return (
    <div className="min-h-screen">
      {/* ---------------------------------------------------------------- header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#08090a]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-6 py-3">
          <div className="brand-mark grid h-8 w-8 place-items-center rounded-[10px] font-mono text-sm font-bold">֏</div>
          <span className="text-[15px] font-semibold tracking-tight text-white">
            HELIX<span className="font-normal text-slate-500"> QUANT</span>
          </span>
          <span className="ml-2 hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[10px] text-slate-400 sm:flex">
            <span className={`dot ${run ? "dot-live" : ""}`} />
            {run ? `run #${run.runId} · ${run.dataSource} feed` : "engine idle"}
          </span>
          <div className="ml-auto flex items-center gap-2 font-mono text-[10px]">
            <a
              href="/pro"
              className="rounded-full border border-[#d4af37]/40 bg-[#d4af37]/10 px-3 py-1 text-[#f3c63f] transition hover:bg-[#d4af37]/20"
            >
              PRO DESK ↗
            </a>
            <span className="hidden rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-slate-400 md:inline">
              {run ? `${run.ticker} · ${run.timeframe}` : "kein instrument"}
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-slate-400">
              {run ? `${(run.durationMs / 1000).toFixed(1)}s` : "—"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
        <section className="hero-panel relative overflow-hidden rounded-2xl px-7 py-10 md:px-10 md:py-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-[#98a0ff]">
            Institutional alpha research · live execution
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.06] tracking-tight text-white md:text-[52px]">
            Dreizehn Alphas. Ein Meta-Layer.
            <br />
            <span className="grad-text">Jede Entscheidung auditierbar.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-slate-400 md:text-sm">
            HELIX bündelt Mean-Reversion-, Trend- und Mikrostruktur-Modelle zu einem meta-gelabelten Ensemble —
            validiert mit Walk-Forward, CSCV-Overfitting-Audit und Monte-Carlo. Freigegebene Orders laufen über
            deine Bridge direkt in MetaTrader 5.
          </p>
          <div className="mt-10 grid gap-8 sm:grid-cols-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Hit rate</div>
              <div className="mt-2 text-4xl font-semibold tracking-tight text-white tabular-nums">
                {run ? fmtPct(run.metrics.winRate) : "—"}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                {run
                  ? `${run.metrics.trades} trades · ziel ${fmtPct(run.targetWinRate, 0)} · hold-out ${run.oosMetrics ? fmtPct(run.oosMetrics.winRate) : "—"}`
                  : "pipeline noch nicht gelaufen"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Expectancy</div>
              <div className="mt-2 text-4xl font-semibold tracking-tight text-white tabular-nums">
                {run ? `${run.metrics.expectancyR >= 0 ? "+" : ""}${run.metrics.expectancyR.toFixed(2)}R` : "—"}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                {run
                  ? `profit factor ${run.metrics.profitFactor.toFixed(2)} · sharpe ${run.metrics.sharpe.toFixed(2)}`
                  : "pro trade, nach kosten"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Overfitting-risiko</div>
              <div className="mt-2 text-4xl font-semibold tracking-tight text-white tabular-nums">
                {run?.pbo ? fmtPct(run.pbo.pbo) : "—"}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                {run?.pbo ? run.pbo.verdict : "cscv-audit läuft zusammen mit dem optimiser"}
              </div>
            </div>
          </div>
        </section>
        {/* disclaimer */}
        <div className="rounded-xl border border-[#f5a524]/20 bg-[#f5a524]/[0.05] px-4 py-3 text-[11px] leading-relaxed text-[#f2c88a]">
          <strong className="font-mono uppercase tracking-wider">Risk notice.</strong> A high hit rate is
          structurally easy (small target, wide stop) and is <em>not</em> the same as profitability — the payoff
          ratio and expectancy are what decide whether you keep the money. Every number below is produced by an
          event-driven simulator with fees, slippage, pessimistic intrabar fills and an out-of-sample hold-out.
          Nothing here is investment advice; past performance never guarantees future results.
        </div>

        {/* -------------------------------------------------------- control deck */}
        <Panel
          title="Research control deck"
          right={
            <button
              onClick={execute}
              disabled={running}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/15 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-40"
            >
              {running ? "optimising…" : "run pipeline"}
            </button>
          }
        >
          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Instrument</span>
                <select
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value)}
                  className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200"
                >
                  {TICKERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Timeframe</span>
                <select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value)}
                  className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200"
                >
                  {TIMEFRAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Bars</span>
                <input
                  type="number"
                  min={600}
                  max={5000}
                  step={200}
                  value={bars}
                  onChange={(e) => setBars(Number(e.target.value))}
                  className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Target hit rate</span>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.4}
                    max={0.97}
                    step={0.01}
                    value={target}
                    onChange={(e) => setTarget(Number(e.target.value))}
                    className="w-full accent-emerald-500"
                  />
                  <span className="w-10 font-mono text-xs text-emerald-400">{(target * 100).toFixed(0)}%</span>
                </div>
              </label>
            </div>
            <div className="space-y-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-500">Strategy stack</span>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-xs text-slate-200"
              >
                {PRESET_CATALOG.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className="text-[10px] leading-relaxed text-slate-500">
                {PRESET_CATALOG.find((p) => p.key === preset)?.tagline}
              </p>
              <div className="flex flex-wrap gap-3 pt-1">
                {(
                  [
                    ["optimiser", optimize, setOptimize],
                    ["walk-forward", walkForward, setWalkForward],
                    ["monte carlo", monteCarlo, setMonteCarlo],
                  ] as const
                ).map(([label, value, setter]) => (
                  <label key={label} className="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => setter(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {running ? (
            <div className="mt-3 h-0.5 w-full overflow-hidden rounded bg-slate-800">
              <div className="h-full w-1/3 animate-pulse bg-emerald-500" />
            </div>
          ) : null}
          {error ? <p className="mt-3 font-mono text-[11px] text-rose-400">✗ {error}</p> : null}
        </Panel>

        {/* --------------------------------------------------------------- tabs */}
        <nav className="flex w-fit flex-wrap items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] p-1">
          {(
            [
              ["overview", "Performance"],
              ["attribution", "Alpha attribution"],
              ["validation", "Validation & risk"],
              ["ledger", "Trade ledger"],
              ["signals", "Live signals"],
              ["paper", "Paper brokerage"],
              ["execution", "⚡ Live execution / MT5"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-full px-4 py-1.5 text-xs font-medium tracking-wide transition ${
                tab === key
                  ? "tab-active text-white shadow-[0_2px_14px_-2px_rgba(94,106,210,0.75)]"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* ----------------------------------------------------------- overview */}
        {tab === "overview" ? (
          !run ? (
            <Panel title="Awaiting first run">
              <p className="text-xs text-slate-500">
                Configure the deck above and execute the pipeline. The engine will generate/stream the market
                data, evaluate all thirteen alpha models, fit the meta classifier, run differential evolution,
                calibrate the entry threshold to your hit-rate target and then validate everything on an
                untouched hold-out segment.
              </p>
            </Panel>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <SystemPulse />
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(`${window.location.origin}/share/${run.runId}`);
                    setShareCopied(true);
                    setTimeout(() => setShareCopied(false), 1600);
                  }}
                  className="ml-auto rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[10px] text-slate-300 transition hover:border-[#5e6ad2]/50 hover:text-[#98a0ff]"
                >
                  {shareCopied ? "link kopiert ✓" : "report-link kopieren"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-6">
                <Kpi
                  label="Hit rate"
                  value={m ? fmtPct(m.winRate) : "—"}
                  sub={`target ${fmtPct(run.targetWinRate, 0)} · ${m?.trades ?? 0} trades`}
                  tone={m && m.winRate >= run.targetWinRate ? "good" : m && m.winRate >= run.targetWinRate - 0.05 ? "warn" : "bad"}
                />
                <Kpi
                  label="Hold-out hit rate"
                  value={oos ? fmtPct(oos.winRate) : "—"}
                  sub={oos ? `${oos.trades} unseen trades` : "no hold-out trades"}
                  tone={oos && oos.winRate >= run.targetWinRate - 0.03 ? "good" : "warn"}
                />
                <Kpi
                  label="Profit factor"
                  value={m ? fmtNum(m.profitFactor) : "—"}
                  sub={`gross ${m ? fmtMoney(m.grossProfit) : 0} / ${m ? fmtMoney(m.grossLoss) : 0}`}
                  tone={m && m.profitFactor >= 1.3 ? "good" : m && m.profitFactor >= 1 ? "warn" : "bad"}
                />
                <Kpi
                  label="Expectancy"
                  value={m ? `${fmtNum(m.expectancyR, 3)}R` : "—"}
                  sub={`payoff ${m ? fmtNum(m.payoffRatio) : "—"}`}
                  tone={m && m.expectancyR > 0.05 ? "good" : m && m.expectancyR > 0 ? "warn" : "bad"}
                />
                <Kpi
                  label="Net return"
                  value={m ? fmtPct(m.netReturn) : "—"}
                  sub={`CAGR ${m ? fmtPct(m.cagr) : "—"}`}
                  tone={m && m.netReturn > 0 ? "good" : "bad"}
                />
                <Kpi
                  label="Max drawdown"
                  value={m ? fmtPct(m.maxDrawdown) : "—"}
                  sub={m ? `${m.maxDrawdownBars} bars underwater` : ""}
                  tone={m && m.maxDrawdown > -0.15 ? "good" : "bad"}
                />
                <Kpi label="Sharpe" value={m ? fmtNum(m.sharpe) : "—"} sub={`Sortino ${m ? fmtNum(m.sortino) : "—"}`} tone={m && m.sharpe > 1.5 ? "good" : "warn"} />
                <Kpi label="Deflated Sharpe" value={m ? fmtNum(m.deflatedSharpe, 3) : "—"} sub={`PSR ${m ? fmtNum(m.probabilisticSharpe, 3) : "—"}`} tone={m && m.deflatedSharpe > 0.95 ? "good" : "warn"} />
                <Kpi label="SQN" value={m ? fmtNum(m.sqn) : "—"} sub={`t-stat ${m ? fmtNum(m.tStat) : "—"} · p ${m ? fmtNum(m.pValue, 4) : "—"}`} tone={m && m.sqn > 2 ? "good" : "warn"} />
                <Kpi label="PBO" value={run.pbo ? fmtPct(run.pbo.pbo) : "—"} sub={run.pbo?.verdict ?? "not run"} tone={run.pbo && run.pbo.pbo < 0.3 ? "good" : "warn"} />
                <Kpi label="Exposure" value={m ? fmtPct(m.exposurePct) : "—"} sub={`avg hold ${m ? fmtNum(m.avgHoldingBars, 1) : "—"} bars`} />
                <Kpi label="Cost drag" value={m ? fmtPct(m.feeDrag + m.slippageDrag, 2) : "—"} sub={`turnover ${m ? fmtNum(m.turnover, 1) : "—"}×`} tone="warn" />
              </div>

              <Panel
                title={`Equity curve — ${run.label}`}
                right={
                  <div className="flex gap-3 font-mono text-[10px]">
                    <span className="text-emerald-400">■ strategy</span>
                    <span className="text-slate-500">┄ buy &amp; hold</span>
                    <span className="text-indigo-400">▮ hold-out zone</span>
                  </div>
                }
              >
                <EquityChart data={equity} oosFrom={oosBoundary} />
                <div className="mt-2 border-t border-slate-800/60 pt-2">
                  <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    Underwater curve
                  </div>
                  <DrawdownChart data={equity} />
                </div>
              </Panel>

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title="Rolling 40-trade hit rate">
                  <RollingWinRateChart data={run.rolledWinRate} target={run.targetWinRate} />
                  <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-slate-500">
                    <span>best streak: <span className="text-emerald-400">{m?.maxWinStreak ?? 0}</span></span>
                    <span>worst streak: <span className="text-rose-400">{m?.maxLossStreak ?? 0}</span></span>
                    <span>long/short WR: {fmtPct(m?.longWinRate ?? 0, 0)}/{fmtPct(m?.shortWinRate ?? 0, 0)}</span>
                  </div>
                </Panel>
                <Panel title="Monthly returns (last 24)">
                  <MonthlyBars data={run.monthlyReturns} />
                  <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500">
                    <span>{run.monthlyReturns[0]?.label}</span>
                    <span>{run.monthlyReturns[run.monthlyReturns.length - 1]?.label}</span>
                  </div>
                </Panel>
              </div>

              <Panel title="Engine diagnostics">
                <ul className="space-y-1.5 font-mono text-[11px] leading-relaxed">
                  {run.diagnostics.map((d, i) => (
                    <li key={i} className="flex gap-2 text-slate-400">
                      <span className="text-emerald-500/70">▸</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )
        ) : null}

        {/* ------------------------------------------------------ attribution */}
        {tab === "attribution" && run ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Alpha model attribution">
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-slate-500">
                    <tr className="border-b border-slate-800">
                      <th className="py-1.5 text-left">model</th>
                      <th className="text-right">trades</th>
                      <th className="text-right">hit rate</th>
                      <th className="text-right">exp. R</th>
                      <th className="text-right">PF</th>
                      <th className="text-right">net P&amp;L</th>
                      <th className="text-right">weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.attribution.map((a) => (
                      <tr key={a.alphaKey} className="border-b border-slate-900">
                        <td className="py-1.5 pr-2 text-slate-300">{a.name}</td>
                        <td className="text-right text-slate-400">{a.trades}</td>
                        <td className={`text-right ${a.winRate >= 0.5 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtPct(a.winRate, 0)}
                        </td>
                        <td className={`text-right ${a.expectancyR > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtNum(a.expectancyR, 3)}
                        </td>
                        <td className="text-right text-slate-400">{fmtNum(a.profitFactor)}</td>
                        <td className={`text-right ${a.netPnl > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtMoney(a.netPnl)}
                        </td>
                        <td className="text-right text-slate-500">{fmtPct(a.contribution, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <div className="space-y-4">
              <Panel title="Regime attribution">
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-slate-500">
                    <tr className="border-b border-slate-800">
                      <th className="py-1.5 text-left">regime</th>
                      <th className="text-right">bars</th>
                      <th className="text-right">trades</th>
                      <th className="text-right">hit rate</th>
                      <th className="text-right">net P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.regimeAttribution.map((r) => (
                      <tr key={r.regime} className="border-b border-slate-900">
                        <td className="py-1.5 text-slate-300">{r.regime}</td>
                        <td className="text-right text-slate-400">{r.bars}</td>
                        <td className="text-right text-slate-400">{r.trades}</td>
                        <td className="text-right text-slate-400">{fmtPct(r.winRate, 0)}</td>
                        <td className={`text-right ${r.netPnl > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtMoney(r.netPnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
              <Panel
                title="Optimiser search space"
                right={
                  <span className="font-mono text-[10px] text-slate-500">
                    {run.optimization.evaluations} evals · {run.optimization.generations} generations
                  </span>
                }
              >
                <TrialsScatter trials={run.optimization.trials} target={run.targetWinRate} />
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                  Each dot is one differential-evolution candidate: horizontal = realised hit rate, vertical =
                  fitness, size/colour = sign of expectancy. The optimiser is constrained — candidates below the
                  target hit rate are penalised, and candidates whose payoff collapses into a fee-harvesting
                  lottery are rejected outright.
                </p>
              </Panel>
            </div>
          </div>
        ) : null}

        {/* -------------------------------------------------------- validation */}
        {tab === "validation" && run ? (
          <div className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Anchored walk-forward">
                {run.walkForward ? (
                  <>
                    <table className="w-full font-mono text-[11px]">
                      <thead className="text-slate-500">
                        <tr className="border-b border-slate-800">
                          <th className="py-1.5 text-left">fold</th>
                          <th className="text-right">train WR</th>
                          <th className="text-right">test WR</th>
                          <th className="text-right">test PF</th>
                          <th className="text-right">test trades</th>
                          <th className="text-right">decay</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.walkForward.folds.map((f) => (
                          <tr key={f.fold} className="border-b border-slate-900">
                            <td className="py-1.5 text-slate-300">#{f.fold}</td>
                            <td className="text-right text-slate-400">{fmtPct(f.trainMetrics.winRate, 0)}</td>
                            <td className={`text-right ${f.testMetrics.winRate >= run.targetWinRate - 0.05 ? "text-emerald-400" : "text-amber-400"}`}>
                              {fmtPct(f.testMetrics.winRate, 0)}
                            </td>
                            <td className="text-right text-slate-400">{fmtNum(f.testMetrics.profitFactor)}</td>
                            <td className="text-right text-slate-400">{f.testMetrics.trades}</td>
                            <td className={`text-right ${f.degradation > -0.3 ? "text-emerald-400" : "text-rose-400"}`}>
                              {fmtPct(f.degradation, 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                      <Kpi label="OOS hit rate" value={fmtPct(run.walkForward.oosWinRate)} tone="good" />
                      <Kpi label="OOS PF" value={fmtNum(run.walkForward.oosProfitFactor)} />
                      <Kpi label="Fold consistency" value={fmtPct(run.walkForward.consistency, 0)} />
                      <Kpi label="Edge decay" value={fmtPct(run.walkForward.degradationScore, 0)} />
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">Walk-forward disabled for this run.</p>
                )}
              </Panel>
              <Panel title="Monte Carlo block bootstrap">
                {run.monteCarlo && run.monteCarlo.iterations > 0 ? (
                  <>
                    <FanChart percentiles={run.monteCarlo.percentiles} />
                    <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                      <Kpi label="P05 return" value={fmtPct(run.monteCarlo.finalReturnPercentiles.p05)} tone="bad" />
                      <Kpi label="Median return" value={fmtPct(run.monteCarlo.finalReturnPercentiles.p50)} />
                      <Kpi label="P95 return" value={fmtPct(run.monteCarlo.finalReturnPercentiles.p95)} tone="good" />
                      <Kpi label="Risk of ruin" value={fmtPct(run.monteCarlo.riskOfRuin, 2)} tone={run.monteCarlo.riskOfRuin < 0.02 ? "good" : "bad"} />
                      <Kpi label="P(loss)" value={fmtPct(run.monteCarlo.probLoss)} />
                      <Kpi label="DD p95" value={fmtPct(run.monteCarlo.drawdownPercentiles.p95)} tone="bad" />
                      <Kpi label="DD worst" value={fmtPct(run.monteCarlo.drawdownPercentiles.worst)} tone="bad" />
                      <Kpi label="P(hit target)" value={fmtPct(run.monteCarlo.probTargetWinRate)} tone="good" />
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">Monte Carlo disabled or too few trades.</p>
                )}
              </Panel>
            </div>
            <Panel title="Overfitting audit — combinatorially symmetric cross-validation">
              {run.pbo ? (
                <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
                  <div className="grid grid-cols-2 gap-2">
                    <Kpi label="PBO" value={fmtPct(run.pbo.pbo)} tone={run.pbo.pbo < 0.3 ? "good" : "bad"} />
                    <Kpi label="Block combos" value={String(run.pbo.combinations)} />
                    <Kpi label="Mean logit" value={fmtNum(run.pbo.logitMean, 3)} />
                    <Kpi label="OOS rank corr" value={fmtNum(run.pbo.oosRankCorrelation, 3)} />
                  </div>
                  <p className="text-[11px] leading-relaxed text-slate-400">
                    <span className="font-mono uppercase tracking-wider text-slate-300">Verdict: {run.pbo.verdict}.</span>{" "}
                    The strategy universe is cut into {run.pbo.blocks} blocks; every half-block partition is used
                    once as an in-sample selection set and once as a hold-out. PBO is the probability that the
                    configuration which looked best in-sample lands in the bottom half out-of-sample. A high PBO
                    means the reported edge is mostly selection bias — the engine will tell you so instead of
                    hiding it.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  CSCV audit requires the optimiser to be enabled so a population of competing configurations
                  exists.
                </p>
              )}
            </Panel>
          </div>
        ) : null}

        {/* ----------------------------------------------------------- ledger */}
        {tab === "ledger" && run ? (
          <Panel title={`Trade ledger — ${run.trades.length} of ${run.metrics.trades} trades`}>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full font-mono text-[11px]">
                <thead className="sticky top-0 bg-[#080b14] text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="py-1.5 text-left">#</th>
                    <th className="text-left">side</th>
                    <th className="text-left">alpha</th>
                    <th className="text-left">entry (utc)</th>
                    <th className="text-right">entry</th>
                    <th className="text-right">exit</th>
                    <th className="text-right">R</th>
                    <th className="text-right">MFE</th>
                    <th className="text-right">MAE</th>
                    <th className="text-right">bars</th>
                    <th className="text-left">exit</th>
                    <th className="text-left">regime</th>
                    <th className="text-right">p(win)</th>
                  </tr>
                </thead>
                <tbody>
                  {run.trades.map((t) => (
                    <tr key={t.seq} className="border-b border-slate-900/70 hover:bg-slate-900/40">
                      <td className="py-1 text-slate-500">{t.seq}</td>
                      <td className={t.side === "long" ? "text-emerald-400" : "text-indigo-400"}>{t.side}</td>
                      <td className="pr-2 text-slate-400">{t.alphaKey}</td>
                      <td className="text-slate-500">{new Date(t.entryTs * 1000).toISOString().slice(0, 16).replace("T", " ")}</td>
                      <td className="text-right text-slate-400">{t.entryPrice.toFixed(2)}</td>
                      <td className="text-right text-slate-400">{t.exitPrice.toFixed(2)}</td>
                      <td className={`text-right ${t.rMultiple > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {fmtNum(t.rMultiple, 3)}
                      </td>
                      <td className="text-right text-slate-500">{fmtNum(t.mfeR, 2)}</td>
                      <td className="text-right text-slate-500">{fmtNum(t.maeR, 2)}</td>
                      <td className="text-right text-slate-500">{t.holdingBars}</td>
                      <td className="text-slate-500">{t.exitReason}</td>
                      <td className="text-slate-500">{t.regime}</td>
                      <td className="text-right text-amber-400/80">{fmtNum(t.metaProb, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        {/* ---------------------------------------------------------- signals */}
        {tab === "signals" ? (
          <div className="space-y-4">
            <Panel
              title="Live signal engine"
              right={
                <button
                  onClick={loadSignals}
                  disabled={busy}
                  className="rounded border border-slate-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
                >
                  {busy ? "scanning…" : "rescan"}
                </button>
              }
            >
              <div className="grid gap-3 lg:grid-cols-3">
                {signals.map((s) => {
                  const c = s.candidates[s.candidates.length - 1];
                  return (
                    <div key={s.ticker} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="font-mono text-sm text-slate-100">{s.ticker}</span>
                        <span className="font-mono text-sm text-emerald-400">{s.price.toFixed(2)}</span>
                      </div>
                      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
                        <span>{s.regime}</span>
                        <span>atr {s.atrPct}%</span>
                        <span>{s.source}</span>
                      </div>
                      {c ? (
                        <div className="mt-3 space-y-1.5 rounded border border-emerald-500/25 bg-emerald-500/[0.06] p-2 font-mono text-[11px]">
                          <div className="flex justify-between">
                            <span className="text-slate-400">signal</span>
                            <span className={c.direction === "long" ? "text-emerald-400" : "text-indigo-400"}>
                              {c.direction.toUpperCase()} · {c.alphaKey}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">entry / stop / target</span>
                            <span className="text-slate-300">
                              {c.entryPrice.toFixed(2)} / {c.stopPrice.toFixed(2)} / {c.targetPrice.toFixed(2)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">p(win)</span>
                            <span className="text-amber-400">{fmtPct(c.metaProb, 1)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">filter</span>
                            <span className="text-slate-500">{c.trendFilter}</span>
                          </div>
                          <button
                            onClick={() =>
                              paperAction("open", {
                                ticker: s.ticker,
                                timeframe,
                                direction: c.direction,
                                metaProb: c.metaProb,
                                entryPrice: c.entryPrice,
                                stopPrice: c.stopPrice,
                                targetPrice: c.targetPrice,
                                alphaKey: c.alphaKey,
                                regime: c.regime,
                              })
                            }
                            className="mt-1 w-full rounded border border-emerald-500/40 bg-emerald-500/10 py-1 text-[10px] uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20"
                          >
                            stage in paper book
                          </button>
                        </div>
                      ) : (
                        <p className="mt-3 rounded border border-slate-800 p-2 font-mono text-[10px] text-slate-500">
                          No setup clears the calibrated threshold right now — the engine stays flat rather than
                          forcing a trade.
                        </p>
                      )}
                    </div>
                  );
                })}
                {!signals.length ? (
                  <p className="text-xs text-slate-500">Press rescan to evaluate the universe.</p>
                ) : null}
              </div>
            </Panel>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Ensemble seat allocation (top instrument)">
                {signals.length ? (
                  <div className="space-y-1.5">
                    {Object.entries(signals[0].votes)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 10)
                      .map(([k, v]) => (
                        <div key={k} className="flex items-center gap-2">
                          <span className="w-40 shrink-0 truncate font-mono text-[10px] text-slate-500">{k}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
                            <div
                              className={`h-full ${v >= 0 ? "bg-emerald-500" : "bg-indigo-500"}`}
                              style={{ width: `${Math.min(100, Math.abs(v) * 160)}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-[10px] text-slate-400">{fmtNum(v, 3)}</span>
                        </div>
                      ))}
                  </div>
                ) : null}
              </Panel>
              <Panel title="Meta classifier feature importance">
                {signals.length ? (
                  <div className="space-y-1.5">
                    {signals[0].featureImportance.map((f) => (
                      <div key={f.name} className="flex items-center gap-2">
                        <span className="w-32 shrink-0 font-mono text-[10px] text-slate-500">{f.name}</span>
                        <div className="relative h-1.5 flex-1 rounded bg-slate-800">
                          <div
                            className={`absolute top-0 h-full ${f.weight >= 0 ? "bg-emerald-500 left-1/2" : "bg-rose-500 right-1/2"}`}
                            style={{ width: `${Math.min(50, Math.abs(f.weight) * 45)}%` }}
                          />
                        </div>
                        <span className="w-12 text-right font-mono text-[10px] text-slate-400">{fmtNum(f.weight, 3)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Panel>
            </div>
          </div>
        ) : null}

        {/* ----------------------------------------------------------- paper */}
        {tab === "paper" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label="Equity" value={paper ? fmtMoney(paper.account.equity) : "—"} />
              <Kpi label="Cash" value={paper ? fmtMoney(paper.account.cash) : "—"} />
              <Kpi label="Realised P&L" value={paper ? fmtMoney(paper.account.realizedPnl) : "—"} tone={paper && paper.account.realizedPnl >= 0 ? "good" : "bad"} />
              <Kpi label="Unrealised" value={paper ? fmtMoney(paper.stats.unrealized) : "—"} tone={paper && paper.stats.unrealized >= 0 ? "good" : "bad"} />
              <Kpi label="Closed WR" value={paper ? fmtPct(paper.stats.winRate, 0) : "—"} sub={`${paper?.stats.closedTrades ?? 0} closed`} />
              <Kpi label="Fees paid" value={paper ? fmtMoney(paper.account.feesPaid) : "—"} tone="warn" />
            </div>
            <Panel
              title="Paper brokerage"
              right={
                <div className="flex gap-2">
                  <button
                    onClick={() => paperAction("tick")}
                    disabled={busy}
                    className="rounded border border-slate-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-300 hover:border-emerald-500/50 hover:text-emerald-400 disabled:opacity-40"
                  >
                    mark &amp; manage
                  </button>
                  <button
                    onClick={() => paperAction("reset")}
                    disabled={busy}
                    className="rounded border border-slate-700 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400 hover:border-rose-500/50 hover:text-rose-400 disabled:opacity-40"
                  >
                    reset
                  </button>
                </div>
              }
            >
              <table className="w-full font-mono text-[11px]">
                <thead className="text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="py-1.5 text-left">id</th>
                    <th className="text-left">instrument</th>
                    <th className="text-left">side</th>
                    <th className="text-right">qty</th>
                    <th className="text-right">entry</th>
                    <th className="text-right">mark</th>
                    <th className="text-right">stop</th>
                    <th className="text-right">target</th>
                    <th className="text-right">unreal.</th>
                    <th className="text-right">R</th>
                    <th className="text-left">alpha</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(paper?.open ?? []).map((p) => (
                    <tr key={p.id} className="border-b border-slate-900/70">
                      <td className="py-1.5 text-slate-500">{p.id}</td>
                      <td className="text-slate-300">{p.ticker}</td>
                      <td className={p.side === "long" ? "text-emerald-400" : "text-indigo-400"}>{p.side}</td>
                      <td className="text-right text-slate-400">{fmtNum(p.qty, 4)}</td>
                      <td className="text-right text-slate-400">{p.entryPrice.toFixed(2)}</td>
                      <td className="text-right text-slate-400">{p.markPrice.toFixed(2)}</td>
                      <td className="text-right text-rose-400/70">{p.stopPrice.toFixed(2)}</td>
                      <td className="text-right text-emerald-400/70">{p.targetPrice.toFixed(2)}</td>
                      <td className={`text-right ${p.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {fmtMoney(p.unrealizedPnl)}
                      </td>
                      <td className={`text-right ${p.rMultipleLive >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {fmtNum(p.rMultipleLive, 2)}
                      </td>
                      <td className="text-slate-500">{p.alphaKey}</td>
                      <td className="text-right">
                        <button
                          onClick={() => paperAction("close", { id: p.id, reason: "manual" })}
                          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:border-rose-500/50 hover:text-rose-400"
                        >
                          close
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!paper?.open.length ? (
                    <tr>
                      <td colSpan={12} className="py-4 text-center text-[11px] text-slate-500">
                        No open positions. Stage a setup from the live signals tab.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {paper?.closed.length ? (
                <div className="mt-4">
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                    Recently closed
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {paper.closed.slice(0, 18).map((c) => (
                      <span
                        key={c.id}
                        className={`rounded border px-2 py-1 font-mono text-[10px] ${
                          (c.realizedPnl ?? 0) >= 0
                            ? "border-emerald-500/30 text-emerald-400"
                            : "border-rose-500/30 text-rose-400"
                        }`}
                      >
                        {c.ticker} {c.side} {fmtMoney(c.realizedPnl ?? 0)} · {c.exitReason}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </Panel>
          </div>
        ) : null}

        {/* -------------------------------------------------------- execution */}
        {tab === "execution" ? <Execution /> : null}

        {/* ------------------------------------------------------ run history */}
        <Panel title="Research run history">
          {runs.length ? (
            <div className="max-h-64 overflow-auto">
              <table className="w-full font-mono text-[11px]">
                <thead className="sticky top-0 bg-[#080b14] text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="py-1.5 text-left">id</th>
                    <th className="text-left">label</th>
                    <th className="text-right">hit rate</th>
                    <th className="text-right">PF</th>
                    <th className="text-right">return</th>
                    <th className="text-right">sharpe</th>
                    <th className="text-right">max dd</th>
                    <th className="text-right">trades</th>
                    <th className="text-left">created</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b border-slate-900/70">
                      <td className="py-1 text-slate-500">{r.id}</td>
                      <td className="text-slate-300">{r.label}</td>
                      <td className="text-right text-emerald-400">{fmtPct(r.winRate, 0)}</td>
                      <td className="text-right text-slate-400">{fmtNum(r.profitFactor)}</td>
                      <td className="text-right text-slate-400">{fmtPct(r.netReturn)}</td>
                      <td className="text-right text-slate-400">{fmtNum(r.sharpe)}</td>
                      <td className="text-right text-rose-400/80">{fmtPct(r.maxDrawdown)}</td>
                      <td className="text-right text-slate-400">{r.tradeCount}</td>
                      <td className="text-slate-500">{new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500">No persisted runs yet.</p>
          )}
        </Panel>

        <Panel title="Architecture">
          <div className="grid gap-4 text-[11px] leading-relaxed text-slate-400 md:grid-cols-3">
            <div>
              <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                Alpha layer — 13 models
              </h3>
              <p>
                Microstructure pattern scalper, RSI(2) double reversion, Bollinger z-score OU reversion, VWAP band
                reversion, Kalman state-space reversion, value-area node fade, Hurst adaptive switch, SuperTrend
                regime rider, Donchian breakout, MACD acceleration stack, Ichimoku Kumo breakout, volatility
                squeeze expansion and multi-timeframe momentum carry.
              </p>
            </div>
            <div>
              <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                Aggregation layer
              </h3>
              <p>
                Each model is graded every bar by its trailing information coefficient measured over its own
                holding horizon, shifted to eliminate look-ahead. Models without positive IC are benched. The
                strongest conviction leads the book, dissenters are excluded from the blend instead of cancelling
                it, and a 18-feature logistic meta classifier estimates P(trade wins) for meta-labelling.
              </p>
            </div>
            <div>
              <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                Validation layer
              </h3>
              <p>
                Event-driven fills with taker fees, sqrt slippage and pessimistic intrabar resolution; anchored
                walk-forward with purge and embargo; differential evolution over ten dimensions; CSCV probability
                of backtest overfitting; deflated and probabilistic Sharpe ratios; block-bootstrapped Monte Carlo
                with drawdown and ruin distributions.
              </p>
            </div>
          </div>
        </Panel>
      </main>

      <footer className="border-t border-slate-800/80 px-5 py-4 text-center font-mono text-[10px] tracking-wider text-slate-600">
        HELIX QUANT · research software · simulated and historical data · no investment advice
      </footer>
    </div>
  );
}
