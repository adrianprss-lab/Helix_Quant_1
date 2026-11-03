/**
 * Core type system for the HELIX quantitative research stack.
 * Everything is deliberately explicit and serialisable so that results can be
 * streamed into PostgreSQL (jsonb) and into React server components.
 */

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime =
  | "trend_up"
  | "trend_down"
  | "range"
  | "compression"
  | "expansion"
  | "shock";

export type AlphaFamily =
  | "mean_reversion"
  | "trend"
  | "momentum"
  | "breakout"
  | "volatility"
  | "statistical"
  | "meta";

export interface AlphaVote {
  score: number;
  active: boolean;
  weight: number;
}

export interface StrategyOutput {
  /** signed conviction in [-1, 1]; > 0 long, < 0 short */
  score: number[];
  /** strategy is allowed to express itself at this bar (regime gate) */
  active: boolean[];
}

export interface AlphaModel {
  key: string;
  name: string;
  family: AlphaFamily;
  description: string;
  /** expected holding period in bars, used for regime gating and attribution */
  horizon: number;
  evaluate(ctx: AlphaContext): StrategyOutput;
}

export interface AlphaContext {
  candles: Candle[];
  ind: IndicatorSet;
  regime: MarketRegime[];
  params: EnsembleParams;
}

/** Every indicator is aligned with the candle array (NaN during warm-up). */
export interface IndicatorSet {
  close: number[];
  open: number[];
  high: number[];
  low: number[];
  volume: number[];
  logReturn: number[];

  ema9: number[];
  ema21: number[];
  ema50: number[];
  ema200: number[];
  sma20: number[];
  sma50: number[];
  hma: number[];

  rsi2: number[];
  rsi7: number[];
  rsi14: number[];
  stochRsi: number[];
  macd: number[];
  macdSignal: number[];
  macdHist: number[];

  atr: number[];
  atrPct: number[];
  adx: number[];
  plusDi: number[];
  minusDi: number[];
  bbUpper: number[];
  bbLower: number[];
  bbMid: number[];
  bbWidth: number[];
  percentB: number[];
  zscore: number[];

  supertrend: number[];
  superDir: number[];
  donchianHigh: number[];
  donchianLow: number[];
  donchianMid: number[];
  keltnerUpper: number[];
  keltnerLower: number[];

  tenkan: number[];
  kijun: number[];
  senkouA: number[];
  senkouB: number[];
  chikouShift: number[];

  obv: number[];
  obvSlope: number[];
  mfi: number[];
  cmf: number[];
  vwap: number[];
  vwapDev: number[];
  volumeZ: number[];
  valueAreaHigh: number[];
  valueAreaLow: number[];
  poc: number[];

  realizedVol: number[];
  parkinsonVol: number[];
  garmanKlassVol: number[];
  yangZhangVol: number[];
  volPercentile: number[];
  volOfVol: number[];

  hurst: number[];
  halfLife: number[];
  kalman: number[];
  kalmanResid: number[];
  kalmanResidZ: number[];
  linregSlope: number[];
  linregR2: number[];
  skew: number[];
  kurtosis: number[];

  sar: number[];
  chandelier: number[];
  aroon: number[];
  cci: number[];
  williamsR: number[];
  stochK: number[];
  stochD: number[];
  trima: number[];
  massIndex: number[];
  ulti: number[];
  tsi: number[];
  roc: number[];
  patternScore: number[];
}

export interface EnsembleParams {
  /** minimum blended conviction required to consider an entry */
  confidenceFloor: number;
  /** minimum meta-model probability of success */
  metaThreshold: number;
  /** relative weight of the meta model vs the alpha ensemble (0..1) */
  metaWeight: number;
  /** regime gate strength: 0 = ignore regime, 1 = hard block */
  regimeGate: number;
  /** stop distance in ATR multiples */
  stopAtrMult: number;
  /** profit target in ATR multiples */
  targetAtrMult: number;
  /** fraction of the position scaled out at the first target */
  tp1Fraction: number;
  /** ATR trailing stop multiple */
  trailAtrMult: number;
  /** move stop to breakeven once this many R is banked */
  breakevenAtR: number;
  /** hard time stop in bars */
  timeStopBars: number;
  /** rolling window (bars) used for adaptive alpha weighting */
  weightWindow: number;
  /** meta model training window */
  metaTrainWindow: number;
  /** refit cadence of the meta model in bars */
  metaRefitCadence: number;
  /** allow long entries */
  allowLong: boolean;
  /** allow short entries */
  allowShort: boolean;
  /** L2 regularisation for the online logistic regression */
  metaL2: number;
}

export interface RiskProfile {
  initialEquity: number;
  /** fraction of equity risked per position at stop distance */
  riskPerTrade: number;
  maxLeverage: number;
  maxConcurrentPositions: number;
  /** annualised volatility target; 0 disables volatility targeting */
  targetVol: number;
  /** fraction of full-Kelly used for sizing */
  kellyFraction: number;
  /** daily loss circuit breaker as fraction of equity */
  dailyLossLimit: number;
  takerFeeBps: number;
  makerFeeBps: number;
  slippageBps: number;
  barsPerDay: number;
}

export interface CostModel {
  takerFeeBps: number;
  makerFeeBps: number;
  slippageBps: number;
}

export type ExitReason =
  | "stop"
  | "target"
  | "trail"
  | "breakeven"
  | "time_stop"
  | "signal_flip"
  | "risk_engine"
  | "end_of_data";

export interface Fill {
  ts: number;
  price: number;
  qty: number;
  fee: number;
  slippage: number;
}

export interface Trade {
  seq: number;
  side: "long" | "short";
  alphaKey: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  rMultiple: number;
  maeR: number;
  mfeR: number;
  holdingBars: number;
  exitReason: ExitReason;
  regime: MarketRegime;
  confidence: number;
  metaProb: number;
  riskPerUnit: number;
  equityAfter: number;
  fills: Fill[];
}

export interface EquityPoint {
  ts: number;
  index: number;
  equity: number;
  drawdown: number;
  benchmark: number;
  exposure: number;
}

export interface StrategyAttribution {
  alphaKey: string;
  name: string;
  family: AlphaFamily;
  trades: number;
  netPnl: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  contribution: number;
}

export interface RegimeAttribution {
  regime: MarketRegime;
  bars: number;
  trades: number;
  netPnl: number;
  winRate: number;
  exposure: number;
}

export interface BacktestMetrics {
  bars: number;
  warmupBars: number;
  trades: number;
  winRate: number;
  lossRate: number;
  longTrades: number;
  shortTrades: number;
  longWinRate: number;
  shortWinRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  netReturn: number;
  cagr: number;
  profitFactor: number;
  expectancy: number;
  expectancyR: number;
  payoffRatio: number;
  avgWin: number;
  avgLoss: number;
  avgTradeR: number;
  avgHoldingBars: number;
  maxWinStreak: number;
  maxLossStreak: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  omega: number;
  ulcerIndex: number;
  sqn: number;
  maxDrawdown: number;
  maxDrawdownAbs: number;
  maxDrawdownBars: number;
  recoveryFactor: number;
  exposurePct: number;
  turnover: number;
  feeDrag: number;
  slippageDrag: number;
  var95: number;
  cvar95: number;
  tailRatio: number;
  kelly: number;
  probabilisticSharpe: number;
  deflatedSharpe: number;
  tStat: number;
  pValue: number;
  bestTrade: number;
  worstTrade: number;
  finalEquity: number;
}

export interface FoldResult {
  fold: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  trainMetrics: BacktestMetrics;
  testMetrics: BacktestMetrics;
  degradation: number;
}

export interface WalkForwardReport {
  anchored: boolean;
  folds: FoldResult[];
  aggregatedWinRate: number;
  aggregatedProfitFactor: number;
  aggregatedReturn: number;
  aggregateSharpe: number;
  consistency: number;
  degradationScore: number;
  oosWinRate: number;
  oosProfitFactor: number;
  oosExpectancyR: number;
}

export interface MonteCarloReport {
  iterations: number;
  blockSize: number;
  percentiles: { p05: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  finalReturnPercentiles: { p05: number; p25: number; p50: number; p75: number; p95: number };
  drawdownPercentiles: { p50: number; p95: number; p99: number; worst: number };
  riskOfRuin: number;
  probLoss: number;
  probTargetWinRate: number;
  medianTimeToDouble: number;
}

export interface PboReport {
  blocks: number;
  combinations: number;
  pbo: number;
  logitMean: number;
  oosRankCorrelation: number;
  verdict: string;
}

export interface AlphaEnsembleBar {
  index: number;
  ts: number;
  score: number;
  confidence: number;
  direction: "long" | "short" | "flat";
  metaProb: number;
  regime: MarketRegime;
  votes: Record<string, number>;
  weights: Record<string, number>;
}

export interface OptimizationTrialRecord {
  iteration: number;
  stage: "population" | "mutation" | "crossover" | "elitist";
  params: EnsembleParams;
  objective: number;
  winRate: number;
  profitFactor: number;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
}

export interface BacktestResult {
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  attribution: StrategyAttribution[];
  regimeAttribution: RegimeAttribution[];
  monthlyReturns: { label: string; return: number }[];
  rolledWinRate: { ts: number; winRate: number; trades: number }[];
  signals: AlphaEnsembleBar[];
}

export interface PipelineResult {
  runId?: number;
  label: string;
  ticker: string;
  timeframe: string;
  dataSource: string;
  preset: string;
  bars: number;
  candles: Candle[];
  params: EnsembleParams;
  risk: RiskProfile;
  inSample: BacktestResult;
  outOfSample: BacktestResult | null;
  walkForward: WalkForwardReport | null;
  monteCarlo: MonteCarloReport | null;
  pbo: PboReport | null;
  optimization: {
    enabled: boolean;
    trials: OptimizationTrialRecord[];
    bestObjective: number;
    generations: number;
    evaluations: number;
  };
  targetWinRate: number;
  achievedWinRate: number;
  durationMs: number;
  diagnostics: string[];
}

export interface SignalCandidate {
  ticker: string;
  timeframe: string;
  barTs: number;
  direction: "long" | "short";
  alphaKey: string;
  score: number;
  metaProb: number;
  confidence: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  regime: MarketRegime;
  votes: Record<string, number>;
  atrPct: number;
  trendFilter: string;
  expectedHoldBars: number;
}
