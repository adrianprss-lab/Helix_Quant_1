import { NextRequest } from "next/server";
import { BARS_PER_DAY, TIMEFRAME_SECONDS, UNIVERSE, loadSeries } from "@/lib/quant/data";
import type { Timeframe } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "BTCUSDT").toUpperCase();
  const timeframe = (url.searchParams.get("timeframe") ?? "1h") as Timeframe;
  const limit = Math.max(50, Math.min(1000, Number(url.searchParams.get("limit") ?? 240)));
  if (!UNIVERSE.some((u) => u.ticker === ticker)) {
    return Response.json({ ok: false, error: "unknown instrument" }, { status: 400 });
  }
  const tf: Timeframe = (["5m", "15m", "1h", "4h", "1d"] as const).includes(timeframe) ? timeframe : "1h";
  const series = await loadSeries(ticker, tf, limit, url.searchParams.get("live") !== "0");
  const candles = series.candles;
  const last = candles[candles.length - 1];
  const first = candles[0];
  return Response.json({
    ok: true,
    ticker,
    timeframe: tf,
    source: series.source,
    timeframeSeconds: TIMEFRAME_SECONDS[tf],
    barsPerDay: BARS_PER_DAY[tf],
    universe: UNIVERSE,
    summary: {
      price: last?.close ?? 0,
      changePct: first && first.close ? ((last.close - first.close) / first.close) * 100 : 0,
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
      bars: candles.length,
    },
    candles,
  });
}
