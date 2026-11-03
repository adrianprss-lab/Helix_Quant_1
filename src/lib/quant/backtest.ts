import type { EnsembleResult } from "./ensemble";
import type {
  AlphaEnsembleBar,
  AlphaFamily,
  BacktestResult,
  Candle,
  EnsembleParams,
  EquityPoint,
  ExitReason,
  Fill,
  MarketRegime,
  RegimeAttribution,
  RiskProfile,
  Trade,
} from "./types";
import { ALPHA_REGISTRY } from "./strategies";
import { buildAttribution, computeMetrics, monthlyReturns, rolledWinRate } from "./metrics";
import { clamp, mean } from "./math";

export interface BacktestOptions {
  candles: Candle[];
  ens: EnsembleResult;
  risk: RiskProfile;
  params: EnsembleParams;
  /** first bar index that may be traded (warm-up boundary) */
  start?: number;
  /** exclusive end index */
  end?: number;
  /** overrides params.metaThreshold (used by the calibrator / optimiser) */
  metaThreshold?: number;
  confidenceFloor?: number;
  /** disable the signal-flip exit so the exit ladder is deterministic */
  allowSignalFlipExit?: boolean;
}

interface OpenPosition {
  side: 1 | -1;
  entryIndex: number;
  entryTs: number;
  entryPrice: number;
  qty: number;
  initialQty: number;
  stop: number;
  target: number;
  riskPerUnit: number;
  riskDollars: number;
  alphaKey: string;
  regime: MarketRegime;
  confidence: number;
  metaProb: number;
  realizedGross: number;
  fees: number;
  slippageCost: number;
  partials: number;
  bestR: number;
  worstR: number;
  exitQtyWeighted: number;
  exitQty: number;
  exitTs: number | null;
  exitReason: ExitReason | null;
  holdingBars: number;
  breakeven: boolean;
  entryFee: number;
  entrySlip: number;
}

export interface EngineDiagnostics {
  entriesBlockedByRegime: number;
  entriesBlockedByMeta: number;
  entriesBlockedByConfidence: number;
  entriesBlockedByRisk: number;
  entriesBlockedByBreaker: number;
  partialExits: number;
  tradesClosed: number;
}

export function runBacktest(opts: BacktestOptions): BacktestResult & { diagnostics: EngineDiagnostics } {
  const { candles, ens, risk, params } = opts;
  const n = candles.length;
  const start = Math.max(opts.start ?? 0, 1);
  const end = Math.min(opts.end ?? n, n);
  const metaThreshold = opts.metaThreshold ?? params.metaThreshold;
  const confidenceFloor = opts.confidenceFloor ?? params.confidenceFloor;
  const ppy = risk.barsPerDay * 365;
  const daySec = 86400;

  let cash = risk.initialEquity;
  const positions: OpenPosition[] = [];
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const regimeBuckets = new Map<MarketRegime, { bars: number; exposure: number; pnl: number; trades: number; wins: number }>();
  const diag: EngineDiagnostics = {
    entriesBlockedByRegime: 0,
    entriesBlockedByMeta: 0,
    entriesBlockedByConfidence: 0,
    entriesBlockedByRisk: 0,
    entriesBlockedByBreaker: 0,
    partialExits: 0,
    tradesClosed: 0,
  };

  let peak = risk.initialEquity;
  let dayStartEquity = risk.initialEquity;
  let currentDay = -1;
  let breakerActive = false;
  let notionalTraded = 0;
  let feeTotal = 0;
  let slippageTotal = 0;
  let tradeSeq = 0;
  const recentR: number[] = [];

  const ind = ens.ind;

  const unrealized = (i: number): number => {
    let acc = 0;
    for (const p of positions) {
      const mark = p.side === 1 ? candles[i].low * 0 + candles[i].close : candles[i].close;
      acc += p.realizedGross + (mark - p.entryPrice) * p.side * p.qty;
    }
    return acc;
  };

  const closePosition = (
    p: OpenPosition,
    i: number,
    price: number,
    qty: number,
    reason: ExitReason,
    slipMult: number,
  ): void => {
    const slip = price * (risk.slippageBps * slipMult) / 1e4;
    const fillPrice = price - p.side * slip;
    const notional = fillPrice * qty;
    const fee = (notional * risk.takerFeeBps) / 1e4;
    const gross = (fillPrice - p.entryPrice) * p.side * qty;
    cash += gross - fee;
    p.realizedGross += gross;
    p.fees += fee + p.entryFee * (qty / p.initialQty);
    p.slippageCost += slip * qty + p.entrySlip * (qty / p.initialQty);
    p.exitQtyWeighted += fillPrice * qty;
    p.exitQty += qty;
    p.qty -= qty;
    notionalTraded += notional;
    feeTotal += fee;
    slippageTotal += slip * qty;
    if (qty > 1e-12 && p.qty <= 1e-9) {
      p.qty = 0;
      p.exitTs = candles[i].ts;
      p.exitReason = reason;
    } else {
      p.partials++;
      diag.partialExits++;
    }
  };

  for (let i = start; i < end; i++) {
    const bar = candles[i];
    const day = Math.floor(bar.ts / daySec);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = cash + unrealized(i);
      breakerActive = false;
    }

    const equityNow = cash + unrealized(i);
    if (risk.dailyLossLimit > 0 && equityNow < dayStartEquity * (1 - risk.dailyLossLimit)) {
      if (!breakerActive) {
        breakerActive = true;
        diag.entriesBlockedByBreaker++;
      }
    }

    // ------------------------------------------------------------------ entries
    const signalIdx = i - 1;
    if (
      signalIdx >= start &&
      positions.length < risk.maxConcurrentPositions &&
      !breakerActive
    ) {
      const dir = ens.direction[signalIdx];
      const s = ens.score[signalIdx];
      const mp = ens.metaProb[signalIdx];
      const regime = ens.regime[signalIdx];
      let blocked = false;
      if (dir === "flat" || Math.abs(s) < confidenceFloor) {
        diag.entriesBlockedByConfidence++;
        blocked = true;
      }
      if (!blocked && mp < metaThreshold) {
        diag.entriesBlockedByMeta++;
        blocked = true;
      }
      if (!blocked) {
        const mrFamily = ALPHA_REGISTRY[ens.dominant[signalIdx]]?.family;
        const trendish = mrFamily === "trend" || mrFamily === "momentum" || mrFamily === "breakout";
        const regimeOk = trendish
          ? regime === "trend_up" || regime === "trend_down" || regime === "expansion"
          : regime !== "shock";
        if (!regimeOk && params.regimeGate >= 0.5) {
          diag.entriesBlockedByRegime++;
          blocked = true;
        }
      }
      if (!blocked && positions.some((p) => p.alphaKey === ens.dominant[signalIdx])) {
        blocked = true;
      }
      const a = ind.atr[signalIdx];
      if (!blocked && Number.isFinite(a) && a > 0) {
        const atrNow = a;
        const stopDist = params.stopAtrMult * atrNow;
        const targetDist = params.targetAtrMult * atrNow;
        const equity = Math.max(1, cash + unrealized(i));
        // volatility targeting
        let volAdj = 1;
        if (risk.targetVol > 0) {
          const rvAnn = (ind.realizedVol[signalIdx] || 0) * Math.sqrt(ppy);
          volAdj = rvAnn > 0 ? clamp(risk.targetVol / rvAnn, 0.3, 2.2) : 1;
        }
        // fractional Kelly on the trailing trade population
        let kellyAdj = 1;
        if (risk.kellyFraction > 0 && recentR.length >= 30) {
          const w = recentR.filter((r) => r > 0).length / recentR.length;
          const avgWin = mean(recentR.filter((r) => r > 0));
          const avgLoss = Math.abs(mean(recentR.filter((r) => r <= 0)));
          const payoff = avgLoss > 0 ? avgWin / avgLoss : 1;
          const kelly = payoff > 0 ? w - (1 - w) / payoff : 0;
          kellyAdj = clamp((risk.kellyFraction * kelly) / risk.riskPerTrade, 0.25, 2.2);
        }
        const riskBudget = equity * risk.riskPerTrade * volAdj * kellyAdj;
        let qty = riskBudget / stopDist;
        const maxNotional = equity * risk.maxLeverage * 0.98;
        const openNotional = positions.reduce((acc, p) => acc + p.qty * p.entryPrice, 0);
        const allowed = Math.max(0, maxNotional - openNotional);
        const priceRef = bar.open;
        if (qty * priceRef > allowed) qty = allowed / priceRef;
        if (qty * priceRef < equity * 0.002 || qty <= 0) {
          diag.entriesBlockedByRisk++;
        } else {
          const side: 1 | -1 = dir === "long" ? 1 : -1;
          const entrySlip = (priceRef * risk.slippageBps) / 1e4;
          const entryPrice = priceRef + side * entrySlip;
          const entryFee = (entryPrice * qty * risk.takerFeeBps) / 1e4;
          cash -= entryFee;
          notionalTraded += entryPrice * qty;
          feeTotal += entryFee;
          slippageTotal += entrySlip * qty;
          positions.push({
            side,
            entryIndex: i,
            entryTs: bar.ts,
            entryPrice,
            qty,
            initialQty: qty,
            stop: entryPrice - side * stopDist,
            target: entryPrice + side * targetDist,
            riskPerUnit: stopDist,
            riskDollars: riskBudget,
            alphaKey: ens.dominant[signalIdx],
            regime,
            confidence: Math.abs(s),
            metaProb: mp,
            realizedGross: -entryFee,
            fees: entryFee,
            slippageCost: entrySlip * qty,
            partials: 0,
            bestR: 0,
            worstR: 0,
            exitQtyWeighted: 0,
            exitQty: 0,
            exitTs: null,
            exitReason: null,
            holdingBars: 0,
            breakeven: false,
            entryFee,
            entrySlip,
          });
        }
      }
    }

    // ------------------------------------------------------------------- exits
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const p = positions[pi];
      if (p.entryIndex === i) {
        // entered at this bar's open: same-bar resolution is allowed
      }
      p.holdingBars = i - p.entryIndex;
      const fav = (p.side === 1 ? bar.high - p.entryPrice : p.entryPrice - bar.low) / p.riskPerUnit;
      const adv = (p.side === 1 ? p.entryPrice - bar.low : bar.high - p.entryPrice) / p.riskPerUnit;
      if (fav > p.bestR) p.bestR = fav;
      if (adv > p.worstR) p.worstR = adv;

      const hitStop = p.side === 1 ? bar.low <= p.stop : bar.high >= p.stop;
      const hitTarget = p.side === 1 ? bar.high >= p.target : bar.low <= p.target;

      if (hitStop) {
        closePosition(p, i, p.stop, p.qty, p.qty < p.initialQty ? "trail" : "stop", 1.9);
      } else if (hitTarget) {
        if (p.partials === 0 && p.qty >= p.initialQty - 1e-9) {
          const part = Math.max(0.05, Math.min(0.95, params.tp1Fraction));
          const closeQty = p.initialQty * part;
          closePosition(p, i, p.target, closeQty, "target", 0.7);
          // runner: ratchet the stop to breakeven and extend the target
          p.stop = p.side === 1
            ? Math.max(p.stop, p.entryPrice + p.entryPrice * 0.0002)
            : Math.min(p.stop, p.entryPrice - p.entryPrice * 0.0002);
          p.target = p.entryPrice + p.side * p.riskPerUnit * (params.stopAtrMult * 0.75);
          p.breakeven = true;
        } else {
          closePosition(p, i, p.target, p.qty, "target", 0.7);
        }
      } else if (p.holdingBars >= params.timeStopBars) {
        closePosition(p, i, bar.close, p.qty, "time_stop", 1.2);
      } else if (
        opts.allowSignalFlipExit !== false &&
        ens.direction[i] !== "flat" &&
        Math.sign(ens.score[i]) === -p.side &&
        Math.abs(ens.score[i]) > confidenceFloor * 1.35 &&
        ens.metaProb[i] > metaThreshold
      ) {
        closePosition(p, i, bar.close, p.qty, "signal_flip", 1.2);
      } else if (breakerActive && risk.dailyLossLimit > 0) {
        closePosition(p, i, bar.close, p.qty, "risk_engine", 1.4);
      } else {
        // trailing / breakeven maintenance at the bar close
        const atrNow = ind.atr[i];
        if (Number.isFinite(atrNow)) {
          if (!p.breakeven && p.bestR >= params.breakevenAtR) {
            p.stop = p.side === 1
              ? Math.max(p.stop, p.entryPrice + p.entryPrice * 0.0002)
              : Math.min(p.stop, p.entryPrice - p.entryPrice * 0.0002);
            p.breakeven = true;
          }
          const trail = params.trailAtrMult * atrNow;
          const ref = p.side === 1 ? bar.close : bar.close;
          const newStop = p.side === 1 ? ref - trail : ref + trail;
          p.stop = p.side === 1 ? Math.max(p.stop, newStop) : Math.min(p.stop, newStop);
        }
      }

      if (p.qty <= 1e-9 && p.exitTs !== null) {
        const grossPnl = p.realizedGross;
        const fees = p.fees;
        const netPnl = grossPnl;
        const exitPrice = p.exitQty > 0 ? p.exitQtyWeighted / p.exitQty : p.entryPrice;
        const riskDollars = Math.max(1e-6, p.riskPerUnit * p.initialQty);
        trades.push({
          seq: ++tradeSeq,
          side: p.side === 1 ? "long" : "short",
          alphaKey: p.alphaKey,
          entryTs: p.entryTs,
          exitTs: p.exitTs,
          entryPrice: p.entryPrice,
          exitPrice,
          qty: p.initialQty,
          grossPnl: grossPnl + fees,
          fees,
          slippage: p.slippageCost,
          netPnl,
          rMultiple: netPnl / riskDollars,
          maeR: p.worstR,
          mfeR: p.bestR,
          holdingBars: p.holdingBars,
          exitReason: p.exitReason ?? "end_of_data",
          regime: p.regime,
          confidence: p.confidence,
          metaProb: p.metaProb,
          riskPerUnit: p.riskPerUnit,
          equityAfter: cash,
          fills: [] as Fill[],
        });
        recentR.push(netPnl / riskDollars);
        if (recentR.length > 120) recentR.shift();
        const bucket = regimeBuckets.get(p.regime) ?? { bars: 0, exposure: 0, pnl: 0, trades: 0, wins: 0 };
        bucket.trades++;
        bucket.pnl += netPnl;
        if (netPnl > 0) bucket.wins++;
        regimeBuckets.set(p.regime, bucket);
        diag.tradesClosed++;
        positions.splice(pi, 1);
      }
    }

    // --------------------------------------------------------------- accounting
    const equity = cash + unrealized(i);
    if (equity > peak) peak = equity;
    const bucket = regimeBuckets.get(ens.regime[i]) ?? { bars: 0, exposure: 0, pnl: 0, trades: 0, wins: 0 };
    bucket.bars++;
    bucket.exposure += positions.length > 0 ? 1 : 0;
    regimeBuckets.set(ens.regime[i], bucket);
    const openNotional = positions.reduce((acc, p) => acc + p.qty * bar.close, 0);
    equityCurve.push({
      ts: bar.ts,
      index: i,
      equity,
      drawdown: peak > 0 ? equity / peak - 1 : 0,
      benchmark: risk.initialEquity * (bar.close / candles[start].close),
      exposure: equity > 0 ? openNotional / equity : 0,
    });
  }

  // liquidate anything still open at the last mark
  const lastIdx = Math.max(start, end - 1);
  for (let pi = positions.length - 1; pi >= 0; pi--) {
    const p = positions[pi];
    closePosition(p, lastIdx, candles[lastIdx].close, p.qty, "end_of_data", 1.3);
    const netPnl = p.realizedGross;
    const riskDollars = Math.max(1e-6, p.riskPerUnit * p.initialQty);
    trades.push({
      seq: ++tradeSeq,
      side: p.side === 1 ? "long" : "short",
      alphaKey: p.alphaKey,
      entryTs: p.entryTs,
      exitTs: candles[lastIdx].ts,
      entryPrice: p.entryPrice,
      exitPrice: p.exitQty > 0 ? p.exitQtyWeighted / p.exitQty : p.entryPrice,
      qty: p.initialQty,
      grossPnl: p.realizedGross + p.fees,
      fees: p.fees,
      slippage: p.slippageCost,
      netPnl,
      rMultiple: netPnl / riskDollars,
      maeR: p.worstR,
      mfeR: p.bestR,
      holdingBars: p.holdingBars,
      exitReason: "end_of_data",
      regime: p.regime,
      confidence: p.confidence,
      metaProb: p.metaProb,
      riskPerUnit: p.riskPerUnit,
      equityAfter: cash,
      fills: [],
    });
  }
  if (equityCurve.length > 0) {
    const last = equityCurve[equityCurve.length - 1];
    last.equity = cash;
    last.drawdown = peak > 0 ? cash / peak - 1 : 0;
  }

  const metrics = computeMetrics({
    trades,
    equityCurve,
    initialEquity: risk.initialEquity,
    warmupBars: start,
    periodsPerYear: ppy,
    feeTotal,
    slippageTotal,
    notionalTraded,
  });

  const names: Record<string, string> = {};
  const families: Record<string, string> = {};
  for (const model of Object.values(ALPHA_REGISTRY)) {
    names[model.key] = model.name;
    families[model.key] = model.family;
  }
  const attribution = buildAttribution(trades, names).map((a) => ({
    ...a,
    family: (families[a.alphaKey] as AlphaFamily | undefined) ?? "mean_reversion",
  }));

  const regimeAttribution: RegimeAttribution[] = [...regimeBuckets.entries()]
    .map(([regime, b]) => ({
      regime,
      bars: b.bars,
      trades: b.trades,
      netPnl: b.pnl,
      winRate: b.trades ? b.wins / b.trades : 0,
      exposure: b.bars ? b.exposure / b.bars : 0,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);

  const signals: AlphaEnsembleBar[] = [];
  const tailCount = Math.min(320, n);
  for (let i = Math.max(start, n - tailCount); i < n; i++) {
    const votes: Record<string, number> = {};
    for (const model of Object.values(ALPHA_REGISTRY)) {
      votes[model.key] = Number(((ens.weights[i][Object.keys(ALPHA_REGISTRY).indexOf(model.key)] ?? 0) * ens.alphaScores[model.key][i]).toFixed(4));
    }
    signals.push({
      index: i,
      ts: candles[i].ts,
      score: Number(ens.score[i].toFixed(4)),
      confidence: Number(ens.confidence[i].toFixed(4)),
      direction: ens.direction[i],
      metaProb: Number(ens.metaProb[i].toFixed(4)),
      regime: ens.regime[i],
      votes,
      weights: {},
    });
  }

  return {
    trades,
    equityCurve,
    metrics,
    attribution,
    regimeAttribution,
    monthlyReturns: monthlyReturns(equityCurve),
    rolledWinRate: rolledWinRate(trades),
    signals,
    diagnostics: diag,
  };
}
