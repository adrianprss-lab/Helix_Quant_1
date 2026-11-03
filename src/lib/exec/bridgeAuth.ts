import { NextRequest } from "next/server";
import { logEvent, resolveBridgeByToken } from "./oms";
import { decodeKv, sanitizeToken } from "./protocol";

export interface BridgeAuth {
  bridge: Awaited<ReturnType<typeof resolveBridgeByToken>>;
  fields: Record<string, string>;
  body: string;
}

/**
 * Every connection attempt against the bridge endpoints is recorded here,
 * including the failed ones. This is the difference between "the agent is
 * misconfigured" and "the agent never reaches us at all" — without it a
 * silent WebRequest block is indistinguishable from a dead backend.
 */
export interface KnockInfo {
  at: number;
  path: string;
  tokenPrefix: string;
  valid: boolean;
  count: number;
}

const g = globalThis as typeof globalThis & { __helixKnock?: KnockInfo & { lastEventAt?: number } };

export function lastKnock(): KnockInfo | null {
  return g.__helixKnock ?? null;
}

async function recordKnock(path: string, token: string, valid: boolean): Promise<void> {
  const prefix = token ? token.slice(0, 8) : "(kein Token gesendet)";
  const now = Date.now();
  const prev = g.__helixKnock;
  if (prev && prev.tokenPrefix === prefix && prev.path === path && prev.valid === valid && now - prev.at < 60_000) {
    prev.count += 1;
    prev.at = now;
    return;
  }
  g.__helixKnock = { at: now, path, tokenPrefix: prefix, valid, count: 1, lastEventAt: prev?.lastEventAt };
  if (!valid && now - (g.__helixKnock.lastEventAt ?? 0) > 60_000) {
    g.__helixKnock.lastEventAt = now;
    await logEvent(
      "warn",
      "bridge-auth",
      `connection attempt rejected: path=${path} token=${prefix}… — agent reached the server but the token is unknown or missing`,
    );
  }
}

/** Pull the token out of a query string or a `key=value` line-protocol body. */
export async function authenticateBridge(req: NextRequest): Promise<BridgeAuth> {
  const url = new URL(req.url);
  let body = "";
  try {
    body = await req.text();
  } catch {
    body = "";
  }
  const fields = decodeKv(body);
  let rawToken = url.searchParams.get("token") ?? fields.token ?? req.headers.get("x-helix-token") ?? "";
  // JSON endpoints (history ingest) carry the token inside their payload
  if (!rawToken && body.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as { token?: unknown };
      if (typeof parsed.token === "string") rawToken = parsed.token;
    } catch {
      rawToken = "";
    }
  }
  const token = sanitizeToken(rawToken);
  const bridge = await resolveBridgeByToken(token);
  if (!bridge) await recordKnock(url.pathname, token, false);
  return { bridge, fields, body };
}

/** Repeated `prefix=a|b|c` lines -> array of field arrays. */
export function parseRepeated(body: string, prefix: string): string[][] {
  const out: string[][] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(`${prefix}=`)) continue;
    const payload = line.slice(prefix.length + 1);
    if (!payload) continue;
    out.push(payload.split("|"));
  }
  return out;
}

export function num(v: string | undefined, fb = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

export function unauthorized(): Response {
  return new Response("ok=0\nerror=invalid or missing agent token\n", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function lineResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
