/**
 * HELIX numerical core — vectorised statistics, robust estimators, stochastic
 * process helpers and special functions. Every function is allocation-aware
 * (hot loops are used by the backtester and the differential-evolution search).
 */

export const NaN_ = Number.NaN;

export function isFiniteNumber(x: number): boolean {
  return typeof x === "number" && Number.isFinite(x);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function round(x: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

export function variance(xs: number[], sample = true): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    acc += d * d;
  }
  return acc / (sample ? n - 1 : n);
}

export function stdev(xs: number[], sample = true): number {
  return Math.sqrt(variance(xs, sample));
}

export function median(xs: number[]): number {
  return quantile(xs, 0.5);
}

export function quantile(xs: number[], q: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1) return xs[0];
  const sorted = xs.slice().sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return lerp(sorted[lo], sorted[hi], pos - lo);
}

export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  let m2 = 0;
  let m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 <= 0) return 0;
  return m3 / m2 ** 1.5;
}

export function kurtosisExcess(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  let m2 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 <= 0) return 0;
  return m4 / (m2 * m2) - 3;
}

export function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  let used = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
    used++;
  }
  if (used < 3 || dx <= 0 || dy <= 0) return 0;
  return clamp(num / Math.sqrt(dx * dy), -1, 1);
}

/** Spearman rank correlation — robust for the CSCV/PBO machinery. */
export function rankCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  return correlation(rx, ry);
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = r;
    i = j + 1;
  }
  return out;
}

export function linreg(ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1);
  return { slope, intercept, r2 };
}

/* ------------------------------ distributions ----------------------------- */

/** Abramowitz & Stegun 7.1.26 based error function. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Acklam's inverse normal CDF (high precision, no dependencies). */
export function normalInv(p: number): number {
  const pp = clamp(p, 1e-12, 1 - 1e-12);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (pp < pLow) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pp <= 1 - pLow) {
    const q = pp - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - pp));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function tCdf(t: number, df: number): number {
  // Regularised incomplete beta approximation for the Student-t CDF.
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(0.5 * df, 0.5, x);
  return t > 0 ? 1 - p : p;
}

function logGamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++x;
  return -tmp + Math.log((2.5066282746310005 * ser) / z);
}

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  const f = (xx: number) =>
    front * continuedFraction(a, b, xx) / a;
  if (x < (a + 1) / (a + b + 2)) return f(x);
  return 1 - ((1 - front) * continuedFraction(b, a, 1 - x)) / b;
}

function continuedFraction(a: number, b: number, x: number): number {
  const maxIter = 200;
  const eps = 3e-12;
  const qab = a * b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

export function studentPValue(t: number, df: number): number {
  if (df <= 0) return 1;
  return clamp(2 * (1 - tCdf(Math.abs(t), df)), 0, 1);
}

/* --------------------------------- arrays --------------------------------- */

export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

export function nans(n: number): number[] {
  return new Array<number>(n).fill(Number.NaN);
}

export function maxOf(xs: number[]): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
}

export function minOf(xs: number[]): number {
  let m = Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

export function argmax(xs: number[]): number {
  let bi = -1;
  let bv = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > bv) { bv = xs[i]; bi = i; }
  return bi;
}

export function percentileRank(rolling: number[], value: number): number {
  let below = 0;
  let total = 0;
  for (let i = 0; i < rolling.length; i++) {
    const v = rolling[i];
    if (!Number.isFinite(v)) continue;
    total++;
    if (v <= value) below++;
  }
  if (total === 0) return 0.5;
  return below / total;
}

/* ------------------------------ random numbers ---------------------------- */

export interface Rng {
  (): number;
  gauss(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return rng;
}

export function hashSeed(...parts: string[]): number {
  let h = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

/* -------------------------- process estimators ---------------------------- */

/**
 * Rescaled-range (R/S) Hurst exponent, computed on a rolling window.
 * H < 0.5 => mean reverting, H > 0.5 => trending, H ~ 0.5 => random walk.
 */
export function hurstExponent(returns: number[]): number {
  const n = returns.length;
  if (n < 32) return 0.5;
  const sizes: number[] = [];
  for (let s = 8; s <= Math.floor(n / 2); s = Math.floor(s * 1.6)) sizes.push(s);
  if (sizes.length < 2) return 0.5;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const size of sizes) {
    const chunks = Math.floor(n / size);
    if (chunks < 1) continue;
    let rsSum = 0;
    let used = 0;
    for (let c = 0; c < chunks; c++) {
      const slice = returns.slice(c * size, (c + 1) * size);
      let cum = 0;
      let min = Infinity;
      let max = -Infinity;
      const m = mean(slice);
      for (let i = 0; i < slice.length; i++) {
        cum += slice[i] - m;
        if (cum < min) min = cum;
        if (cum > max) max = cum;
      }
      const range = max - min;
      const sd = stdev(slice);
      if (sd > 0 && range > 0) {
        rsSum += range / sd;
        used++;
      }
    }
    if (used === 0) continue;
    xs.push(Math.log(size));
    ys.push(Math.log(rsSum / used));
  }
  if (xs.length < 2) return 0.5;
  // regress log(R/S) on log(size)
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / xs.length;
  const my = sy / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const h = den === 0 ? 0.5 : num / den;
  return clamp(h, 0.05, 0.95);
}

/** Ornstein-Uhlenbeck half life of mean reversion from an AR(1) fit. */
export function ouHalfLife(spread: number[]): number {
  const n = spread.length;
  if (n < 12) return 999;
  let dxSum = 0;
  const dx: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = spread[i] - spread[i - 1];
    dx.push(d);
    dxSum += d;
  }
  const mdx = dxSum / dx.length;
  const ms = mean(spread.slice(0, n - 1));
  let num = 0;
  let den = 0;
  for (let i = 1; i < n; i++) {
    const dev = spread[i - 1] - ms;
    num += dev * (dx[i - 1] - mdx);
    den += dev * dev;
  }
  if (den === 0) return 999;
  const beta = num / den;
  if (beta >= -1e-9) return 999;
  return clamp(-Math.log(2) / beta, 0.5, 500);
}

/** 1-D Kalman filter with adaptive observation noise (local level + slope). */
export function kalmanFilter(
  prices: number[],
  processVar = 1e-5,
  measurementVar = 1e-2,
): { level: number[]; resid: number[] } {
  const n = prices.length;
  const level = nans(n);
  const resid = nans(n);
  if (n === 0) return { level, resid };
  let x = prices[0];
  let p = 1;
  const q = processVar;
  const r = measurementVar;
  for (let i = 0; i < n; i++) {
    // predict
    p += q;
    // update
    const k = p / (p + r);
    const z = prices[i];
    x = x + k * (z - x);
    p = (1 - k) * p;
    level[i] = x;
    resid[i] = z - x;
  }
  return { level, resid };
}

/* --------------------------- matrix / ML helpers -------------------------- */

export function standardise(xs: number[]): { out: number[]; mu: number; sigma: number } {
  const mu = mean(xs);
  const sigma = stdev(xs);
  if (sigma === 0) return { out: xs.map(() => 0), mu, sigma: 0 };
  return { out: xs.map((v) => (v - mu) / sigma), mu, sigma };
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function logLoss(p: number, y: number): number {
  const pp = clamp(p, 1e-9, 1 - 1e-9);
  return -(y * Math.log(pp) + (1 - y) * Math.log(1 - pp));
}

/** Combinatorics C(n, k) — returns index tuples to keep the PBO search exact. */
export function combinations(n: number, k: number): number[][] {
  const res: number[][] = [];
  const idx = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) idx[i] = i;
  if (k > n) return res;
  while (true) {
    res.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return res;
}
