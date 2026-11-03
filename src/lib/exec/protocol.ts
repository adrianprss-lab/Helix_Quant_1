import { createHash, randomBytes } from "node:crypto";

/**
 * HELIX bridge wire protocol.
 *
 * MQL5 has no JSON parser in the standard library, so the EA <-> OMS channel
 * uses a deliberately boring, newline delimited `key=value` protocol. It is
 * trivially parseable on both sides, diffable in a terminal and impossible to
 * get subtly wrong the way hand rolled JSON in MQL5 is.
 */

export type OrderAction = "OPEN" | "CLOSE" | "MODIFY" | "PARTIAL";
export type OrderSide = "buy" | "sell";

export type OrderState =
  | "HELD"
  | "PENDING"
  | "DISPATCHED"
  | "ACKED"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED";

export interface DispatchOrder {
  id: number;
  action: OrderAction;
  symbol: string;
  side: OrderSide;
  volume: number;
  price: number;
  stop: number;
  target: number;
  comment: string;
  /** EA-side protections */
  trailingAtr: number;
  breakevenAtR: number;
  partialFraction: number;
  partialAtR: number;
  ttlSeconds: number;
}

export interface ControlsPayload {
  armed: boolean;
  killSwitch: boolean;
  confirmMode: string;
  lotMultiplier: number;
  maxSpreadPoints: number;
  trailingAtr: number;
  breakevenAtR: number;
  partialFraction: number;
  partialAtR: number;
  orderTtlSeconds: number;
}

export function encodeKv(obj: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");
}

export function decodeKv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Encode a poll response for the EA. */
export function encodePollResponse(controls: ControlsPayload, orders: DispatchOrder[]): string {
  const lines: string[] = [
    encodeKv({
      ok: 1,
      armed: controls.armed && !controls.killSwitch ? 1 : 0,
      killswitch: controls.killSwitch ? 1 : 0,
      confirm: controls.confirmMode === "auto" ? "auto" : "manual",
      lotmul: controls.lotMultiplier,
      maxspread: controls.maxSpreadPoints,
      trail: controls.trailingAtr,
      beAtR: controls.breakevenAtR,
      partialFrac: controls.partialFraction,
      partialAtR: controls.partialAtR,
      ttl: controls.orderTtlSeconds,
      orders: orders.length,
    }),
  ];
  for (const o of orders) {
    // The EA matches lines on the literal prefix "order=" and then splits the
    // remainder on "|". Missing the "=" made the agent silently skip every
    // dispatched order — keep this exact format in sync with HelixBridgeEA.mq5.
    lines.push(
      "order=" +
      [
        o.id,
        o.action,
        o.symbol,
        o.side.toUpperCase(),
        o.volume.toFixed(8),
        o.price.toFixed(8),
        o.stop.toFixed(8),
        o.target.toFixed(8),
        o.comment,
        o.trailingAtr.toFixed(3),
        o.breakevenAtR.toFixed(3),
        o.partialFraction.toFixed(3),
        o.partialAtR.toFixed(3),
        o.ttlSeconds,
      ].join("|"),
    );
  }
  return lines.join("\n") + "\n";
}

export interface ParsedOrderLine {
  id: number;
  action: OrderAction;
  symbol: string;
  side: OrderSide;
  volume: number;
  price: number;
  stop: number;
  target: number;
  comment: string;
  trailingAtr: number;
  breakevenAtR: number;
  partialFraction: number;
  partialAtR: number;
  ttlSeconds: number;
}

/** Decode an `order=...` line (used by the MQL5 agent's mirror parser/tests). */
export function decodeOrderLine(line: string): ParsedOrderLine | null {
  const parts = line.split("|");
  if (parts.length < 10 || parts[0] !== "order") return null;
  const num = (i: number, fb = 0) => {
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : fb;
  };
  return {
    id: num(1),
    action: parts[2] as OrderAction,
    symbol: parts[3],
    side: parts[4].toLowerCase() === "sell" ? "sell" : "buy",
    volume: num(5),
    price: num(6),
    stop: num(7),
    target: num(8),
    comment: parts[9] ?? "",
    trailingAtr: num(10),
    breakevenAtR: num(11),
    partialFraction: num(12),
    partialAtR: num(13),
    ttlSeconds: num(14, 90),
  };
}

/* --------------------------------- tokens --------------------------------- */

export function generateAgentToken(): { token: string; hash: string; prefix: string } {
  const token = `hxb_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

/**
 * Tokens are base64url and therefore never contain whitespace. Pasting a long
 * token from a chat window frequently injects a line wrap or trailing space,
 * which would silently invalidate an otherwise correct key. Normalise it away.
 */
export function sanitizeToken(token: string): string {
  return token.replace(/[\s\r\n\t]+/g, "");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** MT5 rejects comments longer than 31 characters; keep the marker compact. */
export function orderComment(orderId: number): string {
  return `HX-${orderId}`;
}

export function orderIdFromComment(comment: string | null | undefined): number | null {
  if (!comment) return null;
  const m = /HX-(\d+)/.exec(comment);
  return m ? Number(m[1]) : null;
}

export function idempotencyKey(parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
}
