import { NextRequest } from "next/server";
import { authenticateBridge, lineResponse, num, parseRepeated, unauthorized } from "@/lib/exec/bridgeAuth";
import { reconcilePositions } from "@/lib/exec/oms";
import { matchTicker } from "@/lib/exec/symbolMap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { bridge, body } = await authenticateBridge(req);
  if (!bridge) return unauthorized();
  const rows = parseRepeated(body, "p");
  const positions = rows.map((f) => ({
    ticket: f[0] ?? "",
    symbol: f[1] ?? "",
    side: (String(f[2]).toLowerCase() === "sell" ? "sell" : "buy") as "buy" | "sell",
    volume: num(f[3]),
    openPrice: num(f[4]),
    currentPrice: num(f[5], num(f[4])),
    sl: num(f[6]),
    tp: num(f[7]),
    profit: num(f[8]),
    swap: num(f[9]),
    commission: num(f[10]),
    magic: num(f[11]),
    comment: f[12] ?? "",
    openedTs: num(f[13], Math.floor(Date.now() / 1000)),
  }));
  const out = await reconcilePositions(bridge.id, positions);
  return lineResponse(`ok=1\nsynced=${out.synced}\nclosed=${out.closed}\n`);
}
