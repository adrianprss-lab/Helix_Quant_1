import { NextRequest } from "next/server";
import { authenticateBridge, lineResponse, num, unauthorized } from "@/lib/exec/bridgeAuth";
import { ackOrder } from "@/lib/exec/oms";
import type { OrderState } from "@/lib/exec/protocol";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATES: OrderState[] = ["PENDING", "DISPATCHED", "ACKED", "FILLED", "PARTIALLY_FILLED", "REJECTED", "CANCELLED", "EXPIRED"];

export async function POST(req: NextRequest) {
  const { bridge, fields } = await authenticateBridge(req);
  if (!bridge) return unauthorized();
  const orderId = Number(fields.order);
  if (!Number.isFinite(orderId)) return lineResponse("ok=0\nerror=missing order id\n", 400);
  const rawState = String(fields.state ?? "ACKED").toUpperCase();
  const state = (STATES.includes(rawState as OrderState) ? rawState : "ACKED") as OrderState;

  const order = await ackOrder({
    orderId,
    state,
    retcode: fields.retcode ? Number(fields.retcode) : undefined,
    retcodeText: fields.text ?? undefined,
    errorText: state === "REJECTED" ? fields.text ?? "agent rejection" : undefined,
    fillPrice: fields.price ? num(fields.price) : undefined,
    fillVolume: fields.volume ? num(fields.volume) : undefined,
    slippagePoints: fields.slippage ? num(fields.slippage) : undefined,
    mt5Position: fields.position || undefined,
    mt5Deal: fields.deal || undefined,
  });
  if (!order) return lineResponse("ok=0\nerror=unknown order\n", 404);
  return lineResponse(`ok=1\norder=${order.id}\nstate=${order.state}\n`);
}
