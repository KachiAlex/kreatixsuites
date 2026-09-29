import { Fragment, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import type { Slide, SlideObject, Theme } from "./model";
import { SLIDE_W, SLIDE_H, chartSeries, resolveConn, connBBox, hitAnchor, animSteps, animKind } from "./model";

const GRID = 8;
const HANDLE = 8;

export interface ObjPatch { id: string; patch: Partial<SlideObject> }

export function SlideCanvas({ slide, theme, scale, interactive, selection, onSelect, onPatch, onTextCommit, onTableCommit, onObjDblClick, canEdit, animStep, onEditingChange, cropId, onCropChange, under, size }: {
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
  onEditingChange?: (id: string | null) => void;
  cropId?: string | null;
  onCropChange?: (id: string | null) => void;
  under?: SlideObject[]; // P2.1 — master/layout objects rendered beneath, non-interactive
  size?: { w: number; h: number }; // P2.4 — defaults to 960×540
}) {
  const [editingIdRaw, setEditingIdRaw] = useState<string | null>(null);
  const setEditingId = (id: string | null) => { setEditingIdRaw(id); onEditingChange?.(id); };
  const editingId = editingIdRaw;
  const [guides, setGuides] = useState<{ v?: number; h?: number }>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize" | "rotate" | "connEnd" | "crop" | "mpath";
    handle?: string;
    startX: number; startY: number;
    orig: Map<string, { x: number; y: number; w: number; h: number; rotate?: number }>;
    connEnd?: 1 | 2;
    cropOrig?: { l: number; t: number; r: number; b: number };
    motionOrig?: { dx: number; dy: number };
  } | null>(null);

  const objs = [...slide.objects].sort((a, b) => a.z - b.z);

  const groupOf = (o: SlideObject) =>
    o.groupId ? objs.filter((x) => x.groupId === o.groupId) : [o];

  const selectObj = (o: SlideObject, e: RMouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    // P1.7 — Ctrl/Cmd+click follows the object's hyperlink instead of selecting
    if ((e.ctrlKey || e.metaKey) && o.link) { window.open(o.link, "_blank", "noopener"); return; }
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

  const slidePt = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current?.getBoundingClientRect();
    return r ? { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale } : { x: 0, y: 0 };
  };

  const startConnEnd = (e: RPointerEvent, o: SlideObject, which: 1 | 2) => {
    if (!interactive || !canEdit) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h }]]);
    dragRef.current = { mode: "connEnd", connEnd: which, startX: e.clientX, startY: e.clientY, orig };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startMPath = (e: RPointerEvent, o: SlideObject) => {
    if (!interactive || !canEdit || !o.anim?.motion) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h }]]);
    dragRef.current = { mode: "mpath", startX: e.clientX, startY: e.clientY, orig, motionOrig: { ...o.anim.motion } };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startCrop = (e: RPointerEvent, o: SlideObject, edge: string) => {
    if (!interactive || !canEdit) return;
    e.stopPropagation();
    const orig = new Map([[o.id, { x: o.x, y: o.y, w: o.w, h: o.h }]]);
    dragRef.current = { mode: "crop", handle: edge, startX: e.clientX, startY: e.clientY, orig,
      cropOrig: o.imgCrop ?? { l: 0, t: 0, r: 0, b: 0 } };
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
    if (d.mode === "mpath") {
      const [id] = [...d.orig][0];
      const cur = objs.find((x) => x.id === id);
      const m0 = d.motionOrig!;
      if (cur?.anim) patches.push({ id, patch: { anim: { ...cur.anim, motion: { dx: Math.round(m0.dx + dx), dy: Math.round(m0.dy + dy) } } } });
    } else if (d.mode === "crop") {
      const [id, o] = [...d.orig][0];
      const c0 = d.cropOrig!;
      const cl = (v: number) => Math.max(0, Math.min(0.9, v));
      const cr = { ...c0 };
      if (d.handle === "l") cr.l = Math.min(cl(c0.l + dx / o.w), 0.9 - c0.r);
      if (d.handle === "r") cr.r = Math.min(cl(c0.r - dx / o.w), 0.9 - c0.l);
      if (d.handle === "t") cr.t = Math.min(cl(c0.t + dy / o.h), 0.9 - c0.b);
      if (d.handle === "b") cr.b = Math.min(cl(c0.b - dy / o.h), 0.9 - c0.t);
      patches.push({ id, patch: { imgCrop: cr } });
    } else if (d.mode === "connEnd") {
      const [id] = [...d.orig][0];
      const cobj = objs.find((x) => x.id === id);
      if (cobj?.conn) {
        const pt = slidePt(e);
        const n = d.connEnd!;
        patches.push({ id, patch: { conn: {
          ...cobj.conn,
          [`x${n}`]: Math.round(pt.x), [`y${n}`]: Math.round(pt.y),
          [n === 1 ? "from" : "to"]: undefined,
        } } });
      }
    } else if (d.mode === "move") {
      let guideV: number | undefined, guideH: number | undefined;
      for (const [id, o] of d.orig) {
        // connectors move their endpoints (detaching any anchors)
        const live = objs.find((x) => x.id === id);
        if (live?.type === "connector" && live.conn) {
          const pts = resolveConn(live, slide);
          patches.push({ id, patch: { conn: {
            ...live.conn, from: undefined, to: undefined,
            x1: Math.round(pts.x1 + dx), y1: Math.round(pts.y1 + dy),
            x2: Math.round(pts.x2 + dx), y2: Math.round(pts.y2 + dy),
          } } });
          continue;
        }
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

  const onUp = (e: RPointerEvent) => {
    if (dragRef.current && onPatch) {
      const d = dragRef.current;
      dragRef.current = null;
      setGuides({});
      if (d.mode === "crop" || d.mode === "mpath") { onPatch([], true); return; }
      // connEnd drop — attach to the nearest anchor if we're over an object
      if (d.mode === "connEnd") {
        const [id] = [...d.orig][0];
        const cobj = objs.find((x) => x.id === id);
        const pt = slidePt(e);
        const hit = cobj ? hitAnchor(slide, pt.x, pt.y, id) : null;
        if (hit && cobj?.conn) {
          const n = d.connEnd!;
          onPatch([{ id, patch: { conn: { ...cobj.conn, [n === 1 ? "from" : "to"]: { id: hit.id, side: hit.side } } } }], true);
          return;
        }
      }
      onPatch([], true); // commit drag as one undo step
    }
  };

  const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
  const handlePos = (o: SlideObject, h: string) => ({
    left: h.includes("w") ? -HANDLE / 2 : h.includes("e") ? o.w - HANDLE / 2 : o.w / 2 - HANDLE / 2,
    top: h.includes("n") ? -HANDLE / 2 : h.includes("s") ? o.h - HANDLE / 2 : o.h / 2 - HANDLE / 2,
    cursor: { nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw", n: "ns", s: "ns", e: "ew", w: "ew" }[h] + "-resize",
  });

  return (
    <div ref={boxRef} className="slide-box" style={{
      width: size?.w ?? SLIDE_W, height: size?.h ?? SLIDE_H, transform: `scale(${scale})`,
      background: slide.bg ?? theme.bg,
      // P2.5 — `bg` may be a gradient string; bgImage layers a picture over it
      backgroundImage: slide.bgImage ? `url(${slide.bgImage})` : undefined,
      backgroundSize: slide.bgImage ? "cover" : undefined,
      backgroundPosition: slide.bgImage ? "center" : undefined,
    }}
      onPointerDown={interactive ? (e) => { if (e.target === e.currentTarget) { onSelect?.(new Set(), false); onCropChange?.(null); } } : undefined}
      onPointerMove={interactive ? onMove : undefined}
      onPointerUp={interactive ? onUp : undefined}>
      {/* shared marker defs — line arrows + connector arrowheads */}
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#26221F" />
          </marker>
        </defs>
      </svg>
      {under?.map((o) => <ObjView key={`u${o.id}`} o={o} theme={theme} />)}
      {(() => { const aSteps = animStep !== undefined ? animSteps(objs) : null; return objs.map((o0) => {
        // connector bbox derives from resolved endpoints so it tracks
        // attached objects even when the stored box is stale
        const connPts = o0.type === "connector" ? resolveConn(o0, slide) : undefined;
        // P3 — per-kind visibility + effect class; path shifts position at its step
        const a = o0.anim;
        let hidden = false;
        let fx: { cls: string; delay?: number; dur?: number; outer?: boolean } | undefined;
        let shift: { dx: number; dy: number } | undefined;
        if (animStep !== undefined && a) {
          const info = aSteps?.get(o0.id);
          const s0 = info?.step ?? a.order;
          const kind = animKind(a.type);
          const spec = { delay: info?.delay, dur: a.duration };
          if (kind === "enter") { hidden = s0 > animStep; if (s0 === animStep) fx = { cls: `fx-enter-${a.type}`, ...spec }; }
          else if (kind === "exit") { hidden = s0 < animStep; if (s0 === animStep) fx = { cls: `fx-exit-${a.type}`, ...spec }; }
          else if (kind === "emphasis") { if (s0 === animStep) fx = { cls: `fx-em-${a.type}`, ...spec }; }
          else if (kind === "path" && a.motion && s0 <= animStep) {
            shift = a.motion;
            if (s0 === animStep) fx = { cls: "fx-path", ...spec, outer: true };
          }
        }
        const o = connPts ? { ...o0, ...connBBox(connPts) }
          : shift ? { ...o0, x: o0.x + shift.dx, y: o0.y + shift.dy } : o0;
        return (
        <ObjView key={o.id} o={o} theme={theme} connPts={connPts}
          selected={interactive && selection.has(o.id)}
          editing={editingId === o.id}
          hidden={hidden}
          fx={fx}
          onMouseDown={(e) => selectObj(o, e)}
          onPointerDown={(e) => startDrag(e, o)}
          onDblClick={() => {
            if (!canEdit) return;
            if (o.type === "text" || o.type === "shape" || o.type === "table") setEditingId(o.id);
            else if (o.type === "image") onCropChange?.(cropId === o.id ? null : o.id);
            else onObjDblClick?.(o);
          }}
          onTextBlur={(html) => { onTextCommit?.(o.id, html); setEditingId(null); }}
          onTableEdit={onTableCommit ? (rows) => onTableCommit(o.id, rows) : undefined} />
        );
      });})()}
      {interactive && canEdit && [...selection].map((id) => {
        const o = slide.objects.find((x) => x.id === id);
        if (!o || editingId === o.id) return null;
        // connectors get endpoint handles, not the rect resize box
        if (o.type === "connector") {
          const pts = resolveConn(o, slide);
          const bb = connBBox(pts);
          return (
            <Fragment key={`h${id}`}>
              <div className="sel-outline" style={{ left: bb.x, top: bb.y, width: Math.max(bb.w, 6), height: Math.max(bb.h, 6) }} />
              {([1, 2] as const).map((n) => (
                <div key={n} className="conn-end" title="Drag to reattach"
                  style={{ left: (n === 1 ? pts.x1 : pts.x2) - 6, top: (n === 1 ? pts.y1 : pts.y2) - 6 }}
                  onPointerDown={(e) => startConnEnd(e, o, n)} />
              ))}
            </Fragment>
          );
        }
        // P1.6 crop mode — edge bars pull each crop boundary (image only)
        if (cropId === o.id && o.type === "image") {
          const bars: Array<[string, React.CSSProperties]> = [
            ["l", { left: o.x - 4, top: o.y + o.h / 2 - 12, width: 8, height: 24, cursor: "ew-resize" }],
            ["r", { left: o.x + o.w - 4, top: o.y + o.h / 2 - 12, width: 8, height: 24, cursor: "ew-resize" }],
            ["t", { left: o.x + o.w / 2 - 12, top: o.y - 4, width: 24, height: 8, cursor: "ns-resize" }],
            ["b", { left: o.x + o.w / 2 - 12, top: o.y + o.h - 4, width: 24, height: 8, cursor: "ns-resize" }],
          ];
          return (
            <Fragment key={`h${id}`}>
              <div className="sel-outline" style={{ left: o.x, top: o.y, width: o.w, height: o.h }} />
              {bars.map(([e2, st]) => (
                <div key={e2} className="s-cropbar" style={st}
                  title="Drag to crop — double-click or Esc to finish"
                  onPointerDown={(ev) => startCrop(ev, o, e2)} />
              ))}
            </Fragment>
          );
        }
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
      {/* P3.2 — motion-path endpoints for selected objects */}
      {interactive && canEdit && [...selection].map((id) => {
        const o = slide.objects.find((x) => x.id === id);
        if (!o?.anim?.motion) return null;
        const sx = o.x + o.w / 2, sy = o.y + o.h / 2;
        const ex = sx + o.anim.motion.dx, ey = sy + o.anim.motion.dy;
        return (
          <Fragment key={`mp${id}`}>
            <svg style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
              <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="#E85D9E" strokeWidth={1.5} strokeDasharray="5 4" />
            </svg>
            <div className="conn-end" title="Motion-path destination — drag to adjust"
              style={{ left: ex - 6, top: ey - 6 }} onPointerDown={(e) => startMPath(e, o)} />
          </Fragment>
        );
      })}
      {guides.v !== undefined && <div className="guide-v" style={{ left: guides.v }} />}
      {guides.h !== undefined && <div className="guide-h" style={{ top: guides.h }} />}
    </div>
  );
}

// ---------- object renderer (also used for thumbnails & presenter) ----------

export function ObjView({ o, theme, selected, editing, hidden, fx, connPts, onMouseDown, onPointerDown, onDblClick, onTextBlur, onTableEdit }: {
  o: SlideObject; theme: Theme;
  connPts?: { x1: number; y1: number; x2: number; y2: number };
  selected?: boolean; editing?: boolean; hidden?: boolean;
  fx?: { cls: string; delay?: number; dur?: number; outer?: boolean };
  onMouseDown?: (e: RMouseEvent) => void;
  onPointerDown?: (e: RPointerEvent) => void;
  onDblClick?: () => void;
  onTextBlur?: (html: string) => void;
  onTableEdit?: (rows: string[][], meta?: SlideObject["tableMeta"]) => void;
}) {
  // P1.5 table cell-range selection (edit mode only)
  const [cellSel, setCellSel] = useState<{ r1: number; c1: number; r2: number; c2: number; contains?: (r: number, c: number) => boolean } | null>(null);
  const selNorm = cellSel && {
    ...cellSel,
    r1: Math.min(cellSel.r1, cellSel.r2), r2: Math.max(cellSel.r1, cellSel.r2),
    c1: Math.min(cellSel.c1, cellSel.c2), c2: Math.max(cellSel.c1, cellSel.c2),
  };
  const inSel = (r: number, c: number) => !!selNorm && r >= selNorm.r1 && r <= selNorm.r2 && c >= selNorm.c1 && c <= selNorm.c2;
  const mergeCells = () => {
    if (!selNorm || !o.table) return;
    const keep = (o.tableMeta?.merges ?? []).filter((m) =>
      !(m.r <= selNorm.r2 && m.r + m.rs - 1 >= selNorm.r1 && m.c <= selNorm.c2 && m.c + m.cs - 1 >= selNorm.c1));
    keep.push({ r: selNorm.r1, c: selNorm.c1, rs: selNorm.r2 - selNorm.r1 + 1, cs: selNorm.c2 - selNorm.c1 + 1 });
    onTableEdit?.(o.table, { ...o.tableMeta, merges: keep });
  };
  const unmergeCells = () => {
    if (!selNorm) return;
    onTableEdit?.(o.table ?? [], {
      ...o.tableMeta,
      merges: (o.tableMeta?.merges ?? []).filter((m) => !(m.r >= selNorm.r1 && m.r <= selNorm.r2 && m.c >= selNorm.c1 && m.c <= selNorm.c2)),
    });
  };
  const setCellFill = (color: string) => {
    if (!selNorm || !o.table) return;
    const cellStyle = { ...(o.tableMeta?.cellStyle ?? {}) };
    for (let r = selNorm.r1; r <= selNorm.r2; r++) for (let c = selNorm.c1; c <= selNorm.c2; c++)
      cellStyle[`${r},${c}`] = { ...cellStyle[`${r},${c}`], bg: color };
    onTableEdit?.(o.table, { ...o.tableMeta, cellStyle });
  };

  const base: CSSProperties = {
    left: o.x, top: o.y, width: o.w, height: o.h,
    transform: o.rotate ? `rotate(${o.rotate}deg)` : undefined,
    opacity: hidden ? 0 : 1,
    // P3.2 — path motion: the position flip transitions via left/top
    transition: fx?.outer ? "left .45s ease, top .45s ease" : undefined,
    transitionDelay: fx?.outer && fx.delay ? `${fx.delay}ms` : undefined,
    pointerEvents: hidden ? "none" : undefined,
  };
  const common = {
    className: `s-obj ${selected ? "selected" : ""}`,
    onMouseDown, onPointerDown, onDoubleClick: onDblClick,
    // P1.7 — in non-interactive renders (presenter/thumbnails) a linked object
    // is directly clickable; editor opens via Ctrl+click in selectObj instead
    onClick: o.link && !onPointerDown ? () => window.open(o.link, "_blank", "noopener") : undefined,
  };
  void theme;
  void selected;

  const textEl = (editingNow: boolean) =>
    editingNow ? (
      <div className="s-text editing" contentEditable suppressContentEditableWarning data-oid={o.id}
        style={{ fontSize: o.fontSize ?? 20, color: o.color, textAlign: o.align, fontFamily: o.fontFamily, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal" }}
        dangerouslySetInnerHTML={{ __html: o.html ?? "" }}
        onBlur={(e) => onTextBlur?.((e.target as HTMLElement).innerHTML)}
        onKeyDown={(e) => {
          // P1.2 — Tab/Shift+Tab inside lists = indent/outdent (execCommand
          // understands list items; falls back to block indent otherwise)
          if (e.key === "Tab") {
            e.preventDefault();
            document.execCommand(e.shiftKey ? "outdent" : "indent");
          }
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        ref={(el) => { if (el) { el.focus(); document.execCommand("styleWithCSS", false, "true"); } }} />
    ) : (
      <div className="s-text"
        style={{ fontSize: o.fontSize ?? 20, color: o.color, textAlign: o.align, fontFamily: o.fontFamily, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal" }}
        dangerouslySetInnerHTML={{ __html: (o.html ?? "").replace(/\n/g, "<br/>") }} />
    );

  let content: React.ReactNode = null;
  const style: CSSProperties = { ...base };
  if (o.link && !onPointerDown) style.cursor = "pointer";
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
    case "image": {
      // P1.6 — crop fractions map a sub-rect of the image onto the object box
      const cr = o.imgCrop ?? { l: 0, t: 0, r: 0, b: 0 };
      const iw = 1 - cr.l - cr.r, ih = 1 - cr.t - cr.b;
      const fx: string | undefined =
        o.imgFilter === "grayscale" ? "grayscale(1)" : o.imgFilter === "sepia" ? "sepia(1)"
        : o.imgFilter === "invert" ? "invert(1)" : o.imgFilter === "blur" ? "blur(2px)" : undefined;
      const flip = o.imgFlipH || o.imgFlipV ? `scale(${o.imgFlipH ? -1 : 1},${o.imgFlipV ? -1 : 1})` : undefined;
      content = (
        <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
          <img src={o.src} alt={o.alt ?? ""} draggable={false}
            style={{
              position: "absolute",
              width: `${100 / Math.max(iw, 0.01)}%`, height: `${100 / Math.max(ih, 0.01)}%`,
              left: `${(-cr.l / Math.max(iw, 0.01)) * 100}%`, top: `${(-cr.t / Math.max(ih, 0.01)) * 100}%`,
              transform: flip, filter: fx, opacity: o.imgOpacity ?? 1,
            }} />
        </div>
      );
      break;
    }
    case "table": {
      const rows = o.table ?? [["", ""]];
      const meta = o.tableMeta ?? {};
      // merge coverage: head cell → span; covered coords skipped
      const covered = new Set<string>();
      const spanOf = new Map<string, { rs: number; cs: number }>();
      for (const m of meta.merges ?? []) {
        spanOf.set(`${m.r},${m.c}`, { rs: m.rs, cs: m.cs });
        for (let rr = 0; rr < m.rs; rr++) for (let cc = 0; cc < m.cs; cc++)
          if (rr || cc) covered.add(`${m.r + rr},${m.c + cc}`);
      }
      const cellBg = (i: number, j: number) =>
        meta.cellStyle?.[`${i},${j}`]?.bg
        ?? (i === 0 && meta.headerRow !== false ? "rgba(0,0,0,.04)"
          : meta.banded && i % 2 === 0 ? "rgba(0,0,0,.025)" : undefined);
      const isHead = (i: number) => i === 0 && meta.headerRow !== false;
      style.overflow = editing ? "auto" : "hidden";
      const tbl = (
        <table className={`s-table ${editing ? "editing" : ""}`}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => {
                  if (covered.has(`${i},${j}`)) return null;
                  const sp = spanOf.get(`${i},${j}`);
                  const st: CSSProperties = {
                    fontSize: o.fontSize ?? 14, color: o.color, minWidth: 40,
                    background: cellBg(i, j), fontWeight: isHead(i) ? 700 : undefined,
                    textAlign: meta.cellStyle?.[`${i},${j}`]?.align,
                  };
                  return editing ? (
                    <td key={j} rowSpan={sp?.rs} colSpan={sp?.cs} contentEditable suppressContentEditableWarning
                      className={inSel(i, j) ? "cellsel" : undefined}
                      style={st}
                      onPointerDown={(e) => { e.stopPropagation(); setCellSel({ r1: i, c1: j, r2: i, c2: j }); }}
                      onClick={(e) => { if (e.shiftKey && cellSel) setCellSel({ ...cellSel, r2: i, c2: j }); }}
                      onBlur={(e) => {
                        const next = rows.map((row, ri) => ri === i ? row.map((cell, cj) => cj === j ? (e.target as HTMLElement).innerText : cell) : row);
                        onTableEdit?.(next, meta);
                      }}>{c}</td>
                  ) : (
                    <td key={j} rowSpan={sp?.rs} colSpan={sp?.cs} style={st}>{c}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
      content = editing ? (
        <div className="s-table-wrap">
          <div className="s-table-bar">
            <button title="Merge selected cells" disabled={!cellSel || (cellSel.r2 - cellSel.r1 === 0 && cellSel.c2 - cellSel.c1 === 0)}
              onClick={() => { mergeCells(); }}>⇥⇤</button>
            <button title="Split merged cell" disabled={!cellSel}
              onClick={() => { unmergeCells(); }}>⇤⇥</button>
            <label title="Cell fill" style={{ cursor: "pointer" }}>
              ▨<input type="color" style={{ position: "absolute", opacity: 0, width: 0 }}
                onChange={(e) => setCellFill(e.target.value)} />
            </label>
            <button title="Header row" className={meta.headerRow !== false ? "on" : ""}
              onClick={() => onTableEdit?.(rows, { ...meta, headerRow: meta.headerRow === false })}>H</button>
            <button title="Banded rows" className={meta.banded ? "on" : ""}
              onClick={() => onTableEdit?.(rows, { ...meta, banded: !meta.banded })}>☰</button>
          </div>
          {tbl}
        </div>
      ) : tbl;
      break;
    }
    case "chart":
      content = <ChartSvg o={o} />;
      break;
    case "connector": {
      const pts = connPts ?? { x1: o.x, y1: o.y, x2: o.x + o.w, y2: o.y + o.h };
      const minX = Math.min(pts.x1, pts.x2), minY = Math.min(pts.y1, pts.y2);
      const x1 = pts.x1 - minX, y1 = pts.y1 - minY, x2 = pts.x2 - minX, y2 = pts.y2 - minY;
      const bw = Math.max(Math.abs(x2 - x1), 2), bh = Math.max(Math.abs(y2 - y1), 2);
      const kind = o.conn?.kind ?? "straight";
      let d = `M${x1},${y1} L${x2},${y2}`;
      if (kind === "elbow") {
        const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
        d = horizontal
          ? `M${x1},${y1} L${(x1 + x2) / 2},${y1} L${(x1 + x2) / 2},${y2} L${x2},${y2}`
          : `M${x1},${y1} L${x1},${(y1 + y2) / 2} L${x2},${(y1 + y2) / 2} L${x2},${y2}`;
      } else if (kind === "curve") {
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
        const off = Math.min(60, len * 0.2);
        d = `M${x1},${y1} Q${mx - (dy / len) * off},${my + (dx / len) * off} ${x2},${y2}`;
      }
      const st = o.stroke ?? "#26221F";
      content = (
        <svg width={bw} height={bh} style={{ overflow: "visible" }}>
          <defs>
            <marker id={`carr-${o.id}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={st} />
            </marker>
          </defs>
          <path d={d} fill="none" stroke={st} strokeWidth={o.strokeW ?? 2} markerEnd={`url(#carr-${o.id})`} />
        </svg>
      );
      style.left = minX; style.top = minY;
      style.width = bw; style.height = bh;
      break;
    }
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
      {fx && !fx.outer ? (
        <div className={`s-fx ${fx.cls}`}
          style={{ animationDelay: fx.delay ? `${fx.delay}ms` : undefined, animationDuration: fx.dur ? `${fx.dur}ms` : undefined }}>
          {content}
        </div>
      ) : content}
    </div>
  );
}

// ---------- P1.3 shape catalog — normalized 100×100 geometry ----------

function starN(n: number, inset = 0.45): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? 50 * inset : 50;
    pts.push(`${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`);
  }
  return pts.join(" ");
}

/** inner SVG nodes for `kind` in a 100×100 box (scale via viewBox) */
function shapeNode(kind: string, fill: string, stroke: string, sw: number): ReactNode {
  const p = { fill, stroke, strokeWidth: sw, vectorEffect: "non-scaling-stroke" as const };
  const poly = (pts: string) => <polygon points={pts} {...p} />;
  const path = (d: string) => <path d={d} {...p} />;
  switch (kind) {
    case "rect": default: return <rect width={100} height={100} {...p} />;
    case "roundrect": return <rect width={100} height={100} rx={12} {...p} />;
    case "ellipse": return <ellipse cx={50} cy={50} rx={50} ry={50} {...p} />;
    case "triangle": return poly("50,0 100,100 0,100");
    case "rightTriangle": return poly("0,0 100,100 0,100");
    case "diamond": return poly("50,0 100,50 50,100 0,50");
    case "pentagon": return poly("50,0 100,38 81,100 19,100 0,38");
    case "hexagon": return poly("25,0 75,0 100,50 75,100 25,100 0,50");
    case "octagon": return poly("30,0 70,0 100,30 100,70 70,100 30,100 0,70 0,30");
    case "parallelogram": return poly("25,0 100,0 75,100 0,100");
    case "trapezoid": return poly("20,0 80,0 100,100 0,100");
    case "star": case "star5": return poly(starN(5));
    case "star4": return poly(starN(4, 0.38));
    case "star6": return poly(starN(6));
    case "arrow": case "arrowRight": return poly("0,35 65,35 65,0 100,50 65,100 65,65 0,65");
    case "arrowLeft": return poly("100,35 35,35 35,0 0,50 35,100 35,65 100,65");
    case "arrowUp": return poly("35,100 35,35 0,35 50,0 100,35 65,35 65,100");
    case "arrowDown": return poly("35,0 35,65 0,65 50,100 100,65 65,65 65,0");
    case "arrowBoth": return poly("35,20 65,20 65,0 100,50 65,100 65,80 35,80 35,100 0,50 35,0");
    case "chevron": return poly("0,0 75,0 100,50 75,100 0,100 25,50");
    case "homePlate": return poly("0,0 75,0 100,50 75,100 0,100");
    case "plus": return poly("35,0 65,0 65,35 100,35 100,65 65,65 65,100 35,100 35,65 0,65 0,35 35,35");
    case "crossX": return poly("21,0 50,29 79,0 100,21 71,50 100,79 79,100 50,71 21,100 0,79 29,50 0,21");
    case "donut": return <path fillRule="evenodd" d="M50 0 A50 50 0 1 0 50 100 A50 50 0 1 0 50 0 Z M50 28 A22 22 0 1 1 50 72 A22 22 0 1 1 50 28 Z" {...p} />;
    case "pie": return path("M50 50 L100 50 A50 50 0 0 1 50 100 Z");
    case "blockArc": return <path fillRule="evenodd" d="M100 50 A50 50 0 0 1 50 100 L50 78 A28 28 0 0 0 78 50 Z" {...p} />;
    case "calloutRect": return <g><rect x={0} y={0} width={100} height={70} {...p} /><polygon points="30,70 60,70 20,100" {...p} /></g>;
    case "calloutRound": return <g><rect x={0} y={0} width={100} height={70} rx={30} {...p} /><polygon points="30,70 60,70 20,100" {...p} /></g>;
    case "cloud": return path("M25 70 A15 15 0 0 1 30 42 A22 22 0 0 1 70 38 A15 15 0 0 1 78 70 Z");
    case "heart": return path("M50 92 C10 62 0 38 14 22 C26 8 44 14 50 30 C56 14 74 8 86 22 C100 38 90 62 50 92 Z");
    case "lightning": return poly("55,0 20,55 42,55 35,100 80,42 55,42 70,0");
    case "sun": return <g><circle cx={50} cy={50} r={28} {...p} /><path d="M50 2 V14 M50 86 V98 M2 50 H14 M86 50 H98 M16 16 L24 24 M84 84 L76 76 M84 16 L76 24 M16 84 L24 76" stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 5)} vectorEffect="non-scaling-stroke" /></g>;
    case "moon": return path("M62 8 A44 44 0 1 0 62 92 A36 36 0 1 1 62 8 Z");
    case "can": return <g><path d="M0 10 A50 10 0 0 0 100 10 V90 A50 10 0 0 1 0 90 Z" {...p} /><ellipse cx={50} cy={10} rx={50} ry={10} {...p} /></g>;
    case "document": return path("M0 0 H100 V82 Q87 100 75 82 Q62 64 50 82 Q37 100 25 82 Q12 64 0 82 Z");
    case "leftBrace": return <path d="M62 0 Q45 0 45 16 V34 Q45 50 30 50 Q45 50 45 66 V84 Q45 100 62 100" {...p} fill="none" stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 3)} />;
    case "rightBrace": return <path d="M38 0 Q55 0 55 16 V34 Q55 50 70 50 Q55 50 55 66 V84 Q55 100 38 100" {...p} fill="none" stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 3)} />;
    case "leftBracket": return <path d="M55 0 H15 V100 H55" {...p} fill="none" stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 3)} />;
    case "rightBracket": return <path d="M45 0 H85 V100 H45" {...p} fill="none" stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 3)} />;
    case "noSymbol": return <g><ellipse cx={50} cy={50} rx={48} ry={48} {...p} /><line x1={16} y1={16} x2={84} y2={84} stroke={fill === "transparent" ? stroke : fill} strokeWidth={Math.max(sw, 8)} vectorEffect="non-scaling-stroke" /></g>;
  }
}

export const SHAPE_MENU: { id: string; glyph: string; name: string }[] = [
  { id: "rect", glyph: "▭", name: "Rectangle" },
  { id: "roundrect", glyph: "▢", name: "Rounded" },
  { id: "ellipse", glyph: "◯", name: "Oval" },
  { id: "triangle", glyph: "△", name: "Triangle" },
  { id: "rightTriangle", glyph: "◺", name: "Right △" },
  { id: "diamond", glyph: "◇", name: "Diamond" },
  { id: "pentagon", glyph: "⬠", name: "Pentagon" },
  { id: "hexagon", glyph: "⬡", name: "Hexagon" },
  { id: "octagon", glyph: "⯃", name: "Octagon" },
  { id: "parallelogram", glyph: "▱", name: "Parallelogram" },
  { id: "trapezoid", glyph: "⏢", name: "Trapezoid" },
  { id: "star4", glyph: "✦", name: "4-star" },
  { id: "star5", glyph: "★", name: "5-star" },
  { id: "star6", glyph: "✶", name: "6-star" },
  { id: "arrowRight", glyph: "➜", name: "Arrow →" },
  { id: "arrowLeft", glyph: "←", name: "Arrow ←" },
  { id: "arrowUp", glyph: "↑", name: "Arrow ↑" },
  { id: "arrowDown", glyph: "↓", name: "Arrow ↓" },
  { id: "arrowBoth", glyph: "↔", name: "Arrow ↔" },
  { id: "chevron", glyph: "❯", name: "Chevron" },
  { id: "homePlate", glyph: "➤", name: "Pentagon arrow" },
  { id: "plus", glyph: "✚", name: "Plus" },
  { id: "crossX", glyph: "✕", name: "Cross" },
  { id: "donut", glyph: "◎", name: "Donut" },
  { id: "pie", glyph: "◔", name: "Pie" },
  { id: "blockArc", glyph: "◠", name: "Block arc" },
  { id: "calloutRect", glyph: "🗨", name: "Callout" },
  { id: "calloutRound", glyph: "💬", name: "Round callout" },
  { id: "cloud", glyph: "☁", name: "Cloud" },
  { id: "heart", glyph: "♥", name: "Heart" },
  { id: "lightning", glyph: "⚡", name: "Lightning" },
  { id: "sun", glyph: "☀", name: "Sun" },
  { id: "moon", glyph: "☾", name: "Moon" },
  { id: "can", glyph: "⬮", name: "Cylinder" },
  { id: "document", glyph: "📄", name: "Document" },
  { id: "leftBrace", glyph: "{", name: "Brace L" },
  { id: "rightBrace", glyph: "}", name: "Brace R" },
  { id: "leftBracket", glyph: "[", name: "Bracket L" },
  { id: "rightBracket", glyph: "]", name: "Bracket R" },
  { id: "noSymbol", glyph: "⊘", name: "No symbol" },
];

function ShapeSvg({ o }: { o: SlideObject }) {
  const fill = o.fill ?? "#F2782E";
  const stroke = o.stroke === "none" ? "transparent" : (o.stroke ?? "transparent");
  return (
    <svg width={o.w} height={o.h} viewBox="0 0 100 100" preserveAspectRatio="none">
      {shapeNode(o.shape ?? "rect", fill, stroke, o.strokeW ?? 0)}
    </svg>
  );
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
