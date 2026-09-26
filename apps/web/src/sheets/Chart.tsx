import { useMemo, type JSX, type MouseEvent } from "react";
import type { ChartSpec, SheetData } from "./model";
import { parseRange, toA1 } from "./model";
import { evaluateSheet } from "./engine";

const COLORS = ["#F2782E", "#3578E5", "#1F9D66", "#D84B57", "#8E6BC8", "#E9B44C"];

interface Series { name: string; values: number[]; labels: string[] }

function extractSeries(sheet: SheetData, rangeA1: string): Series[] {
  const r = parseRange(rangeA1);
  if (!r) return [];
  const evals = evaluateSheet(sheet.cells);
  const val = (c: number, row: number): unknown => {
    const cell = sheet.cells[toA1(c, row)];
    if (!cell) return null;
    const res = evals.get(toA1(c, row));
    return cell.f ? res?.value : cell.v;
  };
  const labels: string[] = [];
  for (let row = r.r1 + 1; row <= r.r2; row++) labels.push(String(val(r.c1, row) ?? toA1(r.c1, row)));
  const series: Series[] = [];
  for (let c = r.c1 + 1; c <= r.c2; c++) {
    const name = String(val(c, r.r1) ?? `Series ${c - r.c1}`);
    const values: number[] = [];
    for (let row = r.r1 + 1; row <= r.r2; row++) values.push(Number(val(c, row)) || 0);
    series.push({ name, values, labels });
  }
  // Single-column range: treat whole column as one series
  if (!series.length && r.c1 === r.c2) {
    const values: number[] = [];
    const labs: string[] = [];
    for (let row = r.r1; row <= r.r2; row++) {
      labs.push(toA1(r.c1, row));
      values.push(Number(val(r.c1, row)) || 0);
    }
    series.push({ name: "Series 1", values, labels: labs });
  }
  return series;
}

export function ChartCard({ spec, sheet, onMove, onRemove }: {
  spec: ChartSpec;
  sheet: SheetData;
  onMove?: (id: string, x: number, y: number) => void;
  onRemove?: (id: string) => void;
}) {
  const series = useMemo(() => extractSeries(sheet, spec.range), [sheet, spec.range]);
  const W = 420, H = 240, PL = 44, PB = 30, PT = 30, PR = 12;

  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all.map(Math.abs));
  const labels = series[0]?.labels ?? [];

  const plotW = W - PL - PR, plotH = H - PT - PB;
  const groupW = labels.length ? plotW / labels.length : plotW;

  const barEls: JSX.Element[] = [];
  const lineEls: JSX.Element[] = [];

  series.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    if (spec.type === "bar") {
      const bw = (groupW * 0.7) / series.length;
      s.values.forEach((v, i) => {
        const h = (Math.abs(v) / max) * plotH;
        barEls.push(
          <rect key={`${si}-${i}`} x={PL + i * groupW + si * bw + groupW * 0.15}
            y={PT + plotH - h} width={bw * 0.92} height={h} rx={3} fill={color} />,
        );
      });
    } else if (spec.type === "line" || spec.type === "area") {
      const pts = s.values.map((v, i) => [
        PL + i * groupW + groupW / 2,
        PT + plotH - (v / max) * plotH,
      ]);
      const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
      if (spec.type === "area") {
        lineEls.push(<path key={`a${si}`} d={`${path} L${pts[pts.length - 1][0]},${PT + plotH} L${pts[0][0]},${PT + plotH} Z`}
          fill={color} opacity={0.22} />);
      }
      lineEls.push(<path key={`l${si}`} d={path} fill="none" stroke={color} strokeWidth={2.4} />);
      pts.forEach((p, i) => lineEls.push(<circle key={`p${si}-${i}`} cx={p[0]} cy={p[1]} r={3} fill={color} />));
    }
  });

  const drag = (e: MouseEvent) => {
    if (!onMove) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = spec.x, oy = spec.y;
    const move = (ev: globalThis.MouseEvent) => onMove(spec.id, ox + ev.clientX - sx, oy + ev.clientY - sy);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="chart-card" style={{ left: spec.x, top: spec.y }}>
      <div className="chart-head" onMouseDown={drag}>
        <b>{spec.title || spec.range}</b>
        {onRemove && <button onClick={() => onRemove(spec.id)}>✕</button>}
      </div>
      <svg width={W} height={H + 34} viewBox={`0 0 ${W} ${H + 34}`}>
        {/* axes */}
        <line x1={PL} y1={PT} x2={PL} y2={PT + plotH} stroke="#D8D2CC" />
        <line x1={PL} y1={PT + plotH} x2={PL + plotW} y2={PT + plotH} stroke="#D8D2CC" />
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={PL} y1={PT + plotH - t * plotH} x2={PL + plotW} y2={PT + plotH - t * plotH} stroke="#F0ECE8" />
            <text x={PL - 6} y={PT + plotH - t * plotH + 4} textAnchor="end" fontSize={9} fill="#A19A95">
              {Math.round(max * t)}
            </text>
          </g>
        ))}
        {spec.type === "pie" ? (
          <Pie series={series} cx={W / 2} cy={PT + plotH / 2} r={Math.min(plotH, plotW) / 2 - 6} />
        ) : (
          <>{barEls}{lineEls}</>
        )}
        {labels.map((l, i) => spec.type !== "pie" && (
          <text key={i} x={PL + i * groupW + groupW / 2} y={PT + plotH + 14}
            textAnchor="middle" fontSize={9} fill="#A19A95">{String(l).slice(0, 8)}</text>
        ))}
        {series.map((s, i) => (
          <g key={i} transform={`translate(${PL + i * 110},${H + 12})`}>
            <rect width={10} height={10} rx={3} fill={COLORS[i % COLORS.length]} />
            <text x={14} y={9} fontSize={9} fill="#6E6862">{s.name}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Pie({ series, cx, cy, r }: { series: Series[]; cx: number; cy: number; r: number }) {
  const vals = series[0]?.values.map((v) => Math.max(0, v)) ?? [];
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  let angle = -Math.PI / 2;
  return (
    <g>
      {vals.map((v, i) => {
        const a0 = angle;
        const a1 = angle + (v / total) * Math.PI * 2;
        angle = a1;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        return (
          <path key={i}
            d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`}
            fill={COLORS[i % COLORS.length]} stroke="#fff" strokeWidth={1.5}>
            <title>{series[0]?.labels[i]}: {series[0]?.values[i]}</title>
          </path>
        );
      })}
    </g>
  );
}
