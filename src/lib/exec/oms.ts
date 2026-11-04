import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  brokerInstruments,
  executionBridges,
  executionControls,
  executionEvents,
  executionOrders,
  executionPositions,
} from "@/db/schema";
import type { SignalCandidate } from "@/lib/quant/types";
import { UNIVERSE, getInstrument, type Timeframe } from "@/lib/quant/data";
import { clamp } from "@/lib/quant/math";
import {
  generateAgentToken,
  hashToken,
  idempotencyKey,
  orderComment,
  orderIdFromComment,
  type ControlsPayload,
  type DispatchOrder,
  type OrderAction,
  type OrderSide,
  type OrderState,
} from "./protocol";
import { evaluateRisk, isWeekendWindow, type RiskContext, type RiskDecision } from "./risk";
import { lastKnock } from "./bridgeAuth";

/* ------------------------------- instrument ------------------------------- */

export interface InstrumentSpec {
  ticker: string;
  symbol: string;
  digits: number;
  point: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  stopsLevel: number;
  freezeLevel: number;
  tradeMode: number;
  spreadPoints: number;
  tickValue: number | null;
  marginCurrency: string | null;
  source: "broker" | "default";
  active: boolean;
}

/** Conservative fallback specs used until the EA reports the real contract. */
export function defaultSpecFor(ticker: string): InstrumentSpec {
  const inst = getInstrument(ticker);
  const crypto = inst.assetClass === "crypto";
  const metal = ticker.includes("XAU") || ticker.includes("XAG");
  const index = inst.assetClass === "index";
  const base: InstrumentSpec = {
    ticker,
    symbol: ticker,
    digits: crypto ? 2 : metal ? 2 : index ? 1 : 5,
    point: crypto ? 0.01 : metal ? 0.01 : index ? 0.1 : 0.00001,
    contractSize: crypto ? 1 : metal ? 100 : index ? 1 : 100_000,
    minVolume: crypto ? 0.001 : 0.01,
    maxVolume: crypto ? 1000 : 200,
    volumeStep: crypto ? 0.001 : 0.01,
    stopsLevel: 0,
    freezeLevel: 0,
    // MT5 SYMBOL_TRADE_MODE_FULL. A fallback spec means "not yet reported by
    // the broker", never "disabled" — defaulting to 0 would silently block
    // every order until the agent publishes the real contract.
    tradeMode: 4,
    spreadPoints: 0,
    tickValue: null,
    marginCurrency: inst.quoteCurrency,
    source: "default",
    active: true,
  };
  return base;
}

export async function resolveInstrument(bridgeId: number | null, ticker: string): Promise<InstrumentSpec> {
  const rows = await db
    .select()
    .from(brokerInstruments)
    .where(
      and(
        eq(brokerInstruments.ticker, ticker),
        bridgeId === null ? isNull(brokerInstruments.bridgeId) : eq(brokerInstruments.bridgeId, bridgeId),
      ),
    )
    .limit(1);
  let row = rows[0];
  if (!row && bridgeId !== null) {
    const globals = await db
      .select()
      .from(brokerInstruments)
      .where(and(eq(brokerInstruments.ticker, ticker), isNull(brokerInstruments.bridgeId)))
      .limit(1);
    row = globals[0];
  }
  if (!row) return defaultSpecFor(ticker);
  return {
    ticker: row.ticker,
    symbol: row.symbol,
    digits: row.digits,
    point: row.point,
    contractSize: row.contractSize,
    minVolume: row.minVolume,
    maxVolume: row.maxVolume,
    volumeStep: row.volumeStep,
    stopsLevel: row.stopsLevel,
    freezeLevel: row.freezeLevel,
    tradeMode: row.tradeMode,
    spreadPoints: row.spreadPoints,
    tickValue: row.tickValue,
    marginCurrency: row.marginCurrency,
    source: "broker",
    active: row.active,
  };
}

/** Round a raw unit quantity into a broker-legal lot size. */
export function toLots(units: number, spec: InstrumentSpec, lotMultiplier = 1): number {
  const lots = (units / spec.contractSize) * lotMultiplier;
  if (!Number.isFinite(lots) || lots <= 0) return 0;
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.01;
  const rounded = Math.floor(lots / step + 1e-9) * step;
  const clamped = clamp(rounded, spec.minVolume, spec.maxVolume);
  return Number(clamped.toFixed(8));
}

/** Risk-based sizing: how many lots put exactly `riskFraction` of equity at risk. */
export function sizeByRisk(args: {
  equity: number;
  riskFraction: number;
  price: number;
  stopPrice: number;
  spec: InstrumentSpec;
  lotMultiplier?: number;
}): { volume: number; lossPerLot: number; notional: number; riskAmount: number } {
  const { equity, riskFraction, price, stopPrice, spec } = args;
  const stopDistance = Math.abs(price - stopPrice);
  const riskAmount = Math.max(0, equity * riskFraction);
  const tickSize = spec.point > 0 ? spec.point : 0.00001;
  const lossPerLot =
    spec.tickValue && spec.tickValue > 0
      ? (stopDistance / tickSize) * spec.tickValue
      : stopDistance * spec.contractSize;
  if (!(lossPerLot > 0)) return { volume: 0, lossPerLot: 0, notional: 0, riskAmount };
  const rawLots = riskAmount / lossPerLot;
  const volume = toLots(rawLots * spec.contractSize, spec, args.lotMultiplier ?? 1);
  return { volume, lossPerLot, notional: volume * spec.contractSize * price, riskAmount };
}

/** Push SL/TP outside the broker's minimum stop distance. */
export function enforceStopLevel(
  side: OrderSide,
  price: number,
  stop: number,
  target: number,
  spec: InstrumentSpec,
): { stop: number; target: number; adjusted: boolean } {
  const minDist = Math.max(spec.stopsLevel, spec.freezeLevel) * spec.point + spec.point * 2;
  if (minDist <= 0) return { stop, target, adjusted: false };
  let adjusted = false;
  let s = stop;
  let t = target;
  if (side === "buy") {
    if (price - s < minDist) {
      s = price - minDist;
      adjusted = true;
    }
    if (t > 0 && t - price < minDist) {
      t = price + minDist;
      adjusted = true;
    }
  } else {
    if (s - price < minDist) {
      s = price + minDist;
      adjusted = true;
    }
    if (t > 0 && price - t < minDist) {
      t = price - minDist;
      adjusted = true;
    }
  }
  return {
    stop: Number(s.toFixed(spec.digits)),
    target: Number(t.toFixed(spec.digits)),
    adjusted,
  };
}

/* --------------------------------- controls -------------------------------- */

export type ControlsRow = typeof executionControls.$inferSelect;

export async function getControls(): Promise<ControlsRow> {
  const rows = await db.select().from(executionControls).limit(1);
  if (rows.length) return rows[0];
  const created = await db.insert(executionControls).values({ owner: "primary" }).returning();
  return created[0];
}

export async function updateControls(patch: Partial<ControlsRow>): Promise<ControlsRow> {
  const current = await getControls();
  const updated = await db
    .update(executionControls)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(executionControls.id, current.id))
    .returning();
  await logEvent("info", "controls", `execution controls updated`, undefined, undefined, {
    patch: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])),
  });
  return updated[0] ?? current;
}

export function toControlsPayload(c: ControlsRow): ControlsPayload {
  const payload: ControlsPayload = {
    armed: c.armed,
    killSwitch: c.killSwitch,
    confirmMode: c.confirmMode,
    lotMultiplier: c.lotMultiplier,
    maxSpreadPoints: c.maxSpreadPoints,
    trailingAtr: c.trailingAtrMult,
    breakevenAtR: c.breakevenAtR,
    partialFraction: c.partialFraction,
    partialAtR: c.partialAtR,
    orderTtlSeconds: c.orderTtlSeconds,
  };
  return payload;
}

/* ---------------------------------- events --------------------------------- */

export async function logEvent(
  level: "info" | "warn" | "error" | "audit",
  scope: string,
  message: string,
  orderId?: number | null,
  bridgeId?: number | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .insert(executionEvents)
      .values({ level, scope, message, orderId: orderId ?? null, bridgeId: bridgeId ?? null, payload });
  } catch {
    // auditing must never break the execution path
  }
}

export async function listEvents(limit = 60) {
  return db.select().from(executionEvents).orderBy(desc(executionEvents.id)).limit(limit);
}

/* ---------------------------------- bridges -------------------------------- */

export async function listBridges() {
  return db.select().from(executionBridges).orderBy(desc(executionBridges.id));
}

export async function registerBridge(name: string, adapter = "mt5_ea") {
  const { token, hash, prefix } = generateAgentToken();
  const existing = await db.select().from(executionBridges).where(eq(executionBridges.name, name)).limit(1);
  if (existing.length) {
    const updated = await db
      .update(executionBridges)
      .set({ tokenHash: hash, tokenPrefix: prefix, adapter, status: "offline", lastError: null })
      .where(eq(executionBridges.id, existing[0].id))
      .returning();
    await logEvent("audit", "bridge", `agent token rotated for "${name}"`, undefined, updated[0].id);
    return { bridge: updated[0], token };
  }
  const created = await db
    .insert(executionBridges)
    .values({ name, tokenHash: hash, tokenPrefix: prefix, adapter })
    .returning();
  await logEvent("audit", "bridge", `execution bridge "${name}" registered`, undefined, created[0].id);
  return { bridge: created[0], token };
}

export async function resolveBridgeByToken(token: string | null | undefined) {
  if (!token) return null;
  const hash = hashToken(token);
  const rows = await db.select().from(executionBridges).where(eq(executionBridges.tokenHash, hash)).limit(1);
  return rows[0] ?? null;
}

export async function heartbeat(bridgeId: number, payload: Record<string, string>) {
  const num = (k: string) => {
    const v = Number(payload[k]);
    return Number.isFinite(v) ? v : null;
  };
  const updated = await db
    .update(executionBridges)
    .set({
      status: "online",
      mt5Login: payload.login ?? null,
      mt5Server: payload.server ?? null,
      mt5Build: payload.build ?? null,
      accountMode: payload.mode ?? null,
      accountCurrency: payload.currency ?? null,
      balance: num("balance"),
      equity: num("equity"),
      margin: num("margin"),
      marginFree: num("free"),
      marginLevel: num("marginlevel"),
      openPositions: num("positions") ?? 0,
      version: payload.version ?? null,
      dryRun: payload.dryrun === "1" ? true : payload.dryrun === "0" ? false : undefined,
      eaVersion: payload.eaversion ?? null,
      feedSummary: payload.feed ?? undefined,
      feedUpdatedAt: payload.feed ? new Date() : undefined,
      capabilities: payload.capabilities ? payload.capabilities.split(",") : null,
      lastHeartbeatAt: new Date(),
      lastError: payload.error ?? null,
    })
    .where(eq(executionBridges.id, bridgeId))
    .returning();
  return updated[0] ?? null;
}

export async function markBridgePoll(bridgeId: number) {
  await db
    .update(executionBridges)
    .set({ lastPollAt: new Date(), status: "online" })
    .where(eq(executionBridges.id, bridgeId));
}

export async function removeBridge(id: number) {
  await db.delete(executionBridges).where(eq(executionBridges.id, id));
  await logEvent("audit", "bridge", `bridge ${id} removed`, undefined, id);
}

/* ---------------------------- instrument reporting ------------------------- */

export interface ReportedSymbol {
  ticker: string;
  symbol: string;
  digits: number;
  point: number;
  contractSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  stopsLevel: number;
  freezeLevel: number;
  tradeMode: number;
  spreadPoints: number;
  marginCurrency?: string | null;
  tickValue?: number | null;
}

export async function upsertInstruments(bridgeId: number | null, specs: ReportedSymbol[]) {
  let written = 0;
  for (const s of specs) {
    const values = {
      bridgeId,
      ticker: s.ticker,
      symbol: s.symbol,
      digits: s.digits,
      point: s.point,
      contractSize: s.contractSize,
      minVolume: s.minVolume,
      maxVolume: s.maxVolume,
      volumeStep: s.volumeStep,
      stopsLevel: s.stopsLevel,
      freezeLevel: s.freezeLevel,
      tradeMode: s.tradeMode,
      spreadPoints: s.spreadPoints,
      marginCurrency: s.marginCurrency ?? null,
      tickValue: s.tickValue ?? null,
      active: true,
      updatedAt: new Date(),
    };
    try {
      await db
        .insert(brokerInstruments)
        .values(values)
        .onConflictDoUpdate({
          target: [brokerInstruments.bridgeId, brokerInstruments.ticker],
          set: values,
        });
      written++;
    } catch {
      // unique index on a nullable column can conflict; fall back to update
      await db
        .update(brokerInstruments)
        .set(values)
        .where(and(eq(brokerInstruments.ticker, s.ticker), eq(brokerInstruments.symbol, s.symbol)));
      written++;
    }
  }
  return written;
}

export async function listInstruments(bridgeId: number | null) {
  return db
    .select()
    .from(brokerInstruments)
    .where(bridgeId === null ? isNull(brokerInstruments.bridgeId) : eq(brokerInstruments.bridgeId, bridgeId))
    .orderBy(brokerInstruments.ticker);
}

/* ---------------------------------- orders --------------------------------- */

export type OrderRow = typeof executionOrders.$inferSelect;

export async function createOrder(input: {
  bridgeId: number | null;
  action: OrderAction;
  ticker: string;
  symbol: string;
  side: OrderSide;
  volume: number;
  requestedVolume?: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  state?: OrderState;
  metaProb?: number;
  confidence?: number;
  alphaKey?: string;
  regime?: string;
  runId?: number;
  signalId?: number;
  source?: string;
  idempotencyKey?: string;
  riskSnapshot?: Record<string, unknown>;
  ttlSeconds?: number;
}): Promise<OrderRow> {
  const controls = await getControls();
  const ttl = input.ttlSeconds ?? controls.orderTtlSeconds;
  const key =
    input.idempotencyKey ??
    idempotencyKey([
      input.action,
      input.symbol,
      input.side,
      input.volume,
      input.entryPrice,
      input.signalId ?? 0,
      Math.floor(Date.now() / 1000),
    ]);
  const created = await db
    .insert(executionOrders)
    .values({
      bridgeId: input.bridgeId,
      idempotencyKey: key,
      source: input.source ?? "signal",
      action: input.action,
      ticker: input.ticker,
      symbol: input.symbol,
      side: input.side,
      volume: input.volume,
      requestedVolume: input.requestedVolume ?? input.volume,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      state: input.state ?? "PENDING",
      metaProb: input.metaProb ?? null,
      confidence: input.confidence ?? null,
      alphaKey: input.alphaKey ?? null,
      regime: input.regime ?? null,
      runId: input.runId ?? null,
      signalId: input.signalId ?? null,
      riskSnapshot: input.riskSnapshot ?? null,
      // HELD orders wait for a human: no TTL while they wait, the clock starts
      // only when an operator (or auto-confirm) releases them into the queue.
      expiresAt: input.state === "HELD" ? null : new Date(Date.now() + ttl * 1000),
    })
    .returning();
  const order = created[0];
  await db
    .update(executionOrders)
    .set({ comment: orderComment(order.id) })
    .where(eq(executionOrders.id, order.id));
  await logEvent(
    "audit",
    "order",
    `order #${order.id} ${order.action} ${order.side.toUpperCase()} ${order.volume} ${order.symbol} → ${order.state}`,
    order.id,
    order.bridgeId,
  );
  return { ...order, comment: orderComment(order.id) };
}

/** Hand the next batch of queued orders to an agent and mark them dispatched. */
export async function pullOrders(bridgeId: number, limit = 5): Promise<DispatchOrder[]> {
  await expireStaleOrders();
  const controls = await getControls();
  const rows = await db
    .select()
    .from(executionOrders)
    .where(
      and(
        eq(executionOrders.state, "PENDING"),
        eq(executionOrders.bridgeId, bridgeId),
        // never hand out an order whose TTL already elapsed
        or(isNull(executionOrders.expiresAt), sql`${executionOrders.expiresAt} > now()`),
      ),
    )
    .orderBy(executionOrders.id)
    .limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await db
    .update(executionOrders)
    .set({ state: "DISPATCHED", dispatchedAt: new Date(), attempts: sql`${executionOrders.attempts} + 1`, updatedAt: new Date() })
    .where(inArray(executionOrders.id, ids));
  return rows.map((r) => ({
    id: r.id,
    action: r.action as OrderAction,
    symbol: r.symbol,
    side: r.side as OrderSide,
    volume: r.volume,
    price: r.entryPrice ?? 0,
    stop: r.stopPrice ?? 0,
    target: r.targetPrice ?? 0,
    comment: r.comment ?? orderComment(r.id),
    trailingAtr: controls.trailingAtrMult,
    breakevenAtR: controls.breakevenAtR,
    partialFraction: controls.partialFraction,
    partialAtR: controls.partialAtR,
    ttlSeconds: controls.orderTtlSeconds,
  }));
}

export async function expireStaleOrders(): Promise<number> {
  // An order that was pulled by an agent but never acknowledged (agent crash,
  // parse error, network blip) goes back into the queue for a limited number
  // of retries instead of rotting in DISPATCHED forever.
  const stuck = await db
    .select({ id: executionOrders.id, attempts: executionOrders.attempts })
    .from(executionOrders)
    .where(
      and(
        eq(executionOrders.state, "DISPATCHED"),
        sql`${executionOrders.dispatchedAt} is not null`,
        sql`${executionOrders.dispatchedAt} < now() - interval '45 seconds'`,
      ),
    );
  const controlsNow = await getControls();
  for (const row of stuck) {
    if (row.attempts < 3) {
      await db
        .update(executionOrders)
        .set({
          state: "PENDING",
          updatedAt: new Date(),
          // a requeued order gets a FRESH clock: stale signals must not be
          // executed minutes later at prices the model never saw
          expiresAt: new Date(Date.now() + controlsNow.orderTtlSeconds * 1000),
          errorText: `no ack after dispatch (attempt ${row.attempts}) - requeued`,
        })
        .where(eq(executionOrders.id, row.id));
      await logEvent("warn", "order", `order #${row.id} got no agent ack - requeued (attempt ${row.attempts}/3)`, row.id);
    } else {
      await db
        .update(executionOrders)
        .set({ state: "EXPIRED", updatedAt: new Date(), errorText: "no agent ack after 3 dispatch attempts" })
        .where(eq(executionOrders.id, row.id));
      await logEvent("error", "order", `order #${row.id} expired - agent never acknowledged 3 dispatches`, row.id);
    }
  }

  const stale = await db
    .select({ id: executionOrders.id })
    .from(executionOrders)
    .where(
      and(
        inArray(executionOrders.state, ["PENDING", "DISPATCHED"]),
        sql`${executionOrders.expiresAt} is not null`,
        sql`${executionOrders.expiresAt} < now()`,
      ),
    );
  if (!stale.length) return 0;
  const ids = stale.map((s) => s.id);
  await db
    .update(executionOrders)
    .set({ state: "EXPIRED", updatedAt: new Date(), errorText: "order TTL elapsed before agent acknowledgement" })
    .where(inArray(executionOrders.id, ids));
  for (const id of ids) await logEvent("warn", "order", `order #${id} expired (TTL)`, id);
  return ids.length;
}

export interface AckPayload {
  orderId: number;
  state: OrderState;
  retcode?: number;
  retcodeText?: string;
  errorText?: string;
  fillPrice?: number;
  fillVolume?: number;
  slippagePoints?: number;
  mt5Position?: string;
  mt5Deal?: string;
  mt5Order?: string;
}

export async function ackOrder(payload: AckPayload): Promise<OrderRow | null> {
  const rows = await db.select().from(executionOrders).where(eq(executionOrders.id, payload.orderId)).limit(1);
  if (!rows.length) return null;
  const order = rows[0];
  // Idempotency: a terminal state is final. Reconnects must not rewrite history.
  if (["FILLED", "REJECTED", "CANCELLED"].includes(order.state) && order.state === payload.state) return order;

  const updated = await db
    .update(executionOrders)
    .set({
      state: payload.state,
      retcode: payload.retcode ?? null,
      retcodeText: payload.retcodeText ?? null,
      errorText: payload.errorText ?? null,
      fillPrice: payload.fillPrice ?? null,
      fillVolume: payload.fillVolume ?? null,
      slippagePoints: payload.slippagePoints ?? null,
      mt5Position: payload.mt5Position ?? null,
      mt5Deal: payload.mt5Deal ?? null,
      mt5Order: payload.mt5Order ?? null,
      ackedAt: payload.state === "ACKED" ? new Date() : order.ackedAt,
      filledAt: payload.state === "FILLED" ? new Date() : order.filledAt,
      updatedAt: new Date(),
    })
    .where(eq(executionOrders.id, payload.orderId))
    .returning();
  await logEvent(
    payload.state === "FILLED" ? "audit" : payload.state === "REJECTED" ? "error" : "info",
    "order",
    `order #${payload.orderId} → ${payload.state}${payload.retcode ? ` (retcode ${payload.retcode} ${payload.retcodeText ?? ""})` : ""}${payload.fillPrice ? ` @ ${payload.fillPrice} x ${payload.fillVolume ?? order.volume}` : ""}`,
    payload.orderId,
    order.bridgeId,
    payload as unknown as Record<string, unknown>,
  );
  return updated[0] ?? null;
}

export async function listOrders(opts: { state?: OrderState; limit?: number; bridgeId?: number } = {}) {
  const conds = [];
  if (opts.state) conds.push(eq(executionOrders.state, opts.state));
  if (opts.bridgeId) conds.push(eq(executionOrders.bridgeId, opts.bridgeId));
  return db
    .select()
    .from(executionOrders)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(executionOrders.id))
    .limit(opts.limit ?? 100);
}

export async function setOrderState(id: number, state: OrderState, note?: string) {
  const updated = await db
    .update(executionOrders)
    .set({ state, errorText: note ?? null, updatedAt: new Date() })
    .where(eq(executionOrders.id, id))
    .returning();
  await logEvent("audit", "order", `order #${id} → ${state}${note ? ` (${note})` : ""}`, id);
  return updated[0] ?? null;
}

/* ------------------------------- positions -------------------------------- */

export interface ReportedPosition {
  ticket: string;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  openPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  commission: number;
  magic: number;
  comment: string;
  openedTs: number;
}

/** Mirror the broker's book. Anything the broker no longer reports is closed. */
export async function reconcilePositions(bridgeId: number, positions: ReportedPosition[]) {
  const existing = await db
    .select()
    .from(executionPositions)
    .where(and(eq(executionPositions.bridgeId, bridgeId), eq(executionPositions.status, "open")));
  const seen = new Set(positions.map((p) => p.ticket));
  let closed = 0;
  for (const e of existing) {
    if (seen.has(e.mt5Ticket)) continue;
    await db
      .update(executionPositions)
      .set({ status: "closed", closedTs: Math.floor(Date.now() / 1000), lastSyncAt: new Date(), profit: 0 })
      .where(eq(executionPositions.id, e.id));
    closed++;
    await logEvent("info", "position", `position ${e.mt5Ticket} ${e.symbol} no longer reported by broker — marked closed`, undefined, bridgeId);
  }
  for (const p of positions) {
    const orderId = orderIdFromComment(p.comment);
    const values = {
      bridgeId,
      mt5Ticket: p.ticket,
      symbol: p.symbol,
      ticker: UNIVERSE.find((u) => p.symbol.startsWith(u.ticker.slice(0, 6)))?.ticker ?? null,
      side: p.side,
      volume: p.volume,
      openPrice: p.openPrice,
      currentPrice: p.currentPrice,
      sl: p.sl || null,
      tp: p.tp || null,
      profit: p.profit,
      swap: p.swap,
      commission: p.commission,
      magic: p.magic,
      comment: p.comment,
      orderId,
      status: "open",
      openedTs: p.openedTs,
      lastSyncAt: new Date(),
    };
    await db
      .insert(executionPositions)
      .values(values)
      .onConflictDoUpdate({ target: [executionPositions.bridgeId, executionPositions.mt5Ticket], set: values });
  }
  return { synced: positions.length, closed };
}

export async function listPositions(bridgeId?: number, status: "open" | "closed" = "open") {
  const conds = [eq(executionPositions.status, status)];
  if (bridgeId) conds.push(eq(executionPositions.bridgeId, bridgeId));
  return db.select().from(executionPositions).where(and(...conds)).orderBy(desc(executionPositions.id)).limit(200);
}

/* --------------------------- signal -> order path -------------------------- */

export interface DispatchContext {
  equity: number;
  riskPerTrade: number;
  bridgeId: number | null;
  mode: string;
}

export interface DispatchResult {
  created: boolean;
  order: OrderRow | null;
  decision: RiskDecision;
  spec: InstrumentSpec;
  volume: number;
  notional: number;
  reason: string;
}

/**
 * Turn a research signal into a broker-legal order.
 * Symbol mapping, lot-step rounding, stop-level compliance, sizing by risk and
 * the full pre-trade risk gate all happen here — the EA only ever executes.
 */
export async function dispatchSignal(
  signal: SignalCandidate,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  const controls = await getControls();
  const spec = await resolveInstrument(ctx.bridgeId, signal.ticker);
  const side: OrderSide = signal.direction === "long" ? "buy" : "sell";
  const price = signal.entryPrice;

  // If the agent already published its contract specs and this ticker is not
  // among them, the broker simply does not offer the instrument. Queueing the
  // order anyway would only produce a terminal-side rejection, so refuse early
  // with an actionable message.
  if (spec.source === "default" && ctx.bridgeId !== null) {
    const reported = await db
      .select({ id: brokerInstruments.id })
      .from(brokerInstruments)
      .where(eq(brokerInstruments.bridgeId, ctx.bridgeId))
      .limit(1);
    if (reported.length) {
      const known = await listInstruments(ctx.bridgeId);
      const decision = evaluateRisk(
        await buildRiskContext(controls, ctx, spec, signal, 0, 0),
        {
          symbol: spec.symbol,
          side,
          volume: 0,
          price,
          stopPrice: signal.stopPrice,
          targetPrice: signal.targetPrice,
          metaProb: signal.metaProb,
          confidence: signal.confidence,
          spreadPoints: spec.spreadPoints,
          notional: 0,
        },
      );
      await logEvent(
        "warn",
        "risk",
        `${signal.ticker} is not offered by this broker/terminal - reported symbols: ${known.map((k) => k.symbol).join(", ")}`,
        undefined,
        ctx.bridgeId,
      );
      return {
        created: false,
        order: null,
        decision: {
          ...decision,
          ok: false,
          code: "SYMBOL_NOT_ALLOWED",
          reason: `terminal never reported a contract for ${signal.ticker}; broker offers: ${known.map((k) => `${k.ticker}→${k.symbol}`).join(", ")}`,
        },
        spec,
        volume: 0,
        notional: 0,
        reason: "instrument not offered by this broker",
      };
    }
  }

  // SYMBOL_TRADE_MODE: 0 disabled, 1 long-only, 2 short-only, 3 close-only, 4 full
  const modeBlocks =
    spec.tradeMode === 0 ||
    spec.tradeMode === 3 ||
    (spec.tradeMode === 1 && side === "sell") ||
    (spec.tradeMode === 2 && side === "buy");
  if (modeBlocks) {
    const decision = evaluateRisk(await buildRiskContext(controls, ctx, spec, signal, 0, 0), {
      symbol: spec.symbol,
      side,
      volume: 0,
      price,
      stopPrice: signal.stopPrice,
      targetPrice: signal.targetPrice,
      metaProb: signal.metaProb,
      confidence: signal.confidence,
      spreadPoints: spec.spreadPoints,
      notional: 0,
    });
    return {
      created: false,
      order: null,
      decision: {
        ...decision,
        ok: false,
        code: "TRADE_MODE_RESTRICTED",
        reason: `broker SYMBOL_TRADE_MODE=${spec.tradeMode} forbids new ${side} orders on ${spec.symbol}`,
      },
      spec,
      volume: 0,
      notional: 0,
      reason: "broker trade mode restriction",
    };
  }

  const sized = sizeByRisk({
    equity: ctx.equity,
    riskFraction: ctx.riskPerTrade,
    price,
    stopPrice: signal.stopPrice,
    spec,
    lotMultiplier: controls.lotMultiplier,
  });
  const stops = enforceStopLevel(side, price, signal.stopPrice, signal.targetPrice, spec);
  const riskCtx = await buildRiskContext(controls, ctx, spec, signal, sized.volume, sized.notional);
  const decision = evaluateRisk(riskCtx, {
    symbol: spec.symbol,
    side,
    volume: sized.volume,
    price,
    stopPrice: stops.stop,
    targetPrice: stops.target,
    metaProb: signal.metaProb,
    confidence: signal.confidence,
    spreadPoints: spec.spreadPoints,
    notional: sized.notional,
  });

  if (!decision.ok) {
    await logEvent(
      "warn",
      "risk",
      `signal ${signal.ticker} ${signal.direction} blocked: ${decision.reason}`,
      undefined,
      ctx.bridgeId === null ? undefined : ctx.bridgeId,
      { metaProb: signal.metaProb, code: decision.code },
    );
    return { created: false, order: null, decision, spec, volume: sized.volume, notional: sized.notional, reason: decision.reason };
  }

  const auto = controls.confirmMode === "auto" && decision.code === "OK";
  const order = await createOrder({
    bridgeId: ctx.bridgeId,
    action: "OPEN",
    ticker: signal.ticker,
    symbol: spec.symbol,
    side,
    volume: sized.volume,
    requestedVolume: sized.volume,
    entryPrice: Number(price.toFixed(spec.digits)),
    stopPrice: stops.stop,
    targetPrice: stops.target,
    state: auto ? "PENDING" : "HELD",
    metaProb: signal.metaProb,
    confidence: signal.confidence,
    alphaKey: signal.alphaKey,
    regime: signal.regime,
    source: "signal",
    idempotencyKey: idempotencyKey([signal.ticker, signal.barTs, signal.direction, signal.alphaKey]),
    riskSnapshot: {
      checks: decision.checks,
      lossPerLot: sized.lossPerLot,
      riskAmount: sized.riskAmount,
      stopLevelAdjusted: stops.adjusted,
      specSource: spec.source,
      auto,
    },
  });
  return {
    created: true,
    order,
    decision,
    spec,
    volume: sized.volume,
    notional: sized.notional,
    reason: auto ? "queued for automatic dispatch" : "HELD — waiting for your approve click",
  };
}

async function buildRiskContext(
  controls: ControlsRow,
  ctx: DispatchContext,
  spec: InstrumentSpec,
  signal: SignalCandidate,
  volume: number,
  notional: number,
): Promise<RiskContext> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [orderCount] = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(gte(executionOrders.createdAt, dayStart));
  const positions = await listPositions(ctx.bridgeId ?? undefined, "open");
  const realizedRows = await db
    .select({ pnl: executionPositions.profit })
    .from(executionPositions)
    .where(and(eq(executionPositions.status, "closed"), gte(executionPositions.lastSyncAt, dayStart)));
  const realizedPnlToday = realizedRows.reduce((acc, r) => acc + (r.pnl ?? 0), 0);
  const openNotional = positions.reduce((acc, p) => acc + p.volume * p.openPrice * spec.contractSize, 0);
  const bridgeRows = ctx.bridgeId ? await db.select().from(executionBridges).where(eq(executionBridges.id, ctx.bridgeId)).limit(1) : [];
  const bridge = bridgeRows[0];
  const staleSeconds = bridge?.lastHeartbeatAt
    ? (Date.now() - new Date(bridge.lastHeartbeatAt).getTime()) / 1000
    : Number.POSITIVE_INFINITY;
  const sameSymbol = await db
    .select({ createdAt: executionOrders.createdAt })
    .from(executionOrders)
    .where(and(eq(executionOrders.symbol, spec.symbol), gte(executionOrders.createdAt, dayStart)))
    .orderBy(desc(executionOrders.id))
    .limit(1);
  const secondsSinceLastOrderForSymbol = sameSymbol[0]?.createdAt
    ? (Date.now() - new Date(sameSymbol[0].createdAt).getTime()) / 1000
    : Number.POSITIVE_INFINITY;

  return {
    mode: controls.mode,
    armed: controls.armed,
    killSwitch: controls.killSwitch,
    confirmMode: controls.confirmMode,
    minMetaProb: controls.minMetaProb,
    minConfidence: controls.minConfidence,
    maxDailyOrders: controls.maxDailyOrders,
    maxDailyLossPct: controls.maxDailyLossPct,
    maxNotionalPct: controls.maxNotionalPct,
    maxOpenPositions: controls.maxOpenPositions,
    maxPositionsPerSymbol: controls.maxPositionsPerSymbol,
    maxSpreadPoints: controls.maxSpreadPoints,
    allowedSymbols: controls.allowedSymbols
      ? controls.allowedSymbols.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    sessionStartUtc: controls.sessionStartUtc,
    sessionEndUtc: controls.sessionEndUtc,
    weekendHalt: controls.weekendHalt,
    cooldownSeconds: controls.cooldownSeconds,
    requireStopLoss: controls.requireStopLoss,
    bridgeOnline: ctx.mode === "metaapi" ? true : Boolean(bridge && staleSeconds < 180),
    bridgeStaleSeconds: Number.isFinite(staleSeconds) ? staleSeconds : 99999,
    equity: ctx.equity > 0 ? ctx.equity : bridge?.equity ?? 0,
    marginFree: bridge?.marginFree ?? 0,
    marginLevelPct: bridge?.marginLevel ?? 0,
    openPositionCount: positions.length,
    openPositionsForSymbol: positions.filter((p) => p.symbol === spec.symbol).length,
    openNotional,
    ordersToday: orderCount?.n ?? 0,
    realizedPnlToday,
    secondsSinceLastOrderForSymbol: Number.isFinite(secondsSinceLastOrderForSymbol)
      ? secondsSinceLastOrderForSymbol
      : 99999,
  };
}

/* ---------------------------------- status --------------------------------- */

export async function execStatus() {
  const controls = await getControls();
  const bridges = await listBridges();
  const now = Date.now();
  const online = bridges.filter(
    (b) => b.lastHeartbeatAt && now - new Date(b.lastHeartbeatAt).getTime() < 180_000,
  );
  const held = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(eq(executionOrders.state, "HELD"));
  const queued = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(eq(executionOrders.state, "PENDING"));
  const dispatched = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(eq(executionOrders.state, "DISPATCHED"));
  const filled = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(eq(executionOrders.state, "FILLED"));
  const rejected = await db
    .select({ n: count() })
    .from(executionOrders)
    .where(inArray(executionOrders.state, ["REJECTED", "EXPIRED", "CANCELLED"]));
  const open = await listPositions(undefined, "open");
  const metaApiConfigured = Boolean(process.env.METAAPI_TOKEN);
  return {
    controls,
    metaApiConfigured,
    metaApiRegion: process.env.METAAPI_REGION ?? "new-york",
    weekend: isWeekendWindow(),
    bridges: bridges.map((b) => ({
      ...b,
      tokenHash: undefined,
      online: online.some((o) => o.id === b.id),
      staleSeconds: b.lastHeartbeatAt ? (now - new Date(b.lastHeartbeatAt).getTime()) / 1000 : null,
    })),
    onlineBridge: online[0] ?? null,
    lastKnock: lastKnock(),
    counts: {
      held: held[0]?.n ?? 0,
      queued: queued[0]?.n ?? 0,
      dispatched: dispatched[0]?.n ?? 0,
      filled: filled[0]?.n ?? 0,
      failed: rejected[0]?.n ?? 0,
      openPositions: open.length,
    },
    openNotional: open.reduce((acc, p) => acc + p.volume * p.openPrice, 0),
    openPnl: open.reduce((acc, p) => acc + (p.profit ?? 0), 0),
  };
}

/** Flatten everything the engine owns — used by the kill switch. */
export async function flattenAll(reason: string) {
  const controls = await getControls();
  const bridges = await listBridges();
  const bridgeId = bridges[0]?.id ?? null;
  const open = await listPositions(bridgeId ?? undefined, "open");

  // Cancel the pending queue FIRST. Doing this after creating the flatten
  // orders would cancel the very CLOSE orders the kill switch just queued,
  // leaving open positions stranded with no exit instruction.
  const cancelled = await db
    .select({ id: executionOrders.id })
    .from(executionOrders)
    .where(inArray(executionOrders.state, ["HELD", "PENDING", "DISPATCHED"]));
  if (cancelled.length) {
    await db
      .update(executionOrders)
      .set({ state: "CANCELLED", updatedAt: new Date(), errorText: `cancelled by kill switch: ${reason}` })
      .where(inArray(executionOrders.id, cancelled.map((c) => c.id)));
  }

  let queued = 0;
  for (const p of open) {
    await createOrder({
      bridgeId,
      action: "CLOSE",
      ticker: p.ticker ?? p.symbol,
      symbol: p.symbol,
      side: p.side === "buy" ? "sell" : "buy",
      volume: p.volume,
      entryPrice: p.currentPrice ?? p.openPrice,
      stopPrice: 0,
      targetPrice: 0,
      source: "killswitch",
      riskSnapshot: { reason, ticket: p.mt5Ticket },
      ttlSeconds: controls.orderTtlSeconds,
    });
    queued++;
  }
  await logEvent(
    "audit",
    "risk",
    `KILL SWITCH: ${reason} — ${cancelled.length} queued orders cancelled, ${queued} flatten orders dispatched`,
    undefined,
    bridgeId === null ? undefined : bridgeId,
  );
  return { queued, cancelled: cancelled.length, reason };
}

export async function autoDispatchFromSignals(args: {
  ticker: string;
  timeframe: Timeframe;
  preset: string;
  targetWinRate: number;
}) {
  const controls = await getControls();
  if (controls.mode === "paper" || controls.killSwitch || !controls.armed) {
    return { dispatched: 0, reason: "engine not armed for live dispatch" };
  }
  const { scanSignals, PRESETS } = await import("@/lib/quant/pipeline");
  const presetKey = (args.preset in PRESETS ? args.preset : "apex_hit_rate") as keyof typeof PRESETS;
  const scan = await scanSignals(args.ticker, args.timeframe, 1400, presetKey, args.targetWinRate);
  // Safety: a live bridge must never receive orders derived from simulated
  // prices. Real feeds only (bridge-mirrored broker history or live exchange).
  const realFeed = scan.source === "bridge" || scan.source === "live";
  if (controls.mode === "bridge" && !realFeed) {
    await logEvent(
      "warn",
      "risk",
      `dispatch verworfen: ${args.ticker} Quelle=${scan.source} — Live-Bridge handelt nur auf echten Broker-Kerzen`,
    );
    return {
      dispatched: 0,
      blocked: [
        `kein Real-Feed fuer ${args.ticker} (Quelle: ${scan.source}) — im Modus bridge werden nur echte Broker-Kerzen gehandelt`,
      ],
      results: [],
    };
  }
  const bridges = await listBridges();
  const bridge = bridges[0];
  const equity = controls.mode === "metaapi" ? (bridge?.equity ?? 10_000) : bridge?.equity ?? 0;
  const preset = PRESETS[presetKey];
  const results: DispatchResult[] = [];
  for (const candidate of scan.candidates.slice(-2)) {
    const res = await dispatchSignal(candidate, {
      equity: equity > 0 ? equity : preset.risk.initialEquity,
      riskPerTrade: preset.risk.riskPerTrade,
      bridgeId: bridge?.id ?? null,
      mode: controls.mode,
    });
    results.push(res);
    if (controls.mode === "metaapi" && res.created && res.order && controls.confirmMode === "auto") {
      const { metaApiExecute } = await import("./metaApi");
      const out = await metaApiExecute(res.order, controls.metaApiAccountId);
      await ackOrder({
        orderId: res.order.id,
        state: out.ok ? "FILLED" : "REJECTED",
        retcode: out.retcode,
        retcodeText: out.message,
        fillPrice: out.price,
        fillVolume: out.volume,
        mt5Position: out.positionId,
      });
    }
  }
  return {
    dispatched: results.filter((r) => r.created).length,
    blocked: results.filter((r) => !r.created).map((r) => r.reason),
    results: results.map((r) => ({
      created: r.created,
      symbol: r.spec.symbol,
      volume: r.volume,
      code: r.decision.code,
      reason: r.reason,
      orderId: r.order?.id ?? null,
    })),
  };
}
