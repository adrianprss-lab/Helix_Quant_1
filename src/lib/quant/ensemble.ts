import type {
  AlphaEnsembleBar,
  Candle,
  EnsembleParams,
  IndicatorSet,
  MarketRegime,
} from "./types";
import type { Timeframe } from "./data";
import { buildIndicators, detectRegime } from "./indicators";
import { ALPHA_MODELS, rollingEdge } from "./strategies";
import { clamp, mean, sigmoid, stdev } from "./math";

export const DEFAULT_PARAMS: EnsembleParams = {
  confidenceFloor: 0.16,
  metaThreshold: 0.62,
  metaWeight: 0.65,
  regimeGate: 0.7,
  stopAtrMult: 2.35,
  targetAtrMult: 0.62,
  tp1Fraction: 0.5,
  trailAtrMult: 1.45,
  breakevenAtR: 0.55,
  timeStopBars: 9,
  weightWindow: 320,
  metaTrainWindow: 1400,
  metaRefitCadence: 90,
  allowLong: true,
  allowShort: true,
  metaL2: 0.0016,
};

export interface MetaModel {
  weights: number[];
  bias: number;
  featureMean: number[];
  featureStd: number[];
  samples: number;
  iterations: number;
  logLoss: number;
  accuracy: number;
  refits: number;
}

export interface EnsembleResult {
  ind: IndicatorSet;
  regime: MarketRegime[];
  score: number[];
  confidence: number[];
  metaProb: number[];
  direction: ("long" | "short" | "flat")[];
  weights: number[][];
  dominant: string[];
  alphaScores: Record<string, number[]>;
  alphaIc: Record<string, number>;
  infoCoefficient: number;
  meta: MetaModel;
  featureNames: string[];
  /** forward-looking labels; only used for training, never for execution */
  labels: number[];
  threshold: number;
  bars: number;
}

export const FEATURE_NAMES = [
  "zscore20",
  "rsi2_dev",
  "rsi14_dev",
  "percentB_dev",
  "atr_pct",
  "vol_pct",
  "hurst_dev",
  "kalman_resid_z",
  "macd_hist_atr",
  "pattern",
  "adx_norm",
  "super_dir",
  "vwap_dev",
  "volume_z",
  "slope_norm",
  "bb_width",
  "ens_score",
  "ens_conviction",
];

function buildFeatures(ind: IndicatorSet, score: number[]): number[][] {
  const n = ind.close.length;
  const f: number[][] = new Array(n);
  const safe = (v: number, fb = 0) => (Number.isFinite(v) ? v : fb);
  for (let i = 0; i < n; i++) {
    const atrRef = safe(ind.atr[i], 0);
    f[i] = [
      clamp(safe(ind.zscore[i]) / 3, -3, 3),
      clamp((safe(ind.rsi2[i], 50) - 50) / 25, -2, 2),
      clamp((safe(ind.rsi14[i], 50) - 50) / 25, -2, 2),
      clamp(safe(ind.percentB[i], 0.5) - 0.5, -0.6, 0.6),
      clamp(safe(ind.atrPct[i]) * 100, 0, 12),
      clamp(safe(ind.volPercentile[i], 0.5), 0, 1),
      clamp(safe(ind.hurst[i], 0.5) - 0.5, -0.3, 0.3) * 4,
      clamp(safe(ind.kalmanResidZ[i]) / 3, -3, 3),
      atrRef > 0 ? clamp(safe(ind.macdHist[i]) / (atrRef * 0.5), -3, 3) : 0,
      clamp(safe(ind.patternScore[i]), -1, 1),
      clamp(safe(ind.adx[i]) / 40 - 0.5, -0.5, 1.2),
      safe(ind.superDir[i]) as number,
      clamp(safe(ind.vwapDev[i], 0) > 0 ? (ind.close[i] - safe(ind.vwap[i], ind.close[i])) / (ind.vwapDev[i]! * 2) : 0, -2.5, 2.5),
      clamp(safe(ind.volumeZ[i]) / 3, -2, 3),
      clamp(safe(ind.linregSlope[i]) * 60, -3, 3),
      clamp(safe(ind.bbWidth[i]) * 12, 0, 4),
      clamp(score[i], -1, 1),
      clamp(Math.abs(score[i]) * 2, 0, 2),
    ];
  }
  return f;
}

/**
 * Single-trade forward simulator that mirrors the live exit ladder exactly:
 * ATR stop, profit target with partial scale-out, breakeven ratchet, ATR
 * trailing stop, time stop and the full round-trip cost haircut. The result is
 * the net R multiple that the engine would have realised had it entered here.
 */
export function outcomesForParams(
  candles: Candle[],
  ind: IndicatorSet,
  score: number[],
  params: EnsembleParams,
  costBps = 13,
): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(Number.NaN);
  const horizon = Math.max(2, Math.round(params.timeStopBars));
  for (let i = 0; i < n; i++) {
    const side = Math.sign(score[i]);
    const a = ind.atr[i];
    if (dirInvalid(side) || !Number.isFinite(a) || a <= 0) continue;
    const entry = candles[i].close;
    const risk = params.stopAtrMult * a;
    const costR = (costBps / 1e4) * entry / risk;
    let stop = entry - side * risk;
    let target = entry + side * params.targetAtrMult * a;
    let partial = false;
    let r = 0;
    let closedQty = 0;
    const addFill = (price: number, qty: number) => {
      r += ((price - entry) * side * qty) / risk;
      closedQty += qty;
    };
    let resolved = false;
    for (let j = i + 1; j <= Math.min(n - 1, i + horizon); j++) {
      const c = candles[j];
      const hitStop = side === 1 ? c.low <= stop : c.high >= stop;
      const hitTarget = side === 1 ? c.high >= target : c.low <= target;
      if (hitStop) {
        const qty = 1 - closedQty;
        addFill(stop, qty);
        resolved = true;
        break;
      }
      if (hitTarget) {
        if (!partial) {
          const part = Math.max(0.05, Math.min(0.95, params.tp1Fraction));
          addFill(target, part);
          closedQty = 0;
          closedQty = part;
          partial = true;
          stop = entry + side * entry * 0.0002;
          target = entry + side * risk * (params.stopAtrMult * 0.75);
        } else {
          addFill(target, 1 - closedQty);
          resolved = true;
          break;
        }
      } else if (j - i >= horizon) {
        addFill(c.close, 1 - closedQty);
        resolved = true;
        break;
      } else {
        const atrNow = ind.atr[j];
        if (Number.isFinite(atrNow)) {
          if (!partial && bestRun(candles, i, j, side, entry, risk) >= params.breakevenAtR) {
            stop = entry + side * entry * 0.0002;
          }
          const newStop = side === 1 ? c.close - params.trailAtrMult * atrNow : c.close + params.trailAtrMult * atrNow;
          stop = side === 1 ? Math.max(stop, newStop) : Math.min(stop, newStop);
        }
      }
    }
    if (!resolved) {
      const last = candles[Math.min(n - 1, i + horizon)];
      addFill(last.close, 1 - closedQty);
    }
    out[i] = r - costR * (0.85 + 0.15 * (partial ? 2 : 1));
  }
  return out;
}

function dirInvalid(side: number): boolean {
  return !(side === 1 || side === -1);
}

function bestRun(candles: Candle[], from: number, to: number, side: number, entry: number, risk: number): number {
  let best = 0;
  for (let j = from; j <= to; j++) {
    const fav = side === 1 ? candles[j].high - entry : entry - candles[j].low;
    if (fav / risk > best) best = fav / risk;
  }
  return best;
}

/** Binary meta labels derived from the simulated net R multiples. */
export function buildLabels(
  candles: Candle[],
  ind: IndicatorSet,
  score: number[],
  params: EnsembleParams,
): number[] {
  return labelsForParams(candles, ind, score, params);
}

export function labelsForParams(
  candles: Candle[],
  ind: IndicatorSet,
  score: number[],
  params: EnsembleParams,
): number[] {
  const rs = outcomesForParams(candles, ind, score, params);
  return rs.map((r) => (Number.isFinite(r) ? (r > 0 ? 1 : 0) : -1));
}

function fitLogistic(
  features: number[][],
  labels: number[],
  rows: number[],
  warm: MetaModel | null,
  iterations: number,
  l2: number,
  featureCount: number,
): MetaModel {
  const fMean = new Array<number>(featureCount).fill(0);
  const fStd = new Array<number>(featureCount).fill(1);
  if (rows.length > 8) {
    for (let f = 0; f < featureCount; f++) {
      let acc = 0;
      for (const r of rows) acc += features[r][f];
      const m = acc / rows.length;
      let ss = 0;
      for (const r of rows) ss += (features[r][f] - m) ** 2;
      fMean[f] = m;
      fStd[f] = Math.sqrt(ss / rows.length) || 1;
    }
  } else if (warm) {
    for (let f = 0; f < featureCount; f++) {
      fMean[f] = warm.featureMean[f];
      fStd[f] = warm.featureStd[f];
    }
  }
  const w = new Array<number>(featureCount).fill(0);
  let b = 0;
  if (warm) {
    for (let f = 0; f < featureCount; f++) w[f] = warm.weights[f];
    b = warm.bias;
  }
  const lr = 0.09;
  const momentumW = new Array<number>(featureCount).fill(0);
  let momentumB = 0;
  let loss = 0;
  let correct = 0;
  for (let it = 0; it < iterations; it++) {
    const gradW = new Array<number>(featureCount).fill(0);
    let gradB = 0;
    loss = 0;
    correct = 0;
    for (const r of rows) {
      let z = b;
      for (let f = 0; f < featureCount; f++) {
        const x = (features[r][f] - fMean[f]) / fStd[f];
        z += w[f] * x;
      }
      const p = sigmoid(z);
      const y = labels[r];
      if ((p >= 0.5 ? 1 : 0) === y) correct++;
      const pp = clamp(p, 1e-7, 1 - 1e-7);
      loss += -(y * Math.log(pp) + (1 - y) * Math.log(1 - pp));
      const err = p - y;
      gradB += err;
      for (let f = 0; f < featureCount; f++) {
        gradW[f] += err * ((features[r][f] - fMean[f]) / fStd[f]);
      }
    }
    const m = Math.max(1, rows.length);
    for (let f = 0; f < featureCount; f++) {
      gradW[f] = gradW[f] / m + l2 * w[f];
      momentumW[f] = 0.85 * momentumW[f] + lr * gradW[f];
      w[f] -= momentumW[f];
    }
    gradB /= m;
    momentumB = 0.85 * momentumB + lr * gradB;
    b -= momentumB;
  }
  return {
    weights: w,
    bias: b,
    featureMean: fMean,
    featureStd: fStd,
    samples: rows.length,
    iterations,
    logLoss: rows.length ? loss / rows.length : 0,
    accuracy: rows.length ? correct / rows.length : 0,
    refits: (warm?.refits ?? 0) + 1,
  };
}

function predict(model: MetaModel, features: number[], featureCount: number): number {
  let z = model.bias;
  for (let f = 0; f < featureCount; f++) {
    z += model.weights[f] * ((features[f] - model.featureMean[f]) / model.featureStd[f]);
  }
  return sigmoid(z);
}

/**
 * Adaptive meta-labelling engine:
 *   1. evaluate every alpha model
 *   2. weight alphas by their trailing information coefficient (shifted to
 *      avoid look-ahead)
 *   3. blend into an ensemble conviction score
 *   4. train a logistic meta classifier that estimates P(trade wins) and use
 *      it as a trade filter (López de Prado meta-labelling)
 */
export function buildEnsemble(
  candles: Candle[],
  params: EnsembleParams,
  _timeframe?: Timeframe,
): EnsembleResult {
  const ind = buildIndicators(candles);
  const { regime } = detectRegime(candles, ind);
  const n = candles.length;
  const models = ALPHA_MODELS;
  const m = models.length;

  const alphaScores: Record<string, number[]> = {};
  const rawScores: number[][] = [];
  const actives: boolean[][] = [];
  const maxHorizon = Math.max(...models.map((x) => x.horizon), 4);

  for (const model of models) {
    const out = model.evaluate({ candles, ind, regime, params });
    alphaScores[model.key] = out.score;
    rawScores.push(out.score);
    actives.push(out.active);
  }

  // ---- forward returns, measured over each model's OWN holding horizon ----
  const fwd = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const j = Math.min(n - 1, i + maxHorizon);
    fwd[i] = ind.close[j] / ind.close[i] - 1;
  }
  const fwdByHorizon = new Map<number, number[]>();
  const forwardFor = (h: number): number[] => {
    const cached = fwdByHorizon.get(h);
    if (cached) return cached;
    const f = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const j = Math.min(n - 1, i + h);
      f[i] = ind.close[j] / ind.close[i] - 1;
    }
    fwdByHorizon.set(h, f);
    return f;
  };

  // Every model is graded on the horizon it was designed for, and its trailing
  // information coefficient is shifted forward by that same horizon so the
  // weighting engine can never peek at the outcome it is being graded on.
  const shiftedEdges: number[][] = [];
  for (let k = 0; k < m; k++) {
    const h = Math.max(2, models[k].horizon);
    const e = rollingEdge(rawScores[k], forwardFor(h), params.weightWindow);
    const se = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const src = i - h;
      se[i] = src >= 0 ? e[src] : 0;
    }
    shiftedEdges.push(se);
  }

  // ---- adaptive weighting: bench every model without a positive trailing IC ----
  const weights: number[][] = new Array(n);
  const score = new Array<number>(n).fill(0);
  const dominant = new Array<string>(n).fill("ensemble");
  const temperature = 2.4;
  const modelCount = models.length;
  for (let i = 0; i < n; i++) {
    const w = new Array<number>(modelCount).fill(0);
    const ranked: { k: number; e: number }[] = [];
    for (let k = 0; k < modelCount; k++) {
      if (!actives[k][i]) continue;
      const e = shiftedEdges[k][i];
      if (!Number.isFinite(e)) continue;
      ranked.push({ k, e });
    }
    ranked.sort((a, b) => b.e - a.e);
    const positive = ranked.filter((r) => r.e > 0);
    // A model only deploys capital when its trailing information coefficient is
    // positive. If the whole book is negative the engine degrades gracefully to
    // the three least-bad models at reduced weight instead of going dormant.
    const book = positive.length ? positive : ranked.slice(0, Math.min(3, ranked.length));
    const haircut = positive.length ? 1 : 0.3;
    for (const r of book) {
      w[r.k] = Math.exp(r.e * temperature) * haircut;
    }
    let total = 0;
    for (let k = 0; k < modelCount; k++) total += w[k];
    if (total <= 0) {
      weights[i] = w;
      dominant[i] = "ensemble";
      continue;
    }

    // Dominant-view blending: the strongest conviction leads, and dissenting
    // models are excluded from the blend rather than allowed to cancel it out.
    let leadIdx = -1;
    let leadPower = -Infinity;
    for (let k = 0; k < modelCount; k++) {
      const power = w[k] * Math.abs(rawScores[k][i]);
      if (w[k] > 0 && power > leadPower) {
        leadPower = power;
        leadIdx = k;
      }
    }
    if (leadIdx < 0) {
      weights[i] = w;
      dominant[i] = "ensemble";
      continue;
    }
    const leadSign = Math.sign(rawScores[leadIdx][i]) || 1;
    let agreeTotal = 0;
    for (let k = 0; k < modelCount; k++) {
      if (w[k] <= 0) continue;
      if (Math.sign(rawScores[k][i]) !== leadSign) w[k] = 0;
      agreeTotal += w[k];
    }
    if (agreeTotal <= 0) {
      w[leadIdx] = total;
      agreeTotal = total;
    }
    let acc = 0;
    let directional = 0;
    for (let k = 0; k < modelCount; k++) {
      w[k] = w[k] / agreeTotal;
      acc += w[k] * rawScores[k][i];
      directional += w[k] * Math.sign(rawScores[k][i]);
    }
    const agreement = clamp(Math.abs(directional) * 1.25, 0, 1);
    score[i] = clamp(acc * (0.55 + 0.45 * agreement), -1, 1);
    dominant[i] = models[leadIdx].key;
    weights[i] = w;
  }

  // ---- labels + features for the meta classifier ----
  const labels = buildLabels(candles, ind, score, params);
  const features = buildFeatures(ind, score);
  const featureCount = FEATURE_NAMES.length;
  const warmup = Math.min(n, 260);
  const metaProb = new Array<number>(n).fill(0.5);
  let meta: MetaModel = {
    weights: new Array<number>(featureCount).fill(0),
    bias: 0,
    featureMean: new Array<number>(featureCount).fill(0),
    featureStd: new Array<number>(featureCount).fill(1),
    samples: 0,
    iterations: 0,
    logLoss: 0,
    accuracy: 0,
    refits: 0,
  };

  const purge = Math.max(2, Math.round(params.timeStopBars)) + maxHorizon;
  const cadence = Math.max(20, params.metaRefitCadence);
  let lastFit = -1;
  const probs: number[] = [];
  for (let i = warmup; i < n; i++) {
    if (i - lastFit >= cadence || lastFit < 0) {
      const start = Math.max(warmup, i - params.metaTrainWindow);
      const end = i - purge;
      const rows: number[] = [];
      for (let j = start; j <= end; j++) {
        if (labels[j] >= 0 && Math.abs(score[j]) > 0.05) rows.push(j);
      }
      if (rows.length >= 40) {
        meta = fitLogistic(features, labels, rows, meta, lastFit < 0 ? 160 : 24, params.metaL2, featureCount);
        lastFit = i;
      }
    }
    metaProb[i] = predict(meta, features[i], featureCount);
    if (labels[i] >= 0) probs.push(metaProb[i]);
  }

  const confidence = new Array<number>(n).fill(0);
  const direction: ("long" | "short" | "flat")[] = new Array(n).fill("flat");
  for (let i = 0; i < n; i++) {
    const s = score[i];
    if (s > 0 && params.allowLong) direction[i] = "long";
    else if (s < 0 && params.allowShort) direction[i] = "short";
    else direction[i] = "flat";
    confidence[i] = clamp(
      params.metaWeight * metaProb[i] + (1 - params.metaWeight) * (0.5 + 0.5 * Math.abs(s)),
      0,
      1,
    );
  }

  // ---- trailing information coefficients for the attribution panel ----
  const alphaIc: Record<string, number> = {};
  for (let k = 0; k < m; k++) {
    const tail = Math.max(0, n - 800);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = tail; i < n; i++) {
      xs.push(rawScores[k][i]);
      ys.push(fwd[i]);
    }
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    alphaIc[models[k].key] = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }

  const tailStart = Math.floor(n * 0.3);
  const ic = correlationSafe(score.slice(tailStart), fwd.slice(tailStart));

  return {
    ind,
    regime,
    score,
    confidence,
    metaProb,
    direction,
    weights,
    dominant,
    alphaScores,
    alphaIc,
    infoCoefficient: ic,
    meta,
    featureNames: FEATURE_NAMES,
    labels,
    threshold: params.metaThreshold,
    bars: n,
  };
}

function correlationSafe(xs: number[], ys: number[]): number {
  const len = Math.min(xs.length, ys.length);
  const a = xs.slice(0, len);
  const b = ys.slice(0, len);
  const mx = mean(a);
  const my = mean(b);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < len; i++) {
    num += (a[i] - mx) * (b[i] - my);
    dx += (a[i] - mx) ** 2;
    dy += (b[i] - my) ** 2;
  }
  if (dx <= 0 || dy <= 0) return 0;
  return clamp(num / Math.sqrt(dx * dy), -1, 1);
}

/**
 * Win-rate targeting calibration on TRUE net R multiples.
 *
 * Signals are ranked by meta-model probability; the cut is the prefix that
 * maximises realised expectancy (sum of R) subject to the requested hit rate
 * and a minimum sample size. This is the exact quantity the engine will trade,
 * so the calibration cannot flatter itself.
 */
export function calibrateFromOutcomes(
  outcomes: number[],
  probs: number[],
  targetWinRate: number,
  minSamples: number,
): { threshold: number; expectedWinRate: number; expectancyR: number; samples: number } {
  const pairs: { p: number; r: number }[] = [];
  for (let i = 0; i < Math.min(outcomes.length, probs.length); i++) {
    if (Number.isFinite(outcomes[i])) pairs.push({ p: probs[i], r: outcomes[i] });
  }
  const fallback = { threshold: 0.5, expectedWinRate: 0.5, expectancyR: 0, samples: pairs.length };
  if (pairs.length < 30) return fallback;
  pairs.sort((a, b) => b.p - a.p);
  const floor = Math.max(20, Math.min(minSamples, Math.floor(pairs.length * 0.5)));
  // Pass 1: what is the best hit rate the signal population can actually deliver?
  let wins = 0;
  let maxWr = 0;
  for (let i = 0; i < pairs.length; i++) {
    wins += pairs[i].r > 0 ? 1 : 0;
    const count = i + 1;
    if (count < floor) continue;
    const wr = wins / count;
    if (wr > maxWr) maxWr = wr;
  }
  // If the requested hit rate is unreachable, aim for the highest achievable
  // rate minus a small margin instead of silently dropping the constraint.
  const goal = Math.min(targetWinRate, Math.max(0.3, maxWr - 0.015));

  let best: { threshold: number; expectedWinRate: number; expectancyR: number; samples: number } | null = null;
  let bestEdge = -Infinity;
  let alt: { threshold: number; expectedWinRate: number; expectancyR: number; samples: number } | null = null;
  let altEdge = -Infinity;
  wins = 0;
  let sumR = 0;
  for (let i = 0; i < pairs.length; i++) {
    wins += pairs[i].r > 0 ? 1 : 0;
    sumR += pairs[i].r;
    const count = i + 1;
    if (count < floor) continue;
    const wr = wins / count;
    if (sumR > altEdge) {
      altEdge = sumR;
      alt = { threshold: pairs[i].p, expectedWinRate: wr, expectancyR: sumR / count, samples: count };
    }
    if (wr >= goal && sumR > bestEdge) {
      bestEdge = sumR;
      best = { threshold: pairs[i].p, expectedWinRate: wr, expectancyR: sumR / count, samples: count };
    }
  }
  if (!best) return alt ?? fallback;
  return best;
}

/** Legacy binary-label calibration kept for the meta-labelling diagnostics. */
export function calibrateThreshold(
  labels: number[],
  probs: number[],
  targetWinRate: number,
  minSamples: number,
  rewardRiskRatio = 0.3,
): { threshold: number; expectedWinRate: number; samples: number } {
  const res = calibrateFromOutcomes(
    labels.map((y) => (y < 0 ? Number.NaN : y === 1 ? 0.3 : -1)),
    probs,
    targetWinRate,
    minSamples,
  );
  void rewardRiskRatio;
  return { threshold: res.threshold, expectedWinRate: res.expectedWinRate, samples: res.samples };
}

/** Compact per-bar signal view (used for the live engine and API payloads). */
export function tailSignals(ens: EnsembleResult, candles: Candle[], count: number): AlphaEnsembleBar[] {
  const n = candles.length;
  const start = Math.max(0, n - count);
  const out: AlphaEnsembleBar[] = [];
  for (let i = start; i < n; i++) {
    if (i < 260) continue;
    const votes: Record<string, number> = {};
    for (let k = 0; k < ALPHA_MODELS.length; k++) {
      votes[ALPHA_MODELS[k].key] = Number((ens.weights[i][k] * ens.alphaScores[ALPHA_MODELS[k].key][i]).toFixed(4));
    }
    out.push({
      index: i,
      ts: candles[i].ts,
      score: Number(ens.score[i].toFixed(4)),
      confidence: Number(ens.confidence[i].toFixed(4)),
      direction: ens.direction[i],
      metaProb: Number(ens.metaProb[i].toFixed(4)),
      regime: ens.regime[i],
      votes,
      weights: Object.fromEntries(
        ALPHA_MODELS.map((m2, k) => [m2.key, Number(ens.weights[i][k].toFixed(4))]),
      ),
    });
  }
  return out;
}

export function metaFeatureImportance(ens: EnsembleResult): { name: string; weight: number }[] {
  return ens.featureNames
    .map((name, i) => ({ name, weight: ens.meta.weights[i] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

export function ensembleHealth(ens: EnsembleResult) {
  const tail = ens.metaProb.slice(Math.floor(ens.bars * 0.4));
  return {
    metaAccuracy: ens.meta.accuracy,
    metaLogLoss: ens.meta.logLoss,
    metaSamples: ens.meta.samples,
    metaRefits: ens.meta.refits,
    probDispersion: stdev(tail),
    probMean: mean(tail),
    infoCoefficient: ens.infoCoefficient,
  };
}
