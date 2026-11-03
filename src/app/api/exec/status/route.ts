import { autoDispatchFromSignals, execStatus, listEvents, listInstruments, listOrders, listPositions } from "@/lib/exec/oms";
import type { Timeframe } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequestLike) {
  const url = new URL(req.url);
  const status = await execStatus();
  const [orders, open, closed, events, instruments] = await Promise.all([
    listOrders({ limit: 60 }),
    listPositions(undefined, "open"),
    listPositions(undefined, "closed"),
    listEvents(60),
    listInstruments(status.onlineBridge?.id ?? null),
  ]);
  const dispatch = url.searchParams.get("dispatch");
  let dispatchResult = null;
  if (dispatch === "1") {
    dispatchResult = await autoDispatchFromSignals({
      ticker: url.searchParams.get("ticker") ?? "BTCUSDT",
      timeframe: (url.searchParams.get("timeframe") ?? "1h") as Timeframe,
      preset: url.searchParams.get("preset") ?? "apex_hit_rate",
      targetWinRate: Number(url.searchParams.get("target") ?? 0.85),
    });
  }
  return Response.json({
    ok: true,
    ...status,
    orders,
    positions: { open, closed },
    events,
    instruments,
    dispatch: dispatchResult,
  });
}

interface NextRequestLike {
  url: string;
}
