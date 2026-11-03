import type { AlphaContext, AlphaModel, MarketRegime, StrategyOutput } from "./types";
import { clamp, correlation, mean } from "./math";
import { ema, rollingMax, rollingMin, rollingStd, sma } from "./indicators";

const NON_FAMILY_REGIMES: Record<string, MarketRegime[]> = {
  mean_reversion: ["range", "compression", "expansion"],
  trend: ["trend_up", "trend_down", "expansion"],
  momentum: ["trend_up", "trend_down"],
  breakout: ["expansion", "trend_up", "trend_down"],
  volatility: ["compression", "expansion", "shock"],
  statistical: ["range", "compression", "expansion", "trend_up", "trend_down"],
};

function gateFor(family: keyof typeof NON_FAMILY_REGIMES | string, regime: MarketRegime[]): boolean[] {
  const allowed = NON_FAMILY_REGIMES[family] ?? NON_FAMILY_REGIMES.statistical;
  return regime.map((r) => allowed.includes(r));
}

function initScore(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/** Map a raw bounded statistic into signed conviction. */
function squash(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return 0;
  return clamp(((x - lo) / (hi - lo)) * 2 - 1, -1, 1);
}

/* ========================================================================== */
/*  MEAN REVERSION FAMILY                                                     */
/* ========================================================================== */

/** Connors-style RSI(2) double mean reversion with trend anchor. */
const rsi2Reversion: AlphaModel = {
  key: "mr_rsi2",
  name: "RSI(2) Double Mean Reversion",
  family: "mean_reversion",
  horizon: 4,
  description:
    "Short-horizon statistical reversion. Enters against 2-bar exhaustion when price sits on the wrong side of the 200-bar anchor, scaled by deviation depth.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    for (let i = 0; i < n; i++) {
      const r = ind.rsi2[i];
      const anchor = ind.ema200[i];
      if (!Number.isFinite(r) || !Number.isFinite(anchor)) continue;
      const aboveAnchor = ind.close[i] > anchor;
      const depth = squash(r, 8, 32);
      if (r < 32 && aboveAnchor) score[i] = Math.abs(depth);
      else if (r > 68 && !aboveAnchor) score[i] = -Math.abs(depth);
      else score[i] = 0;
    }
    return { score, active };
  },
};

/** Bollinger z-score reversion, gated by OU half-life and Hurst exponent. */
const bollingerReversion: AlphaModel = {
  key: "mr_bbands_z",
  name: "Bollinger Z-Score OU Reversion",
  family: "mean_reversion",
  horizon: 6,
  description:
    "Fades 2-sigma statistical dislocations when the process is genuinely mean reverting (H < 0.48) and the OU half-life fits the holding window.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime, params } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    const maxHalfLife = Math.max(4, params.timeStopBars * 0.9);
    for (let i = 0; i < n; i++) {
      const z = ind.zscore[i];
      const h = ind.hurst[i];
      const hl = ind.halfLife[i];
      if (!Number.isFinite(z) || !Number.isFinite(h)) continue;
      if (h > 0.5) continue;
      if (Number.isFinite(hl) && hl > maxHalfLife) continue;
      const intensity = squash(z, -2.6, 2.6);
      score[i] = -intensity;
    }
    return { score, active };
  },
};

/** VWAP fair-value band reversion (institutional execution benchmark). */
const vwapReversion: AlphaModel = {
  key: "mr_vwap_band",
  name: "Rolling VWAP Band Reversion",
  family: "mean_reversion",
  horizon: 5,
  description:
    "Trades reversion to the volume weighted fair value anchor when deviations exceed the rolling VWAP standard deviation with volume climax confirmation.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    for (let i = 0; i < n; i++) {
      const v = ind.vwap[i];
      const d = ind.vwapDev[i];
      if (!Number.isFinite(v) || !Number.isFinite(d) || d <= 0) continue;
      const z = (ind.close[i] - v) / d;
      const climax = ind.volumeZ[i];
      const clim = Number.isFinite(climax) ? clamp(climax / 2.5, 0, 1) : 0;
      score[i] = -squash(z, -2.2, 2.2) * (0.55 + 0.45 * clim);
    }
    return { score, active };
  },
};

/** Kalman filter residual reversion with adaptive observation noise. */
const kalmanReversion: AlphaModel = {
  key: "st_kalman_resid",
  name: "Kalman State-Space Reversion",
  family: "statistical",
  horizon: 7,
  description:
    "Runs an adaptive Kalman local-level filter and fades standardised innovations, exploiting the serial correlation of the residual process.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("statistical", regime);
    for (let i = 0; i < n; i++) {
      const z = ind.kalmanResidZ[i];
      if (!Number.isFinite(z)) continue;
      const persist = -correlation(
        ind.kalmanResid.slice(Math.max(0, i - 60), i),
        ind.close.slice(Math.max(0, i - 60), i).map((_, k, arr) => arr[Math.min(arr.length - 1, k + 1)] - arr[k]),
      );
      const weight = persist > 0 ? 0.6 + 0.4 * clamp(persist, 0, 1) : 0.6;
      score[i] = -squash(z, -2.4, 2.4) * weight;
    }
    return { score, active };
  },
};

/** Volume-node / value-area fade (auction theory). */
const volumeNodeFade: AlphaModel = {
  key: "mr_volume_node",
  name: "Value-Area Node Fade",
  family: "mean_reversion",
  horizon: 8,
  description:
    "Auction-theory model: fades excursions outside the rolling value area back to the point of control, weighted by accepted-volume proximity.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    for (let i = 0; i < n; i++) {
      const vah = ind.valueAreaHigh[i];
      const val = ind.valueAreaLow[i];
      const poc = ind.poc[i];
      const c = ind.close[i];
      if (!Number.isFinite(vah) || !Number.isFinite(val) || !Number.isFinite(poc) || vah <= val) continue;
      const span = vah - val;
      if (c > vah) score[i] = -clamp((c - vah) / span, 0, 1.6);
      else if (c < val) score[i] = clamp((val - c) / span, 0, 1.6);
      else score[i] = -clamp((c - poc) / span, -1, 1) * 0.45;
    }
    return { score, active };
  },
};

/* ========================================================================== */
/*  TREND / MOMENTUM FAMILY                                                   */
/* ========================================================================== */

/** SuperTrend with ADX quality filter. */
const superTrendModel: AlphaModel = {
  key: "tr_supertrend",
  name: "Adaptive SuperTrend Regime Rider",
  family: "trend",
  horizon: 24,
  description:
    "Volatility-adaptive trailing band system. Only expresses when ADX confirms a persistent directional regime and the EMA stack agrees.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("trend", regime);
    for (let i = 0; i < n; i++) {
      const dir = ind.superDir[i];
      const adx = ind.adx[i];
      if (!Number.isFinite(dir) || !Number.isFinite(adx)) continue;
      const quality = squash(adx, 15, 40);
      const stack = Math.sign(ind.ema50[i] - ind.ema200[i]);
      const agree = stack === dir ? 1 : 0.35;
      score[i] = dir * quality * agree;
    }
    return { score, active };
  },
};

/** Turtle-style Donchian channel breakout. */
const donchianBreakout: AlphaModel = {
  key: "br_donchian",
  name: "Donchian Channel Breakout",
  family: "breakout",
  horizon: 30,
  description:
    "Classic 20-day channel breakout with ATR normalisation, requiring a volatility expansion to avoid the death-by-choppy-whipsaw failure mode.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("breakout", regime);
    const widthPct = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(ind.bbWidth[i])) widthPct[i] = ind.bbWidth[i];
    }
    const avgWidth = sma(widthPct, 100);
    for (let i = 0; i < n; i++) {
      const dh = ind.donchianHigh[i];
      const dl = ind.donchianLow[i];
      const dm = ind.donchianMid[i];
      const c = ind.close[i];
      if (!Number.isFinite(dh) || !Number.isFinite(dl) || !Number.isFinite(dm) || dh === dl) continue;
      const pos = ((c - dm) / (dh - dm)) * 2 - 1;
      const expansion = Number.isFinite(avgWidth[i]) && avgWidth[i] > 0 ? ind.bbWidth[i] / avgWidth[i] : 1;
      const expansionBoost = clamp(expansion, 0.5, 1.8) / 1.8;
      score[i] = squash(pos, -1, 1) * (0.45 + 0.55 * expansionBoost);
    }
    return { score, active };
  },
};

/** MACD + EMA stack momentum with histogram acceleration. */
const macdStack: AlphaModel = {
  key: "tr_macd_stack",
  name: "MACD Histogram Acceleration Stack",
  family: "momentum",
  horizon: 18,
  description:
    "Multi-timeframe momentum alignment: EMA ribbon order, MACD histogram sign and acceleration, and volume confirmation as a composite conviction score.",
  evaluate(ctx: AlphaContext): SequenceOutputAlias {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("momentum", regime);
    const histSlope = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) {
      if (Number.isFinite(ind.macdHist[i]) && Number.isFinite(ind.macdHist[i - 1])) {
        histSlope[i] = ind.macdHist[i] - ind.macdHist[i - 1];
      }
    }
    const slopeSd = rollingStd(histSlope, 50);
    for (let i = 0; i < n; i++) {
      const h = ind.macdHist[i];
      if (!Number.isFinite(h)) continue;
      const acc = slopeSd[i] > 0 ? histSlope[i] / slopeSd[i] : 0;
      const stackOk =
        (ind.ema9[i] > ind.ema21[i] && ind.ema21[i] > ind.ema50[i] ? 1 : 0) -
        (ind.ema9[i] < ind.ema21[i] && ind.ema21[i] < ind.ema50[i] ? 1 : 0);
      const sign = Math.sign(h);
      const magnitude = clamp(Math.abs(h) / (ind.atr[i] * 0.35 || 1e-9), 0, 1);
      score[i] = sign * magnitude * 0.55 + clamp(acc, -1, 1) * 0.25 + stackOk * 0.2;
      score[i] = clamp(score[i], -1, 1);
    }
    return { score, active };
  },
};

/** Ichimoku Kumo breakout with Chikou confirmation. */
const ichimokuModel: AlphaModel = {
  key: "tr_ichimoku",
  name: "Ichimoku Kumo Breakout",
  family: "trend",
  horizon: 26,
  description:
    "Japanese cloud system: price above/below the Kumo with Tenkan/Kijun cross confirmation and lagging Chikou span agreement.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("trend", regime);
    for (let i = 0; i < n; i++) {
      const a = ind.senkouA[i];
      const b = ind.senkouB[i];
      const c = ind.close[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const cloudTop = Math.max(a, b);
      const cloudBottom = Math.min(a, b);
      const span = Math.max(1e-9, cloudTop - cloudBottom);
      const pos = clamp(((c - cloudBottom) / span) * 2 - 1, -1, 1);
      const cross = ind.tenkan[i] > ind.kijun[i] ? 1 : -1;
      const chikou = ind.chikouShift[i] > c ? 1 : -1;
      score[i] = clamp(pos * 0.5 + cross * 0.3 + chikou * 0.2, -1, 1);
    }
    return { score, active };
  },
};

/** Volatility compression expansion engine. */
const volExpansion: AlphaModel = {
  key: "br_squeeze",
  name: "Volatility Squeeze Expansion",
  family: "volatility",
  horizon: 12,
  description:
    "Detects Bollinger-inside-Keltner compression and trades the directional resolution, sized by the vol-of-vol term structure at release.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("volatility", regime);
    for (let i = 1; i < n; i++) {
      const bbU = ind.bbUpper[i];
      const bbL = ind.bbLower[i];
      const kU = ind.keltnerUpper[i];
      const kL = ind.keltnerLower[i];
      if (!Number.isFinite(bbU) || !Number.isFinite(kU)) continue;
      const squeeze = bbU < kU && bbL > kL;
      const prev = ind.close[i - 1];
      const c = ind.close[i];
      if (!squeeze) {
        // was the prior bar compressed? then this is the release bar
        const prevSqueeze =
          Number.isFinite(ind.bbUpper[i - 1]) && ind.bbUpper[i - 1] < ind.keltnerUpper[i - 1] && ind.bbLower[i - 1] > ind.keltnerLower[i - 1];
        if (!prevSqueeze) continue;
        const atrRef = ind.atr[i] || 1e-9;
        score[i] = clamp((c - prev) / (atrRef * 1.1), -1, 1);
      } else {
        const drift = clamp((c - ind.bbMid[i]) / Math.max(1e-9, bbU - bbL), -1, 1);
        score[i] = drift * 0.4;
      }
    }
    return { score, active };
  },
};

/** Hurst-aware adaptive regime switcher. */
const hurstSwitch: AlphaModel = {
  key: "st_hurst_switch",
  name: "Hurst Adaptive Regime Switch",
  family: "statistical",
  horizon: 10,
  description:
    "Estimates the rescaled-range Hurst exponent each bar and morphs between persistence (H > 0.55) and anti-persistence (H < 0.45) behaviour automatically.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("statistical", regime);
    for (let i = 1; i < n; i++) {
      const h = ind.hurst[i];
      const mom = ind.close[i] / ind.close[i - 1] - 1;
      const vol = ind.realizedVol[i] || 0.02;
      const norm = clamp(mom / (vol * 1.6), -1, 1);
      if (!Number.isFinite(h)) continue;
      if (h > 0.55) score[i] = norm;
      else if (h < 0.45) score[i] = -norm * 1.15;
      else score[i] = norm * 0.2;
    }
    return { score, active };
  },
};

/** Candlestick auction scalper — the high hit-rate engine. */
const patternScalper: AlphaModel = {
  key: "mr_pattern_scalper",
  name: "Microstructure Pattern Scalper",
  family: "mean_reversion",
  horizon: 3,
  description:
    "Multi-signal micro-scalper: candlestick reversal anatomy, Williams %R saturation, StochRSI pivots and VWAP snap-back, blended into a very high hit-rate signal.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    for (let i = 1; i < n; i++) {
      const wr = ind.williamsR[i];
      const srsi = ind.stochRsi[i];
      const pat = ind.patternScore[i];
      const cci = ind.cci[i];
      if (!Number.isFinite(wr) || !Number.isFinite(srsi)) continue;
      let s = 0;
      if (wr < -82) s += 0.35 * clamp((-82 - wr) / 18, 0, 1.4);
      if (wr > -18) s -= 0.35 * clamp((wr + 18) / 18, 0, 1.4);
      if (srsi < 0.12) s += 0.3;
      if (srsi > 0.88) s -= 0.3;
      if (Number.isFinite(pat)) s += pat * 0.25;
      if (Number.isFinite(cci)) {
        if (cci < -160) s += 0.25;
        if (cci > 160) s -= 0.25;
      }
      const vwapPull = ind.vwap[i];
      if (Number.isFinite(vwapPull)) {
        const dev = ind.vwapDev[i] || ind.atr[i] || 0;
        if (dev > 0) s -= clamp((ind.close[i] - vwapPull) / (dev * 2.1), -1, 1) * 0.25;
      }
      score[i] = clamp(s, -1, 1);
    }
    return { score, active };
  },
};

/**
 * Connors RSI(2) pullback — the publicly documented Connors Research rule:
 * buy short-term exhaustion ONLY above the long-term trend line, sell strength
 * below it. High hit rate by construction, tiny parameter surface (2, 200),
 * which is exactly why it degrades slowly out of sample.
 */
const connorsRsi2: AlphaModel = {
  key: "mr_connors_rsi2",
  name: "Connors RSI(2) Pullback",
  family: "mean_reversion",
  horizon: 5,
  description:
    "Publiziertes Connors-Regelwerk: RSI(2)-Erschöpfung nur in Richtung des 200er-Trends faden, Exit auf Stärke. Wenige Parameter = langsames Decay.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = regime.map((r) => r !== "shock");
    const ma5 = sma(ind.close, 5);
    for (let i = 0; i < n; i++) {
      const r = ind.rsi2[i];
      const trend = ind.ema200[i];
      if (!Number.isFinite(r) || !Number.isFinite(trend)) continue;
      if (ind.close[i] > trend && r < 15) {
        score[i] = clamp((15 - r) / 12, 0, 1) * (ind.close[i] < ma5[i] ? 1 : 0.55);
      } else if (ind.close[i] < trend && r > 85) {
        score[i] = -clamp((r - 85) / 12, 0, 1) * (ind.close[i] > ma5[i] ? 1 : 0.55);
      }
    }
    return { score, active };
  },
};

/**
 * Turtle System 2 — the published Turtle Trading rules: 55-bar channel entry
 * with the 20-bar "already broken" filter, conviction scaled by ADX. Entries
 * fire on the cross and stay voiced while price rides the breakout zone.
 */
const turtleSystem2: AlphaModel = {
  key: "br_turtle_s2",
  name: "Turtle 55/20 Breakout (System 2)",
  family: "breakout",
  horizon: 40,
  description:
    "Publizierte Turtle-Regeln: 55er-Kanal Entry mit 20er-Pre-Break-Filter, der bereits gelaufene Ausbrüche überspringt; ADX skaliert die Conviction.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("breakout", regime);
    const hi55 = rollingMax(ind.high, 55);
    const lo55 = rollingMin(ind.low, 55);
    for (let i = 1; i < n; i++) {
      const prevHi = hi55[i - 1];
      const prevLo = lo55[i - 1];
      if (!Number.isFinite(prevHi) || !Number.isFinite(prevLo)) continue;
      const adx = Number.isFinite(ind.adx[i]) ? clamp((ind.adx[i] - 15) / 25, 0.3, 1.2) : 0.6;
      const crossUp = ind.close[i] > prevHi && ind.close[i - 1] <= prevHi;
      const crossDn = ind.close[i] < prevLo && ind.close[i - 1] >= prevLo;
      const freshUp = ind.close[i - 1] <= (ind.donchianHigh[i - 1] ?? Number.POSITIVE_INFINITY);
      const freshDn = ind.close[i - 1] >= (ind.donchianLow[i - 1] ?? Number.NEGATIVE_INFINITY);
      if (crossUp && freshUp) score[i] = adx;
      else if (crossDn && freshDn) score[i] = -adx;
      else if (ind.close[i] > prevHi) score[i] = 0.55 * adx;
      else if (ind.close[i] < prevLo) score[i] = -0.55 * adx;
    }
    return { score, active };
  },
};

/**
 * 2B false-breakout fade — Linda Raschke's published pattern: a push beyond
 * the prior swing high/low that closes back inside the range is a trap.
 * Fade it toward the range mean, sized by penetration depth.
 */
const falseBreakout2B: AlphaModel = {
  key: "mr_2b_fade",
  name: "2B False-Breakout Fade",
  family: "mean_reversion",
  horizon: 6,
  description:
    "Publiziertes 2B-Muster (Raschke): Ausbruch über das Swing-Hoch, der zurück in die Range schließt, ist eine Falle — Fade Richtung Range-Mitte.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("mean_reversion", regime);
    for (let i = 1; i < n; i++) {
      const priorHi = ind.donchianHigh[i - 1];
      const priorLo = ind.donchianLow[i - 1];
      if (!Number.isFinite(priorHi) || !Number.isFinite(priorLo)) continue;
      const range = Math.max(1e-12, priorHi - priorLo);
      const trapUp = ind.high[i] > priorHi && ind.close[i] < priorHi;
      const trapDn = ind.low[i] < priorLo && ind.close[i] > priorLo;
      if (trapUp) score[i] = -clamp(((ind.high[i] - priorHi) / range) * 6 + 0.4, 0, 1);
      else if (trapDn) score[i] = clamp(((priorLo - ind.low[i]) / range) * 6 + 0.4, 0, 1);
    }
    return { score, active };
  },
};

/** Cross-sectional style momentum carry within the single instrument. */
const carryMomentum: AlphaModel = {
  key: "tr_carry",
  name: "Multi-Timeframe Momentum Carry",
  family: "momentum",
  horizon: 20,
  description:
    "Blends 3/8/21/55-bar risk-adjusted momentum into a carry tilt, neutralised by realised volatility so that all signals are volatility comparable.",
  evaluate(ctx: AlphaContext): StrategyOutput {
    const { ind, regime } = ctx;
    const n = ind.close.length;
    const score = initScore(n);
    const active = gateFor("momentum", regime);
    const rets = ind.logReturn;
    const w1 = 3;
    const w2 = 8;
    const w3 = 21;
    const w4 = 55;
    const cum = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + rets[i];
    for (let i = w4; i < n; i++) {
      const m1 = cum[i] - cum[i - w1];
      const m2 = cum[i] - cum[i - w2];
      const m3 = cum[i] - cum[i - w3];
      const m4 = cum[i] - cum[i - w4];
      const vol = ind.realizedVol[i] || 0.03;
      const scale = 1 / Math.max(vol * Math.sqrt(21), 1e-9);
      const blend = m1 * 0.1 + m2 * 0.2 + m3 * 0.3 + m4 * 0.4;
      const adj = clamp(blend * scale, -1.6, 1.6);
      const r2 = ind.linregR2[i];
      const trendQuality = Number.isFinite(r2) ? clamp(r2 * 2.2, 0, 1) : 0.5;
      score[i] = clamp(adj * (0.5 + 0.5 * trendQuality), -1, 1);
    }
    return { score, active };
  },
};

type SequenceOutputAlias = StrategyOutput;

export const ALPHA_MODELS: AlphaModel[] = [
  patternScalper,
  rsi2Reversion,
  bollingerReversion,
  vwapReversion,
  kalmanReversion,
  volumeNodeFade,
  hurstSwitch,
  superTrendModel,
  donchianBreakout,
  macdStack,
  ichimokuModel,
  volExpansion,
  carryMomentum,
  connorsRsi2,
  turtleSystem2,
  falseBreakout2B,
];

export const ALPHA_REGISTRY: Record<string, AlphaModel> = Object.fromEntries(
  ALPHA_MODELS.map((m) => [m.key, m]),
);

export function alphaName(key: string): string {
  return ALPHA_REGISTRY[key]?.name ?? key;
}

/** Rolling edge score used for adaptive ensemble weighting (information coefficient proxy). */
export function rollingEdge(score: number[], forwardReturn: number[], window: number): number[] {
  const n = score.length;
  const out = new Array<number>(n).fill(0);
  const buf: { s: number; r: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(score[i]) && Number.isFinite(forwardReturn[i])) {
      buf.push({ s: score[i], r: forwardReturn[i] });
    }
    if (buf.length > window) buf.shift();
    if (buf.length < 30) continue;
    const xs = buf.map((b) => b.s);
    const ys = buf.map((b) => b.r);
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (const b of buf) {
      num += (b.s - mx) * (b.r - my);
      dx += (b.s - mx) ** 2;
      dy += (b.r - my) ** 2;
    }
    out[i] = dx > 0 && dy > 0 ? clamp(num / Math.sqrt(dx * dy), -1, 1) : 0;
  }
  return out;
}

/** Smoothed score series helper (used to avoid whipsaw in the meta feature set). */
export function smoothScore(score: number[], period: number): number[] {
  return ema(score.map((v) => (Number.isFinite(v) ? v : 0)), period);
}
