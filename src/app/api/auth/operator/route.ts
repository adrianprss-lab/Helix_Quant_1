import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * Optional operator passcode (env OPERATOR_PASSCODE).
 * Not set  -> terminal behaves exactly as before (open).
 * Set      -> dangerous endpoints require a session cookie issued here.
 */
export function passcodeConfigured(): boolean {
  return Boolean(process.env.OPERATOR_PASSCODE);
}

export function passcodeHash(): string {
  return createHash("sha256").update(`helix-op:${process.env.OPERATOR_PASSCODE ?? ""}`).digest("hex");
}

export async function operatorUnlocked(req: NextRequest): Promise<boolean> {
  if (!passcodeConfigured()) return true;
  const cookie = req.cookies.get("helix_op")?.value;
  return cookie === passcodeHash();
}

export async function POST(req: NextRequest) {
  if (!passcodeConfigured()) {
    return Response.json({ ok: true, locked: false, message: "kein passcode konfiguriert - terminal ist offen" });
  }
  let body: { passcode?: string } = {};
  try {
    body = (await req.json()) as { passcode?: string };
  } catch {
    body = {};
  }
  const givenHash = createHash("sha256").update(`helix-op:${String(body.passcode ?? "")}`).digest("hex");
  if (givenHash !== passcodeHash()) {
    return Response.json({ ok: false, error: "passcode falsch" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, locked: true, unlocked: true });
  res.cookies.set("helix_op", passcodeHash(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

export async function GET(req: NextRequest) {
  return Response.json({
    locked: passcodeConfigured(),
    unlocked: await operatorUnlocked(req),
  });
}
