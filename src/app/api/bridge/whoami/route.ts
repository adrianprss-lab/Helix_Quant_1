import { NextRequest } from "next/server";
import { authenticateBridge } from "@/lib/exec/bridgeAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Side-effect free connectivity + token check.
 * Opens in a plain browser tab: proves (a) the host is reachable from the
 * user's machine and (b) the agent token stored in the EA is the one the
 * server knows. Unlike /bridge/poll this never consumes queued orders.
 */
export async function GET(req: NextRequest) {
  const { bridge } = await authenticateBridge(req);
  if (!bridge) {
    return new Response("ok=0\nerror=invalid or missing agent token\n", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(
    [
      "ok=1",
      `bridge=${bridge.name}`,
      `status=${bridge.status}`,
      `server=${bridge.mt5Server ?? "not reported yet"}`,
      `login=${bridge.mt5Login ?? "not reported yet"}`,
      `lastHeartbeat=${bridge.lastHeartbeatAt ? new Date(bridge.lastHeartbeatAt).toISOString() : "never"}`,
      "",
      "# Token is valid. If the EA still reports no connection, the problem is",
      "# the MT5 WebRequest allow list or an outdated InpServerUrl.",
    ].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
