import { NextRequest } from "next/server";
import { getRun } from "@/lib/quant/pipeline";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) {
    return Response.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const data = await getRun(numeric);
  if (!data) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  return Response.json({ ok: true, ...data });
}
