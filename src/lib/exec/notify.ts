import { db } from "@/db";
import { executionControls } from "@/db/schema";

export type NotifyKind = "fill" | "reject" | "held" | "kill" | "test";

/**
 * Push notifications to Telegram / Discord / any JSON webhook.
 * The operator pastes a full endpoint URL (Telegram needs bot token +
 * chat_id in the URL, Discord a webhook URL); the payload shape is picked
 * automatically. Fire-and-forget: a dead webhook must never block trading.
 */
export async function notify(kind: NotifyKind, text: string): Promise<boolean> {
  try {
    const rows = await db.select().from(executionControls).limit(1);
    const url = rows[0]?.webhookUrl ?? "";
    if (!url) return false;
    const stamp = new Date().toISOString().slice(11, 16);
    const message = `HELIX · ${kind.toUpperCase()} · ${stamp} UTC\n${text}`;
    const body = url.includes("api.telegram.org")
      ? JSON.stringify({ text: message })
      : url.includes("discord.com/api/webhooks") || url.includes("discordapp.com")
        ? JSON.stringify({ content: `**${message.split("\n").join("  ·  ")}**` })
        : JSON.stringify({ kind, text, at: new Date().toISOString() });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
