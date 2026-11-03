import type {
  BacktestMetrics,
  BacktestResult,
  Candle,
  EnsembleParams,
  MonteCarloReport,
  OptimizationTrialRecord,
  PboReport,
  RiskProfile,
  WalkForwardReport,
} from "./types";
import type { EnsembleResult } from "./ensemble";
import { calibrateFromOutcomes, labelsForParams, outcomesForParams } from "./ensemble";
import { runBacktest } from "./backtest";
import { combinations, clamp, mean, mulberry32, quantile, stdev, sum } from "./math";

export const PARAM_SPACE: {
  key: keyof EnsembleParams;
  lo: number;
  hi: number;
  integer?: boolean;
}[] = [
  { key: "confidenceFloor", lo: 0.05, hi: 0.55 },
  { key: "metaThreshold", lo: 0.5, hi: 0.95 },
  { key: "metaWeight", lo: 0.2, hi: 0.95 },
  { key: "regimeGate", lo: 0, hi: 1 },
  { key: "stopAtrMult", lo: 1.5, hi: 4.5 },
  { key: "targetAtrMult", lo: 0.45, hi: 1.8 },
  { key: "tp1Fraction", lo: 0.1, hi: 0.95 },
  { key: "trailAtrMult", lo: 0.4, hi: 4 },
  { key: "breakevenAtR", lo: 0.1, hi: 1.5 },
  { key: "timeStopBars", lo: 3, hi: 30, integer: true },
];

const DE_CONFIG = {
  population: 18,
  generations: 16,
  weightF: 0.72,
  crossoverRate: 0.9,
  minTrades: 100,
};

export interface ObjectiveWeights {
  targetWinRate: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  drawdown: number;
}

export const DEFAULT_OBJECTIVE: ObjectiveWeights = {
  targetWinRate: 0.85,
  winRate: 0.4,
  profitFactor: 0.28,
  expectancy: 0.2,
  drawdown: 0.12,
};

/**
 * Composite fitness anchored on the requested hit rate while penalising
 * drawdown and negative expectancy — a high win rate with negative expectancy
 * is the classic negative-skew trap, so the objective refuses it.
 */
export function objective(m: BacktestMetrics, w: ObjectiveWeights): number {
  if (m.trades < DE_CONFIG.minTrades) {
    // small samples are statistically meaningless: reject hard
    return -2 + m.trades / (DE_CONFIG.minTrades * 2);
  }
  // The hit-rate target is a CONSTRAINT, not a preference: a strategy that
  // misses it is heavily penalised, and meeting it only pays if the strategy is
  // actually profitable (positive expectancy and profit factor).
  const shortfall = Math.max(0, w.targetWinRate - m.winRate);
  // Meeting the target only pays when the edge is real: a 90% hit rate with a
  // 0.05 payoff is a fee-harvesting lottery and is treated as such.
  const credible = m.expectancyR > 0.025 && m.profitFactor > 1.05 && m.payoffRatio > 0.08;
  const wrGate = shortfall > 0 ? -3.2 * clamp(shortfall / 0.2, 0, 1.25) : credible ? 0.5 : -0.4;
  const pfScore = clamp((m.profitFactor - 1) / 1.1, -1.6, 1.8);
  const expScore = clamp(m.expectancyR / 0.12, -1.8, 2);
  const ddScore = clamp(m.maxDrawdown / -0.25, -1.5, 0);
  const degenerate = m.payoffRatio < 0.16 ? -1.4 : m.payoffRatio < 0.28 ? -0.35 : 0;
  const profitability =
    w.profitFactor * pfScore + w.expectancy * expScore + w.drawdown * ddScore;
  const sampleBonus = clamp(Math.log10(m.trades / DE_CONFIG.minTrades) / 2, 0, 0.4);
  return profitability + wrGate + sampleBonus + degenerate;
}

function decodeParams(vector: number[], base: EnsembleParams): EnsembleParams {
  const next: EnsembleParams = { ...base };
  PARAM_SPACE.forEach((dim, i) => {
    const raw = clamp(vector[i], dim.lo, dim.hi);
    next[dim.key] = (dim.integer ? Math.round(raw) : raw) as never;
  });
  return next;
}

export interface OptimizerOptions {
  candles: Candle[];
  ens: EnsembleResult;
  risk: RiskProfile;
  base: EnsembleParams;
  trainStart: number;
  trainEnd: number;
  weights?: ObjectiveWeights;
  deadlineMs?: number;
  seed?: number;
}

export interface OptimizerResult {
  best: EnsembleParams;
  bestObjective: number;
  bestMetrics: BacktestMetrics;
  trials: OptimizationTrialRecord[];
  generations: number;
  evaluations: number;
  threshold: number;
}

/**
 * Differential evolution over the parameter manifold, evaluated strictly on the
 * in-sample window. The entry threshold is recalibrated for every candidate so
 * the meta-model cut is never optimised on out-of-sample information.
 */
export function optimizeEnsemble(opts: OptimizerOptions): OptimizerResult {
  const { candles, ens, risk, base, trainStart, trainEnd } = opts;
  const weights = opts.weights ?? DEFAULT_OBJECTIVE;
  const dims = PARAM_SPACE.length;
  const rng = mulberry32(opts.seed ?? 0x5eed1);
  const deadline = opts.deadlineMs ?? Number.MAX_SAFE_INTEGER;
  const pop = DE_CONFIG.population;
  const bounds = PARAM_SPACE.map((d) => [d.lo, d.hi] as const);

  let population: number[][] = [];
  const trials: OptimizationTrialRecord[] = [];
  let evaluations = 0;
  let generations = 0;
  let best: { vector: number[]; obj: number; params: EnsembleParams; metrics: BacktestMetrics; threshold: number } | null = null;

  const evaluate = (params: EnsembleParams) => {
    const cal = calibrateThresholdRange({
      ens,
      candles,
      params,
      from: trainStart,
      to: trainEnd,
      targetWinRate: weights.targetWinRate,
      minSamples: 150,
    });
    const res = runBacktest({
      candles,
      ens,
      risk,
      params,
      start: trainStart,
      end: trainEnd,
      metaThreshold: cal.threshold,
    });
    const obj = objective(res.metrics, weights);
    evaluations++;
    return { obj, res, threshold: cal.threshold };
  };

  // --- seed the population with the base configuration plus latin-ish spread --
  const baseVector = PARAM_SPACE.map((d) => Number(base[d.key]));
  population.push(baseVector.slice());
  for (let i = 1; i < pop; i++) {
    const v: number[] = [];
    for (let d = 0; d < dims; d++) {
      const jitter = rng() < 0.25 ? 0 : (rng() - 0.5) * 0.4;
      v.push(clamp(baseVector[d] + jitter * (bounds[d][1] - bounds[d][0]), bounds[d][0], bounds[d][1]));
    }
    population.push(v);
  }

  for (let gen = 0; gen < DE_CONFIG.generations; gen++) {
    if (Date.now() > deadline) break;
    const scored: { vector: number[]; obj: number; params: EnsembleParams; metrics: BacktestMetrics; threshold: number }[] = [];
    for (let i = 0; i < population.length; i++) {
      const params = decodeParams(population[i], base);
      const { obj, res, threshold } = evaluate(params);
      scored.push({ vector: population[i], obj, params, metrics: res.metrics, threshold });
      trials.push({
        iteration: gen,
        stage: gen === 0 ? "population" : "mutation",
        params,
        objective: obj,
        winRate: res.metrics.winRate,
        profitFactor: res.metrics.profitFactor,
        netReturn: res.metrics.netReturn,
        maxDrawdown: res.metrics.maxDrawdown,
        tradeCount: res.metrics.trades,
      });
      if (!best || obj > best.obj) best = { ...scored[scored.length - 1] };
    }
    generations = gen + 1;

    const sorted = scored.slice().sort((a, b) => b.obj - a.obj);
    const nextGen: number[][] = sorted.slice(0, 2).map((s) => s.vector.slice());
    while (nextGen.length < pop) {
      const a = scored[Math.floor(rng() * scored.length)].vector;
      const b = scored[Math.floor(rng() * scored.length)].vector;
      const c = scored[Math.floor(rng() * scored.length)].vector;
      const target = scored[Math.floor(rng() * scored.length)].vector;
      const mutant: number[] = new Array(dims);
      const forced = Math.floor(rng() * dims);
      for (let d = 0; d < dims; d++) {
        const diff = a[d] + DE_CONFIG.weightF * (b[d] - c[d]);
        mutant[d] = rng() < DE_CONFIG.crossoverRate || d === forced ? diff : target[d];
        mutant[d] = clamp(mutant[d], bounds[d][0], bounds[d][1]);
      }
      nextGen.push(mutant);
    }
    population = nextGen;
  }

  if (!best) {
    const cal = calibrateThresholdRange({ ens, candles, params: base, from: trainStart, to: trainEnd, targetWinRate: weights.targetWinRate });
    const res = runBacktest({ candles, ens, risk, params: base, start: trainStart, end: trainEnd, metaThreshold: cal.threshold });
    best = { vector: baseVector, obj: objective(res.metrics, weights), params: base, metrics: res.metrics, threshold: cal.threshold };
  }

  return {
    best: best.params,
    bestObjective: best.obj,
    bestMetrics: best.metrics,
    trials: trials
      .sort((a, b) => b.objective - a.objective)
      .slice(0, 240)
      .map((t, i) => ({ ...t, iteration: i })),
    generations,
    evaluations,
    threshold: best.threshold,
  };
}

/**
 * Threshold calibration restricted to a bar range (no out-of-sample leakage).
 * Labels are re-derived from the candidate's own exit geometry so the cut is
 * always consistent with the stops that will actually be traded.
 */
export interface CalibrationResult {
  threshold: number;
  expectedWinRate: number;
  expectancyR: number;
  samples: number;
}

/**
 * Threshold calibration restricted to a bar range (no out-of-sample leakage).
 * Outcomes are re-simulated with the candidate's own exit ladder so the cut is
 * always consistent with the stops the engine will actually trade.
 */
export function calibrateThresholdRange(args: {
  ens: EnsembleResult;
  candles: Candle[];
  params: EnsembleParams;
  from: number;
  to: number;
  targetWinRate: number;
  minSamples?: number;
}): CalibrationResult {
  const { ens, candles, params, from, to, targetWinRate } = args;
  const outcomes = outcomesForParams(candles, ens.ind, ens.score, params);
  const rs: number[] = [];
  const probs: number[] = [];
  for (let i = from; i < Math.min(to, outcomes.length); i++) {
    if (Number.isFinite(outcomes[i]) && Math.abs(ens.score[i]) > 0.04) {
      rs.push(outcomes[i]);
      probs.push(ens.metaProb[i]);
    }
  }
  const res = calibrateFromOutcomes(rs, probs, targetWinRate, args.minSamples ?? 60);
  return { ...res, threshold: clamp(res.threshold, 0.5, 0.995) };
}

/* ------------------------------ walk forward ------------------------------- */

export interface WalkForwardOptions {
  candles: Candle[];
  ens: EnsembleResult;
  risk: RiskProfile;
  params: EnsembleParams;
  start: number;
  end: number;
  folds: number;
  targetWinRate: number;
  purgeBars?: number;
}

export function walkForward(opts: WalkForwardOptions): WalkForwardReport {
  const { candles, ens, risk, params, start, end, folds, targetWinRate } = opts;
  const purge = opts.purgeBars ?? Math.max(3, params.timeStopBars + 6);
  const span = end - start;
  const testSize = Math.floor(span / folds);
  const out: WalkForwardReport = {
    anchored: true,
    folds: [],
    aggregatedWinRate: 0,
    aggregatedProfitFactor: 0,
    aggregatedReturn: 0,
    aggregateSharpe: 0,
    consistency: 0,
    degradationScore: 0,
    oosWinRate: 0,
    oosProfitFactor: 0,
    oosExpectancyR: 0,
  };
  const pooled: BacktestResult[] = [];
  for (let k = 0; k < folds; k++) {
    const testStart = start + k * testSize;
    const testEnd = k === folds - 1 ? end : testStart + testSize;
    const trainEnd = Math.max(start + 40, testStart - purge);
    const cal = calibrateThresholdRange({ ens, candles, params, from: start, to: trainEnd, targetWinRate });
    const train = runBacktest({
      candles,
      ens,
      risk,
      params,
      start,
      end: trainEnd,
      metaThreshold: cal.threshold,
    });
    const test = runBacktest({
      candles,
      ens,
      risk,
      params,
      start: testStart,
      end: testEnd,
      metaThreshold: cal.threshold,
    });
    pooled.push(test);
    const trainScore = train.metrics.expectancyR;
    const testScore = test.metrics.expectancyR;
    out.folds.push({
      fold: k + 1,
      trainStart: start,
      trainEnd: trainEnd,
      testStart,
      testEnd,
      trainMetrics: train.metrics,
      testMetrics: test.metrics,
      degradation: trainScore !== 0 ? (testScore - trainScore) / Math.abs(trainScore) : 0,
    });
  }
  const allTrades = pooled.flatMap((p) => p.trades);
  const wins = allTrades.filter((t) => t.netPnl > 0);
  const gp = sum(wins.map((t) => t.netPnl));
  const gl = Math.abs(sum(allTrades.filter((t) => t.netPnl <= 0).map((t) => t.netPnl)));
  out.aggregatedWinRate = allTrades.length ? wins.length / allTrades.length : 0;
  out.aggregatedProfitFactor = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
  out.aggregatedReturn = pooled.reduce((acc, p) => acc * (1 + p.metrics.netReturn), 1) - 1;
  const sharpes = pooled.map((p) => p.metrics.sharpe).filter((s) => Number.isFinite(s));
  out.aggregateSharpe = sharpes.length ? mean(sharpes) : 0;
  const profitableFolds = pooled.filter((p) => p.metrics.netProfit > 0).length;
  out.consistency = pooled.length ? profitableFolds / pooled.length : 0;
  const degs = out.folds.map((f) => f.degradation);
  out.degradationScore = degs.length ? mean(degs) : 0;
  out.oosWinRate = out.aggregatedWinRate;
  out.oosProfitFactor = out.aggregatedProfitFactor;
  out.oosExpectancyR = allTrades.length ? mean(allTrades.map((t) => t.rMultiple)) : 0;
  return out;
}

/* ------------------------- Monte Carlo block bootstrap -------------------- */

export interface MonteCarloOptions {
  result: BacktestResult;
  iterations?: number;
  blockSize?: number;
  initialEquity: number;
  riskPerTrade: number;
  targetWinRate: number;
  seed?: number;
}

export function monteCarloBootstrap(opts: MonteCarloOptions): MonteCarloReport {
  const rs = opts.result.trades.map((t) => t.rMultiple);
  const iterations = opts.iterations ?? 800;
  const blockSize = Math.max(1, opts.blockSize ?? Math.min(8, Math.max(2, Math.floor(rs.length / 40))));
  const empty: MonteCarloReport = {
    iterations: 0,
    blockSize,
    percentiles: { p05: [], p25: [], p50: [], p75: [], p95: [] },
    finalReturnPercentiles: { p05: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
    drawdownPercentiles: { p50: 0, p95: 0, p99: 0, worst: 0 },
    riskOfRuin: 0,
    probLoss: 0,
    probTargetWinRate: 0,
    medianTimeToDouble: 0,
  };
  if (rs.length < 12) return empty;
  const rng = mulberry32(opts.seed ?? 0xbeef);
  const finals: number[] = [];
  const dds: number[] = [];
  const doubles: number[] = [];
  let ruin = 0;
  let losses = 0;
  let hitTarget = 0;
  const steps = Math.min(rs.length, 160);
  const stride = Math.max(1, Math.floor(rs.length / steps));
  const sampleIdx: number[][] = [];
  for (let s = 0; s < steps; s++) sampleIdx.push([]);

  for (let it = 0; it < iterations; it++) {
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    let wins = 0;
    let doubledAt = -1;
    let ruined = false;
    for (let i = 0; i < rs.length; i++) {
      const blockIdx = Math.floor(rng() * Math.max(1, rs.length - blockSize));
      const r = rs[blockIdx + Math.floor(rng() * blockSize)] ?? rs[blockIdx];
      equity *= 1 + opts.riskPerTrade * r;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? equity / peak - 1 : 0;
      if (dd < maxDd) maxDd = dd;
      if (r > 0) wins++;
      if (doubledAt < 0 && equity >= 2) doubledAt = i + 1;
      if (!ruined && equity < 0.7) ruined = true;
      const si = Math.min(steps - 1, Math.floor(i / stride));
      sampleIdx[si].push(equity);
    }
    finals.push(equity);
    dds.push(maxDd);
    if (ruined) ruin++;
    if (equity < 1) losses++;
    if (wins / rs.length >= opts.targetWinRate) hitTarget++;
    if (doubledAt > 0) doubles.push(doubledAt);
  }

  const percentiles = {
    p05: sampleIdx.map((s) => quantile(s, 0.05)),
    p25: sampleIdx.map((s) => quantile(s, 0.25)),
    p50: sampleIdx.map((s) => quantile(s, 0.5)),
    p75: sampleIdx.map((s) => quantile(s, 0.75)),
    p95: sampleIdx.map((s) => quantile(s, 0.95)),
  };
  return {
    iterations,
    blockSize,
    percentiles,
    finalReturnPercentiles: {
      p05: quantile(finals, 0.05) - 1,
      p25: quantile(finals, 0.25) - 1,
      p50: quantile(finals, 0.5) - 1,
      p75: quantile(finals, 0.75) - 1,
      p95: quantile(finals, 0.95) - 1,
    },
    drawdownPercentiles: {
      p50: quantile(dds, 0.5),
      p95: quantile(dds, 0.95),
      p99: quantile(dds, 0.99),
      worst: Math.min(...dds),
    },
    riskOfRuin: ruin / iterations,
    probLoss: losses / iterations,
    probTargetWinRate: hitTarget / iterations,
    medianTimeToDouble: doubles.length ? quantile(doubles, 0.5) : 0,
  };
}

/* --------------------------- CSCV / probability of ------------------------- */
/* --------------------- backtest overfitting (Bailey 2014) ------------------ */

export interface PboOptions {
  /** per-bar return series for every candidate configuration */
  returnSeries: number[][];
  blocks?: number;
}

export function cscvPbo(opts: PboOptions): PboReport {
  const series = opts.returnSeries.filter((s) => s.length > 60);
  const S = opts.blocks ?? 8;
  if (series.length < 2) {
    return {
      blocks: S,
      combinations: 0,
      pbo: 0,
      logitMean: 0,
      oosRankCorrelation: 0,
      verdict: "insufficient candidates",
    };
  }
  const len = Math.min(...series.map((s) => s.length));
  const trimmed = series.map((s) => s.slice(s.length - len));
  const blockSize = Math.floor(len / S);
  if (blockSize < 12) {
    return {
      blocks: S,
      combinations: 0,
      pbo: 0,
      logitMean: 0,
      oosRankCorrelation: 0,
      verdict: "insufficient sample",
    };
  }
  const blocksOf = trimmed.map((s) => {
    const out: number[][] = [];
    for (let b = 0; b < S; b++) out.push(s.slice(b * blockSize, (b + 1) * blockSize));
    return out;
  });
  const sharpeOf = (rets: number[]) => {
    const sd = stdev(rets);
    return sd > 0 ? (mean(rets) / sd) * Math.sqrt(252) : 0;
  };

  const combos = combinations(S, S / 2);
  const logits: number[] = [];
  const isRanks: number[] = [];
  const oosRanks: number[] = [];
  const nStrat = trimmed.length;

  for (const trainIdx of combos) {
    const testIdx: number[] = [];
    for (let b = 0; b < S; b++) if (!trainIdx.includes(b)) testIdx.push(b);
    const isScores: number[] = [];
    const oosScores: number[] = [];
    for (let k = 0; k < nStrat; k++) {
      const trainRets: number[] = [];
      const testRets: number[] = [];
      for (const b of trainIdx) trainRets.push(...blocksOf[k][b]);
      for (const b of testIdx) testRets.push(...blocksOf[k][b]);
      isScores.push(sharpeOf(trainRets));
      oosScores.push(sharpeOf(testRets));
    }
    let bestIs = 0;
    for (let k = 1; k < nStrat; k++) if (isScores[k] > isScores[bestIs]) bestIs = k;
    // relative OOS rank of the in-sample winner
    let beaten = 0;
    for (let k = 0; k < nStrat; k++) if (oosScores[k] < oosScores[bestIs]) beaten++;
    // relative OOS rank of the in-sample winner: 1.0 = also best out of sample
    const omega = clamp((beaten + 0.5) / nStrat, 0.02, 0.98);
    logits.push(Math.log(omega / (1 - omega)));
    isRanks.push(isScores[bestIs]);
    oosRanks.push(oosScores[bestIs]);
  }

  const pbo = logits.length ? logits.filter((l) => l <= 0).length / logits.length : 0;
  const verdict =
    pbo < 0.2
      ? "robust — low overfitting probability"
      : pbo < 0.45
        ? "acceptable — moderate selection bias"
        : pbo < 0.65
          ? "fragile — significant selection bias"
          : "overfit — results are likely noise";
  return {
    blocks: S,
    combinations: combos.length,
    pbo,
    logitMean: mean(logits),
    oosRankCorrelation: isRanks.length > 3 ? rankCor(isRanks, oosRanks) : 0,
    verdict,
  };
}

function rankCor(xs: number[], ys: number[]): number {
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array<number>(arr.length);
    for (let i = 0; i < idx.length; i++) out[idx[i].i] = i + 1;
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/** Per-bar return series of a backtest, used for the CSCV matrix. */
export function returnSeriesOf(result: BacktestResult): number[] {
  const out: number[] = [];
  for (let i = 1; i < result.equityCurve.length; i++) {
    const prev = result.equityCurve[i - 1].equity;
    out.push(prev > 0 ? result.equityCurve[i].equity / prev - 1 : 0);
  }
  return out;
}
