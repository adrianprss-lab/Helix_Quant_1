import { NextRequest } from "next/server";
import { listBridges, registerBridge, removeBridge } from "@/lib/exec/oms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const bridges = await listBridges();
  return Response.json({
    ok: true,
    bridges: bridges.map((b) => ({ ...b, tokenHash: undefined })),
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const name = String(body.name ?? "mt5-primary").slice(0, 64);
  const adapter = String(body.adapter ?? "mt5_ea");
  const { bridge, token } = await registerBridge(name, adapter);
  return Response.json({
    ok: true,
    bridge: { ...bridge, tokenHash: undefined },
    // Shown once. Store it in the EA's InpAgentToken input.
    token,
  });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id)) return Response.json({ ok: false, error: "id required" }, { status: 400 });
  await removeBridge(id);
  return Response.json({ ok: true, removed: id });
}
