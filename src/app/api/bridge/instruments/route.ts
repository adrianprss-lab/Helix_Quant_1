import { NextRequest } from "next/server";
import { authenticateBridge, lineResponse, num, parseRepeated, unauthorized } from "@/lib/exec/bridgeAuth";
import { logEvent, upsertInstruments } from "@/lib/exec/oms";
import { matchTicker } from "@/lib/exec/symbolMap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { bridge, body } = await authenticateBridge(req);
  if (!bridge) return unauthorized();
  const rows = parseRepeated(body, "s");
  const specs = rows.map((f) => {
    const symbol = f[0] ?? "";
    const match = matchTicker(symbol);
    return {
      ticker: match.ticker ?? symbol,
      symbol,
      point: num(f[1], 0.00001),
      contractSize: num(f[2], 1),
      minVolume: num(f[3], 0.01),
      maxVolume: num(f[4], 100),
      volumeStep: num(f[5], 0.01),
      digits: num(f[6], 5),
      stopsLevel: num(f[7], 0),
      freezeLevel: num(f[8], 0),
      tradeMode: num(f[9], 0),
      spreadPoints: num(f[10], 0),
      marginCurrency: f[11] ?? null,
      tickValue: f[12] ? num(f[12]) : null,
    };
  });
  const written = await upsertInstruments(bridge.id, specs);
  await logEvent(
    "info",
    "bridge",
    `ingested ${written} contract specifications from ${bridge.name}`,
    undefined,
    bridge.id,
    { unmatched: specs.filter((s) => s.ticker === s.symbol && !matchTicker(s.symbol).ticker).map((s) => s.symbol) },
  );
  return lineResponse(`ok=1\nwritten=${written}\n`);
}
