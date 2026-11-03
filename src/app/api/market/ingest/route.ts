import { NextRequest } from "next/server";
import { authenticateBridge } from "@/lib/exec/bridgeAuth";
import { logEvent } from "@/lib/exec/oms";
import { persistCandles } from "@/lib/quant/data";
import type { Timeframe } from "@/lib/quant/data";
import type { Candle } from "@/lib/quant/types";
import { matchTicker } from "@/lib/exec/symbolMap";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TF: Timeframe[] = ["15m", "1h", "4h", "1d"];
const MAX_BARS = 6000;

interface IngestBody {
  symbol?: string;
  timeframe?: string;
  candles?: unknown;
}

/**
 * Real-history ingestion channel.
 * The python bridge mirrors the broker's own candles (copy_rates) into the
 * research database, which makes every backtest, signal scan and autopilot
 * decision run on REAL prices instead of the deterministic simulator.
 */
export async function POST(req: NextRequest) {
  const { bridge, body: rawBody } = await authenticateBridge(req);
  if (!bridge) {
    return Response.json({ ok: false, error: "invalid or missing agent token" }, { status: 401 });
  }
  // authenticateBridge already consumed the (single-use) request stream, so
  // parse the payload from the body it hands back instead of req.json().
  let body: IngestBody = {};
  try {
    body = JSON.parse(rawBody) as IngestBody;
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const symbol = String(body.symbol ?? "");
  const timeframe = TF.includes(body.timeframe as Timeframe) ? (body.timeframe as Timeframe) : null;
  if (!symbol || !timeframe || !Array.isArray(body.candles)) {
    return Response.json({ ok: false, error: "symbol, timeframe and candles[] are required" }, { status: 400 });
  }

  const match = matchTicker(symbol);
  if (!match.ticker) {
    return Response.json({ ok: false, error: `symbol ${symbol} does not map to a known instrument` }, { status: 400 });
  }

  const rows: Candle[] = [];
  for (const raw of body.candles.slice(0, MAX_BARS)) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    const [ts, o, h, l, c, v] = raw.map(Number);
    if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    rows.push({ ts: Math.floor(ts), open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  if (rows.length < 50) {
    return Response.json({ ok: false, error: "fewer than 50 valid bars" }, { status: 400 });
  }
  rows.sort((a, b) => a.ts - b.ts);
  await persistCandles(match.ticker, timeframe, rows, "bridge");
  await logEvent(
    "info",
    "feed",
    `real history ingested: ${match.ticker} ${timeframe} = ${rows.length} bars from ${symbol} (${bridge.name})`,
    undefined,
    bridge.id,
  );
  return Response.json({
    ok: true,
    ticker: match.ticker,
    timeframe,
    written: rows.length,
    fromTs: rows[0].ts,
    toTs: rows[rows.length - 1].ts,
  });
}
