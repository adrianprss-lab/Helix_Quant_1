import { NextRequest } from "next/server";
import { listRuns, normaliseRequest, runPipeline } from "@/lib/quant/pipeline";
import type { Timeframe } from "@/lib/quant/data";
import { UNIVERSE } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const runs = await listRuns(30);
  return Response.json({ runs, universe: UNIVERSE.map((u) => u.ticker) });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const request = normaliseRequest({
    ticker: typeof body.ticker === "string" ? body.ticker : undefined,
    timeframe: typeof body.timeframe === "string" ? (body.timeframe as Timeframe) : undefined,
    bars: typeof body.bars === "number" ? body.bars : undefined,
    preset: typeof body.preset === "string" ? (body.preset as never) : undefined,
    targetWinRate: typeof body.targetWinRate === "number" ? body.targetWinRate : undefined,
    optimize: typeof body.optimize === "boolean" ? body.optimize : undefined,
    walkForward: typeof body.walkForward === "boolean" ? body.walkForward : undefined,
    monteCarlo: typeof body.monteCarlo === "boolean" ? body.monteCarlo : undefined,
    preferLive: typeof body.preferLive === "boolean" ? body.preferLive : undefined,
    budgetMs: typeof body.budgetMs === "number" ? body.budgetMs : undefined,
  });

  try {
    const result = await runPipeline(request);
    return Response.json({
      ok: true,
      runId: result.runId,
      label: result.label,
      ticker: result.ticker,
      timeframe: result.timeframe,
      dataSource: result.dataSource,
      preset: result.preset,
      bars: result.bars,
      params: result.params,
      risk: result.risk,
      targetWinRate: result.targetWinRate,
      achievedWinRate: result.achievedWinRate,
      durationMs: result.durationMs,
      diagnostics: result.diagnostics,
      metrics: result.inSample.metrics,
      oosMetrics: result.outOfSample?.metrics ?? null,
      attribution: result.inSample.attribution,
      regimeAttribution: result.inSample.regimeAttribution,
      equityCurve: result.inSample.equityCurve,
      oosEquityCurve: result.outOfSample?.equityCurve ?? [],
      trades: result.inSample.trades,
      monthlyReturns: result.inSample.monthlyReturns,
      rolledWinRate: result.inSample.rolledWinRate,
      walkForward: result.walkForward,
      monteCarlo: result.monteCarlo,
      pbo: result.pbo,
      optimization: result.optimization,
      candles: result.candles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pipeline failure";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
