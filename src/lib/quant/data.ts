import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { candles as candlesTable } from "@/db/schema";
import type { Candle } from "./types";
import { clamp, hashSeed, mulberry32 } from "./math";

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

export const BARS_PER_DAY: Record<Timeframe, number> = {
  "5m": 288,
  "15m": 96,
  "1h": 24,
  "4h": 6,
  "1d": 1,
};

export interface InstrumentDef {
  ticker: string;
  name: string;
  assetClass: string;
  source: "binance" | "synthetic";
  basePrice: number;
  vol: number;
  quoteCurrency: string;
}

/** The tradable universe. Crypto pairs are streamed live when reachable. */
export const UNIVERSE: InstrumentDef[] = [
  { ticker: "BTCUSDT", name: "Bitcoin / USDT", assetClass: "crypto", source: "binance", basePrice: 64000, vol: 0.55, quoteCurrency: "USDT" },
  { ticker: "ETHUSDT", name: "Ethereum / USDT", assetClass: "crypto", source: "binance", basePrice: 3100, vol: 0.7, quoteCurrency: "USDT" },
  { ticker: "SOLUSDT", name: "Solana / USDT", assetClass: "crypto", source: "binance", basePrice: 145, vol: 0.95, quoteCurrency: "USDT" },
  { ticker: "BNBUSDT", name: "BNB / USDT", assetClass: "crypto", source: "binance", basePrice: 580, vol: 0.62, quoteCurrency: "USDT" },
  { ticker: "EURUSD", name: "Euro / US Dollar", assetClass: "fx", source: "synthetic", basePrice: 1.086, vol: 0.08, quoteCurrency: "USD" },
  { ticker: "XAUUSD", name: "Gold Spot / USD", assetClass: "commodity", source: "synthetic", basePrice: 2320, vol: 0.14, quoteCurrency: "USD" },
  { ticker: "SPX500", name: "S&P 500 Index", assetClass: "index", source: "synthetic", basePrice: 5250, vol: 0.16, quoteCurrency: "USD" },
  { ticker: "NDX100", name: "Nasdaq 100 Index", assetClass: "index", source: "synthetic", basePrice: 18300, vol: 0.21, quoteCurrency: "USD" },
];

export function getInstrument(ticker: string): InstrumentDef {
  return UNIVERSE.find((i) => i.ticker === ticker) ?? UNIVERSE[0];
}

const MAX_SYNTHETIC_BARS = 6000;
const SUBSTEPS = 6;

interface RegimeSpec {
  drift: number;
  vol: number;
  theta: number;
  volume: number;
}

const SYNTHETIC_REGIMES: Record<string, RegimeSpec> = {
  range: { drift: 0, vol: 0.85, theta: 0.42, volume: 0.8 },
  trend_up: { drift: 0.55, vol: 1.0, theta: 0.05, volume: 1.15 },
  trend_down: { drift: -0.55, vol: 1.15, theta: 0.05, volume: 1.3 },
  expansion: { drift: 0, vol: 1.75, theta: 0.18, volume: 1.9 },
  compression: { drift: 0.02, vol: 0.45, theta: 0.55, volume: 0.55 },
  shock: { drift: -0.2, vol: 2.6, theta: 0.12, volume: 2.6 },
};

/**
 * Deterministic regime-switching market simulator.
 *
 * The latent process is a jump-diffusion with GARCH(1,1) volatility, an
 * Ornstein-Uhlenbeck pull towards a slow anchor and Markov regime switching.
 * Sub-steps per bar produce internally consistent OHLC bars. The result is a
 * series with realistic fat tails, volatility clustering, mean-reverting
 * pockets and persistent trends — i.e. an honest opponent for the engine.
 */
export function generateSyntheticSeries(ticker: string, timeframe: Timeframe, limit: number): Candle[] {
  const inst = getInstrument(ticker);
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const barsPerYear = (365 * 86400) / tfSec;
  const rng = mulberry32(hashSeed("helix-v3", ticker, timeframe));
  const total = Math.min(MAX_SYNTHETIC_BARS, Math.max(limit, 600));
  const annualVol = inst.vol;
  const baseSigma = annualVol / Math.sqrt(barsPerYear);

  let price = inst.basePrice * (0.6 + rng() * 0.8);
  let anchor = price;
  let variance = baseSigma * baseSigma;
  let regime = "range";
  let regimeAge = 0;
  const out: Candle[] = [];

  const nowBar = Math.floor(Date.now() / 1000 / tfSec) * tfSec;
  const startTs = nowBar - (total - 1) * tfSec;

  for (let i = 0; i < total; i++) {
    // --- regime transition (Markov chain with duration persistence) ---
    regimeAge++;
    const switchProb = regime === "shock" ? 0.55 : 0.022 + Math.min(0.06, regimeAge / 2600);
    if (rng() < switchProb || regimeAge > 320) {
      const roll = rng();
      if (regime === "shock" || roll < 0.1) regime = "shock";
      else if (roll < 0.3) regime = "compression";
      else if (roll < 0.5) regime = "trend_up";
      else if (roll < 0.68) regime = "trend_down";
      else if (roll < 0.85) regime = "expansion";
      else regime = "range";
      regimeAge = 0;
    }
    const spec = SYNTHETIC_REGIMES[regime];

    // --- GARCH(1,1) variance with regime scaling ---
    const lastSq = variance;
    const longRun = (baseSigma * spec.vol) ** 2;
    variance = 0.000002 + 0.09 * lastSq + 0.885 * longRun + 0.015 * (lastSq - longRun) * (rng() - 0.5);
    variance = clamp(variance, (baseSigma * 0.12) ** 2, (baseSigma * 5) ** 2);
    const sigma = Math.sqrt(variance);

    // --- sub-step path for OHLC integrity ---
    const open = price;
    let hi = price;
    let lo = price;
    for (let s = 0; s < SUBSTEPS; s++) {
      const shock = sigma / Math.sqrt(SUBSTEPS);
      let step = rng.gauss() * shock + (spec.drift * sigma) / SUBSTEPS;
      // jump component
      if (rng() < 0.0018 / SUBSTEPS) step += (rng() > 0.5 ? 1 : -1) * shock * (2.5 + rng() * 4);
      // Ornstein-Uhlenbeck pull towards the slow anchor (relative, not absolute)
      const pull = (spec.theta / SUBSTEPS / 12) * ((anchor - price) / Math.max(price, 1e-9));
      step += pull;
      price = Math.max(1e-6, price * (1 + step));
      if (price > hi) hi = price;
      if (price < lo) lo = price;
    }
    const close = price;
    anchor = anchor * 0.9975 + close * 0.0025;

    // --- volume with a vol/price response ---
    const moveRatio = Math.abs(Math.log(close / Math.max(open, 1e-9))) / Math.max(sigma, 1e-12);
    const volBase = (1_000 + hashSeed(ticker) % 4_000) * spec.volume;
    const volume = Math.max(
      1,
      volBase * (0.55 + rng() * 0.5 + moveRatio * 0.9) * Math.exp(rng.gauss() * 0.22),
    );

    out.push({
      ts: startTs + i * tfSec,
      open: round6(open),
      high: round6(Math.max(hi, open, close)),
      low: round6(Math.min(lo, open, close)),
      close: round6(close),
      volume: Math.round(volume),
    });
  }
  return out.slice(Math.max(0, out.length - limit));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/* ------------------------------ live ingestion ---------------------------- */

const BINANCE_INTERVAL: Record<Timeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};

interface BinanceKline extends Array<unknown> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
}

export async function fetchLiveCandles(
  ticker: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Candle[] | null> {
  const inst = getInstrument(ticker);
  if (inst.source !== "binance") return null;
  const interval = BINANCE_INTERVAL[timeframe];
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(ticker)}&interval=${interval}&limit=${Math.min(1000, limit)}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4500),
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as BinanceKline[];
    if (!Array.isArray(rows) || rows.length < 50) return null;
    return rows.map((r) => ({
      ts: Math.floor(Number(r[0]) / 1000),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }));
  } catch {
    return null;
  }
}

export async function persistCandles(
  ticker: string,
  timeframe: Timeframe,
  rows: Candle[],
  source = "binance",
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((c) => ({
      ticker,
      timeframe,
      ts: c.ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      source,
    }));
    try {
      await db
        .insert(candlesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [candlesTable.ticker, candlesTable.timeframe, candlesTable.ts],
          set: {
            open: sql`excluded.open`,
            high: sql`excluded.high`,
            low: sql`excluded.low`,
            close: sql`excluded.close`,
            volume: sql`excluded.volume`,
            source: sql`excluded.source`,
          },
        });
    } catch {
      // cache write failures are non-fatal for the research pipeline
    }
  }
}

export interface CachedSeries {
  candles: Candle[];
  source: string;
  lastTs: number;
}

export async function loadCachedCandles(
  ticker: string,
  timeframe: Timeframe,
  limit: number,
): Promise<CachedSeries | null> {
  try {
    const rows = await db
      .select()
      .from(candlesTable)
      .where(and(eq(candlesTable.ticker, ticker), eq(candlesTable.timeframe, timeframe)))
      .orderBy(desc(candlesTable.ts))
      .limit(limit);
    if (rows.length < Math.min(200, limit)) return null;
    return {
      candles: rows
        .map((r) => ({ ts: Number(r.ts), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
        .sort((a, b) => a.ts - b.ts),
      source: rows[0]?.source ?? "binance",
      lastTs: Math.max(...rows.map((r) => Number(r.ts))),
    };
  } catch {
    return null;
  }
}

/** Bridge-fed history counts as fresh when its newest bar is recent enough. */
export function isSeriesFresh(lastTs: number, timeframe: Timeframe, maxAgeSec?: number): boolean {
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const maxAge = maxAgeSec ?? (timeframe === "1d" ? 4 * 86400 : tfSec * 3);
  return Date.now() / 1000 - lastTs <= maxAge;
}

export interface SeriesLoadResult {
  ticker: string;
  timeframe: Timeframe;
  source: "live" | "cache" | "synthetic" | "bridge";
  candles: Candle[];
}

/**
 * Data access with graceful degradation:
 *   live exchange -> local cache -> deterministic simulator.
 */
export async function loadSeries(
  ticker: string,
  timeframe: Timeframe,
  limit: number,
  preferLive = true,
  bridgeMaxAgeSec?: number,
): Promise<SeriesLoadResult> {
  if (preferLive) {
    // 1) bridge-fed REAL broker history wins over everything when fresh
    //    (backtests may pass a wider window; live signals keep the tight one)
    const cached = await loadCachedCandles(ticker, timeframe, limit);
    if (
      cached &&
      cached.candles.length >= Math.min(200, limit) &&
      isSeriesFresh(cached.lastTs, timeframe, bridgeMaxAgeSec)
    ) {
      return {
        ticker,
        timeframe,
        source: cached.source === "bridge" ? "bridge" : "cache",
        candles: cached.candles,
      };
    }
    // 2) public exchange feed (only reachable outside this sandbox)
    const live = await fetchLiveCandles(ticker, timeframe, limit);
    if (live && live.length >= 200) {
      await persistCandles(ticker, timeframe, live, "binance");
      return { ticker, timeframe, source: "live", candles: live };
    }
    // 3) stale bridge/exchange cache beats synthetic
    if (cached && cached.candles.length >= Math.min(200, limit)) {
      return { ticker, timeframe, source: "cache", candles: cached.candles };
    }
  }
  return {
    ticker,
    timeframe,
    source: "synthetic",
    candles: generateSyntheticSeries(ticker, timeframe, limit),
  };
}

export async function candleCount(): Promise<number> {
  try {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(candlesTable);
    return rows[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function firstCandleTs(): Promise<number | null> {
  try {
    const rows = await db.select({ ts: candlesTable.ts }).from(candlesTable).orderBy(asc(candlesTable.ts)).limit(1);
    return rows[0] ? Number(rows[0].ts) : null;
  } catch {
    return null;
  }
}
