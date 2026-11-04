import type { Metadata } from "next";
import Link from "next/link";
import { getRun } from "@/lib/quant/pipeline";
import type { EquityPoint, StrategyAttribution } from "@/lib/quant/types";
import { DrawdownChart, EquityChart } from "@/components/charts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HELIX QUANT · Performance Report",
  description: "Read-only performance report of a HELIX QUANT research run.",
};

const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;
const num = (v: number, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : "—");

function Kpi({ label, value, tone = "text-white" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="gcard rounded-xl px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-semibold leading-none tracking-tight tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getRun(Number(id));
  if (!data) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="gcard rounded-2xl px-8 py-6 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">report nicht gefunden</p>
          <Link href="/" className="mt-3 inline-block text-sm text-[#98a0ff] underline decoration-dotted">
            zurück zum Terminal
          </Link>
        </div>
      </main>
    );
  }
  const { run } = data;
  const m = run.metrics;
  const curve = (run.equityCurve as EquityPoint[] | null) ?? [];
  const attribution =
    ((run.attribution as { attribution?: StrategyAttribution[] } | null)?.attribution as StrategyAttribution[]) ?? [];

  return (
    <main className="mx-auto max-w-[1100px] space-y-5 px-6 py-10">
      <header className="flex flex-wrap items-center gap-3">
        <div className="brand-mark grid h-9 w-9 place-items-center rounded-[10px] font-mono text-sm font-bold">֏</div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#98a0ff]">public performance report</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{run.label}</h1>
        </div>
        <span className="ml-auto rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[10px] text-slate-400">
          run #{run.id} · {new Date(run.createdAt).toISOString().slice(0, 10)} · {run.dataSource} feed
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Kpi label="Hit rate" value={pct(m.winRate)} tone="text-[#4cb782]" />
        <Kpi label="Trades" value={String(m.trades)} />
        <Kpi label="Profit factor" value={num(m.profitFactor)} tone={m.profitFactor >= 1 ? "text-[#4cb782]" : "text-[#eb5757]"} />
        <Kpi label="Expectancy" value={`${m.expectancyR >= 0 ? "+" : ""}${num(m.expectancyR, 3)}R`} tone={m.expectancyR >= 0 ? "text-[#4cb782]" : "text-[#eb5757]"} />
        <Kpi label="Net return" value={pct(m.netReturn)} tone={m.netReturn >= 0 ? "text-[#4cb782]" : "text-[#eb5757]"} />
        <Kpi label="Max drawdown" value={pct(m.maxDrawdown)} tone="text-[#eb5757]" />
        <Kpi label="Sharpe" value={num(m.sharpe)} />
        <Kpi label="Deflated Sharpe" value={num(m.deflatedSharpe, 3)} />
      </div>

      {curve.length > 1 ? (
        <section className="gcard rounded-2xl">
          <header className="px-5 py-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">equity curve</h2>
          </header>
          <div className="border-t border-white/[0.06] px-4 py-4">
            <EquityChart data={curve} />
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <DrawdownChart data={curve} />
            </div>
          </div>
        </section>
      ) : null}

      {attribution.length ? (
        <section className="gcard rounded-2xl">
          <header className="px-5 py-3">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">alpha attribution</h2>
          </header>
          <div className="border-t border-white/[0.06] px-5 py-4">
            <table className="w-full font-mono text-[11px]">
              <thead className="text-slate-500">
                <tr className="border-b border-white/[0.07]">
                  <th className="py-1.5 text-left">model</th>
                  <th className="text-right">trades</th>
                  <th className="text-right">hit rate</th>
                  <th className="text-right">exp. R</th>
                  <th className="text-right">net P&L</th>
                </tr>
              </thead>
              <tbody>
                {attribution.slice(0, 8).map((a) => (
                  <tr key={a.alphaKey} className="border-b border-white/[0.04]">
                    <td className="py-1.5 pr-2 text-slate-300">{a.name}</td>
                    <td className="text-right text-slate-400">{a.trades}</td>
                    <td className={`text-right ${a.winRate >= 0.5 ? "text-[#4cb782]" : "text-[#eb5757]"}`}>{pct(a.winRate, 0)}</td>
                    <td className={`text-right ${a.expectancyR > 0 ? "text-[#4cb782]" : "text-[#eb5757]"}`}>{num(a.expectancyR, 3)}</td>
                    <td className={`text-right ${a.netPnl > 0 ? "text-[#4cb782]" : "text-[#eb5757]"}`}>{Math.round(a.netPnl).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="text-[11px] leading-relaxed text-slate-500">
        Read-only excerpt of a HELIX QUANT research run. Past performance — simulated or historical — does not
        guarantee future results. No account data, no tokens, no controls are exposed on this page.
      </p>
      <Link href="/" className="font-mono text-[11px] text-[#98a0ff] underline decoration-dotted">
        → eigenes Terminal öffnen
      </Link>
    </main>
  );
}
