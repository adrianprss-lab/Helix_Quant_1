import { NextRequest } from "next/server";
import { authenticateBridge, lineResponse, unauthorized } from "@/lib/exec/bridgeAuth";
import { expireStaleOrders, getControls, markBridgePoll, pullOrders, toControlsPayload } from "@/lib/exec/oms";
import { encodePollResponse } from "@/lib/exec/protocol";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { bridge } = await authenticateBridge(req);
  if (!bridge) return unauthorized();
  await expireStaleOrders();
  await markBridgePoll(bridge.id);
  const controls = await getControls();
  const payload = toControlsPayload(controls);
  const orders = controls.killSwitch ? [] : await pullOrders(bridge.id, 5);
  const url = new URL(req.url);
  if (url.searchParams.get("fmt") === "ea") {
    return lineResponse(encodePollResponse(payload, orders));
  }
  return Response.json({ ok: true, controls: payload, orders });
}
