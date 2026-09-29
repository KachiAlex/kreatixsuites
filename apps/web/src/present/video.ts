// P6.3 — timed deck export to a .webm video.
// Renders each slide with SlideCanvas in an offscreen React root, rasterizes via
// SVG foreignObject (all our images are data: URLs so nothing taints the canvas),
// then streams timed frames — with a short crossfade between slides — through
// MediaRecorder. Note: <video>/<audio> objects render as blank in foreignObject
// rasterization; animation states export in their final (revealed) form.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import type { Deck, Slide } from "./model";
import { deckSize, themeOf, masterObjects, layoutObjects } from "./model";
import { SlideCanvas } from "./SlideCanvas";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** collect all same-origin stylesheet rules (present objects live in styles.css) */
function collectCss(): string {
  let out = "";
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) out += rule.cssText + "\n";
    } catch { /* cross-origin sheet — skip */ }
  }
  return out;
}

async function htmlToImage(html: string, css: string, w: number, h: number): Promise<HTMLImageElement> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${html}</div>` +
    `</foreignObject></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("raster failed")); img.src = url; });
  return img;
}

/** wait until every <img> in the host has decoded */
async function settleImages(host: HTMLElement) {
  await Promise.all([...host.querySelectorAll("img")].map((i) =>
    i.complete ? Promise.resolve() : new Promise((r) => { i.onload = i.onerror = r; })));
}

/** Export the deck's visible slides as a timed .webm video (default 3s/slide + 400ms fade). */
export async function exportVideo(deck: Deck, title: string, onProgress?: (msg: string) => void): Promise<void> {
  const dims = deckSize(deck);
  const theme = themeOf(deck);
  const slides = deck.slides.filter((s) => !s.hidden);
  if (!slides.length) throw new Error("No visible slides to export");
  onProgress?.("Rendering slides…");

  // 1. rasterize each slide
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-40000px;top:0;width:${dims.w}px;height:${dims.h}px;pointer-events:none`;
  document.body.appendChild(host);
  const root = createRoot(host);
  const css = collectCss();
  const frames: HTMLImageElement[] = [];
  try {
    for (const s of slides) {
      flushSync(() => root.render(createElement(SlideCanvas, {
        slide: s, theme, scale: 1, selection: new Set<string>(), size: dims,
        animStep: 9999, under: [...masterObjects(deck), ...layoutObjects(deck, s)],
      })));
      await settleImages(host);
      await new Promise((r) => requestAnimationFrame(r));
      frames.push(await htmlToImage(host.innerHTML, css, dims.w, dims.h));
      onProgress?.(`Rendered slide ${frames.length} of ${slides.length}…`);
    }
  } finally {
    flushSync(() => root.render(null));
    root.unmount();
    host.remove();
  }

  // 2. record timed frames
  onProgress?.("Recording video…");
  const canvas = document.createElement("canvas");
  canvas.width = dims.w; canvas.height = dims.h;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(250);

  const FADE = 400, FPS = 30;
  const hold = (s: Slide) => Math.max(600, s.advanceAfter ?? 3000);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (i === 0) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, dims.w, dims.h);
      ctx.drawImage(f, 0, 0, dims.w, dims.h);
      await sleep(hold(slides[i]) - FADE / 2);
    } else {
      // crossfade prev → next
      const prev = frames[i - 1];
      const steps = Math.max(2, Math.round(FADE / 1000 * FPS));
      for (let k = 1; k <= steps; k++) {
        ctx.globalAlpha = 1;
        ctx.drawImage(prev, 0, 0, dims.w, dims.h);
        ctx.globalAlpha = k / steps;
        ctx.drawImage(f, 0, 0, dims.w, dims.h);
        ctx.globalAlpha = 1;
        await sleep(1000 / FPS);
      }
      await sleep(hold(slides[i]) - (i === frames.length - 1 ? 0 : FADE / 2));
    }
  }
  rec.stop();
  await done;

  const blob = new Blob(chunks, { type: "video/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/\.[^.]+$/, "")}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}
