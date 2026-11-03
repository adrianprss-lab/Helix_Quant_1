import type {
  BacktestMetrics,
  BacktestResult,
  EquityPoint,
  StrategyAttribution,
  Trade,
} from "./types";
import {
  clamp,
  kurtosisExcess,
  maxOf,
  mean,
  minOf,
  normalCdf,
  normalInv,
  quantile,
  skewness,
  stdev,
  studentPValue,
  sum,
} from "./math";

const EULER_GAMMA = 0.5772156649015329;

export interface MetricsInput {
  trades: Trade[];
  equityCurve: EquityPoint[];
  initialEquity: number;
  warmupBars: number;
  periodsPerYear: number;
  feeTotal: number;
  slippageTotal: number;
  notionalTraded: number;
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { trades, equityCurve, initialEquity, warmupBars, periodsPerYear, feeTotal, slippageTotal, notionalTraded } = input;
  const n = equityCurve.length;
  const rets: number[] = new Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) {
    rets[i - 1] = equityCurve[i - 1].equity > 0 ? equityCurve[i].equity / equityCurve[i - 1].equity - 1 : 0;
  }

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossProfit = sum(wins.map((t) => t.netPnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netPnl)));
  const netProfit = grossProfit - grossLoss;
  const finalEquity = n > 0 ? equityCurve[n - 1].equity : initialEquity;
  const netReturn = initialEquity > 0 ? finalEquity / initialEquity - 1 : 0;
  const years = Math.max(1 / periodsPerYear, n / periodsPerYear);
  const cagr = netReturn > -1 ? (finalEquity / initialEquity) ** (1 / years) - 1 : -1;

  const rMultiples = trades.map((t) => t.rMultiple);
  const avgR = rMultiples.length ? mean(rMultiples) : 0;
  const sdR = rMultiples.length > 1 ? stdev(rMultiples) : 0;

  const rBar = rets.length ? mean(rets) : 0;
  const sdBar = rets.length > 1 ? stdev(rets) : 0;
  const sharpe = sdBar > 0 ? (rBar / sdBar) * Math.sqrt(periodsPerYear) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length ? stdev(downside) : 0;
  const sortino = dsd > 0 ? (rBar / dsd) * Math.sqrt(periodsPerYear) : 0;

  let peak = -Infinity;
  let maxDd = 0;
  let maxDdAbs = 0;
  let ddStart = 0;
  let ddBars = 0;
  let ulcerAcc = 0;
  let exposureBars = 0;
  for (let i = 0; i < n; i++) {
    const eq = equityCurve[i].equity;
    if (eq > peak) {
      peak = eq;
      ddStart = i;
    }
    const dd = peak > 0 ? eq / peak - 1 : 0;
    if (dd < maxDd) {
      maxDd = dd;
      maxDdAbs = peak - eq;
      ddBars = i - ddStart;
    }
    ulcerAcc += dd * dd;
    if (equityCurve[i].exposure > 0) exposureBars++;
  }
  const ulcerIndex = Math.sqrt(n > 0 ? ulcerAcc / n : 0);
  const calmar = maxDd < 0 ? cagr / Math.abs(maxDd) : 0;
  const recoveryFactor = maxDdAbs > 0 ? netProfit / maxDdAbs : 0;

  const gains = rets.filter((r) => r > 0);
  const pains = rets.filter((r) => r < 0);
  const omega = pains.length && sum(pains) !== 0 ? sum(gains) / Math.abs(sum(pains)) : gains.length ? 99 : 0;
  const sqn = sdR > 0 ? (Math.sqrt(trades.length) * avgR) / sdR : 0;

  const sortedRets = rets.slice().sort((a, b) => a - b);
  const var95 = sortedRets.length ? quantile(sortedRets, 0.05) : 0;
  const tailIdx = Math.max(1, Math.floor(sortedRets.length * 0.05));
  const cvarSlice = sortedRets.slice(0, tailIdx);
  const cvar95 = cvarSlice.length ? mean(cvarSlice) : var95;
  const p95 = sortedRets.length ? quantile(sortedRets, 0.95) : 0;
  const p05 = var95;
  const tailRatio = Math.abs(p05) > 0 ? Math.abs(p95 / p05) : 0;

  // streaks
  let winStreak = 0;
  let lossStreak = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const t of trades) {
    if (t.netPnl > 0) {
      curWin++;
      curLoss = 0;
    } else {
      curLoss++;
      curWin = 0;
    }
    winStreak = Math.max(winStreak, curWin);
    lossStreak = Math.max(lossStreak, curLoss);
  }

  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = payoff > 0 ? clamp(winRate - (1 - winRate) / payoff, -1, 1) : 0;

  // --- statistical significance -------------------------------------------
  const skew = skewness(rMultiples);
  const kurt = kurtosisExcess(rMultiples);
  const srTrade = sdR > 0 ? avgR / sdR : 0;
  const tStat = sdR > 0 ? (avgR / sdR) * Math.sqrt(trades.length) : 0;
  const pValue = trades.length > 2 ? studentPValue(tStat, trades.length - 1) : 1;
  const probSharpe = probabilisticSharpe(srTrade, trades.length, skew, kurt, 0);

  const longs = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");
  const longWins = longs.filter((t) => t.netPnl > 0).length;
  const shortWins = shorts.filter((t) => t.netPnl > 0).length;

  return {
    bars: n,
    warmupBars,
    trades: trades.length,
    winRate,
    lossRate: 1 - winRate,
    longTrades: longs.length,
    shortTrades: shorts.length,
    longWinRate: longs.length ? longWins / longs.length : 0,
    shortWinRate: shorts.length ? shortWins / shorts.length : 0,
    grossProfit,
    grossLoss,
    netProfit,
    netReturn,
    cagr,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    expectancy: trades.length ? netProfit / trades.length : 0,
    expectancyR: avgR,
    payoffRatio: payoff,
    avgWin,
    avgLoss,
    avgTradeR: avgR,
    avgHoldingBars: trades.length ? mean(trades.map((t) => t.holdingBars)) : 0,
    maxWinStreak: winStreak,
    maxLossStreak: lossStreak,
    sharpe,
    sortino,
    calmar,
    omega,
    ulcerIndex,
    sqn,
    maxDrawdown: maxDd,
    maxDrawdownAbs: maxDdAbs,
    maxDrawdownBars: ddBars,
    recoveryFactor,
    exposurePct: n > 0 ? exposureBars / n : 0,
    turnover: initialEquity > 0 ? notionalTraded / initialEquity : 0,
    feeDrag: initialEquity > 0 ? feeTotal / initialEquity : 0,
    slippageDrag: initialEquity > 0 ? slippageTotal / initialEquity : 0,
    var95,
    cvar95,
    tailRatio,
    kelly,
    probabilisticSharpe: probSharpe,
    deflatedSharpe: 0,
    tStat,
    pValue,
    bestTrade: trades.length ? maxOf(trades.map((t) => t.netPnl)) : 0,
    worstTrade: trades.length ? minOf(trades.map((t) => t.netPnl)) : 0,
    finalEquity,
  };
}

/**
 * Bailey & López de Prado Probabilistic Sharpe Ratio.
 * P(SR > SR*) accounting for the non-normality of returns.
 */
export function probabilisticSharpe(
  sr: number,
  n: number,
  skew: number,
  kurt: number,
  benchmark: number,
): number {
  if (n < 3) return 0;
  const diff = sr - benchmark;
  const denom = Math.sqrt(
    Math.max(1e-12, 1 - skew * sr + ((kurt) / 4) * sr * sr),
  );
  return normalCdf((diff * Math.sqrt(n - 1)) / denom);
}

/**
 * Expected maximum Sharpe ratio under multiple testing — used to deflate the
 * observed Sharpe (Deflated Sharpe Ratio).
 */
export function expectedMaxSharpe(nTrials: number, varianceOfSharpe: number): number {
  if (nTrials <= 1) return 0;
  const emc = EULER_GAMMA;
  const z1 = normalInv(1 - 1 / nTrials);
  const z2 = normalInv(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varianceOfSharpe) * ((1 - emc) * z1 + emc * z2);
}

export function deflatedSharpe(
  sr: number,
  n: number,
  skew: number,
  kurt: number,
  nTrials: number,
  varianceOfSharpe: number,
): number {
  const srStar = expectedMaxSharpe(nTrials, varianceOfSharpe);
  return probabilisticSharpe(sr, n, skew, kurt, srStar);
}

/** Attach the DSR once the number of optimisation trials is known. */
export function withDeflatedSharpe(
  metrics: BacktestMetrics,
  trades: Trade[],
  nTrials: number,
  varianceOfSharpe: number,
): BacktestMetrics {
  const rs = trades.map((t) => t.rMultiple);
  const sd = rs.length > 1 ? stdev(rs) : 0;
  const sr = sd > 0 ? mean(rs) / sd : 0;
  return {
    ...metrics,
    deflatedSharpe: deflatedSharpe(
      sr,
      rs.length,
      skewness(rs),
      kurtosisExcess(rs),
      nTrials,
      varianceOfSharpe,
    ),
  };
}

export function buildAttribution(trades: Trade[], names: Record<string, string>): StrategyAttribution[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = groups.get(t.alphaKey) ?? [];
    arr.push(t);
    groups.set(t.alphaKey, arr);
  }
  const totalAbs = sum(trades.map((t) => Math.abs(t.netPnl))) || 1;
  const out: StrategyAttribution[] = [];
  for (const [key, list] of groups) {
    const wins = list.filter((t) => t.netPnl > 0);
    const gp = sum(wins.map((t) => t.netPnl));
    const gl = Math.abs(sum(list.filter((t) => t.netPnl <= 0).map((t) => t.netPnl)));
    out.push({
      alphaKey: key,
      name: names[key] ?? key,
      family: "mean_reversion",
      trades: list.length,
      netPnl: sum(list.map((t) => t.netPnl)),
      winRate: list.length ? wins.length / list.length : 0,
      expectancyR: list.length ? mean(list.map((t) => t.rMultiple)) : 0,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? 99 : 0,
      contribution: sum(list.map((t) => Math.abs(t.netPnl))) / totalAbs,
    });
  }
  return out.sort((a, b) => b.netPnl - a.netPnl);
}

export function monthlyReturns(curve: EquityPoint[]): { label: string; return: number }[] {
  const byMonth = new Map<string, { first: number; last: number }>();
  for (const p of curve) {
    const d = new Date(p.ts * 1000);
    const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const entry = byMonth.get(label);
    if (!entry) byMonth.set(label, { first: p.equity, last: p.equity });
    else entry.last = p.equity;
  }
  const out: { label: string; return: number }[] = [];
  let prev: number | null = null;
  for (const [label, v] of byMonth) {
    const base = prev ?? v.first;
    out.push({ label, return: base > 0 ? v.last / base - 1 : 0 });
    prev = v.last;
  }
  return out.slice(-24);
}

export function rolledWinRate(trades: Trade[], window = 40): { ts: number; winRate: number; trades: number }[] {
  const out: { ts: number; winRate: number; trades: number }[] = [];
  for (let i = window; i <= trades.length; i++) {
    const slice = trades.slice(i - window, i);
    const wins = slice.filter((t) => t.netPnl > 0).length;
    out.push({ ts: slice[slice.length - 1].exitTs, winRate: wins / slice.length, trades: window });
  }
  return out;
}

export function summarize(result: BacktestResult) {
  return {
    trades: result.metrics.trades,
    winRate: result.metrics.winRate,
    profitFactor: result.metrics.profitFactor,
    expectancyR: result.metrics.expectancyR,
    netReturn: result.metrics.netReturn,
    sharpe: result.metrics.sharpe,
    maxDrawdown: result.metrics.maxDrawdown,
  };
}
