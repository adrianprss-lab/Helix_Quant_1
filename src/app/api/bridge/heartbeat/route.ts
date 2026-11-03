import { NextRequest } from "next/server";
import { authenticateBridge, lineResponse, unauthorized } from "@/lib/exec/bridgeAuth";
import { autoDispatchFromSignals, getControls, heartbeat, logEvent, upsertInstruments } from "@/lib/exec/oms";
import type { Timeframe } from "@/lib/quant/data";
import { matchTicker } from "@/lib/exec/symbolMap";
import { parseRepeated, num } from "@/lib/exec/bridgeAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { bridge, fields, body } = await authenticateBridge(req);
  if (!bridge) return unauthorized();

  const updated = await heartbeat(bridge.id, fields);
  const controls = await getControls();

  // The EA may piggy-back contract specifications on the heartbeat.
  const specs = parseRepeated(body, "s");
  if (specs.length) {
    const mapped = specs.map((f) => {
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
    const written = await upsertInstruments(bridge.id, mapped);
    await logEvent("info", "bridge", `ingested ${written} contract specifications from ${bridge.name}`, undefined, bridge.id);
  }

  // ------------------------------------------------------------- autopilot
  // The EA poll is the cron: while armed, the server scans the configured
  // symbols on a fixed cadence and queues signals through the same risk guard
  // a manual dispatch would use. Never runs in paper mode or while disarmed.
  if (
    controls.autopilot &&
    controls.armed &&
    !controls.killSwitch &&
    controls.mode !== "paper"
  ) {
    const g = globalThis as typeof globalThis & { __helixAutopilot?: Record<string, number> };
    g.__helixAutopilot ??= {};
    const key = `ap-${bridge.id}`;
    const last = g.__helixAutopilot[key] ?? 0;
    const intervalMs = Math.max(1, controls.autopilotMinutes) * 60_000;
    if (Date.now() - last >= intervalMs) {
      g.__helixAutopilot[key] = Date.now();
      void (async () => {
        const symbols = (controls.autopilotSymbols || "BTCUSDT")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 3);
        try {
          for (const symbol of symbols) {
            await autoDispatchFromSignals({
              ticker: symbol,
              timeframe: controls.autopilotTimeframe as Timeframe,
              preset: controls.autopilotPreset,
              targetWinRate: controls.autopilotTarget,
            });
          }
          await logEvent("info", "autopilot", `autopilot scan finished: ${symbols.join(", ")}`, undefined, bridge.id);
        } catch (e) {
          await logEvent(
            "warn",
            "autopilot",
            `autopilot scan failed: ${e instanceof Error ? e.message : "unknown"}`,
            undefined,
            bridge.id,
          );
        }
      })();
    }
  }

  return lineResponse(
    [
      "ok=1",
      `armed=${controls.armed && !controls.killSwitch ? 1 : 0}`,
      `killswitch=${controls.killSwitch ? 1 : 0}`,
      `mode=${controls.mode}`,
      `lotmul=${controls.lotMultiplier}`,
      `maxspread=${controls.maxSpreadPoints}`,
      `symbols=${specs.length}`,
      `equity=${updated?.equity ?? 0}`,
    ].join("\n") + "\n",
  );
}
