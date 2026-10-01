import { useMemo, type JSX } from "react";
import type { ChartSpec, SheetData, Workbook } from "./model";
import { parseRange, parseA1, toA1 } from "./model";
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

/** S13.4 — range covering a pivot's materialized output, excluding the
 *  grand-total row and column. Null when the pivot hasn't been built. */
export function pivotChartRange(sheet: SheetData, i: number): string | null {
  const p = sheet.pivots?.[i];
  const at = p && parseA1(p.at);
  if (!p?.span || !at) return null;
  return `${toA1(at.col, at.row)}:${toA1(at.col + p.span.c - 2, at.row + p.span.r - 2)}`;
}

export function ChartCard({ spec, sheet, wb, onMove, onRemove, onEdit }: {
  spec: ChartSpec;
  sheet: SheetData;
  wb?: Workbook;
  onMove?: (id: string, x: number, y: number) => void;
  onRemove?: (id: string) => void;
  onEdit?: (spec: ChartSpec) => void;
}) {
  // pivot-linked charts re-derive their range from the live span each render
  const effectiveRange = spec.pivot != null ? pivotChartRange(sheet, spec.pivot) ?? spec.range : spec.range;
  const series = useMemo(() => extractSeries(sheet, effectiveRange, wb), [sheet, effectiveRange, wb]);
  const W = 440, H = 250;
  const rightLegend = spec.legend === "right";
  const legendPos = spec.legend ?? "bottom";
  const PL = spec.yTitle ? 56 : 44, PB = spec.xTitle ? 42 : 30, PT = 30;
  const PR = rightLegend ? 92 : 12;

  const isPie = spec.type === "pie" || spec.type === "doughnut";
  const isScatter = spec.type === "scatter";
  // types without cartesian axes / generic x labels
  const noAxes = isPie || spec.type === "treemap" || spec.type === "funnel" || spec.type === "radar";
  const noXLabels = noAxes || spec.type === "histogram" || spec.type === "boxwhisker";

  // stacked: cumulative sums per index; max is the tallest stack
  const stacks: number[] = [];
  if (spec.type === "stacked") {
    const n = series[0]?.values.length ?? 0;
    for (let i = 0; i < n; i++) stacks.push(series.reduce((a, s) => a + Math.max(0, s.values[i]), 0));
  }
  const all = series.flatMap((s) => s.values);
  // S14.2 axis bounds — primary axis range (secondary-axis series excluded)
  const prim = spec.axis2 != null ? series.filter((_, i) => i !== spec.axis2).flatMap((s) => s.values) : all;
  const vmax = spec.yMax ?? Math.max(1, ...(prim.length ? prim : all).map(Math.abs));
  const vmin = spec.yMin ?? Math.min(0, ...(prim.length ? prim : all));
  // secondary axis range (S14.2)
  const secSeries = spec.axis2 != null ? series[spec.axis2] : undefined;
  const secMax = secSeries ? Math.max(1, ...secSeries.values.map(Math.abs)) : 0;

  const labels = series[0]?.labels ?? [];
  const xs = labels.map((l) => Number(l)); // scatter X coords come from the label column
  const xMin = Math.min(...xs), xMax = Math.max(...xs, xMin + 1);

  const plotW = W - PL - PR, plotH = H - PT - PB;
  const groupW = labels.length ? plotW / labels.length : plotW;
  const xAt = (i: number) => isScatter
    ? PL + ((xs[i] - xMin) / (xMax - xMin || 1)) * plotW
    : PL + i * groupW + groupW / 2;
  const yOf = (v: number) => PT + plotH - ((v - vmin) / (vmax - vmin || 1)) * plotH;
  const yOf2 = (v: number) => PT + plotH - (v / secMax) * plotH;
  const y0 = Math.min(PT + plotH, Math.max(PT, yOf(0)));

  const els: JSX.Element[] = [];
  const cum: number[] = new Array(labels.length).fill(0);
  const errAmt = (s: Series) =>
    spec.errorBars === "stddev"
      ? Math.sqrt(s.values.reduce((a, v) => a + v * v, 0) / Math.max(1, s.values.length)
        - Math.pow(s.values.reduce((a, v) => a + v, 0) / Math.max(1, s.values.length), 2))
      : typeof spec.errorBars === "number" ? spec.errorBars : 0;
  const errBar = (x: number, yv: number, e: number, key: string) => e ? (
    <g key={key} stroke="#6E6862" strokeWidth={1}>
      <line x1={x} y1={yOf(yv - e)} x2={x} y2={yOf(yv + e)} />
      <line x1={x - 3} y1={yOf(yv - e)} x2={x + 3} y2={yOf(yv - e)} />
      <line x1={x - 3} y1={yOf(yv + e)} x2={x + 3} y2={yOf(yv + e)} />
    </g>
  ) : null;

  if (spec.type === "waterfall") {
    // S14.1 — cumulative floating bars from the first series
    const vals = series[0]?.values ?? [];
    let run = 0;
    const wmax = Math.max(1, ...vals.map((_, i) => vals.slice(0, i + 1).reduce((a, b) => a + b, 0)));
    vals.forEach((v, i) => {
      const y1 = PT + plotH - (run / wmax) * plotH;
      run += v;
      const y2 = PT + plotH - (run / wmax) * plotH;
      els.push(<rect key={`w${i}`} x={xAt(i) - groupW * 0.3} y={Math.min(y1, y2)}
        width={groupW * 0.6} height={Math.abs(y2 - y1) || 1}
        fill={v >= 0 ? "#1F9D66" : "#D84B57"} rx={2} />);
      if (spec.dataLabels) els.push(
        <text key={`wd${i}`} x={xAt(i)} y={Math.min(y1, y2) - 4} textAnchor="middle" fontSize={8} fill="#6E6862">{fmtTick(v)}</text>);
    });
  } else if (spec.type === "funnel") {
    // S14.1 — centered bars sorted descending
    const s0 = series[0];
    const items = (s0?.values ?? []).map((v, i) => ({ v, l: labels[i] })).sort((a, b) => b.v - a.v);
    const fmax = Math.max(1, ...items.map((i2) => i2.v));
    const bh = plotH / Math.max(1, items.length);
    items.forEach((it, i) => {
      const bw2 = (it.v / fmax) * plotW;
      els.push(<g key={`f${i}`}>
        <rect x={PL + (plotW - bw2) / 2} y={PT + i * bh + 2} width={bw2} height={Math.max(1, bh - 4)}
          fill={COLORS[i % COLORS.length]} rx={3} />
        <text x={PL + plotW / 2} y={PT + i * bh + bh / 2 + 3} textAnchor="middle" fontSize={9} fill="#fff">{it.l}: {fmtTick(it.v)}</text>
      </g>);
    });
  } else if (spec.type === "histogram") {
    // S14.1 — bin the flattened values, bar the counts
    const flat = series.flatMap((s) => s.values);
    const lo = Math.min(...flat), hi = Math.max(...flat, lo + 1);
    const bins = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(flat.length))));
    const counts = new Array(bins).fill(0);
    flat.forEach((v) => counts[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++);
    const cmax = Math.max(1, ...counts);
    const bw3 = plotW / bins;
    counts.forEach((c, i) => {
      const h = (c / cmax) * plotH;
      els.push(<rect key={`h${i}`} x={PL + i * bw3 + 1} y={PT + plotH - h} width={bw3 - 2} height={h}
        fill="#3578E5" rx={2} />);
      els.push(<text key={`hl${i}`} x={PL + i * bw3 + bw3 / 2} y={PT + plotH + 12} textAnchor="middle" fontSize={8} fill="#A19A95">
        {fmtTick(lo + (i * (hi - lo)) / bins)}</text>);
    });
  } else if (spec.type === "radar") {
    // S14.1 — polygon per series across label axes
    const n = labels.length;
    const rcx = PL + plotW / 2, rcy = PT + plotH / 2, rr = Math.min(plotW, plotH) / 2 - 6;
    const rmax = Math.max(1, ...series.flatMap((s) => s.values.map(Math.abs)));
    const ptAt = (v: number, i: number) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      return [rcx + (v / rmax) * rr * Math.cos(a), rcy + (v / rmax) * rr * Math.sin(a)];
    };
    // rings + spokes
    [0.33, 0.66, 1].forEach((t) => els.push(
      <polygon key={`rg${t}`} points={labels.map((_, i) => ptAt(rmax * t, i).join(",")).join(" ")}
        fill="none" stroke="#EDE9E5" />));
    labels.forEach((l, i) => {
      const [sx, sy] = ptAt(rmax, i);
      els.push(<line key={`rs${i}`} x1={rcx} y1={rcy} x2={sx} y2={sy} stroke="#EDE9E5" />);
      const [lx, ly] = ptAt(rmax * 1.12, i);
      els.push(<text key={`rl${i}`} x={lx} y={ly} textAnchor="middle" fontSize={9} fill="#A19A95">{String(l).slice(0, 8)}</text>);
    });
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => ptAt(v, i).join(",")).join(" ");
      els.push(<polygon key={`rp${si}`} points={pts} fill={COLORS[si % COLORS.length]}
        fillOpacity={0.18} stroke={COLORS[si % COLORS.length]} strokeWidth={2} />);
    });
  } else if (spec.type === "stock") {
    // S14.1 — OHLC candles: series[0..3] = open, high, low, close per label
    const [o, h, l, c] = [0, 1, 2, 3].map((i) => series[i]?.values ?? []);
    const smax = Math.max(1, ...h);
    const smin = Math.min(0, ...l);
    const syOf = (v: number) => PT + plotH - ((v - smin) / (smax - smin || 1)) * plotH;
    labels.forEach((_, i) => {
      if (o[i] == null || c[i] == null) return;
      const up = c[i] >= o[i];
      const col = up ? "#1F9D66" : "#D84B57";
      els.push(<g key={`st${i}`}>
        <line x1={xAt(i)} y1={syOf(h[i] ?? Math.max(o[i], c[i]))} x2={xAt(i)} y2={syOf(l[i] ?? Math.min(o[i], c[i]))} stroke={col} strokeWidth={1.2} />
        <rect x={xAt(i) - groupW * 0.22} y={Math.min(syOf(o[i]), syOf(c[i]))} width={groupW * 0.44}
          height={Math.max(1, Math.abs(syOf(o[i]) - syOf(c[i])))} fill={up ? "#fff" : col} stroke={col} />
      </g>);
    });
  } else if (spec.type === "boxwhisker") {
    // S14.1 — five-number summary per series, boxes laid across the plot
    const n = series.length;
    const bw4 = plotW / Math.max(1, n);
    const qs = series.map((s) => {
      const v = [...s.values].sort((a, b) => a - b);
      const q = (p: number) => v.length ? v[Math.floor(p * (v.length - 1))] : 0;
      return { lo: v[0] ?? 0, q1: q(0.25), med: q(0.5), q3: q(0.75), hi: v[v.length - 1] ?? 0 };
    });
    const bmax = Math.max(1, ...qs.map((q2) => q2.hi));
    const bmin = Math.min(0, ...qs.map((q2) => q2.lo));
    const byOf = (v: number) => PT + plotH - ((v - bmin) / (bmax - bmin || 1)) * plotH;
    qs.forEach((q2, i) => {
      const cx = PL + i * bw4 + bw4 / 2;
      els.push(<g key={`b${i}`}>
        <line x1={cx} y1={byOf(q2.hi)} x2={cx} y2={byOf(q2.lo)} stroke="#6E6862" />
        <rect x={cx - bw4 * 0.28} y={byOf(q2.q3)} width={bw4 * 0.56} height={Math.max(1, byOf(q2.q1) - byOf(q2.q3))}
          fill={COLORS[i % COLORS.length]} fillOpacity={0.3} stroke={COLORS[i % COLORS.length]} />
        <line x1={cx - bw4 * 0.28} y1={byOf(q2.med)} x2={cx + bw4 * 0.28} y2={byOf(q2.med)} stroke={COLORS[i % COLORS.length]} strokeWidth={2} />
        <line x1={cx - 4} y1={byOf(q2.hi)} x2={cx + 4} y2={byOf(q2.hi)} stroke="#6E6862" />
        <line x1={cx - 4} y1={byOf(q2.lo)} x2={cx + 4} y2={byOf(q2.lo)} stroke="#6E6862" />
        <text x={cx} y={PT + plotH + 12} textAnchor="middle" fontSize={8} fill="#A19A95">{series[i].name.slice(0, 8)}</text>
      </g>);
    });
  } else if (spec.type === "treemap") {
    // S14.1 — slice-and-dice rectangles sized by value share
    const s0 = series[0];
    const items = (s0?.values ?? []).map((v, i) => ({ v: Math.max(0, v), l: labels[i] })).filter((it) => it.v > 0)
      .sort((a, b) => b.v - a.v);
    let tx = PL, ty = PT, tw = plotW, th = plotH;
    let horiz = true;
    items.forEach((it, i) => {
      const frac = it.v / items.slice(i).reduce((a, x) => a + x.v, 0);
      if (horiz) {
        const hh = th * frac;
        els.push(<g key={`t${i}`}>
          <rect x={tx} y={ty} width={tw} height={Math.max(1, hh - 1)} fill={COLORS[i % COLORS.length]} fillOpacity={0.7} stroke="#fff" />
          {hh > 14 && <text x={tx + 4} y={ty + 12} fontSize={9} fill="#fff">{it.l} {fmtTick(it.v)}</text>}
        </g>);
        ty += hh; th -= hh; horiz = false;
      } else {
        const ww = tw * frac;
        els.push(<g key={`t${i}`}>
          <rect x={tx} y={ty} width={Math.max(1, ww - 1)} height={th} fill={COLORS[i % COLORS.length]} fillOpacity={0.7} stroke="#fff" />
          {ww > 40 && <text x={tx + 4} y={ty + 12} fontSize={9} fill="#fff">{it.l} {fmtTick(it.v)}</text>}
        </g>);
        tx += ww; tw -= ww; horiz = true;
      }
    });
  } else {
    series.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      const yS = si === spec.axis2 ? yOf2 : yOf; // secondary-axis series (S14.2)
      const isLine = spec.type === "line" || spec.type === "area" || spec.type === "scatter"
        || (spec.type === "combo" && si === series.length - 1);
      const e = errAmt(s);
      if (isLine) {
        const pts = s.values.map((v, i) => [xAt(i), yS(v)]);
        if (spec.type !== "scatter") {
          const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
          if (spec.type === "area") {
            els.push(<path key={`a${si}`} d={`${path} L${pts[pts.length - 1][0]},${y0} L${pts[0][0]},${y0} Z`}
              fill={color} opacity={0.22} />);
          }
          els.push(<path key={`l${si}`} d={path} fill="none" stroke={color} strokeWidth={2.4} />);
        }
        pts.forEach((p, i) => {
          els.push(<circle key={`p${si}-${i}`} cx={p[0]} cy={p[1]} r={spec.type === "scatter" ? 4 : 3}
            fill={color} fillOpacity={spec.type === "scatter" ? 0.85 : 1} />);
          if (e) els.push(errBar(p[0], s.values[i], e, `e${si}-${i}`)!);
          if (spec.dataLabels) els.push(
            <text key={`d${si}-${i}`} x={p[0]} y={p[1] - 6} textAnchor="middle" fontSize={8} fill="#6E6862">{fmtTick(s.values[i])}</text>);
        });
      } else if (spec.type === "bar" || spec.type === "combo") {
        const bw = (groupW * 0.7) / (spec.type === "combo" ? Math.max(1, series.length - 1) : series.length);
        s.values.forEach((v, i) => {
          const yv = yS(v);
          const bx = PL + i * groupW + si * bw + groupW * 0.15;
          els.push(<rect key={`${si}-${i}`} x={bx} y={Math.min(yv, si === spec.axis2 ? PT + plotH : y0)}
            width={bw * 0.92} height={Math.abs((si === spec.axis2 ? PT + plotH : y0) - yv) || 1} rx={3} fill={color} />);
          if (e) els.push(errBar(bx + bw / 2, v, e, `e${si}-${i}`)!);
          if (spec.dataLabels) els.push(
            <text key={`d${si}-${i}`} x={bx + bw / 2} y={Math.min(yv, y0) - 4} textAnchor="middle" fontSize={8} fill="#6E6862">{fmtTick(v)}</text>);
        });
      } else if (spec.type === "stacked") {
        const bw = groupW * 0.6;
        s.values.forEach((v, i) => {
          const yv = yOf(v + cum[i]);
          els.push(<rect key={`${si}-${i}`} x={xAt(i) - bw / 2} y={yv} width={bw}
            height={Math.abs(yOf(cum[i]) - yv) || 1} fill={color} stroke="#fff" strokeWidth={1} />);
          if (spec.dataLabels) els.push(
            <text key={`d${si}-${i}`} x={xAt(i)} y={(yv + yOf(cum[i])) / 2 + 3} textAnchor="middle" fontSize={8} fill="#fff">{fmtTick(v)}</text>);
          cum[i] += Math.max(0, v);
        });
      }
      // S14.2 trendline — least-squares fit over the series' points
      if (spec.trendline && s.values.length > 1) {
        const n2 = s.values.length;
        const xs2 = s.values.map((_, i) => i);
        const ys2 = spec.trendline === "exponential" ? s.values.map((v) => Math.log(Math.max(1e-9, v))) : s.values;
        const mx = xs2.reduce((a, b) => a + b, 0) / n2, my = ys2.reduce((a, b) => a + b, 0) / n2;
        const num = xs2.reduce((a, x, i) => a + (x - mx) * (ys2[i] - my), 0);
        const den = xs2.reduce((a, x) => a + (x - mx) ** 2, 0) || 1;
        const slope = num / den, icpt = my - slope * mx;
        const fit = (i: number) => spec.trendline === "exponential" ? Math.exp(icpt + slope * i) : icpt + slope * i;
        const tl = s.values.map((_, i) => `${i ? "L" : "M"}${xAt(i)},${yS(fit(i))}`).join(" ");
        els.push(<path key={`tl${si}`} d={tl} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray="6 3" opacity={0.8} />);
      }
    });
  }

  const drag = (e: React.PointerEvent) => {
    if (!onMove) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = spec.x, oy = spec.y;
    const move = (ev: globalThis.PointerEvent) => onMove(spec.id, ox + ev.clientX - sx, oy + ev.clientY - sy);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
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
      <div className="chart-head" onPointerDown={drag} style={{ touchAction: "none" }}>
        <b>{spec.title || spec.range}</b>
        <span>
          {onEdit && <button title="Chart settings" onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onEdit(spec)}>⚙</button>}
          {onRemove && <button onClick={() => onRemove(spec.id)}>✕</button>}
        </span>
      </div>
      <svg width={W} height={H + (rightLegend ? 0 : 34)} viewBox={`0 0 ${W} ${H + (rightLegend ? 0 : 34)}`}>
        {/* axes + y gridlines */}
        {!noAxes && <>
          <line x1={PL} y1={PT} x2={PL} y2={PT + plotH} stroke="#D8D2CC" />
          <line x1={PL} y1={PT + plotH} x2={PL + plotW} y2={PT + plotH} stroke="#D8D2CC" />
          {[0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={PL} y1={PT + plotH - t * plotH} x2={PL + plotW} y2={PT + plotH - t * plotH} stroke="#F0ECE8" />
              <text x={PL - 6} y={PT + plotH - t * plotH + 4} textAnchor="end" fontSize={9} fill="#A19A95">
                {fmtTick(vmin + (vmax - vmin) * t)}
              </text>
            </g>
          ))}
          {/* secondary axis (S14.2) — right side, its own scale */}
          {spec.axis2 != null && series[spec.axis2] && <>
            <line x1={PL + plotW} y1={PT} x2={PL + plotW} y2={PT + plotH} stroke="#D8D2CC" />
            {[0.25, 0.5, 0.75, 1].map((t) => (
              <text key={`s${t}`} x={PL + plotW + 6} y={PT + plotH - t * plotH + 4} fontSize={9} fill="#A19A95">
                {fmtTick(secMax * t)}
              </text>
            ))}
          </>}
        </>}
        {isPie ? (
          <Pie series={series} doughnut={spec.type === "doughnut"} dataLabels={spec.dataLabels}
            cx={(PL + plotW) / 2 + PL / 2 - PL} cy={PT + plotH / 2} r={Math.min(plotH, plotW) / 2 - 8} />
        ) : els}
        {/* x labels */}
        {!noXLabels && labels.map((l, i) => (
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
