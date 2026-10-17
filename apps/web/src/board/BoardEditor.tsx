// Kreatix Board — freehand canvas whiteboard. Strokes are stored as
// normalized (0..1) points in the canonical JSON doc so the board renders at
// any size; eraser strokes composite with destination-out.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useToast } from "../lib/hooks";

interface Stroke { c: string; w: number; e?: boolean; pts: number[] }
interface BoardDoc { kind?: string; strokes?: Stroke[] }

const COLORS = ["#232020", "#3578E5", "#1F9D66", "#E96A2C", "#D84B57", "#7C5CD6"];
const SIZES = [3, 6, 12, 22];

type SaveState = "saved" | "saving" | "dirty";

export function BoardEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const { msg } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [strokes, setStrokes] = useState<Stroke[]>(
    () => (initialDoc as BoardDoc)?.strokes ?? []);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(6);
  const [tool, setTool] = useState<"pen" | "erase">("pen");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const saveTimer = useRef<number>(0);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;

  const redraw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const s of strokesRef.current) {
      ctx.globalCompositeOperation = s.e ? "destination-out" : "source-over";
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.w * cv.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < s.pts.length; i += 2) {
        const x = s.pts[i] * cv.width, y = s.pts[i + 1] * cv.height;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      if (s.pts.length === 2) ctx.lineTo(s.pts[0] * cv.width + 0.5, s.pts[1] * cv.height + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  // canvas sized to its container at devicePixelRatio
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(redraw, [strokes, redraw]);

  const scheduleSave = useCallback((next: Stroke[]) => {
    setSaveState("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSaveState("saving");
      const ok = await saveContent(item.id, { kind: "board", strokes: next }, false);
      setSaveState(ok ? "saved" : "dirty");
    }, 1200);
  }, [item.id]);

  const pos = (e: React.PointerEvent): [number, number] => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    ];
  };

  const down = (e: React.PointerEvent) => {
    if (!canEdit || e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drawing.current = { c: color, w: size / 1000, e: tool === "erase", pts: pos(e) };
  };
  const move = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    d.pts.push(...pos(e));
    // live preview: redraw committed strokes + the in-flight one
    redraw();
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = d.e ? "destination-out" : "source-over";
    ctx.strokeStyle = d.c;
    ctx.lineWidth = d.w * cv.width;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < d.pts.length; i += 2) {
      const x = d.pts[i] * cv.width, y = d.pts[i + 1] * cv.height;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  };
  const up = () => {
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;
    const next = [...strokesRef.current, d];
    setStrokes(next);
    scheduleSave(next);
  };

  const undo = () => {
    const next = strokesRef.current.slice(0, -1);
    setStrokes(next);
    scheduleSave(next);
  };
  const clear = () => {
    setStrokes([]);
    scheduleSave([]);
  };
  const exportPng = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const a = document.createElement("a");
    a.download = `${title || "board"}.png`;
    a.href = cv.toDataURL("image/png");
    a.click();
  };
  const rename = async (name: string) => {
    await api.patch(`/api/drive/${item.id}`, { name }).catch(() => {});
  };

  return (
    <div className="editor board-editor">
      <div className="editor-top">
        <button className="iconbtn" title="Back" onClick={() => navigate("/drive/all")}>←</button>
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.name && void rename(title.trim())} />
        {canEdit && (<>
          <div className="board-tools">
            <button className={`board-tool ${tool === "pen" ? "active" : ""}`} title="Pen"
              onClick={() => setTool("pen")}>✏️</button>
            <button className={`board-tool ${tool === "erase" ? "active" : ""}`} title="Eraser"
              onClick={() => setTool("erase")}>◻</button>
            <span className="board-sep" />
            {COLORS.map((c) => (
              <button key={c} className={`board-swatch ${color === c && tool === "pen" ? "active" : ""}`}
                style={{ background: c }} title={c}
                onClick={() => { setColor(c); setTool("pen"); }} />
            ))}
            <span className="board-sep" />
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} title="Stroke width">
              {SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
            </select>
            <button className="board-tool" title="Undo" disabled={!strokes.length} onClick={undo}>↩</button>
            <button className="board-tool" title="Clear board" onClick={() => {
              if (window.confirm("Clear the entire board?")) clear();
            }}>🗑</button>
          </div>
        </>)}
        <span className="spacer" />
        <button className="btn-ghost btn-sm" onClick={exportPng}>Export PNG</button>
        <span className={`save-state ${saveState}`}>
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Unsaved"}
        </span>
      </div>
      <div className="board-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="board-canvas"
          style={{ cursor: canEdit ? "crosshair" : "default", touchAction: "none" }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
        {!canEdit && <div className="board-ro">Read-only — you have view access</div>}
      </div>
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}
