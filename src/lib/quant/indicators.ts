import type { Candle, IndicatorSet, MarketRegime } from "./types";
import {
  clamp,
  hurstExponent,
  kalmanFilter,
  linreg,
  mean,
  nans,
  ouHalfLife,
  percentileRank,
  skewness,
  kurtosisExcess,
  stdev,
  zeros,
} from "./math";

/* ------------------------------ rolling kernels --------------------------- */

export function sma(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  if (period <= 0) return out;
  let acc = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    acc += xs[i];
    count++;
    if (count > period) {
      acc -= xs[i - period];
      count--;
    }
    if (count === period) out[i] = acc / period;
  }
  return out;
}

export function ema(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  if (n === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  const warm = Math.min(period, n);
  for (let i = 0; i < warm; i++) seed += xs[i];
  let prev = seed / warm;
  out[warm - 1] = prev;
  for (let i = warm; i < n; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (used by RSI/ATR/ADX). */
export function rma(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  if (n === 0 || period <= 0) return out;
  let seed = 0;
  const warm = Math.min(period, n);
  for (let i = 0; i < warm; i++) seed += xs[i];
  let prev = seed / warm;
  out[warm - 1] = prev;
  for (let i = warm; i < n; i++) {
    prev = (prev * (period - 1) + xs[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function wma(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += xs[i - period + 1 + j] * (j + 1);
    out[i] = acc / denom;
  }
  return out;
}

export function hma(xs: number[], period: number): number[] {
  const half = Math.max(2, Math.floor(period / 2));
  const sqrtP = Math.max(2, Math.floor(Math.sqrt(period)));
  const w1 = wma(xs, half);
  const w2 = wma(xs, period);
  const diff = xs.map((_, i) =>
    Number.isFinite(w1[i]) && Number.isFinite(w2[i]) ? 2 * w1[i] - w2[i] : Number.NaN,
  );
  return wma(diff, sqrtP);
}

export function rollingStd(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      acc += xs[j];
      sq += xs[j] * xs[j];
    }
    const m = acc / period;
    out[i] = Math.sqrt(Math.max(0, sq / period - m * m));
  }
  return out;
}

export function rollingMax(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && xs[dq[dq.length - 1]] <= xs[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = xs[dq[0]];
  }
  return out;
}

export function rollingMin(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && xs[dq[dq.length - 1]] >= xs[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - period) dq.shift();
    if (i >= period - 1) out[i] = xs[dq[0]];
  }
  return out;
}

export function rollingSum(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += xs[i];
    if (i >= period) acc -= xs[i - period];
    if (i >= period - 1) out[i] = acc;
  }
  return out;
}

export function rollingPercentile(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  const win: number[] = [];
  for (let i = 0; i < n; i++) {
    win.push(xs[i]);
    if (win.length > period) win.shift();
    if (win.length === period) {
      const sorted = win.slice().sort((a, b) => a - b);
      out[i] = sorted[Math.floor((sorted.length - 1) * 0.5) + 1] ?? sorted[sorted.length - 1];
    }
  }
  return out;
}

/* ------------------------------- oscillators ------------------------------ */

export function rsi(xs: number[], period: number): number[] {
  const n = xs.length;
  const out = nans(n);
  if (n < period + 1) return out;
  const gains: number[] = zeros(n);
  const losses: number[] = zeros(n);
  for (let i = 1; i < n; i++) {
    const d = xs[i] - xs[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const ag = rma(gains.slice(1), period);
  const al = rma(losses.slice(1), period);
  for (let i = 0; i < ag.length; i++) {
    if (!Number.isFinite(ag[i])) continue;
    const rs = al[i] === 0 ? 100 : ag[i] / al[i];
    out[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export function stochastic(high: number[], low: number[], close: number[], period: number, smoothK = 3, smoothD = 3) {
  const hh = rollingMax(high, period);
  const ll = rollingMin(low, period);
  const raw = close.map((c, i) =>
    Number.isFinite(hh[i]) && Number.isFinite(ll[i]) && hh[i] !== ll[i]
      ? ((c - ll[i]) / (hh[i] - ll[i])) * 100
      : Number.NaN,
  );
  const k = sma(raw, smoothK);
  const d = sma(k, smoothD);
  return { k, d, raw };
}

export function macd(xs: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const f = ema(xs, fast);
  const s = ema(xs, slow);
  const line = xs.map((_, i) =>
    Number.isFinite(f[i]) && Number.isFinite(s[i]) ? f[i] - s[i] : Number.NaN,
  );
  const clean = line.map((v) => (Number.isFinite(v) ? v : 0));
  const sig = ema(clean, signalPeriod).map((v, i) => (Number.isFinite(line[i]) ? v : Number.NaN));
  const hist = line.map((v, i) => (Number.isFinite(v) && Number.isFinite(sig[i]) ? v - sig[i] : Number.NaN));
  return { macd: line, signal: sig, hist };
}

export function trueRange(candles: Candle[]): number[] {
  const n = candles.length;
  const out = zeros(n);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  out[0] = candles.length ? candles[0].high - candles[0].low : 0;
  return out;
}

export function atr(candles: Candle[], period = 14): number[] {
  return rma(trueRange(candles), period);
}

export function adx(candles: Candle[], period = 14) {
  const n = candles.length;
  const plusDM = zeros(n);
  const minusDM = zeros(n);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(candles), period);
  const pdm = rma(plusDM, period);
  const mdm = rma(minusDM, period);
  const plusDi = nans(n);
  const minusDi = nans(n);
  const dx = zeros(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(tr[i]) || tr[i] === 0) continue;
    plusDi[i] = (pdm[i] / tr[i]) * 100;
    minusDi[i] = (mdm[i] / tr[i]) * 100;
    const s = plusDi[i] + minusDi[i];
    dx[i] = s === 0 ? 0 : (Math.abs(plusDi[i] - minusDi[i]) / s) * 100;
  }
  const adxLine = rma(dx.map((v) => (Number.isFinite(v) ? v : 0)), period).map((v, i) =>
    Number.isFinite(plusDi[i]) ? v : Number.NaN,
  );
  return { adx: adxLine, plusDi, minusDi };
}

export function bollinger(xs: number[], period = 20, mult = 2) {
  const mid = sma(xs, period);
  const sd = rollingStd(xs, period);
  const upper = mid.map((m, i) => m + mult * sd[i]);
  const lower = mid.map((m, i) => m - mult * sd[i]);
  const width = mid.map((m, i) => (m !== 0 && Number.isFinite(sd[i]) ? (2 * mult * sd[i]) / m : Number.NaN));
  const percentB = xs.map((x, i) =>
    Number.isFinite(upper[i]) && upper[i] !== lower[i] ? (x - lower[i]) / (upper[i] - lower[i]) : Number.NaN,
  );
  return { mid, sd, upper, lower, width, percentB };
}

export function keltner(candles: Candle[], period = 20, mult = 1.8) {
  const close = candles.map((c) => c.close);
  const mid = ema(close, period);
  const a = atr(candles, period);
  return {
    mid,
    upper: mid.map((m, i) => m + mult * a[i]),
    lower: mid.map((m, i) => m - mult * a[i]),
  };
}

export function donchian(candles: Candle[], period = 20) {
  const high = rollingMax(candles.map((c) => c.high), period);
  const low = rollingMin(candles.map((c) => c.low), period);
  const mid = high.map((h, i) => (h + low[i]) / 2);
  return { high, low, mid };
}

export function supertrend(candles: Candle[], period = 10, mult = 3) {
  const n = candles.length;
  const a = atr(candles, period);
  const st = nans(n);
  const dir = zeros(n);
  let upper = Number.NaN;
  let lower = Number.NaN;
  let trend = 1;
  for (let i = 1; i < n; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
    const prevClose = candles[i - 1].close;
    if (!Number.isFinite(upper)) {
      upper = basicUpper;
      lower = basicLower;
      trend = 1;
    } else {
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      if (candles[i].close > upper) trend = 1;
      else if (candles[i].close < lower) trend = -1;
    }
    dir[i] = trend;
    st[i] = trend === 1 ? lower : upper;
  }
  return { supertrend: st, dir };
}

export function ichimoku(candles: Candle[], tenkanP = 9, kijunP = 26, senkouBP = 52) {
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const midOf = (p: number) => {
    const hh = rollingMax(high, p);
    const ll = rollingMin(low, p);
    return hh.map((h, i) => (h + ll[i]) / 2);
  };
  const tenkan = midOf(tenkanP);
  const kijun = midOf(kijunP);
  const senkouA = tenkan.map((t, i) => (t + kijun[i]) / 2);
  const senkouB = midOf(senkouBP);
  const close = candles.map((c) => c.close);
  const chikouShift = close.map((_, i) => close[Math.min(close.length - 1, i + kijunP)]);
  return { tenkan, kijun, senkouA, senkouB, chikouShift };
}

export function parabolicSar(candles: Candle[], step = 0.02, max = 0.2): number[] {
  const n = candles.length;
  const out = nans(n);
  if (n < 2) return out;
  let up = candles[1].close >= candles[0].close;
  let af = step;
  let ep = up ? candles[0].high : candles[0].low;
  let sar = up ? candles[0].low : candles[0].high;
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      if (candles[i].low < sar) {
        up = false;
        sar = ep;
        ep = candles[i].low;
        af = step;
      } else if (candles[i].high > ep) {
        ep = candles[i].high;
        af = Math.min(max, af + step);
      }
    } else {
      if (candles[i].high > sar) {
        up = true;
        sar = ep;
        ep = candles[i].high;
        af = step;
      } else if (candles[i].low < ep) {
        ep = candles[i].low;
        af = Math.min(max, af + step);
      }
    }
    out[i] = sar;
  }
  return out;
}

export function chandelierExit(candles: Candle[], period = 22, mult = 3): number[] {
  const a = atr(candles, period);
  const hh = rollingMax(candles.map((c) => c.high), period);
  return hh.map((h, i) => h - mult * a[i]);
}

export function aroon(candles: Candle[], period = 25): number[] {
  const n = candles.length;
  const out = nans(n);
  const highs = candles.map((c) => c.high);
  for (let i = period; i < n; i++) {
    let hiIdx = i;
    let loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (highs[j] >= highs[hiIdx]) hiIdx = j;
      if (candles[j].low <= candles[loIdx].low) loIdx = j;
    }
    const up = ((period - (i - hiIdx)) / period) * 100;
    const down = ((period - (i - loIdx)) / period) * 100;
    out[i] = up - down;
  }
  return out;
}

/* --------------------------------- volume -------------------------------- */

export function obv(candles: Candle[]): number[] {
  const n = candles.length;
  const out = zeros(n);
  for (let i = 1; i < n; i++) {
    const dir = Math.sign(candles[i].close - candles[i - 1].close);
    out[i] = out[i - 1] + dir * candles[i].volume;
  }
  return out;
}

export function mfi(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const pos = zeros(n);
  const neg = zeros(n);
  for (let i = 1; i < n; i++) {
    const flow = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) pos[i] = flow;
    else if (tp[i] < tp[i - 1]) neg[i] = flow;
  }
  const ps = rollingSum(pos, period);
  const ns = rollingSum(neg, period);
  return ps.map((p, i) => {
    if (!Number.isFinite(p) || !Number.isFinite(ns[i])) return Number.NaN;
    if (ns[i] === 0) return 100;
    return 100 - 100 / (1 + p / ns[i]);
  });
}

export function cmf(candles: Candle[], period = 20): number[] {
  const n = candles.length;
  const mfv = zeros(n);
  for (let i = 0; i < n; i++) {
    const range = candles[i].high - candles[i].low;
    mfv[i] = range === 0 ? 0 : ((candles[i].close - candles[i].low - (candles[i].high - candles[i].close)) / range) * candles[i].volume;
  }
  const num = rollingSum(mfv, period);
  const den = rollingSum(candles.map((c) => c.volume), period);
  return num.map((v, i) => (Number.isFinite(v) && den[i] !== 0 ? v / den[i] : Number.NaN));
}

/** Rolling VWAP with standard deviation bands (deviation used by mean reversion). */
export function rollingVwap(candles: Candle[], period = 48) {
  const n = candles.length;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const pv = candles.map((c, i) => tp[i] * c.volume);
  const spv = rollingSum(pv, period);
  const sv = rollingSum(candles.map((c) => c.volume), period);
  const vwap = spv.map((v, i) => (Number.isFinite(v) && sv[i] > 0 ? v / sv[i] : Number.NaN));
  const dev = nans(n);
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      acc += tp[j] * tp[j] * candles[j].volume;
      vol += candles[j].volume;
    }
    const m = vwap[i];
    if (vol > 0 && Number.isFinite(m)) dev[i] = Math.sqrt(Math.max(0, acc / vol - m * m));
  }
  return { vwap, dev };
}

/** Volume profile (value area / POC) over a rolling window — coarse but O(n*w). */
export function volumeProfile(candles: Candle[], period = 120, bins = 24) {
  const n = candles.length;
  const poc = nans(n);
  const vah = nans(n);
  const val = nans(n);
  for (let i = period - 1; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].low < lo) lo = candles[j].low;
      if (candles[j].high > hi) hi = candles[j].high;
    }
    if (!(hi > lo)) continue;
    const step = (hi - lo) / bins;
    const bucket = new Array<number>(bins).fill(0);
    let total = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const b = clamp(Math.floor((tp - lo) / step), 0, bins - 1);
      bucket[b] += candles[j].volume;
      total += candles[j].volume;
    }
    let best = 0;
    for (let b = 1; b < bins; b++) if (bucket[b] > bucket[best]) best = b;
    poc[i] = lo + (best + 0.5) * step;
    let acc = bucket[best];
    let lowBin = best;
    let highBin = best;
    while (acc < total * 0.7 && (lowBin > 0 || highBin < bins - 1)) {
      const nextLow = lowBin > 0 ? bucket[lowBin - 1] : -1;
      const nextHigh = highBin < bins - 1 ? bucket[highBin + 1] : -1;
      if (nextHigh >= nextLow) {
        highBin++;
        acc += Math.max(0, nextHigh);
      } else {
        lowBin--;
        acc += Math.max(0, nextLow);
      }
    }
    vah[i] = lo + (highBin + 1) * step;
    val[i] = lo + lowBin * step;
  }
  return { poc, vah, val };
}

/* ------------------------------- volatility ------------------------------- */

export function logReturns(close: number[]): number[] {
  const n = close.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    out[i] = close[i - 1] !== 0 ? Math.log(close[i] / close[i - 1]) : 0;
  }
  return out;
}

export function realizedVol(close: number[], period: number): number[] {
  const lr = logReturns(close);
  return rollingStd(lr, period).map((v) => v * Math.sqrt(period));
}

export function parkinsonVol(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const sq = candles.map((c) => {
    const l = Math.log(c.high / Math.max(c.low, 1e-12));
    return (l * l) / (4 * Math.log(2));
  });
  return rollingMeanOf(sq, period).map((v) => Math.sqrt(Math.max(0, v)));
}

export function garmanKlassVol(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const sq = candles.map((c) => {
    const hl = Math.log(c.high / Math.max(c.low, 1e-12)) ** 2;
    const co = Math.log(c.close / Math.max(c.open, 1e-12)) ** 2;
    return 0.5 * hl - (2 * Math.log(2) - 1) * co;
  });
  return rollingMeanOf(sq, period).map((v) => Math.sqrt(Math.max(0, v)));
}

export function yangZhangVol(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const oc = candles.map((c) => Math.log(c.close / Math.max(c.open, 1e-12)) ** 2);
  const co = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    co[i] = Math.log(candles[i].open / Math.max(candles[i - 1].close, 1e-12)) ** 2;
  }
  const rs = candles.map((c) => {
    const hl = Math.log(c.high / Math.max(c.low, 1e-12)) ** 2;
    const co2 = Math.log(c.close / Math.max(c.open, 1e-12)) ** 2;
    return Math.max(0, hl - co2) / 2;
  });
  const k = 0.34 / (1.34 + (period + 1) / (period - 1));
  const mOC = rollingMeanOf(oc, period);
  const mCO = rollingMeanOf(co, period);
  const mRS = rollingMeanOf(rs, period);
  return mOC.map((v, i) => Math.sqrt(Math.max(0, v + k * mCO[i] + (1 - k) * mRS[i])));
}

function rollingMeanOf(xs: number[], period: number): number[] {
  return sma(xs, period);
}

/* ---------------------------- misc oscillators ---------------------------- */

export function cci(candles: Candle[], period = 20): number[] {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const m = sma(tp, period);
  const out = nans(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += Math.abs(tp[j] - m[i]);
    const md = acc / period;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

export function williamsR(candles: Candle[], period = 14): number[] {
  const hh = rollingMax(candles.map((c) => c.high), period);
  const ll = rollingMin(candles.map((c) => c.low), period);
  return candles.map((c, i) => {
    if (!Number.isFinite(hh[i]) || hh[i] === ll[i]) return Number.NaN;
    return ((hh[i] - c.close) / (hh[i] - ll[i])) * -100;
  });
}

export function trima(xs: number[], period: number): number[] {
  const half = Math.floor((period + 1) / 2);
  return sma(sma(xs, half), half);
}

export function massIndex(candles: Candle[], period = 25): number[] {
  const hl = candles.map((c) => c.high - c.low);
  const e1 = ema(hl, 9);
  const e2 = ema(e1.map((v) => (Number.isFinite(v) ? v : 0)), 9);
  const ratio = candles.map((_, i) =>
    Number.isFinite(e1[i]) && e2[i] !== 0 ? e1[i] / e2[i] : Number.NaN,
  );
  return rollingSum(ratio.map((v) => (Number.isFinite(v) ? v : 0)), period);
}

export function ultimateOscillator(candles: Candle[]): number[] {
  const n = candles.length;
  const bp = zeros(n);
  const tr = zeros(n);
  for (let i = 1; i < n; i++) {
    const prevClose = candles[i - 1].close;
    const low = Math.min(candles[i].low, prevClose);
    const high = Math.max(candles[i].high, prevClose);
    bp[i] = candles[i].close - low;
    tr[i] = high - low;
  }
  const bp7 = rollingSum(bp, 7);
  const tr7 = rollingSum(tr, 7);
  const bp14 = rollingSum(bp, 14);
  const tr14 = rollingSum(tr, 14);
  const bp28 = rollingSum(bp, 28);
  const tr28 = rollingSum(tr, 28);
  const out = nans(n);
  for (let i = 27; i < n; i++) {
    const a = tr7[i] === 0 ? 0 : bp7[i] / tr7[i];
    const b = tr14[i] === 0 ? 0 : bp14[i] / tr14[i];
    const c = tr28[i] === 0 ? 0 : bp28[i] / tr28[i];
    out[i] = (100 * (4 * a + 2 * b + c)) / 7;
  }
  return out;
}

export function tsi(close: number[], long = 25, short = 13): number[] {
  const n = close.length;
  const mom = zeros(n);
  for (let i = 1; i < n; i++) mom[i] = close[i] - close[i - 1];
  const e1 = ema(mom, long);
  const e2 = ema(e1.map((v) => (Number.isFinite(v) ? v : 0)), short);
  const abs = mom.map(Math.abs);
  const a1 = ema(abs, long);
  const a2 = ema(a1.map((v) => (Number.isFinite(v) ? v : 0)), short);
  return e2.map((v, i) => (a2[i] !== 0 ? (v / a2[i]) * 100 : Number.NaN));
}

export function roc(xs: number[], period = 12): number[] {
  return xs.map((x, i) =>
    i >= period && xs[i - period] !== 0 ? ((x - xs[i - period]) / xs[i - period]) * 100 : Number.NaN,
  );
}

/** Candlestick pattern recognition score in [-1, 1] (bullish > 0). */
export function patternScore(candles: Candle[]): number[] {
  const n = candles.length;
  const out = zeros(n);
  for (let i = 2; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const body = Math.abs(c.close - c.open);
    const range = Math.max(1e-12, c.high - c.low);
    const upper = c.high - Math.max(c.close, c.open);
    const lower = Math.min(c.close, c.open) - c.low;
    const pBody = Math.abs(p.close - p.open);
    let score = 0;

    // hammer / shooting star
    if (body / range < 0.35 && lower > body * 1.8) score += 0.45;
    if (body / range < 0.35 && upper > body * 1.8) score -= 0.45;

    // bullish / bearish engulfing
    if (c.close > c.open && p.close < p.open && c.close >= p.open && c.open <= p.close && body > pBody) score += 0.6;
    if (c.close < c.open && p.close > p.open && c.close <= p.open && c.open >= p.close && body > pBody) score -= 0.6;

    // inside bar compression
    if (c.high < p.high && c.low > p.low) score += (c.close > c.open ? 0.15 : -0.15);

    // momentum candle (marubozu continuation)
    if (body / range > 0.75) score += (c.close > c.open ? 0.35 : -0.35);

    // gap fill pressure
    if (c.low > p.high) score += 0.2;
    if (c.high < p.low) score -= 0.2;

    out[i] = clamp(score, -1, 1);
  }
  return out;
}

/* ----------------------------- regime detection --------------------------- */

export interface RegimeResult {
  regime: MarketRegime[];
  volPercentile: number[];
  trendStrength: number[];
}

export function detectRegime(candles: Candle[], ind: Partial<IndicatorSet>): RegimeResult {
  const n = candles.length;
  const regime: MarketRegime[] = new Array<MarketRegime>(n).fill("range");
  const volPct = nans(n);
  const trendStrength = nans(n);
  const close = candles.map((c) => c.close);
  const lr = logReturns(close);
  const lookback = 150;

  for (let i = 0; i < n; i++) {
    if (i < lookback) {
      regime[i] = "range";
      continue;
    }
    const win = lr.slice(i - lookback + 1, i + 1);
    const v = stdev(win);
    volPct[i] = percentileRank(lr.slice(Math.max(0, i - 500), i), lr[i]);
    const adxVal = ind.adx?.[i] ?? 0;
    const ema50 = ind.ema50?.[i] ?? close[i];
    const ema200 = ind.ema200?.[i] ?? close[i];
    const slopeWin = close.slice(i - 40, i + 1);
    const { slope, r2 } = linreg(slopeWin);
    const normSlope = (slope * 40) / Math.max(ema50, 1e-9);
    trendStrength[i] = clamp(Math.abs(normSlope) * r2 * 40, 0, 3);

    const histVol = stdev(lr.slice(i - 500, i)) || v;
    const volRatio = v / histVol;
    const ret20 = close[i] / close[i - 20] - 1;
    const shockMove = Math.abs(ret20) > 4 * v * Math.sqrt(20) && volRatio > 2;

    if (shockMove) regime[i] = "shock";
    else if (volRatio > 1.35) regime[i] = "expansion";
    else if (adxVal < 18 && Math.abs(normSlope) < 0.012) regime[i] = "range";
    else if (volRatio < 0.75 && adxVal < 22) regime[i] = "compression";
    else if (ema50 >= ema200 && (normSlope > 0 || adxVal > 22)) regime[i] = "trend_up";
    else if (ema50 < ema200 && (normSlope < 0 || adxVal > 22)) regime[i] = "trend_down";
    else regime[i] = "range";
  }
  return { regime, volPercentile: volPct, trendStrength };
}

/* ------------------------------ master builder ---------------------------- */

export function buildIndicators(candles: Candle[]): IndicatorSet {
  const close = candles.map((c) => c.close);
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume);
  const lr = logReturns(close);

  const bb = bollinger(close, 20, 2);
  const st = supertrend(candles, 10, 3);
  const dc = donchian(candles, 20);
  const kc = keltner(candles, 20, 1.8);
  const ich = ichimoku(candles);
  const adxRes = adx(candles, 14);
  const atr14 = atr(candles, 14);
  const obvSeries = obv(candles);
  const obvEma = ema(obvSeries.map((v) => (Number.isFinite(v) ? v : 0)), 20);
  const { vwap, dev } = rollingVwap(candles, 48);
  const vp = volumeProfile(candles, 120, 24);
  const kal = kalmanFilter(close, 1e-5, 1.2e-2);
  const kalResidZ = nans(candles.length);
  const kalSd = rollingStd(kal.resid.map((v) => (Number.isFinite(v) ? v : 0)), 60);
  for (let i = 0; i < kalResidZ.length; i++) {
    kalResidZ[i] = kalSd[i] > 0 ? kal.resid[i] / kalSd[i] : Number.NaN;
  }
  const rsi14 = rsi(close, 14);
  const stoch = stochastic(high, low, close, 14, 3, 3);
  const rsi7Raw = rsi(close, 7);
  const stochRsiRaw = nans(candles.length);
  const rsi14Clean = rsi14.map((v) => (Number.isFinite(v) ? v : 50));
  const rsiLow = rollingMin(rsi14Clean, 14);
  const rsiHigh = rollingMax(rsi14Clean, 14);
  for (let i = 0; i < stochRsiRaw.length; i++) {
    const span = rsiHigh[i] - rsiLow[i];
    stochRsiRaw[i] = span > 0 ? (rsi14Clean[i] - rsiLow[i]) / span : 0.5;
  }
  const zscore = nans(candles.length);
  const sd20 = bb.sd;
  for (let i = 0; i < zscore.length; i++) {
    zscore[i] = sd20[i] > 0 ? (close[i] - bb.mid[i]) / sd20[i] : Number.NaN;
  }
  const hurstArr = nans(candles.length);
  const halfLifeArr = nans(candles.length);
  const slopeArr = nans(candles.length);
  const r2Arr = nans(candles.length);
  const skewArr = nans(candles.length);
  const kurtArr = nans(candles.length);
  for (let i = 60; i < candles.length; i += 1) {
    const win = lr.slice(i - 59, i + 1);
    hurstArr[i] = hurstExponent(win);
    halfLifeArr[i] = ouHalfLife(close.slice(i - 59, i + 1));
    const reg = linreg(close.slice(i - 39, i + 1));
    slopeArr[i] = (reg.slope * 40) / Math.max(close[i], 1e-9);
    r2Arr[i] = reg.r2;
    skewArr[i] = skewness(win);
    kurtArr[i] = kurtosisExcess(win);
  }
  const rv = realizedVol(close, 20);
  const park = parkinsonVol(candles, 20);
  const gk = garmanKlassVol(candles, 20);
  const yz = yangZhangVol(candles, 20);
  const volPct = nans(candles.length);
  const volOfVol = nans(candles.length);
  const rvClean = rv.map((v) => (Number.isFinite(v) ? v : 0));
  for (let i = 1; i < volPct.length; i++) {
    volPct[i] = percentileRank(rvClean.slice(Math.max(0, i - 250), i), rvClean[i]);
    if (i > 60) volOfVol[i] = stdev(rvClean.slice(i - 60, i));
  }
  const m = macd(close);
  const volSma = sma(volume, 20);
  const volumeZ = volume.map((v, i) => (volSma[i] > 0 ? (v - volSma[i]) / volSma[i] : Number.NaN));

  return {
    close,
    open,
    high,
    low,
    volume,
    logReturn: lr,
    ema9: ema(close, 9),
    ema21: ema(close, 21),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    sma20: bb.mid,
    sma50: sma(close, 50),
    hma: hma(close, 21),
    rsi2: rsi(close, 2),
    rsi7: rsi7Raw,
    rsi14,
    stochRsi: stochRsiRaw,
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    atr: atr14,
    atrPct: atr14.map((v, i) => (Number.isFinite(v) && close[i] ? v / close[i] : Number.NaN)),
    adx: adxRes.adx,
    plusDi: adxRes.plusDi,
    minusDi: adxRes.minusDi,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMid: bb.mid,
    bbWidth: bb.width,
    percentB: bb.percentB,
    zscore,
    supertrend: st.supertrend,
    superDir: st.dir,
    donchianHigh: dc.high,
    donchianLow: dc.low,
    donchianMid: dc.mid,
    keltnerUpper: kc.upper,
    keltnerLower: kc.lower,
    tenkan: ich.tenkan,
    kijun: ich.kijun,
    senkouA: ich.senkouA,
    senkouB: ich.senkouB,
    chikouShift: ich.chikouShift,
    obv: obvSeries,
    obvSlope: obvSeries.map((_, i) =>
      Number.isFinite(obvEma[i]) ? (obvSeries[i] - obvEma[i]) / Math.max(1, Math.abs(obvEma[i])) : Number.NaN,
    ),
    mfi: mfi(candles, 14),
    cmf: cmf(candles, 20),
    vwap,
    vwapDev: dev,
    volumeZ,
    valueAreaHigh: vp.vah,
    valueAreaLow: vp.val,
    poc: vp.poc,
    realizedVol: rv,
    parkinsonVol: park,
    garmanKlassVol: gk,
    yangZhangVol: yz,
    volPercentile: volPct,
    volOfVol,
    hurst: hurstArr,
    halfLife: halfLifeArr,
    kalman: kal.level,
    kalmanResid: kal.resid,
    kalmanResidZ: kalResidZ,
    linregSlope: slopeArr,
    linregR2: r2Arr,
    skew: skewArr,
    kurtosis: kurtArr,
    sar: parabolicSar(candles),
    chandelier: chandelierExit(candles, 22, 3),
    aroon: aroon(candles, 25),
    cci: cci(candles, 20),
    williamsR: williamsR(candles, 14),
    stochK: stoch.k,
    stochD: stoch.d,
    trima: trima(close, 21),
    massIndex: massIndex(candles, 25),
    ulti: ultimateOscillator(candles),
    tsi: tsi(close),
    roc: roc(close, 12),
    patternScore: patternScore(candles),
  };
}
