import { Fragment, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import type { Slide, SlideObject, Theme } from "./model";
import { SLIDE_W, SLIDE_H, chartSeries } from "./model";

const GRID = 8;
const HANDLE = 8;

export interface ObjPatch { id: string; patch: Partial<SlideObject> }

export function SlideCanvas({ slide, theme, scale, interactive, selection, onSelect, onPatch, onTextCommit, onTableCommit, onObjDblClick, canEdit, animStep }: {
  slide: Slide;
  theme: Theme;
  scale: number;
  interactive?: boolean;
  selection: Set<string>;
  onSelect?: (ids: Set<string>, additive: boolean) => void;
  onPatch?: (patches: ObjPatch[], commit: boolean) => void;
  onTextCommit?: (id: string, html: string) => void;
  onTableCommit?: (id: string, rows: string[][]) => void;
  onObjDblClick?: (o: SlideObject) => void;
  canEdit?: boolean;
  animStep?: number;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ v?: number; h?: number }>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize" | "rotate";
    handle?: string;
    startX: number; startY: number;
    orig: Map<string, { x: number; y: number; w: number; h: number; rotate?: number }>;
  } | null>(null);

  const objs = [...slide.objects].sort((a, b) => a.z - b.z);

  const groupOf = (o: SlideObject) =>
    o.groupId ? objs.filter((x) => x.groupId === o.groupId) : [o];

  const selectObj = (o: SlideObject, e: RMouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    const grp = groupOf(o);
    const ids = new Set(grp.map((g) => g.id));
    if (e.shiftKey && onSelect) {
      const next = new Set(selection);
      if (ids.has(o.id) && [...ids].every((i) => next.has(i))) ids.forEach((i) => next.delete(i));
      else ids.forEach((i) => next.add(i));
      onSelect(next, true);
    } else {
      onSelect?.(ids, false);
    }
  };

  const startDrag = (e: RPointerEvent, o: SlideObject) => {
    if (!interactive || !canEdit || editingId === o.id) return;
    if (e.shiftKey) return; // shift+click is selection-only
    const ids = selection.has(o.id) ? selection : new Set(groupOf(o).map((g) => g.id));
    onSelect?.(ids, false);
    const orig = new Map<string, { x: number; y: number; w: number; h: number; rotate?: number }>();
    for (const so of objs) if (ids.has(so.id)) orig.set(so.id, { x: so.x, y: so.y, w: so.w, h: so.h, rotate: so.rotate });
    dragRef.current = { mode: "move", startX: e.clientX, startY: e.clientY, orig };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startResize = (e: RPointerEvent, o: SlideObject, handle: string) => {
    if (!interactive || !canEdit) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h, rotate: o.rotate }]]);
    dragRef.current = { mode: "resize", handle, startX: e.clientX, startY: e.clientY, orig };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startRotate = (e: RPointerEvent, o: SlideObject) => {
    if (!interactive || !canEdit) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h, rotate: o.rotate }]]);
    dragRef.current = { mode: "rotate", startX: e.clientX, startY: e.clientY, orig };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const snap = (v: number, targets: number[], guide: "v" | "h") => {
    for (const t of targets) {
      if (Math.abs(v - t) <= 6 / scale + 3) { setGuides((g) => ({ ...g, [guide]: t })); return t; }
    }
    const g = Math.round(v / GRID) * GRID;
    return Math.abs(g - v) <= 4 ? g : v;
  };

  const onMove = (e: RPointerEvent) => {
    const d = dragRef.current;
    if (!d || !onPatch) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    const patches: ObjPatch[] = [];
    if (d.mode === "move") {
      let guideV: number | undefined, guideH: number | undefined;
      for (const [id, o] of d.orig) {
        let nx = o.x + dx, ny = o.y + dy;
        // snap edges + center to slide center / edges
        const cx = SLIDE_W / 2, cy = SLIDE_H / 2;
        const snapX = snap(nx, [0, cx - o.w / 2, SLIDE_W - o.w], "v");
        if (snapX !== nx) { nx = snapX; guideV = nx === 0 ? 0 : nx === SLIDE_W - o.w ? SLIDE_W : cx; }
        else { const mid = snap(nx + o.w / 2, [cx], "v"); if (mid !== nx + o.w / 2) { nx = mid - o.w / 2; guideV = cx; } }
        const snapY = snap(ny, [0, cy - o.h / 2, SLIDE_H - o.h], "h");
        if (snapY !== ny) { ny = snapY; guideH = ny === 0 ? 0 : ny === SLIDE_H - o.h ? SLIDE_H : cy; }
        else { const mid = snap(ny + o.h / 2, [cy], "h"); if (mid !== ny + o.h / 2) { ny = mid - o.h / 2; guideH = cy; } }
        patches.push({ id, patch: { x: Math.round(nx), y: Math.round(ny) } });
      }
      setGuides({ v: guideV, h: guideH });
    } else if (d.mode === "rotate") {
      const [id, o] = [...d.orig][0];
      const box = boxRef.current?.getBoundingClientRect();
      if (box) {
        const cx = box.left + (o.x + o.w / 2) * scale;
        const cy = box.top + (o.y + o.h / 2) * scale;
        const a0 = Math.atan2(d.startY - cy, d.startX - cx);
        const a1 = Math.atan2(e.clientY - cy, e.clientX - cx);
        let deg = ((o.rotate ?? 0) + (a1 - a0) * 180 / Math.PI) % 360;
        if (deg < 0) deg += 360;
        if (!e.shiftKey) deg = Math.round(deg / 15) * 15;
        patches.push({ id, patch: { rotate: Math.round(deg) } });
      }
    } else {
      const [id, o] = [...d.orig][0];
      let { x, y, w, h } = o;
      const hnd = d.handle!;
      if (hnd.includes("e")) w = Math.max(16, o.w + dx);
      if (hnd.includes("s")) h = Math.max(16, o.h + dy);
      if (hnd.includes("w")) { w = Math.max(16, o.w - dx); x = o.x + o.w - w; }
      if (hnd.includes("n")) { h = Math.max(16, o.h - dy); y = o.y + o.h - h; }
      patches.push({ id, patch: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } });
    }
    onPatch(patches, false);
  };

  const onUp = () => {
    if (dragRef.current && onPatch) {
      const d = dragRef.current;
      dragRef.current = null;
      setGuides({});
      onPatch([], true); // commit drag as one undo step
      void d;
    }
  };

  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
  const handlePos = (o: SlideObject, h: string) => ({
    left: h.includes("w") ? -HANDLE / 2 : h.includes("e") ? o.w - HANDLE / 2 : o.w / 2 - HANDLE / 2,
    top: h.includes("n") ? -HANDLE / 2 : h.includes("s") ? o.h - HANDLE / 2 : o.h / 2 - HANDLE / 2,
    cursor: { nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw", n: "ns", s: "ns", e: "ew", w: "ew" }[h] + "-resize",
  });

  return (
    <div ref={boxRef} className="slide-box" style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: slide.bg ?? theme.bg }}
      onPointerDown={interactive ? (e) => { if (e.target === e.currentTarget) onSelect?.(new Set(), false); } : undefined}
      onPointerMove={interactive ? onMove : undefined}
      onPointerUp={interactive ? onUp : undefined}>
      {objs.map((o) => {
        const hidden = animStep !== undefined && o.anim && o.anim.order > animStep;
        const entering = animStep !== undefined && o.anim && o.anim.order === animStep ? o.anim.type : undefined;
        return (
        <ObjView key={o.id} o={o} theme={theme}
          selected={interactive && selection.has(o.id)}
          editing={editingId === o.id}
          hidden={!!hidden}
          enterAnim={entering}
          onMouseDown={(e) => selectObj(o, e)}
          onPointerDown={(e) => startDrag(e, o)}
          onDblClick={() => {
            if (!canEdit) return;
            if (o.type === "text" || o.type === "shape" || o.type === "table") setEditingId(o.id);
            else onObjDblClick?.(o);
          }}
          onTextBlur={(html) => { onTextCommit?.(o.id, html); setEditingId(null); }}
          onTableEdit={onTableCommit ? (rows) => onTableCommit(o.id, rows) : undefined} />
        );
      })}
      {interactive && canEdit && [...selection].map((id) => {
        const o = slide.objects.find((x) => x.id === id);
        if (!o || editingId === o.id) return null;
        return (
          <Fragment key={`h${id}`}>
            <div className="sel-outline" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
            {/* rotate handle */}
            <div className="rot-handle" style={{ left: o.x + o.w / 2 - 5, top: o.y - 24 }}
              title="Drag to rotate (hold Shift for free angle)"
              onPointerDown={(e) => startRotate(e, o)} />
            <div className="rot-stem" style={{ left: o.x + o.w / 2 - 0.5, top: o.y - 14 }} />
            {handles.map((h) => (
              <div key={h} className="rs-handle"
                style={{ left: o.x + handlePos(o, h).left, top: o.y + handlePos(o, h).top, width: HANDLE, height: HANDLE, cursor: handlePos(o, h).cursor }}
                onPointerDown={(e) => startResize(e, o, h)} />
            ))}
          </Fragment>
        );
      })}
      {guides.v !== undefined && <div className="guide-v" style={{ left: guides.v }} />}
      {guides.h !== undefined && <div className="guide-h" style={{ top: guides.h }} />}
    </div>
  );
}

// ---------- object renderer (also used for thumbnails & presenter) ----------

export function ObjView({ o, theme, selected, editing, hidden, enterAnim, onMouseDown, onPointerDown, onDblClick, onTextBlur, onTableEdit }: {
  o: SlideObject; theme: Theme;
  selected?: boolean; editing?: boolean; hidden?: boolean;
  enterAnim?: string;
  onMouseDown?: (e: RMouseEvent) => void;
  onPointerDown?: (e: RPointerEvent) => void;
  onDblClick?: () => void;
  onTextBlur?: (html: string) => void;
  onTableEdit?: (rows: string[][]) => void;
}) {
  const base: CSSProperties = {
    left: o.x, top: o.y, width: o.w, height: o.h,
    transform: o.rotate ? `rotate(${o.rotate}deg)` : undefined,
    opacity: hidden ? 0 : 1,
    pointerEvents: hidden ? "none" : undefined,
  };
  const common = {
    className: `s-obj ${selected ? "selected" : ""}`,
    onMouseDown, onPointerDown, onDoubleClick: onDblClick,
  };
  void theme;
  void selected;

  const textEl = (editingNow: boolean) =>
    editingNow ? (
      <div className="s-text editing" contentEditable suppressContentEditableWarning
        style={{ fontSize: o.fontSize ?? 20, color: o.color, textAlign: o.align, fontFamily: o.fontFamily, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal" }}
        dangerouslySetInnerHTML={{ __html: o.html ?? "" }}
        onBlur={(e) => onTextBlur?.((e.target as HTMLElement).innerHTML)}
        onPointerDown={(e) => e.stopPropagation()}
        ref={(el) => { el?.focus(); }} />
    ) : (
      <div className="s-text"
        style={{ fontSize: o.fontSize ?? 20, color: o.color, textAlign: o.align, fontFamily: o.fontFamily, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal" }}
        dangerouslySetInnerHTML={{ __html: (o.html ?? "").replace(/\n/g, "<br/>") }} />
    );

  let content: React.ReactNode = null;
  const style: CSSProperties = { ...base };
  switch (o.type) {
    case "text":
      content = textEl(!!editing);
      break;
    case "shape":
      content = (
        <>
          <ShapeSvg o={o} />
          {o.html !== undefined || editing ? (
            <div className="s-shape-text">{textEl(!!editing)}</div>
          ) : null}
        </>
      );
      break;
    case "image":
      content = <img src={o.src} alt={o.alt ?? ""} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
      break;
    case "table": {
      const rows = o.table ?? [["", ""]];
      style.overflow = editing ? "auto" : "hidden";
      content = (
        <table className={`s-table ${editing ? "editing" : ""}`}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => editing ? (
                <td key={j} contentEditable suppressContentEditableWarning
                  style={{ fontSize: o.fontSize ?? 14, color: o.color, minWidth: 40 }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const next = rows.map((row, ri) => ri === i ? row.map((cell, cj) => cj === j ? (e.target as HTMLElement).innerText : cell) : row);
                    onTableEdit?.(next);
                  }}>{c}</td>
              ) : (
                <td key={j} style={{ fontSize: o.fontSize ?? 14, color: o.color }}>{c}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      );
      break;
    }
    case "chart":
      content = <ChartSvg o={o} />;
      break;
    case "line": {
      const x2 = o.x2 ?? o.w, y2 = o.y2 ?? 0;
      style.height = Math.max(o.h, Math.abs(y2));
      content = (
        <svg width={o.w} height={Math.max(o.h, Math.abs(y2))}>
          <line x1={0} y1={0} x2={x2} y2={y2} stroke={o.stroke ?? "#171717"} strokeWidth={o.strokeW ?? 2} markerEnd={o.shape === "arrow" ? "url(#arr)" : undefined} />
        </svg>
      );
      break;
    }
    default:
      break;
  }
  // enter-* animates an inner wrapper so it never fights the object's own rotate transform
  return (
    <div {...common} style={style}>
      {enterAnim ? <div className={`s-enter enter-${enterAnim}`}>{content}</div> : content}
    </div>
  );
}

function ShapeSvg({ o }: { o: SlideObject }) {
  const w = o.w, h = o.h;
  const fill = o.fill ?? "#F2782E";
  const stroke = o.stroke === "none" ? "transparent" : (o.stroke ?? "transparent");
  const sw = o.strokeW ?? 0;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {o.shape === "ellipse" && <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {o.shape === "triangle" && <polygon points={`${w / 2},0 ${w},${h} 0,${h}`} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {o.shape === "arrow" && <polygon points={`0,${h * 0.35} ${w * 0.65},${h * 0.35} ${w * 0.65},0 ${w},${h / 2} ${w * 0.65},${h} ${w * 0.65},${h * 0.65} 0,${h * 0.65}`} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {o.shape === "star" && <polygon points={starPts(w, h)} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {(o.shape === "rect" || !o.shape) && <rect width={w} height={h} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {o.shape === "roundrect" && <rect width={w} height={h} rx={Math.min(w, h) * 0.12} fill={fill} stroke={stroke} strokeWidth={sw} />}
    </svg>
  );
}

function starPts(w: number, h: number): string {
  const pts: string[] = [];
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2, r = R * 0.45;
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push(`${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`);
  }
  return pts.join(" ");
}

const CHART_COLORS = ["#F2782E", "#3578E5", "#1F9D66", "#D84B57", "#8E6BC8"];

export function ChartSvg({ o }: { o: SlideObject }) {
  const c = o.chart;
  if (!c) return null;
  const series = chartSeries(c);
  const w = o.w, h = o.h;
  const max = Math.max(1, ...series.flatMap((s) => s.values.map(Math.abs)));
  const showLegend = series.length > 1 && series.some((s) => s.name);
  const PL = 30, PB = 20, PT = c.title ? 26 : 10, LG = showLegend ? 18 : 0;
  const pw = w - PL - 8, ph = h - PT - PB - LG;
  const labels = c.labels;
  const legend = showLegend && (
    <>
      {series.map((s, si) => (
        <g key={si}>
          <rect x={PL + si * 110} y={h - LG + 4} width={9} height={9} rx={2} fill={CHART_COLORS[si % CHART_COLORS.length]} />
          <text x={PL + si * 110 + 13} y={h - LG + 12} fontSize={9} fill="#8B8480">{s.name || `Series ${si + 1}`}</text>
        </g>
      ))}
    </>
  );
  if (c.type === "pie") {
    const vals = series[0]?.values ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let angle = -Math.PI / 2;
    const cx = w / 2, cy = PT + ph / 2, r = Math.min(pw, ph) / 2 - 4;
    return (
      <svg width={w} height={h}>
        {c.title && <text x={w / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill="#5B554F">{c.title}</text>}
        {vals.map((v, i) => {
          const a0 = angle; angle += (Math.max(0, v) / total) * Math.PI * 2;
          const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
          return <path key={i} d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${angle - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1} Z`} fill={CHART_COLORS[i % CHART_COLORS.length]}><title>{labels[i]}: {v}</title></path>;
        })}
        {legend}
      </svg>
    );
  }
  const n = Math.max(1, labels.length);
  const bw = pw / n;
  return (
    <svg width={w} height={h}>
      {c.title && <text x={w / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill="#5B554F">{c.title}</text>}
      <line x1={PL} y1={PT} x2={PL} y2={PT + ph} stroke="#D8D2CC" />
      <line x1={PL} y1={PT + ph} x2={w - 4} y2={PT + ph} stroke="#D8D2CC" />
      {c.type === "bar" && series.map((s, si) => {
        const gw = bw * 0.8 / series.length;
        return s.values.map((v, i) => {
          const bh = (v / max) * ph;
          return <rect key={`${si}-${i}`} x={PL + i * bw + bw * 0.1 + si * gw} y={PT + ph - bh} width={Math.max(1, gw - 1)} height={bh} rx={2} fill={CHART_COLORS[si % CHART_COLORS.length]} />;
        });
      })}
      {c.type === "line" && series.map((s, si) => (
        <Fragment key={si}>
          <path d={s.values.map((v, i) => `${i ? "L" : "M"}${PL + i * bw + bw / 2},${PT + ph - (v / max) * ph}`).join(" ")}
            fill="none" stroke={CHART_COLORS[si % CHART_COLORS.length]} strokeWidth={2.4} />
          {s.values.map((v, i) => <circle key={i} cx={PL + i * bw + bw / 2} cy={PT + ph - (v / max) * ph} r={3} fill={CHART_COLORS[si % CHART_COLORS.length]} />)}
        </Fragment>
      ))}
      {labels.map((l, i) => (
        <text key={i} x={PL + i * bw + bw / 2} y={PT + ph + 13} textAnchor="middle" fontSize={8.5} fill="#A19A95">{String(l).slice(0, 7)}</text>
      ))}
      {legend}
    </svg>
  );
}
