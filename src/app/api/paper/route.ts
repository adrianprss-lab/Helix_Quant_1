import { NextRequest } from "next/server";
import { ensurePaperAccount, openPaperPosition, paperSnapshot, paperTick } from "@/lib/quant/pipeline";
import type { Timeframe } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const snapshot = await paperSnapshot();
  return Response.json({ ok: true, ...snapshot });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid body" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  try {
    if (action === "open") {
      await ensurePaperAccount();
      const position = await openPaperPosition({
        ticker: String(body.ticker ?? "BTCUSDT"),
        timeframe: (String(body.timeframe ?? "1h") as Timeframe) ?? "1h",
        direction: body.direction === "short" ? "short" : "long",
        metaProb: Number(body.metaProb ?? 0.7),
        entryPrice: Number(body.entryPrice ?? 0),
        stopPrice: Number(body.stopPrice ?? 0),
        targetPrice: Number(body.targetPrice ?? 0),
        alphaKey: String(body.alphaKey ?? "ensemble"),
        regime: String(body.regime ?? "range"),
      });
      return Response.json({ ok: true, position });
    }
    if (action === "close") {
      const res = await import("@/lib/quant/pipeline").then((m) =>
        m.closePaperPosition(Number(body.id), String(body.reason ?? "manual"), Number(body.price ?? 0) || undefined),
      );
      return Response.json({ ok: true, result: res });
    }
    if (action === "tick") {
      const res = await paperTick();
      const snapshot = await paperSnapshot();
      return Response.json({ ok: true, tick: res, ...snapshot });
    }
    if (action === "reset") {
      const { db } = await import("@/db");
      const { paperPositions, paperAccounts } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const account = await ensurePaperAccount();
      await db.delete(paperPositions).where(eq(paperPositions.accountId, account.id));
      await db
        .update(paperAccounts)
        .set({
          cash: 100_000,
          equity: 100_000,
          realizedPnl: 0,
          feesPaid: 0,
          peakEquity: 100_000,
          maxDrawdown: 0,
          updatedAt: new Date(),
        })
        .where(eq(paperAccounts.id, account.id));
      const snapshot = await paperSnapshot();
      return Response.json({ ok: true, ...snapshot });
    }
    return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "paper engine failure" },
      { status: 500 },
    );
  }
}
