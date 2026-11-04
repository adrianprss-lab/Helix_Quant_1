import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { backtestRuns, backtestTrades, optimizationTrials, paperAccounts, paperPositions, signals as signalsTable } from "@/db/schema";
import type {
  BacktestMetrics,
  BacktestResult,
  Candle,
  EnsembleParams,
  PipelineResult,
  RiskProfile,
  SignalCandidate,
  StrategyAttribution,
  Trade,
} from "./types";
import type { Timeframe } from "./data";
import { BARS_PER_DAY, loadSeries } from "./data";
import { DEFAULT_PARAMS, buildEnsemble, ensembleHealth, metaFeatureImportance } from "./ensemble";
import { runBacktest } from "./backtest";
import { calibrateThresholdRange } from "./research";
import {
  DEFAULT_OBJECTIVE,
  cscvPbo,
  monteCarloBootstrap,
  optimizeEnsemble,
  returnSeriesOf,
  walkForward,
} from "./research";
import { withDeflatedSharpe } from "./metrics";
import { ALPHA_MODELS, ALPHA_REGISTRY } from "./strategies";
import { clamp, stdev } from "./math";

export type PresetKey =
  | "apex_hit_rate"
  | "balanced_core"
  | "regime_trend"
  | "micro_scalper"
  | "gold_daily_swing"
  | "capital_defense";

export interface PresetDefinition {
  key: PresetKey;
  name: string;
  tagline: string;
  description: string;
  params: EnsembleParams;
  risk: RiskProfile;
  targetWinRate: number;
}

const BASE_RISK: RiskProfile = {
  barsPerDay: 24,
  initialEquity: 100_000,
  riskPerTrade: 0.0075,
  maxLeverage: 3,
  maxConcurrentPositions: 3,
  targetVol: 0.5,
  kellyFraction: 0.35,
  dailyLossLimit: 0.035,
  takerFeeBps: 4,
  makerFeeBps: 1.5,
  slippageBps: 2.5,
};

export const PRESETS: Record<PresetKey, PresetDefinition> = {
  apex_hit_rate: {
    key: "apex_hit_rate",
    name: "APEX HIT-RATE",
    tagline: "Meta-labelled mean reversion stack, engineered for ≥ 85% hit rate",
    description:
      "Mean-reversion dominant ensemble with an asymmetric exit ladder (0.6 ATR target vs 2.6 ATR stop), a 9-bar time stop and a logistic meta-label filter calibrated to the requested hit rate. Expect negative skew: many small wins, rare larger losses.",
    targetWinRate: 0.86,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.14,
      metaThreshold: 0.68,
      metaWeight: 0.72,
      regimeGate: 0.8,
      stopAtrMult: 2.0,
      targetAtrMult: 0.9,
      tp1Fraction: 0.5,
      trailAtrMult: 1.8,
      breakevenAtR: 0.6,
      timeStopBars: 7,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.007, targetVol: 0.45, maxConcurrentPositions: 3 },
  },
  balanced_core: {
    key: "balanced_core",
    name: "BALANCED CORE",
    tagline: "Equal-weight blend of reversion, trend and statistical alpha",
    description:
      "Volatility targeted blend across all fourteen alpha models with adaptive information-coefficient weighting. Symmetric exits, medium holding period.",
    targetWinRate: 0.62,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.2,
      metaThreshold: 0.6,
      metaWeight: 0.55,
      stopAtrMult: 1.9,
      targetAtrMult: 1.25,
      tp1Fraction: 0.4,
      trailAtrMult: 1.8,
      timeStopBars: 16,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.009, targetVol: 0.55, maxConcurrentPositions: 4 },
  },
  regime_trend: {
    key: "regime_trend",
    name: "REGIME TREND RIDER",
    tagline: "Momentum/breakout stack that only fires in persistent regimes",
    description:
      "Gated to trending and expansion regimes. Wide targets, chandelier-style trailing exits, ADX/Hurst confirmation on every entry.",
    targetWinRate: 0.48,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.26,
      metaThreshold: 0.56,
      metaWeight: 0.45,
      regimeGate: 0.95,
      stopAtrMult: 2.1,
      targetAtrMult: 2.4,
      tp1Fraction: 0.3,
      trailAtrMult: 2.6,
      breakevenAtR: 0.9,
      timeStopBars: 28,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.011, targetVol: 0.65, maxConcurrentPositions: 2 },
  },
  micro_scalper: {
    key: "micro_scalper",
    name: "MICROSTRUCTURE SCALPER",
    tagline: "Sub-5-bar auction scalps with an extreme hit rate",
    description:
      "Pattern + VWAP + StochRSI micro-scalps. Takes 0.4 ATR very quickly and cuts on a 2-bar time stop. Highest win rate, thinnest edge per trade, most sensitive to fees.",
    targetWinRate: 0.88,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.1,
      metaThreshold: 0.7,
      metaWeight: 0.78,
      regimeGate: 0.85,
      stopAtrMult: 2.4,
      targetAtrMult: 0.55,
      tp1Fraction: 0.6,
      trailAtrMult: 1.3,
      breakevenAtR: 0.4,
      timeStopBars: 4,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.005, targetVol: 0.35, maxConcurrentPositions: 5, takerFeeBps: 2 },
  },
  gold_daily_swing: {
    key: "gold_daily_swing",
    name: "GOLD DAILY SWING",
    tagline: "Für XAUUSD 1d: Trend-following Swings mit weiten Stops, tiefem Meta-Gate",
    description:
      "Auf Tages-Charts tragen Trend- und Breakout-Modelle am zuverlässigsten. Dieses Preset gibt Trades deshalb Luft: weiter Stop, gestaffelter Ausstieg über Tage, niedriges Kosten/Edge-Verhältnis. Entstanden aus deinem Befund, dass Gold 1d der einzige stabile Lauf war.",
    targetWinRate: 0.68,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.16,
      metaThreshold: 0.6,
      metaWeight: 0.5,
      regimeGate: 0.55,
      stopAtrMult: 2.4,
      targetAtrMult: 1.7,
      tp1Fraction: 0.4,
      trailAtrMult: 2.4,
      breakevenAtR: 0.8,
      timeStopBars: 40,
      weightWindow: 220,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.01, targetVol: 0.3, kellyFraction: 0.3, maxConcurrentPositions: 2 },
  },
  capital_defense: {
    key: "capital_defense",
    name: "CAPITAL DEFENSE",
    tagline: "Ultra-conservative, drawdown first, hit rate second",
    description:
      "Small size, hard daily circuit breaker, very selective meta threshold. Optimised for capital preservation and smooth equity.",
    targetWinRate: 0.72,
    params: {
      ...DEFAULT_PARAMS,
      confidenceFloor: 0.3,
      metaThreshold: 0.74,
      metaWeight: 0.8,
      regimeGate: 0.9,
      stopAtrMult: 1.7,
      targetAtrMult: 0.8,
      tp1Fraction: 0.5,
      trailAtrMult: 1.3,
      timeStopBars: 12,
    },
    risk: { ...BASE_RISK, riskPerTrade: 0.004, targetVol: 0.25, kellyFraction: 0.2, dailyLossLimit: 0.015, maxConcurrentPositions: 2 },
  },
};

export interface PipelineRequest {
  ticker: string;
  timeframe: Timeframe;
  bars: number;
  preset: PresetKey;
  targetWinRate: number;
  optimize: boolean;
  walkForward: boolean;
  monteCarlo: boolean;
  preferLive: boolean;
  budgetMs?: number;
}

export function normaliseRequest(raw: Partial<PipelineRequest>): PipelineRequest {
  const preset = (raw.preset && PRESETS[raw.preset] ? raw.preset : "apex_hit_rate") as PresetKey;
  const timeframe: Timeframe = (["15m", "1h", "4h", "1d"] as const).includes(raw.timeframe as Timeframe)
    ? (raw.timeframe as Timeframe)
    : "1h";
  return {
    ticker: raw.ticker ?? "BTCUSDT",
    timeframe,
    bars: clamp(Math.round(Number(raw.bars ?? 3000)), 600, 5000),
    preset,
    targetWinRate: clamp(Number(raw.targetWinRate ?? PRESETS[preset].targetWinRate), 0.35, 0.97),
    optimize: raw.optimize !== false,
    walkForward: raw.walkForward !== false,
    monteCarlo: raw.monteCarlo !== false,
    preferLive: raw.preferLive !== false,
    budgetMs: clamp(Number(raw.budgetMs ?? 42_000), 5_000, 120_000),
  };
}

function trimTrades(trades: Trade[], limit = 260): Trade[] {
  if (trades.length <= limit) return trades;
  const step = trades.length / limit;
  const out: Trade[] = [];
  for (let i = 0; i < limit; i++) out.push(trades[Math.floor(i * step)]);
  return out;
}

function trimCurve(curve: BacktestResult["equityCurve"], limit = 420): BacktestResult["equityCurve"] {
  if (curve.length <= limit) return curve;
  const step = curve.length / limit;
  const out: BacktestResult["equityCurve"] = [];
  for (let i = 0; i < limit; i++) {
    const p = curve[Math.floor(i * step)];
    out.push({
      ...p,
      equity: Math.round(p.equity * 100) / 100,
      drawdown: Math.round(p.drawdown * 1e6) / 1e6,
      benchmark: Math.round(p.benchmark * 100) / 100,
      exposure: Math.round(p.exposure * 1000) / 1000,
    });
  }
  return out;
}

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult & { runId: number }> {
  const t0 = Date.now();
  const preset = PRESETS[req.preset];
  const deadline = t0 + (req.budgetMs ?? 42_000);
  const series = await loadSeries(req.ticker, req.timeframe, req.bars, req.preferLive);
  const candles = series.candles;
  const barsPerDay = BARS_PER_DAY[req.timeframe];
  const risk: RiskProfile = { ...preset.risk, barsPerDay };
  let params: EnsembleParams = { ...preset.params };

  const diagnostics: string[] = [
    `Data source: ${series.source} (${candles.length} bars, ${req.timeframe})`,
    `Preset: ${preset.name} — target hit rate ${(req.targetWinRate * 100).toFixed(1)}%`,
  ];

  const ens = buildEnsemble(candles, params, req.timeframe);
  const warmup = Math.min(candles.length - 60, Math.max(240, Math.floor(candles.length * 0.06)));
  const tradableSpan = candles.length - warmup;
  const inSampleEnd = warmup + Math.floor(tradableSpan * 0.62);
  diagnostics.push(
    `Ensemble: ${ALPHA_MODELS.length} alpha models, adaptive IC weighting, meta classifier refit ${ens.meta.refits}× on ${ens.meta.samples} labels`,
  );

  // ---------------------------------------------------------------- optimisation
  let optTrials: PipelineResult["optimization"]["trials"] = [];
  let generations = 0;
  let evaluations = 0;
  let bestObjective = 0;
  if (req.optimize && tradableSpan > 500) {
    const opt = optimizeEnsemble({
      candles,
      ens,
      risk,
      base: params,
      trainStart: warmup,
      trainEnd: inSampleEnd,
      weights: { ...DEFAULT_OBJECTIVE, targetWinRate: req.targetWinRate },
      deadlineMs: deadline - 4_000,
      seed: 0x5eed1,
    });
    params = opt.best;
    generations = opt.generations;
    evaluations = opt.evaluations;
    bestObjective = opt.bestObjective;
    optTrials = opt.trials.slice(0, 120);
    diagnostics.push(
      `Differential evolution: ${evaluations} evaluations across ${generations} generations, best fitness ${opt.bestObjective.toFixed(4)}`,
    );
  }

  // ------------------------------------------------------------- final assembly
  // The entry threshold is calibrated exclusively on the in-sample window, with
  // labels re-derived from the final exit geometry, and then applied unchanged
  // to both the full sample and the untouched hold-out segment.
  const calibration = calibrateThresholdRange({
    ens,
    candles,
    params,
    from: warmup,
    to: inSampleEnd,
    targetWinRate: req.targetWinRate,
    minSamples: 140,
  });
  const threshold = clamp(calibration.threshold, 0.5, 0.99);
  params = { ...params, metaThreshold: threshold };
  const inSampleResult = runBacktest({
    candles,
    ens,
    risk,
    params,
    start: warmup,
    end: candles.length,
    metaThreshold: threshold,
  });
  const holdoutResult = runBacktest({
    candles,
    ens,
    risk,
    params,
    start: warmup,
    end: inSampleEnd,
    metaThreshold: threshold,
  });
  diagnostics.push(
    `Entry threshold calibrated at P(win) ≥ ${(threshold * 100).toFixed(1)}% — simulated hit rate ${(calibration.expectedWinRate * 100).toFixed(1)}%, expectancy ${calibration.expectancyR.toFixed(3)}R across ${calibration.samples} candidate signals`,
  );
  diagnostics.push(
    `Calibration segment: ${holdoutResult.metrics.trades} trades, hit rate ${(holdoutResult.metrics.winRate * 100).toFixed(1)}%, profit factor ${holdoutResult.metrics.profitFactor.toFixed(2)}`,
  );

  // --------------------------------------------------------------- hold-out run
  const outOfSample = runBacktest({
    candles,
    ens,
    risk,
    params,
    start: inSampleEnd,
    end: candles.length,
    metaThreshold: threshold,
  });

  // --------------------------------------------------------------- walk-forward
  const wfReport = req.walkForward
    ? walkForward({
        candles,
        ens,
        risk,
        params,
        start: warmup,
        end: candles.length,
        folds: Math.min(6, Math.max(3, Math.floor(tradableSpan / 320))),
        targetWinRate: req.targetWinRate,
      })
    : null;
  if (wfReport) {
    diagnostics.push(
      `Anchored walk-forward: ${wfReport.folds.length} folds, OOS hit rate ${(wfReport.oosWinRate * 100).toFixed(1)}%, PF ${wfReport.oosProfitFactor.toFixed(2)}, fold consistency ${(wfReport.consistency * 100).toFixed(0)}%`,
    );
  }

  // ---------------------------------------------------------------- monte carlo
  const mcReport = req.monteCarlo
    ? monteCarloBootstrap({
        result: inSampleResult,
        iterations: 900,
        initialEquity: risk.initialEquity,
        riskPerTrade: risk.riskPerTrade,
        targetWinRate: req.targetWinRate,
        seed: 0xa17e,
      })
    : null;

  // ------------------------------------------------- CSCV / deflated Sharpe ratio
  let pboReport = null;
  let varianceOfSharpe = 0.0004;
  let trialCount = 1;
  if (req.optimize && optTrials.length >= 4) {
    const candidates: number[][] = [returnSeriesOf(inSampleResult)];
    const tradeSharpes: number[] = (() => {
      const rs = inSampleResult.trades.map((t) => t.rMultiple);
      const sd = stdev(rs);
      return [sd > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length / sd : 0];
    })();
    const uniqueParams = new Set<string>();
    // Stratified sample across the whole fitness distribution (best, median,
    // worst) so the CSCV rank test compares genuinely different configurations
    // instead of near-duplicates, which would inflate the PBO mechanically.
    const ordered = optTrials.slice().sort((a, b) => b.objective - a.objective);
    const picked: typeof ordered = [];
    for (let i = 0; i < ordered.length && picked.length < 9; i++) {
      const idx = Math.round((i * (ordered.length - 1)) / 8);
      picked.push(ordered[idx]);
    }
    for (const trial of picked) {
      const key = JSON.stringify(trial.params);
      if (uniqueParams.has(key)) continue;
      if (candidates.length >= 9) break;
      uniqueParams.add(key);
      const res = runBacktest({
        candles,
        ens,
        risk,
        params: trial.params,
        start: warmup,
        end: candles.length,
        metaThreshold: trial.params.metaThreshold,
      });
      if (res.metrics.trades >= 25) {
        candidates.push(returnSeriesOf(res));
        const rs = res.trades.map((t) => t.rMultiple);
        const sd = stdev(rs);
        tradeSharpes.push(sd > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length / sd : 0);
      }
    }
    if (candidates.length >= 3) {
      // All Sharpe statistics are expressed in PER-TRADE units so that the
      // deflation term and the observed Sharpe live on the same scale.
      const sharpes = candidates.map((s) => {
        const sd = stdev(s);
        return sd > 0 ? s.reduce((a, b) => a + b, 0) / s.length / sd : 0;
      });
      sharpes.push(...tradeSharpes);
      varianceOfSharpe = Math.max(1e-6, stdev(sharpes) ** 2);
      trialCount = candidates.length;
      pboReport = cscvPbo({ returnSeries: candidates, blocks: 8 });
      diagnostics.push(
        `CSCV overfitting audit: ${pboReport.combinations} block combinations, PBO ${(pboReport.pbo * 100).toFixed(1)}% — ${pboReport.verdict}`,
      );
    }
  }
  trialCount = Math.max(trialCount, evaluations || 1);

  const finalMetrics = withDeflatedSharpe(
    inSampleResult.metrics,
    inSampleResult.trades,
    trialCount,
    varianceOfSharpe,
  );
  const oosMetrics = withDeflatedSharpe(outOfSample.metrics, outOfSample.trades, trialCount, varianceOfSharpe);

  const attribution: StrategyAttribution[] = inSampleResult.attribution;
  const health = ensembleHealth(ens);
  diagnostics.push(
    `Meta classifier: accuracy ${(health.metaAccuracy * 100).toFixed(1)}%, log-loss ${health.metaLogLoss.toFixed(3)}, ensemble IC ${health.infoCoefficient.toFixed(3)}`,
  );
  if (finalMetrics.winRate < req.targetWinRate) {
    diagnostics.push(
      `Hit-rate shortfall: realised ${(finalMetrics.winRate * 100).toFixed(1)}% vs target ${(req.targetWinRate * 100).toFixed(1)}%. The engine refuses to loosen stops to buy win rate at the cost of expectancy — raise the target or accept the honest number.`,
    );
  } else {
    diagnostics.push(
      `Target achieved: ${(finalMetrics.winRate * 100).toFixed(1)}% realised hit rate with expectancy ${finalMetrics.expectancyR.toFixed(3)}R and payoff ${finalMetrics.payoffRatio.toFixed(2)}.`,
    );
  }

  const result: PipelineResult & { runId: number } = {
    runId: 0,
    label: `${preset.name} · ${req.ticker} ${req.timeframe}`,
    ticker: req.ticker,
    timeframe: req.timeframe,
    dataSource: series.source,
    preset: req.preset,
    bars: candles.length,
    candles: candles.slice(-260),
    params,
    risk,
    inSample: {
      ...inSampleResult,
      metrics: finalMetrics,
      trades: trimTrades(inSampleResult.trades),
      equityCurve: trimCurve(inSampleResult.equityCurve),
    },
    outOfSample: {
      ...outOfSample,
      metrics: oosMetrics,
      trades: trimTrades(outOfSample.trades, 120),
      equityCurve: trimCurve(outOfSample.equityCurve, 200),
    },
    walkForward: wfReport,
    monteCarlo: mcReport,
    pbo: pboReport,
    optimization: {
      enabled: req.optimize,
      trials: optTrials,
      bestObjective,
      generations,
      evaluations,
    },
    targetWinRate: req.targetWinRate,
    achievedWinRate: finalMetrics.winRate,
    durationMs: Date.now() - t0,
    diagnostics,
  };

  result.runId = await persistRun(result, {
    attribution,
    health,
    featureImportance: metaFeatureImportance(ens),
  });
  return result;
}

async function persistRun(
  result: PipelineResult,
  extras: {
    attribution: StrategyAttribution[];
    health: ReturnType<typeof ensembleHealth>;
    featureImportance: { name: string; weight: number }[];
  },
): Promise<number> {
  try {
    const inserted = await db
      .insert(backtestRuns)
      .values({
        label: result.label,
        ticker: result.ticker,
        timeframe: result.timeframe,
        bars: result.bars,
        startTs: result.candles.length ? result.candles[0].ts : 0,
        endTs: result.candles.length ? result.candles[result.candles.length - 1].ts : 0,
        dataSource: result.dataSource,
        preset: result.preset,
        targetWinRate: result.targetWinRate,
        winRate: result.inSample.metrics.winRate,
        profitFactor: result.inSample.metrics.profitFactor,
        expectancyR: result.inSample.metrics.expectancyR,
        netReturn: result.inSample.metrics.netReturn,
        sharpe: result.inSample.metrics.sharpe,
        deflatedSharpe: result.inSample.metrics.deflatedSharpe,
        maxDrawdown: result.inSample.metrics.maxDrawdown,
        tradeCount: result.inSample.metrics.trades,
        oosWinRate: result.outOfSample?.metrics.winRate ?? null,
        oosProfitFactor: result.outOfSample?.metrics.profitFactor ?? null,
        pbo: result.pbo?.pbo ?? null,
        durationMs: result.durationMs,
        params: result.params,
        risk: result.risk,
        metrics: result.inSample.metrics,
        equityCurve: result.inSample.equityCurve,
        attribution: { attribution: extras.attribution, health: extras.health, featureImportance: extras.featureImportance },
        walkForward: result.walkForward,
        monteCarlo: result.monteCarlo,
        trials: result.optimization.trials.length,
      })
      .returning({ id: backtestRuns.id });
    const runId = inserted[0]?.id ?? 0;
    if (runId && result.inSample.trades.length) {
      await db.insert(backtestTrades).values(
        result.inSample.trades.slice(0, 240).map((t) => ({
          runId,
          seq: t.seq,
          side: t.side,
          alphaKey: t.alphaKey,
          entryTs: t.entryTs,
          exitTs: t.exitTs,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          qty: t.qty,
          grossPnl: t.grossPnl,
          fees: t.fees,
          slippage: t.slippage,
          netPnl: t.netPnl,
          rMultiple: t.rMultiple,
          maeR: t.maeR,
          mfeR: t.mfeR,
          holdingBars: t.holdingBars,
          exitReason: t.exitReason,
          regime: t.regime,
          confidence: t.confidence,
          metaProb: t.metaProb,
        })),
      );
    }
    if (runId && result.optimization.trials.length) {
      await db.insert(optimizationTrials).values(
        result.optimization.trials.slice(0, 80).map((t) => ({
          runId,
          iteration: t.iteration,
          stage: t.stage,
          params: t.params,
          objective: t.objective,
          winRate: t.winRate,
          profitFactor: t.profitFactor,
          netReturn: t.netReturn,
          maxDrawdown: t.maxDrawdown,
          tradeCount: t.tradeCount,
        })),
      );
    }
    return runId;
  } catch {
    return 0;
  }
}

export async function listRuns(limit = 25) {
  try {
    return await db
      .select({
        id: backtestRuns.id,
        label: backtestRuns.label,
        ticker: backtestRuns.ticker,
        timeframe: backtestRuns.timeframe,
        preset: backtestRuns.preset,
        bars: backtestRuns.bars,
        winRate: backtestRuns.winRate,
        profitFactor: backtestRuns.profitFactor,
        netReturn: backtestRuns.netReturn,
        sharpe: backtestRuns.sharpe,
        maxDrawdown: backtestRuns.maxDrawdown,
        tradeCount: backtestRuns.tradeCount,
        oosWinRate: backtestRuns.oosWinRate,
        pbo: backtestRuns.pbo,
        targetWinRate: backtestRuns.targetWinRate,
        durationMs: backtestRuns.durationMs,
        createdAt: backtestRuns.createdAt,
      })
      .from(backtestRuns)
      .orderBy(desc(backtestRuns.id))
      .limit(limit);
  } catch {
    return [];
  }
}

export async function getRun(id: number) {
  try {
    const rows = await db.select().from(backtestRuns).where(eq(backtestRuns.id, id)).limit(1);
    if (!rows.length) return null;
    const trades = await db
      .select()
      .from(backtestTrades)
      .where(eq(backtestTrades.runId, id))
      .orderBy(backtestTrades.seq)
      .limit(240);
    return { run: rows[0], trades };
  } catch {
    return null;
  }
}

/* ========================================================================== */
/*  Live signal engine                                                        */
/* ========================================================================== */

export interface SignalScanResult {
  ticker: string;
  timeframe: Timeframe;
  source: string;
  candles: Candle[];
  candidates: SignalCandidate[];
  tape: SignalCandidate[];
  health: ReturnType<typeof ensembleHealth>;
  threshold: number;
  regime: string;
  price: number;
  atrPct: number;
  metaFeatureImportance: { name: string; weight: number }[];
  alphaIc: Record<string, number>;
  votes: Record<string, number>;
}

export async function scanSignals(
  ticker: string,
  timeframe: Timeframe,
  bars: number,
  presetKey: PresetKey,
  targetWinRate: number,
): Promise<SignalScanResult> {
  const preset = PRESETS[presetKey] ?? PRESETS.apex_hit_rate;
  const series = await loadSeries(ticker, timeframe, Math.max(600, bars), true);
  const candles = series.candles;
  const params = { ...preset.params };
  const ens = buildEnsemble(candles, params, timeframe);
  const risk: RiskProfile = { ...preset.risk, barsPerDay: BARS_PER_DAY[timeframe] };

  const cal = (() => {
    const lab: number[] = [];
    const pr: number[] = [];
    for (let i = 260; i < candles.length; i++) {
      if (ens.labels[i] >= 0 && Math.abs(ens.score[i]) > 0.04) {
        lab.push(ens.labels[i]);
        pr.push(ens.metaProb[i]);
      }
    }
    const pairs = lab.map((y, i) => ({ y, p: pr[i] })).sort((a, b) => b.p - a.p);
    let wins = 0;
    let threshold = params.metaThreshold;
    for (let i = 0; i < pairs.length; i++) {
      wins += pairs[i].y;
      const count = i + 1;
      if (count < Math.max(40, Math.floor(pairs.length * 0.1))) continue;
      if (wins / count >= targetWinRate) threshold = pairs[i].p;
    }
    return clamp(threshold, 0.5, 0.99);
  })();

  const n = candles.length;
  const build = (i: number): SignalCandidate | null => {
    const dir = ens.direction[i];
    if (dir === "flat") return null;
    const a = ens.ind.atr[i];
    if (!Number.isFinite(a) || a <= 0) return null;
    const price = candles[i].close;
    const votes: Record<string, number> = {};
    for (let k = 0; k < ALPHA_MODELS.length; k++) {
      const key = ALPHA_MODELS[k].key;
      votes[key] = Number((ens.weights[i][k] * ens.alphaScores[key][i]).toFixed(4));
    }
    return {
      ticker,
      timeframe,
      barTs: candles[i].ts,
      direction: dir,
      alphaKey: ens.dominant[i],
      score: Number(ens.score[i].toFixed(4)),
      metaProb: Number(ens.metaProb[i].toFixed(4)),
      confidence: Number(ens.confidence[i].toFixed(4)),
      entryPrice: price,
      stopPrice: dir === "long" ? price - params.stopAtrMult * a : price + params.stopAtrMult * a,
      targetPrice: dir === "long" ? price + params.targetAtrMult * a : price - params.targetAtrMult * a,
      regime: ens.regime[i],
      votes,
      atrPct: Number(((a / price) * 100).toFixed(3)),
      trendFilter: `${ALPHA_REGISTRY[ens.dominant[i]]?.name ?? "ensemble"} · ADX ${ens.ind.adx[i]?.toFixed(1) ?? "n/a"}`,
      expectedHoldBars: params.timeStopBars,
    };
  };

  const candidates: SignalCandidate[] = [];
  for (let i = Math.max(260, n - 3); i < n; i++) {
    const c = build(i);
    if (!c) continue;
    if (Math.abs(c.score) >= params.confidenceFloor && c.metaProb >= cal) candidates.push(c);
  }
  const tape: SignalCandidate[] = [];
  for (let i = Math.max(260, n - 120); i < n; i++) {
    const c = build(i);
    if (c && Math.abs(c.score) >= params.confidenceFloor) tape.push(c);
  }

  const last = n - 1;
  if (candidates.length) {
    try {
      await db.insert(signalsTable).values(
        candidates.slice(0, 3).map((c) => ({
          ticker: c.ticker,
          timeframe: c.timeframe,
          barTs: c.barTs,
          direction: c.direction,
          alphaKey: c.alphaKey,
          score: c.score,
          metaProb: c.metaProb,
          confidence: c.confidence,
          entryPrice: c.entryPrice,
          stopPrice: c.stopPrice,
          targetPrice: c.targetPrice,
          regime: c.regime,
          votes: c.votes,
        })),
      );
    } catch {
      // signal persistence is best-effort
    }
  }

  return {
    ticker,
    timeframe,
    source: series.source,
    candles: candles.slice(-180),
    candidates: candidates.slice(-4),
    tape: tape.slice(-24).reverse(),
    health: ensembleHealth(ens),
    threshold: cal,
    regime: ens.regime[last] ?? "range",
    price: candles[last].close,
    atrPct: Number(((ens.ind.atr[last] / candles[last].close) * 100).toFixed(3)),
    metaFeatureImportance: metaFeatureImportance(ens),
    alphaIc: ens.alphaIc,
    votes: Object.fromEntries(
      ALPHA_MODELS.map((m, k) => [m.key, Number((ens.weights[last][k] ?? 0).toFixed(4))]),
    ),
  };
}

/* ========================================================================== */
/*  Paper brokerage                                                           */
/* ========================================================================== */

export async function ensurePaperAccount() {
  const rows = await db.select().from(paperAccounts).limit(1);
  if (rows.length) return rows[0];
  const created = await db
    .insert(paperAccounts)
    .values({ owner: "primary", cash: 100_000, equity: 100_000, peakEquity: 100_000 })
    .returning();
  return created[0];
}

export async function openPaperPosition(input: {
  ticker: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  metaProb: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  alphaKey: string;
  regime: string;
  riskPerTrade?: number;
  leverage?: number;
}) {
  const account = await ensurePaperAccount();
  const series = await loadSeries(input.ticker, input.timeframe, 300, true);
  const candles = series.candles;
  const price = input.entryPrice > 0 ? input.entryPrice : candles[candles.length - 1].close;
  const stopDist = Math.abs(price - input.stopPrice) || price * 0.01;
  const riskFrac = input.riskPerTrade ?? 0.0075;
  const qty = Math.max(0.0001, (account.equity * riskFrac) / stopDist);
  const notional = qty * price;
  const fee = (notional * 4) / 1e4;
  const maxNotional = account.equity * (input.leverage ?? 3) * 0.9;
  const finalQty = notional > maxNotional ? maxNotional / price : qty;
  const inserted = await db
    .insert(paperPositions)
    .values({
      accountId: account.id,
      ticker: input.ticker,
      timeframe: input.timeframe,
      side: input.direction,
      status: "open",
      qty: finalQty,
      remainingQty: finalQty,
      entryPrice: price,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      leverage: input.leverage ?? 3,
      riskR: stopDist,
      fees: fee,
      alphaKey: input.alphaKey,
      regime: (input.regime as never) ?? "range",
      openedTs: candles[candles.length - 1].ts,
      metaProb: input.metaProb,
    })
    .returning();
  await db
    .update(paperAccounts)
    .set({ cash: account.cash - fee, feesPaid: account.feesPaid + fee, updatedAt: new Date() })
    .where(eq(paperAccounts.id, account.id));
  return inserted[0];
}

export async function closePaperPosition(id: number, reason: string, price?: number) {
  const rows = await db.select().from(paperPositions).where(eq(paperPositions.id, id)).limit(1);
  if (!rows.length || rows[0].status !== "open") return null;
  const pos = rows[0];
  const account = await ensurePaperAccount();
  const series = await loadSeries(pos.ticker, pos.timeframe as Timeframe, 200, true);
  const candles = series.candles;
  const exit = price ?? candles[candles.length - 1].close;
  const dir = pos.side === "long" ? 1 : -1;
  const gross = (exit - pos.entryPrice) * dir * pos.qty;
  const fee = (exit * pos.qty * 4) / 1e4;
  const net = gross - fee - pos.fees;
  const rMultiple = pos.riskR > 0 ? net / (pos.riskR * pos.qty) : 0;
  const equity = account.equity + net;
  const peak = Math.max(account.peakEquity, equity);
  await db
    .update(paperPositions)
    .set({
      status: "closed",
      remainingQty: 0,
      realizedPnl: net,
      rMultiple,
      exitReason: reason,
      closedTs: candles[candles.length - 1].ts,
      fees: pos.fees + fee,
    })
    .where(eq(paperPositions.id, id));
  await db
    .update(paperAccounts)
    .set({
      equity,
      cash: account.cash + gross - fee,
      realizedPnl: account.realizedPnl + net,
      feesPaid: account.feesPaid + fee,
      peakEquity: peak,
      maxDrawdown: Math.min(account.maxDrawdown, peak > 0 ? equity / peak - 1 : 0),
      updatedAt: new Date(),
    })
    .where(eq(paperAccounts.id, account.id));
  return { id, net, rMultiple, exit, reason };
}

export async function paperSnapshot() {
  const account = await ensurePaperAccount();
  const open = await db.select().from(paperPositions).where(eq(paperPositions.status, "open"));
  const closed = await db
    .select()
    .from(paperPositions)
    .where(eq(paperPositions.status, "closed"))
    .orderBy(desc(paperPositions.id))
    .limit(40);
  const marks: Record<string, number> = {};
  for (const pos of open) {
    if (!marks[pos.ticker]) {
      const series = await loadSeries(pos.ticker, pos.timeframe as Timeframe, 200, true);
      marks[pos.ticker] = series.candles[series.candles.length - 1]?.close ?? pos.entryPrice;
    }
  }
  const enriched = open.map((p) => {
    const mark = marks[p.ticker] ?? p.entryPrice;
    const dir = p.side === "long" ? 1 : -1;
    const unrealized = (mark - p.entryPrice) * dir * p.qty - p.fees;
    return {
      ...p,
      markPrice: mark,
      unrealizedPnl: unrealized,
      rMultipleLive: p.riskR > 0 ? unrealized / (p.riskR * p.qty) : 0,
    };
  });
  const wins = closed.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  return {
    account,
    open: enriched,
    closed,
    stats: {
      closedTrades: closed.length,
      winRate: closed.length ? wins / closed.length : 0,
      realizedPnl: account.realizedPnl,
      unrealized: enriched.reduce((acc, p) => acc + p.unrealizedPnl, 0),
    },
  };
}

/** Mark open paper positions against the latest bar and honour stop/target. */
export async function paperTick(): Promise<{ closed: number; signals: SignalCandidate[] }> {
  const snapshot = await paperSnapshot();
  let closed = 0;
  for (const pos of snapshot.open) {
    const series = await loadSeries(pos.ticker, pos.timeframe as Timeframe, 120, true);
    const bar = series.candles[series.candles.length - 1];
    const dir = pos.side === "long" ? 1 : -1;
    const hitStop = dir === 1 ? bar.low <= pos.stopPrice : bar.high >= pos.stopPrice;
    const hitTarget = dir === 1 ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;
    if (hitStop) {
      await closePaperPosition(pos.id, "stop", pos.stopPrice);
      closed++;
    } else if (hitTarget) {
      await closePaperPosition(pos.id, "target", pos.targetPrice);
      closed++;
    }
  }
  const scan = await scanSignals("BTCUSDT", "1h", 900, "apex_hit_rate", 0.85);
  return { closed, signals: scan.candidates };
}
