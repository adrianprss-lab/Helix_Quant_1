import { NextRequest } from "next/server";
import { PRESETS, scanSignals, type PresetKey } from "@/lib/quant/pipeline";
import type { Timeframe } from "@/lib/quant/data";
import { UNIVERSE } from "@/lib/quant/data";
import { clamp } from "@/lib/quant/math";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") ?? "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => UNIVERSE.some((u) => u.ticker === t))
    .slice(0, 4);
  const timeframe = (url.searchParams.get("timeframe") ?? "1h") as Timeframe;
  const presetKey = (url.searchParams.get("preset") ?? "apex_hit_rate") as PresetKey;
  const target = clamp(Number(url.searchParams.get("target") ?? PRESETS[presetKey]?.targetWinRate ?? 0.85), 0.35, 0.97);
  const bars = clamp(Number(url.searchParams.get("bars") ?? 1200), 600, 3000);

  const list = tickers.length ? tickers : ["BTCUSDT"];
  const scans = [];
  for (const ticker of list) {
    try {
      const scan = await scanSignals(ticker, timeframe, bars, presetKey in PRESETS ? presetKey : "apex_hit_rate", target);
      scans.push({
        ticker: scan.ticker,
        source: scan.source,
        price: scan.price,
        regime: scan.regime,
        atrPct: scan.atrPct,
        threshold: scan.threshold,
        health: scan.health,
        candidates: scan.candidates,
        tape: scan.tape.slice(0, 8),
        votes: scan.votes,
        alphaIc: scan.alphaIc,
        featureImportance: scan.metaFeatureImportance.slice(0, 8),
        candles: scan.candles.slice(-120),
      });
    } catch (err) {
      scans.push({
        ticker,
        error: err instanceof Error ? err.message : "scan failed",
        price: 0,
        regime: "range",
        atrPct: 0,
        threshold: 0.5,
        health: {},
        candidates: [],
        tape: [],
        votes: {},
        alphaIc: {},
        featureImportance: [],
        candles: [],
        source: "error",
      });
    }
  }
  return Response.json({ ok: true, timeframe, preset: presetKey, target, scans });
}
