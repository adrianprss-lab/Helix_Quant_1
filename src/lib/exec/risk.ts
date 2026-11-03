import type { OrderSide } from "./protocol";

export interface RiskContext {
  mode: string;
  armed: boolean;
  killSwitch: boolean;
  confirmMode: string;
  minMetaProb: number;
  minConfidence: number;
  maxDailyOrders: number;
  maxDailyLossPct: number;
  maxNotionalPct: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  maxSpreadPoints: number;
  allowedSymbols: string[];
  sessionStartUtc: number;
  sessionEndUtc: number;
  weekendHalt: boolean;
  cooldownSeconds: number;
  requireStopLoss: boolean;
  bridgeOnline: boolean;
  bridgeStaleSeconds: number;
  equity: number;
  marginFree: number;
  marginLevelPct: number;
  openPositionCount: number;
  openPositionsForSymbol: number;
  openNotional: number;
  ordersToday: number;
  realizedPnlToday: number;
  secondsSinceLastOrderForSymbol: number;
}

export interface OrderCandidate {
  symbol: string;
  side: OrderSide;
  volume: number;
  price: number;
  stopPrice: number;
  targetPrice: number;
  metaProb: number;
  confidence: number;
  spreadPoints: number;
  notional: number;
}

export type RiskCode =
  | "OK"
  | "MODE_NOT_LIVE"
  | "NOT_ARMED"
  | "KILL_SWITCH"
  | "MANUAL_CONFIRM"
  | "OUTSIDE_SESSION"
  | "WEEKEND_HALT"
  | "DAILY_ORDER_LIMIT"
  | "DAILY_LOSS_LIMIT"
  | "MAX_POSITIONS"
  | "MAX_POSITIONS_SYMBOL"
  | "NOTIONAL_LIMIT"
  | "SPREAD_TOO_WIDE"
  | "SYMBOL_NOT_ALLOWED"
  | "TRADE_MODE_RESTRICTED"
  | "META_PROB_BELOW_FLOOR"
  | "CONFIDENCE_BELOW_FLOOR"
  | "MISSING_STOP_LOSS"
  | "BRIDGE_OFFLINE"
  | "BRIDGE_STALE"
  | "INSUFFICIENT_MARGIN"
  | "COOLDOWN_ACTIVE"
  | "INVALID_VOLUME";

export interface RiskDecision {
  ok: boolean;
  code: RiskCode;
  reason: string;
  /** every check that ran, for the audit panel */
  checks: { code: RiskCode; passed: boolean; detail: string }[];
}

const HUMAN: Record<RiskCode, string> = {
  OK: "all pre-trade checks passed",
  MODE_NOT_LIVE: "execution mode is not set to a live adapter",
  NOT_ARMED: "execution engine is disarmed",
  KILL_SWITCH: "kill switch is engaged",
  MANUAL_CONFIRM: "confirm mode is manual — order queued for operator approval",
  OUTSIDE_SESSION: "outside the configured trading session (UTC)",
  WEEKEND_HALT: "weekend halt active — markets are closed or illiquid",
  DAILY_ORDER_LIMIT: "daily order limit reached",
  DAILY_LOSS_LIMIT: "daily loss circuit breaker tripped",
  MAX_POSITIONS: "maximum concurrent positions reached",
  MAX_POSITIONS_SYMBOL: "maximum positions for this symbol reached",
  NOTIONAL_LIMIT: "notional exposure cap breached",
  SPREAD_TOO_WIDE: "spread exceeds the configured maximum",
  SYMBOL_NOT_ALLOWED: "symbol is not on the allow list",
  TRADE_MODE_RESTRICTED: "broker trade mode forbids this order",
  META_PROB_BELOW_FLOOR: "meta-model P(win) below the floor",
  CONFIDENCE_BELOW_FLOOR: "ensemble confidence below the floor",
  MISSING_STOP_LOSS: "order has no stop loss — refused",
  BRIDGE_OFFLINE: "no execution bridge is online",
  BRIDGE_STALE: "bridge heartbeat is stale",
  INSUFFICIENT_MARGIN: "insufficient free margin for the requested size",
  COOLDOWN_ACTIVE: "symbol cooldown still running",
  INVALID_VOLUME: "volume rounds to zero at the broker lot step",
};

/** Friday 21:00 UTC -> Sunday 22:00 UTC covers most broker weekend windows. */
export function isWeekendWindow(now = new Date()): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (day === 6) return true;
  if (day === 0) return hour < 22;
  if (day === 5) return hour >= 21;
  return false;
}

export function inSession(startUtc: number, endUtc: number, now = new Date()): boolean {
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (startUtc === endUtc) return true;
  if (startUtc < endUtc) return hour >= startUtc && hour < endUtc;
  // window wraps midnight, e.g. 22 -> 06
  return hour >= startUtc || hour < endUtc;
}

/**
 * Pre-trade risk guard. Every rule is evaluated — not short-circuited — so the
 * UI can show the operator exactly which gates a signal passed and failed.
 */
export function evaluateRisk(ctx: RiskContext, order: OrderCandidate): RiskDecision {
  const checks: { code: RiskCode; passed: boolean; detail: string }[] = [];
  const add = (code: RiskCode, passed: boolean, detail: string) => {
    checks.push({ code, passed, detail });
    return passed;
  };

  const live = ctx.mode === "bridge" || ctx.mode === "metaapi";
  add("MODE_NOT_LIVE", live, `mode=${ctx.mode}`);
  add("KILL_SWITCH", !ctx.killSwitch, `killSwitch=${ctx.killSwitch}`);
  add("NOT_ARMED", ctx.armed, `armed=${ctx.armed}`);
  add("BRIDGE_OFFLINE", ctx.bridgeOnline || ctx.mode === "metaapi", `online=${ctx.bridgeOnline}`);
  add("BRIDGE_STALE", ctx.bridgeStaleSeconds < 180 || ctx.mode === "metaapi", `${ctx.bridgeStaleSeconds.toFixed(0)}s since heartbeat`);
  add(
    "OUTSIDE_SESSION",
    inSession(ctx.sessionStartUtc, ctx.sessionEndUtc),
    `session ${ctx.sessionStartUtc}:00-${ctx.sessionEndUtc}:00 UTC, now ${new Date().getUTCHours()}:${String(new Date().getUTCMinutes()).padStart(2, "0")}`,
  );
  add("WEEKEND_HALT", !ctx.weekendHalt || !isWeekendWindow(), `weekendHalt=${ctx.weekendHalt}`);
  add("DAILY_ORDER_LIMIT", ctx.ordersToday < ctx.maxDailyOrders, `${ctx.ordersToday}/${ctx.maxDailyOrders} today`);
  add(
    "DAILY_LOSS_LIMIT",
    ctx.maxDailyLossPct <= 0 ||
      ctx.equity <= 0 ||
      ctx.realizedPnlToday > -ctx.equity * ctx.maxDailyLossPct,
    `pnl today ${ctx.realizedPnlToday.toFixed(2)}, limit ${(-ctx.equity * ctx.maxDailyLossPct).toFixed(2)}`,
  );
  add("MAX_POSITIONS", ctx.openPositionCount < ctx.maxOpenPositions, `${ctx.openPositionCount}/${ctx.maxOpenPositions}`);
  add(
    "MAX_POSITIONS_SYMBOL",
    ctx.openPositionsForSymbol < ctx.maxPositionsPerSymbol,
    `${order.symbol}: ${ctx.openPositionsForSymbol}/${ctx.maxPositionsPerSymbol}`,
  );
  add(
    "NOTIONAL_LIMIT",
    ctx.equity <= 0 || ctx.openNotional + order.notional <= ctx.equity * ctx.maxNotionalPct,
    `notional ${(ctx.openNotional + order.notional).toFixed(0)} / cap ${(ctx.equity * ctx.maxNotionalPct).toFixed(0)}`,
  );
  add(
    "INSUFFICIENT_MARGIN",
    ctx.marginFree <= 0 || order.notional * 0.02 < ctx.marginFree,
    `free margin ${ctx.marginFree.toFixed(2)}`,
  );
  add("SPREAD_TOO_WIDE", order.spreadPoints <= ctx.maxSpreadPoints, `${order.spreadPoints.toFixed(1)} pts / max ${ctx.maxSpreadPoints}`);
  add(
    "SYMBOL_NOT_ALLOWED",
    ctx.allowedSymbols.length === 0 || ctx.allowedSymbols.includes(order.symbol),
    ctx.allowedSymbols.length ? ctx.allowedSymbols.join(",") : "all symbols",
  );
  add("META_PROB_BELOW_FLOOR", order.metaProb >= ctx.minMetaProb, `p=${order.metaProb.toFixed(3)} / floor ${ctx.minMetaProb.toFixed(3)}`);
  add("CONFIDENCE_BELOW_FLOOR", order.confidence >= ctx.minConfidence, `c=${order.confidence.toFixed(3)} / floor ${ctx.minConfidence.toFixed(3)}`);
  add("MISSING_STOP_LOSS", !ctx.requireStopLoss || (order.stopPrice > 0 && Math.abs(order.price - order.stopPrice) > 0), `sl=${order.stopPrice}`);
  add("INVALID_VOLUME", order.volume > 0, `volume=${order.volume}`);
  add(
    "COOLDOWN_ACTIVE",
    ctx.cooldownSeconds <= 0 || ctx.secondsSinceLastOrderForSymbol >= ctx.cooldownSeconds,
    `${ctx.secondsSinceLastOrderForSymbol.toFixed(0)}s / ${ctx.cooldownSeconds}s`,
  );

  const failed = checks.filter((c) => !c.passed);
  const manual = ctx.confirmMode !== "auto";
  const ok = failed.length === 0;
  return {
    ok,
    code: failed.length ? failed[0].code : manual ? "MANUAL_CONFIRM" : "OK",
    reason: failed.length ? HUMAN[failed[0].code] : manual ? HUMAN.MANUAL_CONFIRM : HUMAN.OK,
    checks,
  };
}
