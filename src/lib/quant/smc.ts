/**
 * SMC / ICT structure engine — implemented from the operator's blueprint:
 *
 *   Weekly/Daily  : overall bias via Break of Structure (BoS)
 *   4h / 1h       : range narrowing, Point-of-Interest (order block) detection
 *   15m (entry)   : POI tap -> wait for confirming BoS/ChoCh -> new range ->
 *                   entry at the last LTF POI left by the impulse
 *   Targets       : T1 opposing LTF POI, T2 trendline/equal-point liquidity,
 *                   T3 buyside/sellside liquidity of the HTF range,
 *                   with partial scale-outs at each
 *
 * Everything is derived from swing structure only — no lagging oscillator is
 * used for entries, exactly as the blueprint demands.
 */
import type { BacktestResult, Candle, EquityPoint, ExitReason, Trade } from "./types";
import { computeMetrics, monthlyReturns, rolledWinRate } from "./metrics";
import { clamp, mean } from "./math";

export interface SmcParams {
  entryTfSec: number;
  swingLookback: number;
  riskPerTrade: number;
  takerBps: number;
  slippageBps: number;
  partial1: number;
  partial2: number;
  poiBufferAtr: number;
  expiryBars: number;
  timeStopBars: number;
  minRR: number;
  eqTolAtr: number;
  initialEquity: number;
  barsPerDay: number;
}

export const SMC_DEFAULT: SmcParams = {
  entryTfSec: 900,
  swingLookback: 3,
  riskPerTrade: 0.0075,
  takerBps: 2.5,
  slippageBps: 1.5,
  partial1: 0.5,
  partial2: 0.3,
  poiBufferAtr: 0.15,
  expiryBars: 64,
  timeStopBars: 96,
  minRR: 1.6,
  eqTolAtr: 0.25,
  initialEquity: 100_000,
  barsPerDay: 96,
};

export interface Poi {
  ts: number;
  top: number;
  bottom: number;
  dir: 1 | -1;
  used: boolean;
  kind: "ob" | "fvg";
}

export interface LiquidityPool {
  ts: number;
  price: number;
  side: "buy" | "sell";
  taken: boolean;
}

export interface StructureSeries {
  bias: number[];
  lastSH: number[];
  lastSL: number[];
  bosUp: boolean[];
  bosDn: boolean[];
  chochUp: boolean[];
  chochDn: boolean[];
  pois: Poi[];
  pools: LiquidityPool[];
  atr: number[];
}

/* ------------------------------ resampling -------------------------------- */

export function resample(candles: Candle[], targetSec: number): Candle[] {
  const out: Candle[] = [];
  let bucketTs = -1;
  for (const c of candles) {
    const b = Math.floor(c.ts / targetSec) * targetSec;
    if (b !== bucketTs) {
      bucketTs = b;
      out.push({ ts: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    } else {
      const last = out[out.length - 1];
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    }
  }
  return out;
}

function atrSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  let prev = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    prev = i <= period ? (prev * (i - 1) + tr) / i : (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

/* ------------------------- structure / POI / liquidity --------------------- */

export function computeStructure(candles: Candle[], lookback: number, eqTolAtr: number): StructureSeries {
  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const atr = atrSeries(candles);

  const bias = new Array<number>(n).fill(0);
  const lastSH = new Array<number>(n).fill(Number.NaN);
  const lastSL = new Array<number>(n).fill(Number.NaN);
  const bosUp = new Array<boolean>(n).fill(false);
  const bosDn = new Array<boolean>(n).fill(false);
  const chochUp = new Array<boolean>(n).fill(false);
  const chochDn = new Array<boolean>(n).fill(false);
  const pois: Poi[] = [];
  const pools: LiquidityPool[] = [];

  // confirmed swing points (a swing at i is known at i+lookback)
  const swingHighs: { idx: number; price: number }[] = [];
  const swingLows: { idx: number; price: number }[] = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isH = true;
    let isL = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (high[k] > high[i]) isH = false;
      if (low[k] < low[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) swingHighs.push({ idx: i, price: high[i] });
    if (isL) swingLows.push({ idx: i, price: low[i] });
  }

  // equal highs / lows -> liquidity pools
  for (let a = 0; a < swingHighs.length; a++) {
    for (let b = a + 1; b < swingHighs.length; b++) {
      const tol = Math.max(atr[swingHighs[a].idx] * eqTolAtr, 1e-9);
      if (Math.abs(swingHighs[a].price - swingHighs[b].price) <= tol && swingHighs[b].idx - swingHighs[a].idx > lookback * 2) {
        pools.push({ ts: candles[swingHighs[b].idx].ts, price: Math.max(swingHighs[a].price, swingHighs[b].price), side: "buy", taken: false });
      }
    }
  }
  for (let a = 0; a < swingLows.length; a++) {
    for (let b = a + 1; b < swingLows.length; b++) {
      const tol = Math.max(atr[swingLows[a].idx] * eqTolAtr, 1e-9);
      if (Math.abs(swingLows[a].price - swingLows[b].price) <= tol && swingLows[b].idx - swingLows[a].idx > lookback * 2) {
        pools.push({ ts: candles[swingLows[b].idx].ts, price: Math.min(swingLows[a].price, swingLows[b].price), side: "sell", taken: false });
      }
    }
  }

  let sh = Number.NaN;
  let sl = Number.NaN;
  let shIdx = -1;
  let slIdx = -1;
  let curBias = 0;
  let hi = 0;
  let li = 0;

  const pushPoi = (dir: 1 | -1, fromIdx: number, toIdx: number) => {
    // origin of the impulse: last counter-directional candle before displacement
    for (let j = Math.max(1, fromIdx); j < toIdx; j++) {
      const c = candles[j];
      const counter = dir === 1 ? c.close < c.open : c.close > c.open;
      if (counter) {
        pois.push({ ts: c.ts, top: Math.max(c.open, c.close), bottom: Math.min(c.open, c.close), dir, used: false, kind: "ob" });
      }
    }
    // fair value gaps inside the impulse leg
    for (let j = Math.max(2, fromIdx); j < toIdx; j++) {
      if (dir === 1 && low[j] > high[j - 2]) {
        pois.push({ ts: candles[j - 1].ts, top: low[j], bottom: high[j - 2], dir, used: false, kind: "fvg" });
      }
      if (dir === -1 && high[j] < low[j - 2]) {
        pois.push({ ts: candles[j - 1].ts, top: low[j - 2], bottom: high[j], dir: -1, used: false, kind: "fvg" });
      }
    }
    if (pois.length > 400) pois.splice(0, pois.length - 400);
  };

  for (let i = 1; i < n; i++) {
    while (hi < swingHighs.length && swingHighs[hi].idx + lookback <= i) {
      sh = swingHighs[hi].price;
      shIdx = swingHighs[hi].idx;
      hi++;
    }
    while (li < swingLows.length && swingLows[li].idx + lookback <= i) {
      sl = swingLows[li].price;
      slIdx = swingLows[li].idx;
      li++;
    }
    if (Number.isFinite(sh) && close[i] > sh && close[i - 1] <= sh) {
      bosUp[i] = true;
      pushPoi(1, Math.max(shIdx, i - 24), i);
      curBias = curBias === -1 ? (chochUp[i] = true, 1) : 1;
    }
    if (Number.isFinite(sl) && close[i] < sl && close[i - 1] >= sl) {
      bosDn[i] = true;
      pushPoi(-1, Math.max(slIdx, i - 24), i);
      curBias = curBias === 1 ? (chochDn[i] = true, -1) : -1;
    }
    for (const p of pools) {
      if (!p.taken && p.ts <= candles[i].ts) {
        if (p.side === "buy" && high[i] >= p.price) p.taken = true;
        if (p.side === "sell" && low[i] <= p.price) p.taken = true;
      }
    }
    bias[i] = curBias;
    lastSH[i] = sh;
    lastSL[i] = sl;
  }
  return { bias, lastSH, lastSL, bosUp, bosDn, chochUp, chochDn, pois, pools, atr };
}

function lookupIndex(tsArr: number[], ts: number): number {
  let lo = 0;
  let hi = tsArr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tsArr[mid] <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/* --------------------------------- the engine ------------------------------ */

export interface SmcPending {
  dir: 1 | -1;
  entry: number;
  stop: number;
  t1: number;
  t2: number;
  t3: number;
  rr: number;
  atr: number;
  poiTop: number;
  poiBottom: number;
}

export interface SmcResult {
  pending: SmcPending | null;
  trades: Trade[];
  equityCurve: EquityPoint[];
  stats: {
    tradesPerDay: number;
    taps: number;
    confirms: number;
    entries: number;
    biasSplit: { long: number; short: number };
    avgHoldBars: number;
  };
  checklist: string[];
}

export function runSmcBacktest(entryCandles: Candle[], params: SmcParams, livePeek = false): SmcResult {
  const tf = params.entryTfSec;
  const h1 = resample(entryCandles, 3600);
  const h4 = resample(entryCandles, 14400);
  const d1 = resample(entryCandles, 86400);

  const s15 = computeStructure(entryCandles, params.swingLookback, params.eqTolAtr);
  const s60 = computeStructure(h1, 2, params.eqTolAtr);
  const s240 = computeStructure(h4, 2, params.eqTolAtr);
  const sD = computeStructure(d1, 2, params.eqTolAtr);

  const ts60 = h1.map((c) => c.ts);
  const ts240 = h4.map((c) => c.ts);
  const tsD = d1.map((c) => c.ts);

  const n = entryCandles.length;
  const warm = Math.max(80, params.swingLookback * 12);
  let cash = params.initialEquity;
  let peak = params.initialEquity;
  const equityCurve: EquityPoint[] = [];
  const trades: Trade[] = [];

  let taps = 0;
  let confirms = 0;
  let entries = 0;
  let pending: SmcPending | null = null;
  let longCount = 0;
  let shortCount = 0;

  interface Pos {
    dir: 1 | -1;
    entry: number;
    stop: number;
    t1: number;
    t2: number;
    t3: number;
    qty: number;
    remaining: number;
    risk: number;
    openIdx: number;
    realized: number;
    fees: number;
    mae: number;
    mfe: number;
    p1: boolean;
    p2: boolean;
    exitTs: number;
    exitPrice: number;
    exitQtyW: number;
    exitQty: number;
    reason: ExitReason;
  }
  let pos: Pos | null = null;

  // setup state machine
  let state: 0 | 1 | 2 = 0;
  let setupDir: 1 | -1 = 1;
  let expiry = 0;
  let entryPoi: Poi | null = null;

  const costRate = (params.takerBps + params.slippageBps) / 1e4;
  const closeSlice = (p: Pos, qty: number, price: number, ts: number, reason: ExitReason) => {
    const fee = price * qty * costRate;
    const gross = (price - p.entry) * p.dir * qty;
    cash += gross - fee;
    p.realized += gross;
    p.fees += fee;
    p.remaining -= qty;
    p.exitTs = ts;
    p.exitPrice = price;
    p.exitQtyW += price * qty;
    p.exitQty += qty;
    if (p.remaining <= 1e-12) {
      p.remaining = 0;
      p.reason = reason;
    }
  };

  for (let i = warm; i < n; i++) {
    const bar = entryCandles[i];
    const a = s15.atr[i] || 1e-9;

    /* ---------------------------------------------------- position management */
    if (pos) {
      const p = pos;
      const hitStop = p.dir === 1 ? bar.low <= p.stop : bar.high >= p.stop;
      if (hitStop) {
        closeSlice(p, p.remaining, p.stop, bar.ts, p.p1 ? "breakeven" : "stop");
      } else {
        if (!p.p1) {
          const hit1 = p.dir === 1 ? bar.high >= p.t1 : bar.low <= p.t1;
          if (hit1) {
            closeSlice(p, p.qty * params.partial1, p.t1, bar.ts, "target");
            p.p1 = true;
            p.stop = p.entry; // Breakeven exakt am Entry — keine Phantom-Profits
          }
        }
        if (p.p1 && !p.p2) {
          const hit2 = p.dir === 1 ? bar.high >= p.t2 : bar.low <= p.t2;
          if (hit2) {
            closeSlice(p, p.qty * params.partial2, p.t2, bar.ts, "target");
            p.p2 = true;
          }
        }
        if (p.p1 && p.p2 && p.remaining > 0) {
          const hit3 = p.dir === 1 ? bar.high >= p.t3 : bar.low <= p.t3;
          if (hit3) closeSlice(p, p.remaining, p.t3, bar.ts, "target");
        }
        if (p.remaining > 0 && i - p.openIdx >= params.timeStopBars) {
          closeSlice(p, p.remaining, bar.close, bar.ts, "time_stop");
        }
      }
      if (p.remaining <= 0) {
        const net = p.realized;
        const riskDollars = Math.max(1e-6, p.risk * p.qty);
        trades.push({
          seq: trades.length + 1,
          side: p.dir === 1 ? "long" : "short",
          alphaKey: "smc_liquidity",
          entryTs: entryCandles[p.openIdx].ts,
          exitTs: p.exitTs,
          entryPrice: p.entry,
          exitPrice: p.exitQty > 0 ? p.exitQtyW / p.exitQty : p.entry,
          qty: p.qty,
          grossPnl: net + p.fees,
          fees: p.fees,
          slippage: p.fees * 0.4,
          netPnl: net,
          rMultiple: net / riskDollars,
          maeR: p.mae,
          mfeR: p.mfe,
          holdingBars: i - p.openIdx,
          exitReason: p.reason || "target",
          regime: "range",
          confidence: 0.6,
          metaProb: 0.6,
          riskPerUnit: p.risk,
          equityAfter: cash,
          fills: [],
        });
        pos = null;
      } else {
        const adv = p.dir === 1 ? (p.entry - bar.low) / p.risk : (bar.high - p.entry) / p.risk;
        const fav = p.dir === 1 ? (bar.high - p.entry) / p.risk : (p.entry - bar.low) / p.risk;
        p.mae = Math.max(p.mae, adv);
        p.mfe = Math.max(p.mfe, fav);
      }
    }

    /* ---------------------------------------------------------- state machine */
    const i60 = lookupIndex(ts60, bar.ts);
    const i240 = lookupIndex(ts240, bar.ts);
    const iD = lookupIndex(tsD, bar.ts);
    const biasD = iD >= 0 ? sD.bias[iD] : 0;
    const bias4 = i240 >= 0 ? s240.bias[i240] : 0;
    const overall: 1 | -1 | 0 = (biasD || bias4) as 1 | -1 | 0;

    if (!pos && overall !== 0) {
      if (state === 0) {
        // HTF POI tap (1h first, then 4h) within the current HTF range
        const ranges: { pois: Poi[]; sh: number; sl: number }[] = [];
        if (i60 >= 0) ranges.push({ pois: s60.pois, sh: s60.lastSH[i60], sl: s60.lastSL[i60] });
        if (i240 >= 0) ranges.push({ pois: s240.pois, sh: s240.lastSH[i240], sl: s240.lastSL[i240] });
        for (const r of ranges) {
          for (const poi of r.pois.slice(-40)) {
            if (poi.used || poi.dir !== overall) continue;
            const buf = a * params.poiBufferAtr * 4;
            const tapped = overall === 1 ? bar.low <= poi.top + buf && bar.low >= poi.bottom - buf * 3 : bar.high >= poi.bottom - buf && bar.high <= poi.top + buf * 3;
            if (tapped) {
              poi.used = true;
              setupDir = overall;
              state = 1;
              expiry = i + params.expiryBars;
              taps++;
              break;
            }
          }
          if (state === 1) break;
        }
        // Setup-Klasse B (Blueprint 5.2/aggressiv): Strukturflip im 15m selbst,
        // in Richtung des HTF-Bias — bringt die Trade-Frequenz auf mehrere pro Tag
        if (state === 0) {
          const flip = overall === 1 ? s15.chochUp[i] || s15.bosUp[i] : s15.chochDn[i] || s15.bosDn[i];
          if (flip) {
            const fresh = s15.pois.filter((pp) => !pp.used && pp.dir === overall && pp.ts >= entryCandles[Math.max(0, i - 10)].ts);
            const poi = fresh.length ? fresh[fresh.length - 1] : null;
            if (poi) {
              setupDir = overall;
              entryPoi = poi;
              state = 2;
              expiry = i + params.expiryBars;
              confirms++;
            }
          }
        }
      } else if (state === 1) {
        const conf =
          setupDir === 1 ? s15.bosUp[i] || s15.chochUp[i] : s15.bosDn[i] || s15.chochDn[i];
        const against = setupDir === 1 ? s15.bosDn[i] : s15.bosUp[i];
        if (against) state = 0;
        else if (conf) {
          confirms++;
          state = 2;
          expiry = i + params.expiryBars;
          // entry POI: last LTF POI left by the confirming impulse
          const fresh = s15.pois.filter((p) => !p.used && p.dir === setupDir && p.ts >= entryCandles[Math.max(0, i - 12)].ts);
          entryPoi = fresh.length ? fresh[fresh.length - 1] : null;
          if (!entryPoi) {
            // fallback: last counter-directional candle of the new 15m range
            for (let j = i; j > Math.max(warm, i - 16); j--) {
              const c = entryCandles[j];
              const counter = setupDir === 1 ? c.close < c.open : c.close > c.open;
              if (counter) {
                entryPoi = { ts: c.ts, top: Math.max(c.open, c.close), bottom: Math.min(c.open, c.close), dir: setupDir, used: false, kind: "ob" };
                break;
              }
            }
          }
          if (!entryPoi) state = 0;
        } else if (i > expiry) state = 0;
      } else if (state === 2 && entryPoi) {
        const against = setupDir === 1 ? s15.bosDn[i] : s15.bosUp[i];
        if (against) {
          state = 0;
          entryPoi = null;
        } else {
          const buf = a * params.poiBufferAtr;
          const touched = setupDir === 1 ? bar.low <= entryPoi.top + buf : bar.high >= entryPoi.bottom - buf;
          if (touched) {
            const entryPrice = setupDir === 1 ? Math.min(bar.open, entryPoi.top + buf) : Math.max(bar.open, entryPoi.bottom - buf);
            const stop = setupDir === 1 ? entryPoi.bottom - buf * 2 : entryPoi.top + buf * 2;
            const risk = Math.abs(entryPrice - stop);
            if (risk > 1e-9) {
              // targets: opposing LTF POI -> liquidity pool -> HTF range extreme
              const oppPois = s15.pois.filter((p) => p.dir !== setupDir && (setupDir === 1 ? p.bottom > entryPrice : p.top < entryPrice));
              const t1Cand = oppPois.length ? (setupDir === 1 ? oppPois[0].bottom : oppPois[oppPois.length - 1].top) : Number.NaN;
              const poolsAhead = s15.pools.filter((p) => !p.taken && (setupDir === 1 ? p.price > entryPrice && p.side === "buy" : p.price < entryPrice && p.side === "sell"));
              const t2Cand = poolsAhead.length ? poolsAhead[0].price : setupDir === 1 ? (s15.lastSH[i] ?? entryPrice + risk * 2) : (s15.lastSL[i] ?? entryPrice - risk * 2);
              const t3Cand =
                setupDir === 1
                  ? (i240 >= 0 ? (s240.lastSH[i240] ?? t2Cand) : t2Cand)
                  : i240 >= 0
                    ? (s240.lastSL[i240] ?? t2Cand)
                    : t2Cand;
              const t1 = Number.isFinite(t1Cand) && Math.abs(t1Cand - entryPrice) > risk * 0.8 ? t1Cand : entryPrice + setupDir * risk * 1.2;
              const t2 = Math.abs(t2Cand - entryPrice) > risk * 1.4 ? t2Cand : entryPrice + setupDir * risk * 2;
              const t3 = Math.abs(t3Cand - entryPrice) > risk * 2 ? t3Cand : entryPrice + setupDir * risk * 3;
              const rr = (Math.abs(t2 - entryPrice) * params.partial1 + Math.abs(t3 - entryPrice) * params.partial2 + Math.abs(t1 - entryPrice) * 0.2) / risk;
              if (rr >= params.minRR && livePeek && i === n - 1) {
                pending = { dir: setupDir, entry: entryPrice, stop, t1, t2, t3, rr, atr: a, poiTop: entryPoi.top, poiBottom: entryPoi.bottom };
                state = 0;
                entryPoi = null;
              } else if (rr >= params.minRR) {
                const equity = cash;
                const qty = (equity * params.riskPerTrade) / risk;
                pos = {
                  dir: setupDir,
                  entry: entryPrice,
                  stop,
                  t1,
                  t2,
                  t3,
                  qty,
                  remaining: qty,
                  risk,
                  openIdx: i,
                  realized: -entryPrice * qty * costRate,
                  fees: entryPrice * qty * costRate,
                  mae: 0,
                  mfe: 0,
                  p1: false,
                  p2: false,
                  exitTs: bar.ts,
                  exitPrice: entryPrice,
                  exitQtyW: 0,
                  exitQty: 0,
                  reason: "target" as ExitReason,
                };
                cash -= entryPrice * qty * costRate;
                entries++;
                if (setupDir === 1) longCount++;
                else shortCount++;
                entryPoi.used = true;
              }
            }
            state = 0;
            entryPoi = null;
          } else if (i > expiry) {
            state = 0;
            entryPoi = null;
          }
        }
      }
    } else if (overall === 0 && state !== 0) {
      state = 0;
      entryPoi = null;
    }

    /* ------------------------------------------------------------- accounting */
    const mark = pos ? cash + (bar.close - pos.entry) * pos.dir * pos.remaining : cash;
    if (mark > peak) peak = mark;
    equityCurve.push({
      ts: bar.ts,
      index: i,
      equity: mark,
      drawdown: peak > 0 ? mark / peak - 1 : 0,
      benchmark: params.initialEquity * (bar.close / entryCandles[warm].close),
      exposure: pos ? 1 : 0,
    });
  }

  if (pos && pos.remaining > 0) {
    const lastBar = entryCandles[n - 1];
    closeSlice(pos, pos.remaining, lastBar.close, lastBar.ts, "end_of_data");
    const p = pos;
    const net = p.realized;
    const riskDollars = Math.max(1e-6, p.risk * p.qty);
    trades.push({
      seq: trades.length + 1,
      side: p.dir === 1 ? "long" : "short",
      alphaKey: "smc_liquidity",
      entryTs: entryCandles[p.openIdx].ts,
      exitTs: p.exitTs,
      entryPrice: p.entry,
      exitPrice: p.exitQty > 0 ? p.exitQtyW / p.exitQty : p.entry,
      qty: p.qty,
      grossPnl: net + p.fees,
      fees: p.fees,
      slippage: p.fees * 0.4,
      netPnl: net,
      rMultiple: net / riskDollars,
      maeR: p.mae,
      mfeR: p.mfe,
      holdingBars: n - 1 - p.openIdx,
      exitReason: "end_of_data",
      regime: "range",
      confidence: 0.6,
      metaProb: 0.6,
      riskPerUnit: p.risk,
      equityAfter: cash,
      fills: [],
    });
    pos = null;
  }

  const days = ((entryCandles[n - 1].ts - entryCandles[warm].ts) / 86400) || 1;
  const checklist = [
    `Overall bias (Daily/4h BoS): ${sD.bias[sD.bias.length - 1] === 1 ? "bullish" : sD.bias[sD.bias.length - 1] === -1 ? "bearish" : "flat"} / ${s240.bias[s240.bias.length - 1] === 1 ? "bullish" : s240.bias[s240.bias.length - 1] === -1 ? "bearish" : "flat"}`,
    `4h-Range: ${Number.isFinite(s240.lastSL[s240.lastSL.length - 1]) ? s240.lastSL[s240.lastSL.length - 1].toFixed(2) : "?"} – ${Number.isFinite(s240.lastSH[s240.lastSH.length - 1]) ? s240.lastSH[s240.lastSH.length - 1].toFixed(2) : "?"} · 1h-POIs im Spiel: ${s60.pois.filter((p) => !p.used).length}`,
    `POI-Taps: ${taps} · Confirmations (15m BoS/ChoCh): ${confirms} · Entries: ${entries}`,
    `Liquidity-Pools erkannt: ${s15.pools.length} · davon genommen: ${s15.pools.filter((p) => p.taken).length}`,
    `Trades pro Tag: ${(trades.length / days).toFixed(2)} · long ${longCount} / short ${shortCount}`,
  ];

  return {
    pending,
    trades,
    equityCurve,
    stats: {
      tradesPerDay: trades.length / days,
      taps,
      confirms,
      entries,
      biasSplit: { long: longCount, short: shortCount },
      avgHoldBars: trades.length ? mean(trades.map((t) => t.holdingBars)) : 0,
    },
    checklist,
  };
}

export function smcToBacktestResult(res: SmcResult, params: SmcParams): BacktestResult {
  const metrics = computeMetrics({
    trades: res.trades,
    equityCurve: res.equityCurve,
    initialEquity: params.initialEquity,
    warmupBars: 0,
    periodsPerYear: params.barsPerDay * 365,
    feeTotal: res.trades.reduce((a, t) => a + t.fees, 0),
    slippageTotal: res.trades.reduce((a, t) => a + t.slippage, 0),
    notionalTraded: res.trades.reduce((a, t) => a + t.qty * t.entryPrice, 0),
  });
  return {
    trades: res.trades,
    equityCurve: res.equityCurve,
    metrics,
    attribution: [
      {
        alphaKey: "smc_liquidity",
        name: "SMC Liquidity Engine (BoS · POI · LTF-Confirmation)",
        family: "breakout",
        trades: res.trades.length,
        netPnl: res.trades.reduce((a, t) => a + t.netPnl, 0),
        winRate: res.trades.length ? res.trades.filter((t) => t.netPnl > 0).length / res.trades.length : 0,
        expectancyR: res.trades.length ? mean(res.trades.map((t) => t.rMultiple)) : 0,
        profitFactor: metrics.profitFactor,
        contribution: 1,
      },
    ],
    regimeAttribution: [],
    monthlyReturns: monthlyReturns(res.equityCurve),
    rolledWinRate: rolledWinRate(res.trades),
    signals: [],
  };
}

export { clamp };
