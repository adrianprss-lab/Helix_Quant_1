import Terminal, { type RunResponse, type RunSummary } from "@/components/Terminal";
import { getRun, listRuns } from "@/lib/quant/pipeline";
import type { EquityPoint, StrategyAttribution, Trade } from "@/lib/quant/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const runs = await listRuns(30);
  const initialRuns: RunSummary[] = runs.map((r) => ({
    id: r.id,
    label: r.label,
    ticker: r.ticker,
    timeframe: r.timeframe,
    preset: r.preset,
    winRate: r.winRate,
    profitFactor: r.profitFactor,
    netReturn: r.netReturn,
    sharpe: r.sharpe,
    maxDrawdown: r.maxDrawdown,
    tradeCount: r.tradeCount,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
  }));
  // Latest run straight from the database, so a fresh visitor (or a friend
  // with the link) sees the terminal alive instead of "awaiting first run".
  let initialRun: RunResponse | null = null;
  if (initialRuns.length) {
    const detail = await getRun(initialRuns[0].id);
    const r = detail?.run;
    if (r) {
      const attr = (r.attribution as { attribution?: StrategyAttribution[] } | null)?.attribution ?? [];
      initialRun = {
        ok: true,
        runId: r.id,
        label: r.label,
        ticker: r.ticker,
        timeframe: r.timeframe,
        dataSource: r.dataSource,
        preset: r.preset,
        bars: r.bars,
        targetWinRate: r.targetWinRate,
        achievedWinRate: r.winRate,
        durationMs: r.durationMs,
        diagnostics: [
          `Geladen aus der Run-Datenbank (#${r.id}) — neuer Pipeline-Lauf ueberschreibt diese Ansicht.`,
        ],
        metrics: r.metrics,
        oosMetrics: null,
        attribution: attr,
        regimeAttribution: [],
        equityCurve: (r.equityCurve as EquityPoint[] | null) ?? [],
        oosEquityCurve: [],
        trades: ((detail?.trades ?? []) as unknown as Partial<Trade>[]).map((t) => ({
          ...t,
          side: (t.side as Trade["side"]) ?? "long",
          exitReason: (t.exitReason as Trade["exitReason"]) ?? "end_of_data",
          regime: (t.regime as Trade["regime"]) ?? "range",
          riskPerUnit: t.riskPerUnit ?? 0,
          equityAfter: t.equityAfter ?? 0,
          fills: t.fills ?? [],
        })) as Trade[],
        monthlyReturns: [],
        rolledWinRate: [],
        walkForward: (r.walkForward as RunResponse["walkForward"]) ?? null,
        monteCarlo: (r.monteCarlo as RunResponse["monteCarlo"]) ?? null,
        pbo:
          r.pbo !== null && r.pbo !== undefined
            ? { blocks: 0, combinations: 0, pbo: r.pbo, logitMean: 0, oosRankCorrelation: 0, verdict: "gespeicherter PBO-Wert" }
            : null,
        optimization: { enabled: false, trials: [], bestObjective: 0, generations: 0, evaluations: 0 },
        candles: [],
      };
    }
  }
  return <Terminal initialRuns={initialRuns} initialRun={initialRun} />;
}
