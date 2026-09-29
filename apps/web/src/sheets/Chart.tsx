import { useMemo, type JSX, type MouseEvent } from "react";
import type { ChartSpec, SheetData, Workbook } from "./model";
import { parseRange, toA1 } from "./model";
import { evaluateSheet, evaluateSheetIn } from "./engine";

const COLORS = ["#F2782E", "#3578E5", "#1F9D66", "#D84B57", "#8E6BC8", "#E9B44C"];

interface Series { name: string; values: number[]; labels: string[] }

/** Range may be `Sheet2!A1:C5` — resolve to the owning sheet + plain range. */
function resolveRange(wb: Workbook | undefined, fallback: SheetData, rangeA1: string): { sheet: SheetData; rangeA1: string } {
  const m = rangeA1.match(/^(?:'([^']+)'|([A-Za-z_][\w.]*))!(.+)$/);
  const name = m?.[1] ?? m?.[2];
  const sheet = name && wb
    ? (wb.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? fallback)
    : fallback;
  return { sheet, rangeA1: m ? m[3] : rangeA1 };
}

export function extractSeries(sheet: SheetData, rangeA1: string, wb?: Workbook): Series[] {
  const target = resolveRange(wb, sheet, rangeA1);
  sheet = target.sheet;
  const r = parseRange(target.rangeA1);
  if (!r) return [];
  const evals = wb ? evaluateSheetIn(wb, sheet.name) : evaluateSheet(sheet.cells);
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

const fmtTick = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

export function ChartCard({ spec, sheet, wb, onMove, onRemove, onEdit }: {
  spec: ChartSpec;
  sheet: SheetData;
  wb?: Workbook;
  onMove?: (id: string, x: number, y: number) => void;
  onRemove?: (id: string) => void;
  onEdit?: (spec: ChartSpec) => void;
}) {
  const series = useMemo(() => extractSeries(sheet, spec.range, wb), [sheet, spec.range, wb]);
  const W = 440, H = 250;
  const rightLegend = spec.legend === "right";
  const legendPos = spec.legend ?? "bottom";
  const PL = spec.yTitle ? 56 : 44, PB = spec.xTitle ? 42 : 30, PT = 30;
  const PR = rightLegend ? 92 : 12;

  const isPie = spec.type === "pie" || spec.type === "doughnut";
  const isScatter = spec.type === "scatter";

  // stacked: cumulative sums per index; max is the tallest stack
  const stacks: number[] = [];
  if (spec.type === "stacked") {
    const n = series[0]?.values.length ?? 0;
    for (let i = 0; i < n; i++) stacks.push(series.reduce((a, s) => a + Math.max(0, s.values[i]), 0));
  }
  const all = series.flatMap((s) => s.values);
  const max = spec.type === "stacked" ? Math.max(1, ...stacks) : Math.max(1, ...all.map(Math.abs));

  const labels = series[0]?.labels ?? [];
  const xs = labels.map((l) => Number(l)); // scatter X coords come from the label column
  const xMin = Math.min(...xs), xMax = Math.max(...xs, xMin + 1);

  const plotW = W - PL - PR, plotH = H - PT - PB;
  const groupW = labels.length ? plotW / labels.length : plotW;
  const xAt = (i: number) => isScatter
    ? PL + ((xs[i] - xMin) / (xMax - xMin || 1)) * plotW
    : PL + i * groupW + groupW / 2;

  const els: JSX.Element[] = [];
  const cum: number[] = new Array(labels.length).fill(0);

  series.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    const isLine = spec.type === "line" || spec.type === "area" || spec.type === "scatter"
      || (spec.type === "combo" && si === series.length - 1);
    if (isLine) {
      const pts = s.values.map((v, i) => [xAt(i), PT + plotH - (v / max) * plotH]);
      if (spec.type !== "scatter") {
        const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
        if (spec.type === "area") {
          els.push(<path key={`a${si}`} d={`${path} L${pts[pts.length - 1][0]},${PT + plotH} L${pts[0][0]},${PT + plotH} Z`}
            fill={color} opacity={0.22} />);
        }
        els.push(<path key={`l${si}`} d={path} fill="none" stroke={color} strokeWidth={2.4} />);
      }
      pts.forEach((p, i) => {
        els.push(<circle key={`p${si}-${i}`} cx={p[0]} cy={p[1]} r={spec.type === "scatter" ? 4 : 3}
          fill={color} fillOpacity={spec.type === "scatter" ? 0.85 : 1} />);
        if (spec.dataLabels) els.push(
          <text key={`d${si}-${i}`} x={p[0]} y={p[1] - 6} textAnchor="middle" fontSize={8} fill="#6E6862">{fmtTick(s.values[i])}</text>);
      });
    } else if (spec.type === "bar" || spec.type === "combo") {
      const bw = (groupW * 0.7) / (spec.type === "combo" ? Math.max(1, series.length - 1) : series.length);
      s.values.forEach((v, i) => {
        const h = (Math.abs(v) / max) * plotH;
        const bx = PL + i * groupW + si * bw + groupW * 0.15;
        els.push(<rect key={`${si}-${i}`} x={bx} y={PT + plotH - h} width={bw * 0.92} height={h} rx={3} fill={color} />);
        if (spec.dataLabels) els.push(
          <text key={`d${si}-${i}`} x={bx + bw / 2} y={PT + plotH - h - 4} textAnchor="middle" fontSize={8} fill="#6E6862">{fmtTick(v)}</text>);
      });
    } else if (spec.type === "stacked") {
      const bw = groupW * 0.6;
      s.values.forEach((v, i) => {
        const h = (Math.max(0, v) / max) * plotH;
        const y0 = PT + plotH - (cum[i] / max) * plotH;
        els.push(<rect key={`${si}-${i}`} x={xAt(i) - bw / 2} y={y0 - h} width={bw} height={h} fill={color} stroke="#fff" strokeWidth={1} />);
        if (spec.dataLabels) els.push(
          <text key={`d${si}-${i}`} x={xAt(i)} y={y0 - h / 2 + 3} textAnchor="middle" fontSize={8} fill="#fff">{fmtTick(v)}</text>);
        cum[i] += Math.max(0, v);
      });
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

  const legendEl = legendPos !== "none" && series.length > 0 && (
    <g>
      {series.map((s, i) => (
        <g key={i} transform={rightLegend
          ? `translate(${W - PR + 8},${PT + i * 16})`
          : `translate(${PL + (i % 4) * 105},${H + 10 + Math.floor(i / 4) * 14})`}>
          <rect width={10} height={10} rx={3} fill={COLORS[i % COLORS.length]} />
          <text x={14} y={9} fontSize={9} fill="#6E6862">{s.name}</text>
        </g>
      ))}
    </g>
  );

  return (
    <div className="chart-card" style={{ left: spec.x, top: spec.y }}>
      <div className="chart-head" onMouseDown={drag}>
        <b>{spec.title || spec.range}</b>
        <span>
          {onEdit && <button title="Chart settings" onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onEdit(spec)}>⚙</button>}
          {onRemove && <button onClick={() => onRemove(spec.id)}>✕</button>}
        </span>
      </div>
      <svg width={W} height={H + (rightLegend ? 0 : 34)} viewBox={`0 0 ${W} ${H + (rightLegend ? 0 : 34)}`}>
        {/* axes + y gridlines */}
        {!isPie && <>
          <line x1={PL} y1={PT} x2={PL} y2={PT + plotH} stroke="#D8D2CC" />
          <line x1={PL} y1={PT + plotH} x2={PL + plotW} y2={PT + plotH} stroke="#D8D2CC" />
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={PL} y1={PT + plotH - t * plotH} x2={PL + plotW} y2={PT + plotH - t * plotH} stroke="#F0ECE8" />
              <text x={PL - 6} y={PT + plotH - t * plotH + 4} textAnchor="end" fontSize={9} fill="#A19A95">
                {fmtTick(max * t)}
              </text>
            </g>
          ))}
        </>}
        {isPie ? (
          <Pie series={series} doughnut={spec.type === "doughnut"} dataLabels={spec.dataLabels}
            cx={(PL + plotW) / 2 + PL / 2 - PL} cy={PT + plotH / 2} r={Math.min(plotH, plotW) / 2 - 8} />
        ) : els}
        {/* x labels */}
        {!isPie && labels.map((l, i) => (
          <text key={i} x={isScatter ? xAt(i) : PL + i * groupW + groupW / 2} y={PT + plotH + 14}
            textAnchor={isScatter ? "middle" : "middle"} fontSize={9} fill="#A19A95">
            {isScatter ? fmtTick(xs[i]) : String(l).slice(0, 8)}
          </text>
        ))}
        {/* axis titles */}
        {spec.xTitle && (
          <text x={PL + plotW / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="#6E6862">{spec.xTitle}</text>
        )}
        {spec.yTitle && (
          <text x={12} y={PT + plotH / 2} textAnchor="middle" fontSize={10} fill="#6E6862"
            transform={`rotate(-90 12 ${PT + plotH / 2})`}>{spec.yTitle}</text>
        )}
        {legendEl}
      </svg>
    </div>
  );
}

function Pie({ series, cx, cy, r, doughnut, dataLabels }: {
  series: Series[]; cx: number; cy: number; r: number; doughnut?: boolean; dataLabels?: boolean;
}) {
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
        const mid = (a0 + a1) / 2;
        const lx = cx + r * 0.72 * Math.cos(mid), ly = cy + r * 0.72 * Math.sin(mid);
        return (
          <g key={i}>
            <path d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`}
              fill={COLORS[i % COLORS.length]} stroke="#fff" strokeWidth={1.5}>
              <title>{series[0]?.labels[i]}: {series[0]?.values[i]}</title>
            </path>
            {dataLabels && (
              <text x={lx} y={ly} textAnchor="middle" fontSize={9} fill="#fff" fontWeight={600}>
                {Math.round((v / total) * 100)}%
              </text>
            )}
          </g>
        );
      })}
      {doughnut && <circle cx={cx} cy={cy} r={r * 0.55} fill="#fff" />}
      {doughnut && <text x={cx} y={cy + 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="#26221F">{fmtTick(total)}</text>}
    </g>
  );
}

// ---------- sparklines (S7.3) ----------

/** Tiny inline chart for a single cell. `w`/`h` default to cell size. */
export function SparklineView({ spec, sheet, wb, w = 96, h = 22 }: {
  spec: { range: string; type: "line" | "bar" | "winloss"; color?: string };
  sheet: SheetData; wb?: Workbook; w?: number; h?: number;
}) {
  const vals = useMemo(() => {
    const target = resolveRange(wb, sheet, spec.range);
    const r = parseRange(target.rangeA1);
    if (!r) return [];
    const evals = wb ? evaluateSheetIn(wb, target.sheet.name) : evaluateSheet(target.sheet.cells);
    const out: number[] = [];
    for (const ref of rangeCells(r)) {
      const cell = target.sheet.cells[ref];
      const v = Number(cell?.f ? evals.get(ref)?.value : cell?.v);
      out.push(isNaN(v) ? 0 : v);
    }
    return out;
  }, [spec.range, sheet, wb]);

  if (!vals.length) return null;
  const color = spec.color ?? "#3574E0";
  const max = Math.max(...vals), min = Math.min(...vals, 0);
  const span = max - min || 1;
  const px = 2, py = 2;
  const iw = w - px * 2, ih = h - py * 2;
  const yOf = (v: number) => py + ih - ((v - min) / span) * ih;

  if (spec.type === "bar") {
    const bw = iw / vals.length;
    return (
      <svg className="spark" width={w} height={h}>
        {vals.map((v, i) => {
          const y = yOf(Math.max(v, 0)), y0 = yOf(0);
          return <rect key={i} x={px + i * bw} y={Math.min(y, y0)} width={Math.max(1, bw - 1)}
            height={Math.max(1, Math.abs(y0 - y))} fill={v < 0 ? "#D84B57" : color} />;
        })}
      </svg>
    );
  }
  if (spec.type === "winloss") {
    const bw = iw / vals.length;
    const mid = py + ih / 2;
    return (
      <svg className="spark" width={w} height={h}>
        {vals.map((v, i) => (
          <rect key={i} x={px + i * bw} y={v >= 0 ? py : mid} width={Math.max(1, bw - 1)} height={ih / 2}
            fill={v >= 0 ? "#1E8E3E" : "#D84B57"} />
        ))}
      </svg>
    );
  }
  const pts = vals.map((v, i) => `${px + (i / Math.max(1, vals.length - 1)) * iw},${yOf(v)}`).join(" ");
  return (
    <svg className="spark" width={w} height={h}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} />
    </svg>
  );
}

/** Iterate cell refs over a range (row-major). */
function* rangeCells(r: { c1: number; r1: number; c2: number; r2: number }): Generator<string> {
  for (let row = r.r1; row <= r.r2; row++) for (let c = r.c1; c <= r.c2; c++) yield toA1(c, row);
}
