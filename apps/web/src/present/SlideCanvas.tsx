import { Fragment, useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import type { Slide, SlideObject, Theme } from "./model";
import { SLIDE_W, SLIDE_H } from "./model";

const GRID = 8;
const HANDLE = 8;

export interface ObjPatch { id: string; patch: Partial<SlideObject> }

export function SlideCanvas({ slide, theme, scale, interactive, selection, onSelect, onPatch, onTextCommit, canEdit }: {
  slide: Slide;
  theme: Theme;
  scale: number;
  interactive?: boolean;
  selection: Set<string>;
  onSelect?: (ids: Set<string>, additive: boolean) => void;
  onPatch?: (patches: ObjPatch[], commit: boolean) => void;
  onTextCommit?: (id: string, html: string) => void;
  canEdit?: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ v?: number; h?: number }>({});
  const dragRef = useRef<{
    mode: "move" | "resize";
    handle?: string;
    startX: number; startY: number;
    orig: Map<string, { x: number; y: number; w: number; h: number }>;
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
    const orig = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const so of objs) if (ids.has(so.id)) orig.set(so.id, { x: so.x, y: so.y, w: so.w, h: so.h });
    dragRef.current = { mode: "move", startX: e.clientX, startY: e.clientY, orig };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startResize = (e: RPointerEvent, o: SlideObject, handle: string) => {
    if (!interactive || !canEdit) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h }]]);
    dragRef.current = { mode: "resize", handle, startX: e.clientX, startY: e.clientY, orig };
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
    <div className="slide-box" style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: slide.bg ?? theme.bg }}
      onPointerDown={interactive ? (e) => { if (e.target === e.currentTarget) onSelect?.(new Set(), false); } : undefined}
      onPointerMove={interactive ? onMove : undefined}
      onPointerUp={interactive ? onUp : undefined}>
      {objs.map((o) => (
        <ObjView key={o.id} o={o} theme={theme}
          selected={interactive && selection.has(o.id)}
          editing={editingId === o.id}
          onMouseDown={(e) => selectObj(o, e)}
          onPointerDown={(e) => startDrag(e, o)}
          onDblClick={() => o.type === "text" && canEdit && setEditingId(o.id)}
          onTextBlur={(html) => { onTextCommit?.(o.id, html); setEditingId(null); }} />
      ))}
      {interactive && canEdit && [...selection].map((id) => {
        const o = slide.objects.find((x) => x.id === id);
        if (!o || editingId === o.id) return null;
        return (
          <Fragment key={`h${id}`}>
            <div className="sel-outline" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
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

export function ObjView({ o, theme, selected, editing, onMouseDown, onPointerDown, onDblClick, onTextBlur }: {
  o: SlideObject; theme: Theme;
  selected?: boolean; editing?: boolean;
  onMouseDown?: (e: RMouseEvent) => void;
  onPointerDown?: (e: RPointerEvent) => void;
  onDblClick?: () => void;
  onTextBlur?: (html: string) => void;
}) {
  const base: React.CSSProperties = {
    left: o.x, top: o.y, width: o.w, height: o.h,
    transform: o.rotate ? `rotate(${o.rotate}deg)` : undefined,
  };
  const common = {
    className: `s-obj ${selected ? "selected" : ""}`,
    style: base,
    onMouseDown, onPointerDown, onDoubleClick: onDblClick,
  };
  void theme;
  void selected;

  switch (o.type) {
    case "text":
      return (
        <div {...common}>
          {editing ? (
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
          )}
        </div>
      );
    case "shape":
      return <div {...common}><ShapeSvg o={o} /></div>;
    case "image":
      return (
        <div {...common}>
          <img src={o.src} alt={o.alt ?? ""} draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      );
    case "table": {
      const rows = o.table ?? [["", ""]];
      return (
        <div {...common} style={{ ...base, overflow: "hidden" }}>
          <table className="s-table">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} style={{ fontSize: o.fontSize ?? 14, color: o.color }}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "chart":
      return <div {...common}><ChartSvg o={o} /></div>;
    case "line": {
      const x2 = o.x2 ?? o.w, y2 = o.y2 ?? 0;
      return (
        <div {...common} style={{ ...base, height: Math.max(o.h, Math.abs(y2 - 0)) }}>
          <svg width={o.w} height={Math.max(o.h, Math.abs(y2))}>
            <line x1={0} y1={0} x2={x2} y2={y2} stroke={o.stroke ?? "#171717"} strokeWidth={o.strokeW ?? 2} markerEnd={o.shape === "arrow" ? "url(#arr)" : undefined} />
          </svg>
        </div>
      );
    }
    default:
      return <div {...common} />;
  }
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
  const w = o.w, h = o.h;
  const max = Math.max(1, ...c.values.map(Math.abs));
  const PL = 30, PB = 20, PT = c.title ? 26 : 10;
  const pw = w - PL - 8, ph = h - PT - PB;
  if (c.type === "pie") {
    const total = c.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let angle = -Math.PI / 2;
    const cx = w / 2, cy = PT + ph / 2, r = Math.min(pw, ph) / 2 - 4;
    return (
      <svg width={w} height={h}>
        {c.title && <text x={w / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill="#5B554F">{c.title}</text>}
        {c.values.map((v, i) => {
          const a0 = angle; angle += (Math.max(0, v) / total) * Math.PI * 2;
          const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
          const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
          return <path key={i} d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${angle - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1} Z`} fill={CHART_COLORS[i % CHART_COLORS.length]}><title>{c.labels[i]}: {v}</title></path>;
        })}
      </svg>
    );
  }
  const bw = pw / c.values.length;
  return (
    <svg width={w} height={h}>
      {c.title && <text x={w / 2} y={16} textAnchor="middle" fontSize={13} fontWeight={700} fill="#5B554F">{c.title}</text>}
      <line x1={PL} y1={PT} x2={PL} y2={PT + ph} stroke="#D8D2CC" />
      <line x1={PL} y1={PT + ph} x2={w - 4} y2={PT + ph} stroke="#D8D2CC" />
      {c.values.map((v, i) => {
        if (c.type === "bar") {
          const bh = (v / max) * ph;
          return <rect key={i} x={PL + i * bw + bw * 0.15} y={PT + ph - bh} width={bw * 0.7} height={bh} rx={3} fill={CHART_COLORS[0]} />;
        }
        return null;
      })}
      {c.type === "line" && (
        <>
          <path d={c.values.map((v, i) => `${i ? "L" : "M"}${PL + i * bw + bw / 2},${PT + ph - (v / max) * ph}`).join(" ")}
            fill="none" stroke={CHART_COLORS[0]} strokeWidth={2.4} />
          {c.values.map((v, i) => <circle key={i} cx={PL + i * bw + bw / 2} cy={PT + ph - (v / max) * ph} r={3} fill={CHART_COLORS[0]} />)}
        </>
      )}
      {c.labels.map((l, i) => (
        <text key={i} x={PL + i * bw + bw / 2} y={PT + ph + 13} textAnchor="middle" fontSize={8.5} fill="#A19A95">{String(l).slice(0, 7)}</text>
      ))}
    </svg>
  );
}
