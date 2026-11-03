import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  BacktestMetrics,
  EnsembleParams,
  MarketRegime,
  RiskProfile,
} from "@/lib/quant/types";

/* -------------------------------------------------------------------------- */
/*  Market universe                                                           */
/* -------------------------------------------------------------------------- */

export const instruments = pgTable(
  "instruments",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    name: text("name").notNull(),
    assetClass: text("asset_class").notNull(),
    source: text("source").notNull().default("synthetic"),
    quoteCurrency: text("quote_currency").notNull().default("USD"),
    tickSize: doublePrecision("tick_size").notNull().default(0.01),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("instruments_ticker_key").on(t.ticker)],
);

export const candles = pgTable(
  "candles",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    timeframe: text("timeframe").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume").notNull(),
    /** who produced these bars: bridge (real broker), binance, or cache */
    source: text("source").notNull().default("binance"),
  },
  (t) => [
    uniqueIndex("candles_key").on(t.ticker, t.timeframe, t.ts),
    index("candles_lookup").on(t.ticker, t.timeframe),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Research / backtesting                                                    */
/* -------------------------------------------------------------------------- */

export const backtestRuns = pgTable(
  "backtest_runs",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    ticker: text("ticker").notNull(),
    timeframe: text("timeframe").notNull(),
    bars: integer("bars").notNull(),
    startTs: bigint("start_ts", { mode: "number" }).notNull(),
    endTs: bigint("end_ts", { mode: "number" }).notNull(),
    dataSource: text("data_source").notNull().default("synthetic"),
    preset: text("preset").notNull(),
    targetWinRate: doublePrecision("target_win_rate").notNull().default(0.85),
    winRate: doublePrecision("win_rate").notNull(),
    profitFactor: doublePrecision("profit_factor").notNull(),
    expectancyR: doublePrecision("expectancy_r").notNull(),
    netReturn: doublePrecision("net_return").notNull(),
    sharpe: doublePrecision("sharpe").notNull(),
    deflatedSharpe: doublePrecision("deflated_sharpe").notNull(),
    maxDrawdown: doublePrecision("max_drawdown").notNull(),
    tradeCount: integer("trade_count").notNull(),
    oosWinRate: doublePrecision("oos_win_rate"),
    oosProfitFactor: doublePrecision("oos_profit_factor"),
    pbo: doublePrecision("pbo"),
    durationMs: integer("duration_ms").notNull(),
    params: jsonb("params").$type<EnsembleParams>().notNull(),
    risk: jsonb("risk").$type<RiskProfile>().notNull(),
    metrics: jsonb("metrics").$type<BacktestMetrics>().notNull(),
    attribution: jsonb("attribution").$type<unknown>(),
    walkForward: jsonb("walk_forward").$type<unknown>(),
    monteCarlo: jsonb("monte_carlo").$type<unknown>(),
    trials: integer("trials").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("backtest_runs_created").on(t.createdAt)],
);

export const backtestTrades = pgTable(
  "backtest_trades",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    seq: integer("seq").notNull(),
    side: text("side").notNull(),
    alphaKey: text("alpha_key").notNull(),
    entryTs: bigint("entry_ts", { mode: "number" }).notNull(),
    exitTs: bigint("exit_ts", { mode: "number" }).notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    exitPrice: doublePrecision("exit_price").notNull(),
    qty: doublePrecision("qty").notNull(),
    grossPnl: doublePrecision("gross_pnl").notNull(),
    fees: doublePrecision("fees").notNull(),
    slippage: doublePrecision("slippage").notNull(),
    netPnl: doublePrecision("net_pnl").notNull(),
    rMultiple: doublePrecision("r_multiple").notNull(),
    maeR: doublePrecision("mae_r").notNull(),
    mfeR: doublePrecision("mfe_r").notNull(),
    holdingBars: integer("holding_bars").notNull(),
    exitReason: text("exit_reason").notNull(),
    regime: text("regime").$type<MarketRegime>().notNull(),
    confidence: doublePrecision("confidence").notNull(),
    metaProb: doublePrecision("meta_prob").notNull(),
  },
  (t) => [index("backtest_trades_run").on(t.runId, t.seq)],
);

export const optimizationTrials = pgTable(
  "optimization_trials",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id").notNull(),
    iteration: integer("iteration").notNull(),
    stage: text("stage").notNull(),
    params: jsonb("params").$type<EnsembleParams>().notNull(),
    objective: doublePrecision("objective").notNull(),
    winRate: doublePrecision("win_rate").notNull(),
    profitFactor: doublePrecision("profit_factor").notNull(),
    netReturn: doublePrecision("net_return").notNull(),
    maxDrawdown: doublePrecision("max_drawdown").notNull(),
    tradeCount: integer("trade_count").notNull(),
  },
  (t) => [index("optimization_trials_run").on(t.runId, t.iteration)],
);

/* -------------------------------------------------------------------------- */
/*  Live signal engine + paper brokerage                                      */
/* -------------------------------------------------------------------------- */

export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    ticker: text("ticker").notNull(),
    timeframe: text("timeframe").notNull(),
    barTs: bigint("bar_ts", { mode: "number" }).notNull(),
    direction: text("direction").notNull(),
    alphaKey: text("alpha_key").notNull(),
    score: doublePrecision("score").notNull(),
    metaProb: doublePrecision("meta_prob").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    stopPrice: doublePrecision("stop_price").notNull(),
    targetPrice: doublePrecision("target_price").notNull(),
    regime: text("regime").$type<MarketRegime>().notNull(),
    votes: jsonb("votes").$type<Record<string, number>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signals_ticker").on(t.ticker, t.timeframe, t.barTs)],
);

/* -------------------------------------------------------------------------- */
/*  Live execution: MT5 bridge OMS                                            */
/* -------------------------------------------------------------------------- */

/** Registered execution agents (MT5 terminals running the bridge EA). */
export const executionBridges = pgTable(
  "execution_bridges",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    adapter: text("adapter").notNull().default("mt5_ea"),
    status: text("status").notNull().default("offline"),
    metaAccountId: text("meta_account_id"),
    mt5Login: text("mt5_login"),
    mt5Server: text("mt5_server"),
    mt5Build: text("mt5_build"),
    accountMode: text("account_mode"),
    accountCurrency: text("account_currency"),
    balance: doublePrecision("balance"),
    equity: doublePrecision("equity"),
    margin: doublePrecision("margin"),
    marginFree: doublePrecision("margin_free"),
    marginLevel: doublePrecision("margin_level"),
    openPositions: integer("open_positions").notNull().default(0),
    version: text("version"),
    dryRun: boolean("dry_run"),
    eaVersion: text("ea_version"),
    feedSummary: text("feed_summary"),
    feedUpdatedAt: timestamp("feed_updated_at", { withTimezone: true }),
    capabilities: jsonb("capabilities").$type<string[]>(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("execution_bridges_status").on(t.status)],
);

/** Internal ticker -> broker symbol mapping plus contract specification. */
export const brokerInstruments = pgTable(
  "broker_instruments",
  {
    id: serial("id").primaryKey(),
    bridgeId: integer("bridge_id"),
    ticker: text("ticker").notNull(),
    symbol: text("symbol").notNull(),
    digits: integer("digits").notNull().default(5),
    point: doublePrecision("point").notNull().default(0.00001),
    contractSize: doublePrecision("contract_size").notNull().default(1),
    minVolume: doublePrecision("min_volume").notNull().default(0.01),
    maxVolume: doublePrecision("max_volume").notNull().default(100),
    volumeStep: doublePrecision("volume_step").notNull().default(0.01),
    stopsLevel: integer("stops_level").notNull().default(0),
    freezeLevel: integer("freeze_level").notNull().default(0),
    tradeMode: integer("trade_mode").notNull().default(4),
    spreadPoints: doublePrecision("spread_points").notNull().default(0),
    marginCurrency: text("margin_currency"),
    tickValue: doublePrecision("tick_value"),
    active: boolean("active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("broker_instruments_key").on(t.bridgeId, t.ticker)],
);

/** The order queue. This is the single source of truth for the EA. */
export const executionOrders = pgTable(
  "execution_orders",
  {
    id: serial("id").primaryKey(),
    bridgeId: integer("bridge_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    source: text("source").notNull().default("signal"),
    action: text("action").notNull().default("OPEN"),
    ticker: text("ticker").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    volume: doublePrecision("volume").notNull(),
    requestedVolume: doublePrecision("requested_volume"),
    entryPrice: doublePrecision("entry_price"),
    stopPrice: doublePrecision("stop_price"),
    targetPrice: doublePrecision("target_price"),
    comment: text("comment"),
    state: text("state").notNull().default("PENDING"),
    metaProb: doublePrecision("meta_prob"),
    confidence: doublePrecision("confidence"),
    alphaKey: text("alpha_key"),
    regime: text("regime"),
    runId: integer("run_id"),
    signalId: integer("signal_id"),
    mt5Position: text("mt5_position"),
    mt5Deal: text("mt5_deal"),
    mt5Order: text("mt5_order"),
    fillPrice: doublePrecision("fill_price"),
    fillVolume: doublePrecision("fill_volume"),
    slippagePoints: doublePrecision("slippage_points"),
    retcode: integer("retcode"),
    retcodeText: text("retcode_text"),
    errorText: text("error_text"),
    attempts: integer("attempts").notNull().default(0),
    riskSnapshot: jsonb("risk_snapshot").$type<Record<string, unknown>>(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    filledAt: timestamp("filled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("execution_orders_idem").on(t.idempotencyKey),
    index("execution_orders_state").on(t.state, t.id),
  ],
);

/** Mirror of the broker's open/closed positions for reconciliation. */
export const executionPositions = pgTable(
  "execution_positions",
  {
    id: serial("id").primaryKey(),
    bridgeId: integer("bridge_id").notNull(),
    mt5Ticket: text("mt5_ticket").notNull(),
    symbol: text("symbol").notNull(),
    ticker: text("ticker"),
    side: text("side").notNull(),
    volume: doublePrecision("volume").notNull(),
    openPrice: doublePrecision("open_price").notNull(),
    currentPrice: doublePrecision("current_price"),
    sl: doublePrecision("sl"),
    tp: doublePrecision("tp"),
    profit: doublePrecision("profit").notNull().default(0),
    swap: doublePrecision("swap").notNull().default(0),
    commission: doublePrecision("commission").notNull().default(0),
    magic: bigint("magic", { mode: "number" }),
    comment: text("comment"),
    alphaKey: text("alpha_key"),
    metaProb: doublePrecision("meta_prob"),
    orderId: integer("order_id"),
    status: text("status").notNull().default("open"),
    openedTs: bigint("opened_ts", { mode: "number" }),
    closedTs: bigint("closed_ts", { mode: "number" }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("execution_positions_key").on(t.bridgeId, t.mt5Ticket)],
);

/** Singleton pre-trade risk / kill-switch configuration. */
export const executionControls = pgTable("execution_controls", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull().default("primary"),
  mode: text("mode").notNull().default("paper"),
  armed: boolean("armed").notNull().default(false),
  killSwitch: boolean("kill_switch").notNull().default(true),
  confirmMode: text("confirm_mode").notNull().default("manual"),
  minMetaProb: doublePrecision("min_meta_prob").notNull().default(0.7),
  minConfidence: doublePrecision("min_confidence").notNull().default(0.2),
  maxDailyOrders: integer("max_daily_orders").notNull().default(12),
  maxDailyLossPct: doublePrecision("max_daily_loss_pct").notNull().default(0.03),
  maxNotionalPct: doublePrecision("max_notional_pct").notNull().default(0.9),
  maxOpenPositions: integer("max_open_positions").notNull().default(3),
  maxPositionsPerSymbol: integer("max_positions_per_symbol").notNull().default(1),
  maxSpreadPoints: doublePrecision("max_spread_points").notNull().default(30),
  allowedSymbols: text("allowed_symbols"),
  sessionStartUtc: integer("session_start_utc").notNull().default(0),
  sessionEndUtc: integer("session_end_utc").notNull().default(24),
  weekendHalt: boolean("weekend_halt").notNull().default(true),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(900),
  lotMultiplier: doublePrecision("lot_multiplier").notNull().default(1),
  requireStopLoss: boolean("require_stop_loss").notNull().default(true),
  orderTtlSeconds: integer("order_ttl_seconds").notNull().default(90),
  /** EA-side protective exit parameters, mirrored from the winning backtest */
  trailingAtrMult: doublePrecision("trailing_atr_mult").notNull().default(1.6),
  breakevenAtR: doublePrecision("breakeven_at_r").notNull().default(0.5),
  partialFraction: doublePrecision("partial_fraction").notNull().default(0.5),
  partialAtR: doublePrecision("partial_at_r").notNull().default(1),
  metaApiAccountId: text("meta_api_account_id"),
  /** periodic server-side scan & dispatch while armed */
  autopilot: boolean("autopilot").notNull().default(false),
  autopilotMinutes: integer("autopilot_minutes").notNull().default(5),
  autopilotSymbols: text("autopilot_symbols").notNull().default("BTCUSDT"),
  autopilotPreset: text("autopilot_preset").notNull().default("apex_hit_rate"),
  autopilotTimeframe: text("autopilot_timeframe").notNull().default("1h"),
  autopilotTarget: doublePrecision("autopilot_target").notNull().default(0.85),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable audit trail of every execution decision. */
export const executionEvents = pgTable(
  "execution_events",
  {
    id: serial("id").primaryKey(),
    level: text("level").notNull().default("info"),
    scope: text("scope").notNull().default("bridge"),
    message: text("message").notNull(),
    orderId: integer("order_id"),
    bridgeId: integer("bridge_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("execution_events_created").on(t.createdAt)],
);

export const paperAccounts = pgTable("paper_accounts", {
  id: serial("id").primaryKey(),
  owner: text("owner").notNull().default("primary"),
  cash: doublePrecision("cash").notNull(),
  equity: doublePrecision("equity").notNull(),
  realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
  feesPaid: doublePrecision("fees_paid").notNull().default(0),
  peakEquity: doublePrecision("peak_equity").notNull(),
  maxDrawdown: doublePrecision("max_drawdown").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paperPositions = pgTable(
  "paper_positions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id").notNull(),
    ticker: text("ticker").notNull(),
    timeframe: text("timeframe").notNull().default("1h"),
    side: text("side").notNull(),
    status: text("status").notNull().default("open"),
    qty: doublePrecision("qty").notNull(),
    remainingQty: doublePrecision("remaining_qty").notNull(),
    entryPrice: doublePrecision("entry_price").notNull(),
    stopPrice: doublePrecision("stop_price").notNull(),
    targetPrice: doublePrecision("target_price").notNull(),
    leverage: doublePrecision("leverage").notNull().default(1),
    riskR: doublePrecision("risk_r").notNull(),
    realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
    fees: doublePrecision("fees").notNull().default(0),
    rMultiple: doublePrecision("r_multiple"),
    exitReason: text("exit_reason"),
    alphaKey: text("alpha_key").notNull().default("ensemble"),
    regime: text("regime").$type<MarketRegime>().notNull().default("range"),
    openedTs: bigint("opened_ts", { mode: "number" }).notNull(),
    closedTs: bigint("closed_ts", { mode: "number" }),
    metaProb: doublePrecision("meta_prob").notNull().default(0),
  },
  (t) => [index("paper_positions_account").on(t.accountId, t.status)],
);
