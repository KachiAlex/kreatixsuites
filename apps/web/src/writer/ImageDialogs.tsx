import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { WRAP_LABELS, effectiveWrap, imagePreset, type ImageWrap } from "./extensions/image";
import { measureBands } from "./banding";

const WRAPS: { v: ImageWrap; hint: string }[] = [
  { v: "inline", hint: "Image sits in the text flow like a character" },
  { v: "square", hint: "Text wraps around the image box" },
  { v: "tight", hint: "Text hugs the image outline" },
  { v: "topBottom", hint: "Text above and below, not beside" },
  { v: "behind", hint: "Image floats behind the text layer" },
  { v: "front", hint: "Image floats above the text layer" },
];

/** Word's "Layout" dialog: Size / Position / Text Wrapping for an image. */
export function ImageLayoutDialog({ editor, pos, onClose }: { editor: Editor; pos: number; onClose: () => void }) {
  const node = editor.state.doc.nodeAt(pos);
  const [tab, setTab] = useState<"size" | "position" | "wrap">("size");
  const [a, setA] = useState<Record<string, unknown>>(() => ({ ...(node?.attrs ?? {}) }));
  if (!node || node.type.name !== "image") return null;

  const upd = (patch: Record<string, unknown>) => setA((p) => ({ ...p, ...patch }));
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.round(Number(v)));
  const apply = () => {
    editor.chain().command(({ tr }) => {
      const n = tr.doc.nodeAt(pos);
      if (n?.type.name === "image") tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...a });
      return true;
    }).focus().run();
    onClose();
  };
  const wrap = effectiveWrap(a as { wrap?: ImageWrap; align?: string });
  const floating = wrap === "behind" || wrap === "front";

  const preset = (h: "left" | "center" | "right", v: "top" | "middle" | "bottom") => {
    const bands = measureBands(editor.view.dom as HTMLElement);
    const p = imagePreset(editor, pos, h, v, bands);
    if (p) upd(p);
  };

  const fld = "w-full rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-sm";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Image layout">
        <h3>Layout</h3>
        <div className="tp-tabs">
          <button className={tab === "size" ? "on" : ""} onClick={() => setTab("size")}>Size</button>
          <button className={tab === "position" ? "on" : ""} onClick={() => setTab("position")}>Position</button>
          <button className={tab === "wrap" ? "on" : ""} onClick={() => setTab("wrap")}>Text Wrapping</button>
        </div>
        <div className="tp-body">
          {tab === "size" && (
            <div className="grid gap-3">
              <div className="flex gap-3">
                <label className="flex-1 text-xs">Width (px)
                  <input className={fld} type="number" value={String(a.width ?? "")} onChange={(e) => upd({ width: num(e.target.value) })} /></label>
                <label className="flex-1 text-xs">Height (px)
                  <input className={fld} type="number" value={String(a.height ?? "")} onChange={(e) => upd({ height: num(e.target.value) })} /></label>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={a.lockAspect !== false} onChange={(e) => upd({ lockAspect: e.target.checked })} />
                Lock aspect ratio</label>
              <label className="text-xs">Rotation (degrees)
                <input className={fld} type="number" step="1" value={String(a.rotate ?? 0)} onChange={(e) => upd({ rotate: Number(e.target.value) || 0 })} /></label>
              <div className="text-xs font-semibold">Crop (% from each edge)</div>
              <div className="flex gap-3">
                {(["cropT", "cropR", "cropB", "cropL"] as const).map((k, i) => (
                  <label key={k} className="flex-1 text-xs">{["Top", "Right", "Bottom", "Left"][i]}
                    <input className={fld} type="number" min="0" max="45" value={String(a[k] ?? 0)}
                      onChange={(e) => upd({ [k]: Math.max(0, Math.min(45, Number(e.target.value) || 0)) })} /></label>
                ))}
              </div>
            </div>
          )}
          {tab === "position" && (
            <div className="grid gap-3">
              {!floating && <div className="text-xs text-[var(--muted,#8B837D)]">Position presets apply to floating images (Behind/In front wrapping). Horizontal alignment is used for other wrap styles.</div>}
              <div className="flex gap-2">
                {(["left", "center", "right", "none"] as const).map((al) => (
                  <button key={al} className={`rb ${a.align === al ? "on" : ""}`} onClick={() => upd({ align: al })}>
                    {al === "none" ? "Inline" : al[0].toUpperCase() + al.slice(1)}</button>
                ))}
              </div>
              {floating && (
                <>
                  <div className="text-xs font-semibold">Position on page</div>
                  <div className="img-pos-grid">
                    {(["top", "middle", "bottom"] as const).map((v) =>
                      (["left", "center", "right"] as const).map((h) => (
                        <button key={v + h} className="rb" onClick={() => preset(h, v)} title={`${v} ${h}`}>
                          {v[0].toUpperCase()}{h[0].toUpperCase()}</button>
                      )))}
                  </div>
                  <div className="flex gap-3">
                    <label className="flex-1 text-xs">Offset X (px)
                      <input className={fld} type="number" value={String(a.posX ?? 0)} onChange={(e) => upd({ posX: Number(e.target.value) || 0 })} /></label>
                    <label className="flex-1 text-xs">Offset Y (px)
                      <input className={fld} type="number" value={String(a.posY ?? 0)} onChange={(e) => upd({ posY: Number(e.target.value) || 0 })} /></label>
                  </div>
                </>
              )}
            </div>
          )}
          {tab === "wrap" && (
            <div className="grid gap-1">
              {WRAPS.map(({ v, hint }) => (
                <label key={v} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[#F6F2EE] cursor-pointer">
                  <input type="radio" name="kx-wrap" className="mt-1" checked={wrap === v}
                    onChange={() => upd({ wrap: v })} />
                  <span><span className="block font-medium">{WRAP_LABELS[v]}</span>
                    <span className="block text-xs text-[var(--muted,#8B837D)]">{hint}</span></span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>OK</button>
        </div>
      </div>
    </div>
  );
}
