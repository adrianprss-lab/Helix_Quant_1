"use client";

import { useMemo, useState } from "react";

const AXIS = "#26292e";
const GRID = "rgba(255,255,255,0.06)";
const TEXT = "#8a8f98";

function pathFrom(points: [number, number][], scale: (p: [number, number]) => [number, number]): string {
  if (!points.length) return "";
  return points
    .map((p, i) => {
      const [x, y] = scale(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export interface EquityPointLite {
  ts: number;
  equity: number;
  drawdown: number;
  benchmark: number;
  exposure: number;
}

export function EquityChart({
  data,
  oosFrom,
  height = 260,
}: {
  data: EquityPointLite[];
  oosFrom?: number | null;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = height;
  const padL = 58;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const bounds = useMemo(() => {
    if (!data.length) return { min: 0, max: 1, t0: 0, t1: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const d of data) {
      min = Math.min(min, d.equity, d.benchmark);
      max = Math.max(max, d.equity, d.benchmark);
    }
    const span = max - min || 1;
    return { min: min - span * 0.06, max: max + span * 0.06, t0: data[0].ts, t1: data[data.length - 1].ts };
  }, [data]);

  const sx = (ts: number) => padL + ((ts - bounds.t0) / Math.max(1, bounds.t1 - bounds.t0)) * (W - padL - padR);
  const sy = (v: number) => padT + (1 - (v - bounds.min) / (bounds.max - bounds.min)) * (H - padT - padB);

  const eqPath = pathFrom(data.map((d) => [d.ts, d.equity] as [number, number]), ([t, v]) => [sx(t), sy(v)]);
  const bmPath = pathFrom(data.map((d) => [d.ts, d.benchmark] as [number, number]), ([t, v]) => [sx(t), sy(v)]);
  const areaPath = `${eqPath} L${sx(bounds.t1).toFixed(2)},${(H - padB).toFixed(2)} L${sx(bounds.t0).toFixed(2)},${(H - padB).toFixed(2)} Z`;
  const hoverPoint = hover !== null ? data[hover] : null;
  const gridLines = 5;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.target as SVGElement).ownerSVGElement?.getBoundingClientRect();
          if (!rect || !data.length) return;
          const rel = ((e.clientX - rect.left) / rect.width) * W;
          const frac = (rel - padL) / Math.max(1, W - padL - padR);
          const idx = Math.round(frac * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, idx)));
        }}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4cb782" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#4cb782" stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const v = bounds.min + ((bounds.max - bounds.min) * i) / gridLines;
          const y = sy(v);
          return (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={GRID} strokeWidth="1" />
              <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="10" fill={TEXT}>
                {Math.round(v).toLocaleString()}
              </text>
            </g>
          );
        })}
        {oosFrom ? (
          <rect
            x={sx(oosFrom)}
            y={padT}
            width={Math.max(0, W - padR - sx(oosFrom))}
            height={H - padT - padB}
            fill="#5e6ad2"
            opacity="0.08"
          />
        ) : null}
        <path d={areaPath} fill="url(#eqFill)" />
        <path d={bmPath} fill="none" stroke="#565b66" strokeWidth="1.2" strokeDasharray="4 3" />
        <path d={eqPath} fill="none" stroke="#4cb782" strokeWidth="2" />
        {hoverPoint ? (
          <g>
            <line x1={sx(hoverPoint.ts)} x2={sx(hoverPoint.ts)} y1={padT} y2={H - padB} stroke="#26292e" strokeWidth="1" />
            <circle cx={sx(hoverPoint.ts)} cy={sy(hoverPoint.equity)} r="4" fill="#4cb782" />
          </g>
        ) : null}
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={AXIS} />
      </svg>
      {hoverPoint ? (
        <div className="pointer-events-none absolute right-3 top-2 rounded border border-slate-800 bg-slate-950/90 px-2 py-1 font-mono text-[10px] text-slate-300">
          {new Date(hoverPoint.ts * 1000).toISOString().slice(0, 16).replace("T", " ")} · eq{" "}
          <span className="text-emerald-400">{Math.round(hoverPoint.equity).toLocaleString()}</span> · bh{" "}
          <span className="text-slate-400">{Math.round(hoverPoint.benchmark).toLocaleString()}</span> · dd{" "}
          <span className="text-rose-400">{(hoverPoint.drawdown * 100).toFixed(2)}%</span>
        </div>
      ) : null}
    </div>
  );
}

export function DrawdownChart({ data, height = 110 }: { data: EquityPointLite[]; height?: number }) {
  const W = 1000;
  const H = height;
  const padL = 58;
  const padR = 12;
  if (!data.length) return <div className="h-[110px]" />;
  const worst = Math.min(-0.001, ...data.map((d) => d.drawdown));
  const sx = (i: number) => padL + (i / Math.max(1, data.length - 1)) * (W - padL - padR);
  const sy = (v: number) => 8 + (v / worst) * (H - 26);
  const p = data.map((d, i) => `L${sx(i).toFixed(2)},${sy(d.drawdown).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, 0.5, 1].map((f) => {
        const y = sy(-worst * f);
        return (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} stroke={GRID} />
            <text x={padL - 8} y={y + 3} textAnchor="end" fontSize="9" fill={TEXT}>
              {(-worst * f * 100).toFixed(1)}%
            </text>
          </g>
        );
      })}
      <path d={`M${sx(0)},${sy(0)} ${p} L${sx(data.length - 1)},${sy(0)} Z`} fill="#e5484d" fillOpacity="0.16" />
      <path d={`M${sx(0)},${sy(data[0].drawdown)} ${p}`} fill="none" stroke="#e5484d" strokeWidth="1.6" />
    </svg>
  );
}

export function FanChart({
  percentiles,
  height = 170,
}: {
  percentiles: { p05: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  height?: number;
}) {
  const W = 1000;
  const H = height;
  const padL = 52;
  const padR = 12;
  const all = [...percentiles.p05, ...percentiles.p95, 1];
  if (percentiles.p50.length < 2) return <div className="h-[170px]" />;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const n = percentiles.p50.length;
  const sx = (i: number) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const sy = (v: number) => 10 + (1 - (v - min) / (max - min || 1)) * (H - 28);
  const band = (a: number[], b: number[]) =>
    `M${a.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" L")} L${b
      .map((v, i) => `${sx(b.length - 1 - i).toFixed(1)},${sy(b[b.length - 1 - i]).toFixed(1)}`)
      .join(" L")} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <path d={band(percentiles.p05, percentiles.p95)} fill="#5e6ad2" fillOpacity="0.10" />
      <path d={band(percentiles.p25, percentiles.p75)} fill="#5e6ad2" fillOpacity="0.20" />
      <path
        d={`M${percentiles.p50.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" L")}`}
        fill="none"
        stroke="#98a0ff"
        strokeWidth="1.8"
      />
      <line x1={padL} x2={W - padR} y1={sy(1)} y2={sy(1)} stroke="#26292e" strokeDasharray="4 3" />
      <text x={padL - 6} y={sy(max) + 8} textAnchor="end" fontSize="9" fill={TEXT}>
        +{((max - 1) * 100).toFixed(0)}%
      </text>
      <text x={padL - 6} y={sy(min) + 8} textAnchor="end" fontSize="9" fill={TEXT}>
        {((min - 1) * 100).toFixed(0)}%
      </text>
    </svg>
  );
}

export function RollingWinRateChart({
  data,
  target,
  height = 120,
}: {
  data: { ts: number; winRate: number }[];
  target: number;
  height?: number;
}) {
  const W = 1000;
  const H = height;
  if (data.length < 2) return <div className="h-[120px]" />;
  const sx = (i: number) => 40 + (i / (data.length - 1)) * (W - 52);
  const sy = (v: number) => 8 + (1 - v) * (H - 24);
  const p = `M${data.map((d, i) => `${sx(i).toFixed(1)},${sy(d.winRate).toFixed(1)}`).join(" L")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={40} x2={W - 12} y1={sy(v)} y2={sy(v)} stroke={GRID} />
          <text x={34} y={sy(v) + 3} textAnchor="end" fontSize="9" fill={TEXT}>
            {(v * 100).toFixed(0)}%
          </text>
        </g>
      ))}
      <line x1={40} x2={W - 12} y1={sy(target)} y2={sy(target)} stroke="#f5a524" strokeDasharray="5 3" strokeWidth="1.4" />
      <path d={`${p} L${sx(data.length - 1)},${sy(0)} L${sx(0)},${sy(0)} Z`} fill="#4cb782" fillOpacity="0.10" />
      <path d={p} fill="none" stroke="#4cb782" strokeWidth="1.8" />
    </svg>
  );
}

export function MonthlyBars({ data }: { data: { label: string; return: number }[] }) {
  if (!data.length) return null;
  const max = Math.max(0.02, ...data.map((d) => Math.abs(d.return)));
  return (
    <div className="flex h-24 items-end gap-[3px]">
      {data.map((d) => {
        const h = Math.max(2, (Math.abs(d.return) / max) * 100);
        const up = d.return >= 0;
        return (
          <div key={d.label} className="group relative flex-1" title={`${d.label}: ${(d.return * 100).toFixed(2)}%`}>
            <div
              className={`w-full rounded-sm ${up ? "bg-emerald-500/70" : "bg-rose-500/70"}`}
              style={{ height: `${h}%`, alignSelf: up ? "flex-end" : "flex-start" }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function MiniPriceChart({ candles }: { candles: { ts: number; close: number }[] }) {
  if (candles.length < 2) return null;
  const W = 240;
  const H = 56;
  const min = Math.min(...candles.map((c) => c.close));
  const max = Math.max(...candles.map((c) => c.close));
  const sx = (i: number) => (i / (candles.length - 1)) * W;
  const sy = (v: number) => H - 4 - ((v - min) / (max - min || 1)) * (H - 8);
  const up = candles[candles.length - 1].close >= candles[0].close;
  const p = `M${candles.map((c, i) => `${sx(i).toFixed(1)},${sy(c.close).toFixed(1)}`).join(" L")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <path d={`${p} L${W},${H} L0,${H} Z`} fill={up ? "#4cb782" : "#e5484d"} fillOpacity="0.12" />
      <path d={p} fill="none" stroke={up ? "#4cb782" : "#e5484d"} strokeWidth="1.5" />
    </svg>
  );
}

export function TrialsScatter({
  trials,
  target,
}: {
  trials: { winRate: number; netReturn: number; objective: number }[];
  target: number;
}) {
  if (!trials.length) return null;
  const W = 1000;
  const H = 150;
  const pad = 34;
  const maxObj = Math.max(...trials.map((t) => t.objective));
  const minObj = Math.min(...trials.map((t) => t.objective));
  const x = (wr: number) => pad + wr * (W - pad - 12);
  const y = (o: number) => 10 + (1 - (o - minObj) / (maxObj - minObj || 1)) * (H - 30);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1={x(target)} x2={x(target)} y1={8} y2={H - 20} stroke="#f5a524" strokeDasharray="4 3" />
      <text x={x(target) + 4} y={16} fontSize="9" fill="#f5a524">
        target {(target * 100).toFixed(0)}%
      </text>
      {trials.map((t, i) => (
        <circle
          key={i}
          cx={x(Math.min(1, t.winRate))}
          cy={y(t.objective)}
          r={t.netReturn > 0 ? 3.4 : 2.2}
          fill={t.netReturn > 0 ? "#4cb782" : "#e5484d"}
          fillOpacity={0.75}
        />
      ))}
      <line x1={pad} x2={W - 12} y1={H - 20} y2={H - 20} stroke={AXIS} />
      <text x={pad} y={H - 6} fontSize="9" fill={TEXT}>
        40%
      </text>
      <text x={W - 30} y={H - 6} fontSize="9" fill={TEXT}>
        100%
      </text>
    </svg>
  );
}
