import { useEffect, useState, useCallback } from "react";
import type { Deck, Theme } from "./model";
import { SLIDE_W, SLIDE_H } from "./model";
import { SlideCanvas } from "./SlideCanvas";

/** Fullscreen slideshow + Presenter View (KBS-PRESENT-015) */
export function Presenter({ deck, theme, startIndex, presenterView, onClose }: {
  deck: Deck;
  theme: Theme;
  startIndex: number;
  presenterView: boolean;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIndex);
  const [step, setStep] = useState(0);
  const [blank, setBlank] = useState<"none" | "black" | "white">("none");
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(true);
  const slides = deck.slides;
  const slide = slides[idx];

  // entrance animations: each click reveals the next ordered object (KBS-PRESENT-005)
  const maxStep = slide ? Math.max(0, ...slide.objects.map((o) => o.anim ? o.anim.order : 0)) : 0;

  const go = useCallback((d: number) => {
    setBlank("none");
    if (d > 0) {
      if (step < maxStep) setStep(step + 1);
      else { setStep(0); setIdx((i) => Math.min(slides.length - 1, i + 1)); }
    } else {
      setStep(Infinity);
      setIdx((i) => Math.max(0, i - 1));
    }
  }, [slides.length, maxStep, step]);

  const jump = useCallback((i: number) => { setIdx(i); setStep(0); }, []);

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

  // scale to fit available box
  const scaleFor = (w: number, h: number) => Math.min(w / SLIDE_W, h / SLIDE_H);
  const mainScale = presenterView ? scaleFor(window.innerWidth * 0.62, window.innerHeight * 0.72) : scaleFor(window.innerWidth, window.innerHeight);

  const renderSlide = (s: typeof slide, scale: number, withAnim = false) => (
    <div className={`pres-slide ${withAnim && s?.transition && s.transition.type !== "none" ? `anim-${s.transition.type}` : ""}`}
      key={s?.id}
      style={{
        width: SLIDE_W * scale, height: SLIDE_H * scale, overflow: "hidden", position: "relative",
        boxShadow: "0 12px 40px rgba(0,0,0,.45)",
        animationDuration: `${(s?.transition?.duration ?? 500) / 1000}s`,
      }}>
      <SlideCanvas slide={s} theme={theme} scale={scale} selection={new Set()}
        animStep={withAnim ? Math.min(step, maxStep) : undefined} />
    </div>
  );

  const counter = `${idx + 1} / ${slides.length}`;

  if (!presenterView) {
    return (
      <div className="presenter-full" onClick={() => go(1)} onContextMenu={(e) => { e.preventDefault(); go(-1); }}>
        {blank !== "none" ? <div className="blank" style={{ background: blank === "black" ? "#000" : "#fff" }} /> : renderSlide(slide, mainScale, true)}
        <div className="pres-hud">
          <span>{counter}</span>
          <span>{mm}:{ss}</span>
          <button onClick={(e) => { e.stopPropagation(); setBlank(blank === "black" ? "none" : "black"); }}>B</button>
          <button onClick={(e) => { e.stopPropagation(); setBlank(blank === "white" ? "none" : "white"); }}>W</button>
          <button onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
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
            <div key={s.id} className={`pv-thumb ${i === idx ? "active" : ""}`} onClick={() => jump(i)}>
              <SlideCanvas slide={s} theme={theme} scale={0.08} selection={new Set()} />
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
          <button className="btn-ghost btn-sm" onClick={() => setBlank(blank === "black" ? "none" : "black")}>Blackout</button>
          <button className="btn-ghost btn-sm" onClick={onClose}>Exit</button>
        </div>
        <span className="pv-counter">{counter}</span>
      </div>
    </div>
  );
}

