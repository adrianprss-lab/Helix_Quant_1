import Terminal, { type RunSummary } from "@/components/Terminal";
import { listRuns } from "@/lib/quant/pipeline";

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
  return <Terminal initialRuns={initialRuns} />;
}
