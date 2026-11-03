import { NextRequest } from "next/server";
import {
  autoDispatchFromSignals,
  createOrder,
  execStatus,
  flattenAll,
  getControls,
  listBridges,
  logEvent,
  setOrderState,
  updateControls,
} from "@/lib/exec/oms";
import { metaApiExecute, metaApiListAccounts, metaApiSyncPositions } from "@/lib/exec/metaApi";
import { enforceStopLevel, resolveInstrument, sizeByRisk } from "@/lib/exec/oms";
import type { Timeframe } from "@/lib/quant/data";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const controls = await getControls();
  return Response.json({ ok: true, controls });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "update": {
        const controls = await getControls();
        const patch: Record<string, unknown> = {};
        const booleans = [
          "armed",
          "killSwitch",
          "weekendHalt",
          "requireStopLoss",
          "autopilot",
        ] as const;
        const numbers = [
          "minMetaProb",
          "minConfidence",
          "maxDailyOrders",
          "maxDailyLossPct",
          "maxNotionalPct",
          "maxOpenPositions",
          "maxPositionsPerSymbol",
          "maxSpreadPoints",
          "sessionStartUtc",
          "sessionEndUtc",
          "cooldownSeconds",
          "lotMultiplier",
          "orderTtlSeconds",
          "trailingAtrMult",
          "breakevenAtR",
          "partialFraction",
          "partialAtR",
          "autopilotMinutes",
          "autopilotTarget",
        ] as const;
        const strings = [
          "mode",
          "confirmMode",
          "allowedSymbols",
          "metaApiAccountId",
          "autopilotSymbols",
          "autopilotPreset",
          "autopilotTimeframe",
        ] as const;
        for (const k of booleans) if (typeof body[k] === "boolean") patch[k] = body[k];
        for (const k of numbers) if (typeof body[k] === "number" && Number.isFinite(body[k] as number)) patch[k] = body[k];
        for (const k of strings) if (typeof body[k] === "string") patch[k] = body[k];
        void controls;
        const updated = await updateControls(patch as never);
        return Response.json({ ok: true, controls: updated });
      }

      case "arm": {
        const updated = await updateControls({ armed: true, killSwitch: false });
        await logEvent("audit", "risk", "execution engine ARMED — kill switch released");
        return Response.json({ ok: true, controls: updated });
      }

      case "disarm": {
        const updated = await updateControls({ armed: false });
        await logEvent("audit", "risk", "execution engine disarmed");
        return Response.json({ ok: true, controls: updated });
      }

      case "kill": {
        const result = await flattenAll(String(body.reason ?? "operator kill switch"));
        const updated = await updateControls({ killSwitch: true, armed: false });
        return Response.json({ ok: true, controls: updated, ...result });
      }

      case "dispatch": {
        const res = await autoDispatchFromSignals({
          ticker: String(body.ticker ?? "BTCUSDT"),
          timeframe: String(body.timeframe ?? "1h") as Timeframe,
          preset: String(body.preset ?? "apex_hit_rate"),
          targetWinRate: Number(body.targetWinRate ?? 0.85),
        });
        return Response.json({ ok: true, ...res });
      }

      case "approve": {
        const id = Number(body.id);
        const controls = await getControls();
        const { db } = await import("@/db");
        const { executionOrders } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await db
          .update(executionOrders)
          .set({
            state: "PENDING",
            errorText: "approved by operator",
            expiresAt: new Date(Date.now() + controls.orderTtlSeconds * 1000),
            updatedAt: new Date(),
          })
          .where(eq(executionOrders.id, id))
          .returning();
        const { logEvent } = await import("@/lib/exec/oms");
        await logEvent("audit", "order", `order #${id} approved by operator -> released to agent queue`, id);
        return Response.json({ ok: true, order: rows[0] ?? null });
      }

      case "cancel": {
        const id = Number(body.id);
        const order = await setOrderState(id, "CANCELLED", String(body.reason ?? "cancelled by operator"));
        return Response.json({ ok: true, order });
      }

      case "manual": {
        const bridges = await listBridges();
        const bridge = bridges[0] ?? null;
        const ticker = String(body.ticker ?? "EURUSD");
        const side = String(body.side ?? "buy") === "sell" ? "sell" : "buy";
        const price = Number(body.price ?? 0);
        const stop = Number(body.stop ?? 0);
        const target = Number(body.target ?? 0);
        const equity = Number(body.equity ?? bridge?.equity ?? 10_000);
        const riskPct = Number(body.riskPct ?? 0.005);
        const spec = await resolveInstrument(bridge?.id ?? null, ticker);
        if (!(price > 0) || !(stop > 0)) {
          return Response.json({ ok: false, error: "price and stop are required" }, { status: 400 });
        }
        const sized = sizeByRisk({ equity, riskFraction: riskPct, price, stopPrice: stop, spec });
        const stops = enforceStopLevel(side, price, stop, target, spec);
        const order = await createOrder({
          bridgeId: bridge?.id ?? null,
          action: "OPEN",
          ticker,
          symbol: spec.symbol,
          side,
          volume: sized.volume,
          requestedVolume: sized.volume,
          entryPrice: Number(price.toFixed(spec.digits)),
          stopPrice: stops.stop,
          targetPrice: stops.target,
          source: "manual",
          riskSnapshot: { lossPerLot: sized.lossPerLot, riskAmount: sized.riskAmount, specSource: spec.source },
        });
        return Response.json({ ok: true, order, spec, sized });
      }

      case "metaapi:accounts": {
        const res = await metaApiListAccounts();
        return Response.json({ ok: res.ok, accounts: res.data ?? [], message: res.message });
      }

      case "metaapi:sync": {
        const accountId = String(body.accountId ?? "");
        const bridges = await listBridges();
        const bridge = bridges[0];
        if (!accountId || !bridge) {
          return Response.json({ ok: false, error: "accountId and a registered bridge are required" }, { status: 400 });
        }
        const res = await metaApiSyncPositions(accountId, bridge.id);
        return Response.json(res as never);
      }

      case "metaapi:flush": {
        const controls = await getControls();
        const status = await execStatus();
        const pending = status.counts.queued;
        const orders = await import("@/lib/exec/oms").then((m) => m.listOrders({ state: "PENDING", limit: 10 }));
        const results = [];
        for (const o of orders) {
          const out = await metaApiExecute(o, controls.metaApiAccountId);
          const { ackOrder } = await import("@/lib/exec/oms");
          await ackOrder({
            orderId: o.id,
            state: out.ok ? "FILLED" : "REJECTED",
            retcode: out.retcode,
            retcodeText: out.message,
            fillPrice: out.price,
            fillVolume: out.volume,
            mt5Position: out.positionId,
          });
          results.push({ id: o.id, ok: out.ok, message: out.message });
        }
        return Response.json({ ok: true, pending, results });
      }

      default:
        return Response.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "execution control failure" },
      { status: 500 },
    );
  }
}
