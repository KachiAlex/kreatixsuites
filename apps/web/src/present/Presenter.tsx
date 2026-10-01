import { useEffect, useRef, useState, useCallback } from "react";
import type { Deck, Theme } from "./model";
import { masterObjects, layoutObjects, deckSize, maxAnimStep } from "./model";
import { SlideCanvas } from "./SlideCanvas";

interface InkStroke { tool: "pen" | "hl"; color: string; w: number; pts: number[] }

/** Fullscreen slideshow + Presenter View (KBS-PRESENT-015) */
export function Presenter({ deck, theme, startIndex, presenterView, showSlides, onClose, onRehearsed }: {
  deck: Deck;
  theme: Theme;
  startIndex: number;
  presenterView: boolean;
  showSlides?: number[]; // P5.3 — custom show subset (indices into deck.slides)
  onClose: () => void;
  onRehearsed?: (timings: Record<number, number>) => void; // P5.2
}) {
  const [idx, setIdx] = useState(startIndex);
  const [step, setStep] = useState(0);
  const [blank, setBlank] = useState<"none" | "black" | "white">("none");
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(true);
  // P5.1 — ink layer
  const [inkTool, setInkTool] = useState<"none" | "pen" | "hl" | "laser">("none");
  const [strokes, setStrokes] = useState<Map<number, InkStroke[]>>(new Map());
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const curStroke = useRef<InkStroke | null>(null);
  // touch swipe → advance/rewind (click/tap already advances)
  const swipeX = useRef<number | null>(null);
  // P5.2 — rehearse: ms spent per subset-position
  const [rehearsing, setRehearsing] = useState(false);
  const timesRef = useRef<Map<number, number>>(new Map());
  const slideEnterAt = useRef(Date.now());
  const slides = showSlides ? showSlides.map((i) => deck.slides[i]).filter(Boolean) : deck.slides;
  const slide = slides[idx];
  const dims = deckSize(deck);

  // P3.3 — click-steps from animSteps: click triggers consume steps, with/after chain on
  const maxStep = slide ? maxAnimStep(slide.objects) : 0;

  const go = useCallback((d: number) => {
    setBlank("none");
    if (d > 0) {
      if (step < maxStep) setStep(step + 1);
      else {
        setStep(0);
        // P2.3 — skip hidden slides; P5.2 — loop at end in kiosk mode
        setIdx((i) => {
          let n = i + 1;
          while (n < slides.length - 1 && slides[n].hidden) n++;
          if (n >= slides.length - 1 && slides[slides.length - 1]?.hidden) n = slides.length - 1;
          if (n > slides.length - 1 || (n === slides.length - 1 && i === slides.length - 1)) {
            if (deck.showLoop) { let f = 0; while (f < slides.length - 1 && slides[f].hidden) f++; return f; }
          }
          return Math.min(slides.length - 1, n);
        });
      }
    } else {
      setStep(Infinity);
      setIdx((i) => {
        let n = i - 1;
        while (n > 0 && slides[n].hidden) n--;
        return Math.max(0, n);
      });
    }
  }, [slides, maxStep, step, deck.showLoop]);

  const jump = useCallback((i: number) => { setIdx(i); setStep(0); }, []);

  // P5.2 — rehearse: accumulate dwell per position; auto-advance per slide timing
  useEffect(() => {
    if (!rehearsing) return;
    slideEnterAt.current = Date.now();
    const prev = slideEnterAt.current;
    return () => {
      const dt = Date.now() - prev;
      timesRef.current.set(idx, (timesRef.current.get(idx) ?? 0) + dt);
    };
  }, [idx, rehearsing]);

  useEffect(() => {
    const ms = slide?.advanceAfter;
    if (!ms || rehearsing || step < maxStep) return;
    const t = setTimeout(() => go(1), ms);
    return () => clearTimeout(t);
  }, [idx, step, slide?.advanceAfter, rehearsing, maxStep, go]);

  // P5.1 — ink pointer handlers in slide coords
  const inkPt = (e: React.PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * dims.w, y: ((e.clientY - r.top) / r.height) * dims.h };
  };
  const inkDown = (e: React.PointerEvent) => {
    if (inkTool === "laser") { setLaser(inkPt(e, e.currentTarget as HTMLElement)); return; }
    if (inkTool === "none") return;
    e.stopPropagation();
    const p = inkPt(e, e.currentTarget as HTMLElement);
    const s: InkStroke = inkTool === "hl"
      ? { tool: "hl", color: "rgba(255,230,0,.45)", w: 18, pts: [p.x, p.y] }
      : { tool: "pen", color: "#E84545", w: 3, pts: [p.x, p.y] };
    curStroke.current = s;
    setStrokes((m) => { const n = new Map(m); n.set(idx, [...(n.get(idx) ?? []), s]); return n; });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const inkMove = (e: React.PointerEvent) => {
    if (inkTool === "laser") { setLaser(inkPt(e, e.currentTarget as HTMLElement)); return; }
    const s = curStroke.current;
    if (!s) return;
    const p = inkPt(e, e.currentTarget as HTMLElement);
    s.pts.push(p.x, p.y);
    setStrokes((m) => new Map(m)); // force repaint of the mutated stroke
  };
  const inkUp = () => { curStroke.current = null; };
  const inkSvg = (
    <svg className="ink-layer" width="100%" height="100%" viewBox={`0 0 ${dims.w} ${dims.h}`}
      style={{ position: "absolute", inset: 0, cursor: inkTool === "laser" ? "none" : inkTool !== "none" ? "crosshair" : undefined }}
      onPointerDown={inkTool !== "none" ? inkDown : undefined}
      onPointerMove={inkTool !== "none" ? inkMove : undefined}
      onPointerUp={inkTool !== "none" ? inkUp : undefined}
      onPointerLeave={inkTool === "laser" ? () => setLaser(null) : undefined}>
      {(strokes.get(idx) ?? []).map((s, i) => (
        <polyline key={i} fill="none" stroke={s.color} strokeWidth={s.w}
          strokeLinecap="round" strokeLinejoin="round"
          points={s.pts.reduce<string>((a, v, k) => k % 2 ? a : `${a}${v},${s.pts[k + 1]} `, "")} />
      ))}
      {laser && inkTool === "laser" && (
        <circle cx={laser.x} cy={laser.y} r={9} fill="rgba(232,69,69,.35)" stroke="#E84545" strokeWidth={2.5} />
      )}
    </svg>
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown" || e.key === "Enter") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp" || e.key === "Backspace") go(-1);
      else if (e.key === "Escape") onClose();
      else if (e.key === "Home") jump(0);
      else if (e.key === "End") jump(slides.length - 1);
      else if (e.key.toLowerCase() === "b") setBlank((b) => (b === "black" ? "none" : "black"));
      else if (e.key.toLowerCase() === "w") setBlank((b) => (b === "white" ? "none" : "white"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, jump, onClose, slides.length]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const next = slides[idx + 1];

  // scale to fit available box — deck-level slide size (P2.4)
  const scaleFor = (w: number, h: number) => Math.min(w / dims.w, h / dims.h);
  const mainScale = presenterView ? scaleFor(window.innerWidth * 0.62, window.innerHeight * 0.72) : scaleFor(window.innerWidth, window.innerHeight);

  const renderSlide = (s: typeof slide, scale: number, withAnim = false) => (
    <div className={`pres-slide ${withAnim && s?.transition && s.transition.type !== "none" ? `anim-${s.transition.type} dir-${s.transition.dir ?? "l"}` : ""}`}
      key={s?.id}
      style={{
        width: dims.w * scale, height: dims.h * scale, overflow: "hidden", position: "relative",
        boxShadow: "0 12px 40px rgba(0,0,0,.45)",
        animationDuration: `${(s?.transition?.duration ?? 500) / 1000}s`,
      }}>
      <SlideCanvas slide={s} theme={theme} scale={scale} selection={new Set()} size={dims}
        under={s ? [...masterObjects(deck), ...layoutObjects(deck, s)] : undefined}
        animStep={withAnim ? Math.min(step, maxStep) : undefined} />
      {withAnim && inkSvg}
    </div>
  );

  const counter = `${idx + 1} / ${slides.length}`;
  // P5.2 — rehearse commit on exit; P5.1 — ink controls shared by both views
  const close = () => {
    if (rehearsing && timesRef.current.size && onRehearsed) {
      const rec: Record<number, number> = {};
      for (const [k, v] of timesRef.current) rec[showSlides ? showSlides[k] : k] = v;
      onRehearsed(rec);
    }
    onClose();
  };
  const inkBtns = (
    <>
      {(["pen", "hl", "laser"] as const).map((t) => (
        <button key={t} className={inkTool === t ? "on" : ""}
          title={t === "pen" ? "Pen" : t === "hl" ? "Highlighter" : "Laser pointer"}
          onClick={(e) => { e.stopPropagation(); setInkTool(inkTool === t ? "none" : t); }}>
          {t === "pen" ? "✒" : t === "hl" ? "▮" : "•"}
        </button>
      ))}
      {inkTool !== "none" && (
        <button title="Clear ink on this slide" onClick={(e) => { e.stopPropagation(); setStrokes((m) => { const n = new Map(m); n.delete(idx); return n; }); }}>⌫</button>
      )}
    </>
  );

  if (!presenterView) {
    return (
      <div className="presenter-full" onClick={() => { if (inkTool === "none") go(1); }} onContextMenu={(e) => { e.preventDefault(); if (inkTool === "none") go(-1); }}
        onPointerDown={(e) => { if (e.pointerType === "touch") swipeX.current = e.clientX; }}
        onPointerUp={(e) => {
          if (e.pointerType !== "touch" || swipeX.current === null) return;
          const dx = e.clientX - swipeX.current; swipeX.current = null;
          if (Math.abs(dx) > 60) { e.preventDefault(); go(dx < 0 ? 1 : -1); }
        }}>
        {blank !== "none" ? <div className="blank" style={{ background: blank === "black" ? "#000" : "#fff" }} /> : renderSlide(slide, mainScale, true)}
        <div className="pres-hud">
          <span>{counter}</span>
          <span>{mm}:{ss}</span>
          {inkBtns}
          <button className={rehearsing ? "on" : ""} title="Rehearse timings" onClick={(e) => { e.stopPropagation(); setRehearsing((r) => !r); }}>⏱</button>
          <button onClick={(e) => { e.stopPropagation(); setBlank(blank === "black" ? "none" : "black"); }}>B</button>
          <button onClick={(e) => { e.stopPropagation(); setBlank(blank === "white" ? "none" : "white"); }}>W</button>
          <button onClick={(e) => { e.stopPropagation(); close(); }}>✕</button>
        </div>
      </div>
    );
  }

  return (
    <div className="presenter-view">
      <div className="pv-main">
        {blank !== "none" ? <div className="blank" style={{ background: blank === "black" ? "#000" : "#fff", flex: 1 }} /> : renderSlide(slide, mainScale, true)}
        <div className="pv-thumbs">
          {slides.map((s, i) => (
            <div key={s.id} className={`pv-thumb ${i === idx ? "active" : ""} ${s.hidden ? "hidden" : ""}`} onClick={() => jump(i)}>
              <SlideCanvas slide={s} theme={theme} scale={0.08} selection={new Set()} size={dims}
                under={[...masterObjects(deck), ...layoutObjects(deck, s)]} />
              <span>{i + 1}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="pv-side">
        <div className="pv-timer">
          <b>{mm}:{ss}</b>
          <div>
            <button onClick={() => setElapsed(0)}>Reset</button>
            <button onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Resume"}</button>
          </div>
        </div>
        <div className="pv-next">
          <label>Next slide</label>
          {next ? renderSlide(next, scaleFor(320, 180)) : <div className="pv-none">End of deck</div>}
        </div>
        <div className="pv-notes">
          <label>Speaker notes</label>
          <div className="pv-notes-body">{slide?.notes || <i>No notes for this slide</i>}</div>
        </div>
        <div className="pv-controls">
          <button className="btn-ghost btn-sm" onClick={() => go(-1)}>← Prev</button>
          <button className="btn-ghost btn-sm" onClick={() => go(1)}>Next →</button>
          {inkBtns}
          <button className="btn-ghost btn-sm" onClick={() => setRehearsing((r) => !r)}>{rehearsing ? "⏱ Rehearsing" : "⏱ Rehearse"}</button>
          <button className="btn-ghost btn-sm" onClick={() => setBlank(blank === "black" ? "none" : "black")}>Blackout</button>
          <button className="btn-ghost btn-sm" onClick={close}>Exit</button>
        </div>
        <span className="pv-counter">{counter}</span>
      </div>
    </div>
  );
}

