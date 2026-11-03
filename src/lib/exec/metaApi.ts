import { db } from "@/db";
import { executionPositions } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { OrderRow } from "./oms";
import { logEvent } from "./oms";

/**
 * MetaApi cloud adapter.
 *
 * Optional second execution path for operators who do not want to run an MT5
 * terminal at all: MetaApi provisions the terminal in their cloud and exposes
 * the account over REST. Credentials live ONLY in server-side env vars and are
 * never shipped to the browser.
 *
 *   METAAPI_TOKEN   — API token from app.metaapi.cloud/token
 *   METAAPI_REGION  — region slug, defaults to "new-york"
 *   METAAPI_BASE_URL— full override if you run a self-hosted gateway
 */

export interface MetaApiConfig {
  token: string | null;
  baseUrl: string;
  configured: boolean;
}

export function metaApiConfig(): MetaApiConfig {
  const token = process.env.METAAPI_TOKEN ?? null;
  const region = process.env.METAAPI_REGION ?? "new-york";
  const baseUrl =
    process.env.METAAPI_BASE_URL ?? `https://mt-client-api-v1.${region}.agiliumtrade.ai`;
  return { token, baseUrl, configured: Boolean(token) };
}

export interface MetaApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  message: string;
}

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<MetaApiResult<T>> {
  const cfg = metaApiConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      status: 0,
      data: null,
      message: "METAAPI_TOKEN is not configured — set it as a server-side environment variable",
    };
  }
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        "auth-token": cfg.token as string,
        "content-type": "application/json",
        accept: "application/json",
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    const errObj = data as unknown as { error?: boolean; message?: string } | null;
    const message =
      errObj && typeof errObj.message === "string"
        ? errObj.message
        : text.slice(0, 240) || `HTTP ${res.status}`;
    return { ok: res.ok && !(errObj?.error === true), status: res.status, data, message };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      message: e instanceof Error ? e.message : "network failure",
    };
  }
}

export interface MetaApiAccount {
  id: string;
  login?: number;
  name?: string;
  server?: string;
  type?: string;
  platform?: string;
  state?: string;
  magic?: number;
}

export async function metaApiListAccounts(): Promise<MetaApiResult<MetaApiAccount[]>> {
  return call<MetaApiAccount[]>("GET", "/users/current/accounts");
}

export async function metaApiAccountInfo(accountId: string) {
  return call<Record<string, unknown>>("GET", `/users/current/accounts/${accountId}/account-information`);
}

export async function metaApiPositions(accountId: string) {
  return call<Array<Record<string, unknown>>>("GET", `/users/current/accounts/${accountId}/positions`);
}

export async function metaApiSymbolSpec(accountId: string, symbol: string) {
  return call<Record<string, unknown>>(
    "GET",
    `/users/current/accounts/${accountId}/symbols/${encodeURIComponent(symbol)}/specification`,
  );
}

export interface ExecuteOutcome {
  ok: boolean;
  retcode: number;
  message: string;
  positionId?: string;
  orderId?: string;
  price?: number;
  volume?: number;
}

/**
 * Send one order to MetaApi. Market execution with SL/TP attached at order
 * time, so the position is protected even if this process dies immediately
 * after the fill.
 */
export async function metaApiExecute(
  order: OrderRow,
  accountId: string | null | undefined,
): Promise<ExecuteOutcome> {
  const cfg = metaApiConfig();
  if (!cfg.configured) {
    return { ok: false, retcode: 0, message: "METAAPI_TOKEN is not configured" };
  }
  const id = accountId ?? (await autoDetectAccountId());
  if (!id) {
    return { ok: false, retcode: 0, message: "no MetaApi account id configured or detectable" };
  }

  if (order.action === "CLOSE") {
    const positionId = await resolvePositionIdForClose(order);
    if (!positionId) {
      return { ok: false, retcode: 0, message: `no open position found for ${order.symbol}` };
    }
    const res = await call<Record<string, unknown>>(
      "POST",
      `/users/current/accounts/${id}/positions/${encodeURIComponent(positionId)}/close`,
    );
    await logEvent(res.ok ? "audit" : "error", "metaapi", `close ${positionId}: ${res.message}`, order.id);
    return {
      ok: res.ok,
      retcode: res.status,
      message: res.message,
      positionId,
    };
  }

  const actionType = order.side === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const payload: Record<string, unknown> = {
    actionType,
    symbol: order.symbol,
    volume: order.volume,
    // Idempotency key understood by MetaApi: replaying the same orderId cannot
    // create a duplicate position after a network retry.
    orderId: `hx-${order.id}-${order.idempotencyKey.slice(0, 12)}`,
    comment: order.comment ?? `HX-${order.id}`,
  };
  if (order.stopPrice && order.stopPrice > 0) payload.stopLoss = order.stopPrice;
  if (order.targetPrice && order.targetPrice > 0) payload.takeProfit = order.targetPrice;

  const res = await call<Record<string, unknown>>("POST", `/users/current/accounts/${id}/trade`, payload);
  const data = (res.data ?? {}) as Record<string, unknown>;
  const outcome: ExecuteOutcome = {
    ok: res.ok,
    retcode: res.status,
    message: res.ok ? String(data.description ?? "accepted") : res.message,
    positionId: typeof data.positionId === "string" ? data.positionId : undefined,
    orderId: typeof data.orderId === "string" ? data.orderId : undefined,
    price: typeof data.price === "number" ? data.price : undefined,
    volume: typeof data.volume === "number" ? data.volume : order.volume,
  };
  await logEvent(
    res.ok ? "audit" : "error",
    "metaapi",
    `${actionType} ${order.volume} ${order.symbol}: ${outcome.message}`,
    order.id,
  );
  return outcome;
}

async function autoDetectAccountId(): Promise<string | null> {
  const res = await metaApiListAccounts();
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  const live = res.data.find((a) => a.type === "cloud" || a.state === "deployed") ?? res.data[0];
  return live?.id ?? null;
}

async function resolvePositionIdForClose(order: OrderRow): Promise<string | null> {
  const snapshot = (order.riskSnapshot ?? {}) as { ticket?: string };
  if (snapshot.ticket) return String(snapshot.ticket);
  const side = order.side === "buy" ? "sell" : "buy";
  const rows = await db
    .select()
    .from(executionPositions)
    .where(
      and(
        eq(executionPositions.symbol, order.symbol),
        eq(executionPositions.side, side),
        eq(executionPositions.status, "open"),
      ),
    )
    .orderBy(desc(executionPositions.id))
    .limit(1);
  return rows[0]?.mt5Ticket ?? null;
}

/** Pull the broker's live book into our mirror table. */
export async function metaApiSyncPositions(accountId: string, bridgeId: number) {
  const res = await metaApiPositions(accountId);
  if (!res.ok || !Array.isArray(res.data)) {
    return { ok: false, message: res.message, synced: 0 };
  }
  const { reconcilePositions } = await import("./oms");
  const positions = res.data.map((p) => {
    const rec = p as Record<string, unknown>;
    const side = String(rec.type ?? "").toLowerCase().includes("sell") ? "sell" : "buy";
    return {
      ticket: String(rec.id ?? rec.positionId ?? `${rec.identifier ?? Date.now()}`),
      symbol: String(rec.symbol ?? ""),
      side: side as "buy" | "sell",
      volume: Number(rec.volume ?? 0),
      openPrice: Number(rec.openPrice ?? 0),
      currentPrice: Number(rec.currentPrice ?? rec.openPrice ?? 0),
      sl: Number(rec.stopLoss ?? 0),
      tp: Number(rec.takeProfit ?? 0),
      profit: Number(rec.profit ?? 0),
      swap: Number(rec.swap ?? 0),
      commission: Number(rec.commission ?? 0),
      magic: Number(rec.magic ?? 0),
      comment: String(rec.comment ?? ""),
      openedTs: Math.floor(Date.now() / 1000),
    };
  });
  const out = await reconcilePositions(bridgeId, positions);
  return { ok: true, message: "synced", ...out };
}
