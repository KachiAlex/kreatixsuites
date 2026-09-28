import { useState } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { PAGE_SIZES, type PageSize } from "tiptap-pagination-plus";

export interface HfPair {
  left: string;
  right: string;
}

export type PageNumberFormat = "decimal" | "lower-roman" | "upper-roman" | "lower-alpha" | "upper-alpha";

export interface PageSetup {
  sizeName: string;
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  headerLeft: string;
  headerRight: string;
  footerLeft: string;
  footerRight: string;
  /** Page 1 uses firstHeader/firstFooter instead of the defaults. */
  differentFirstPage: boolean;
  /** Even pages use evenHeader/evenFooter; odd pages use the defaults. */
  oddEven: boolean;
  firstHeader: HfPair;
  firstFooter: HfPair;
  evenHeader: HfPair;
  evenFooter: HfPair;
  /** CSS counter style for {page} tokens. */
  pnFormat: PageNumberFormat;
  /** Number assigned to page 1. */
  pnStart: number;
}

export const DEFAULT_SETUP: PageSetup = {
  sizeName: "LETTER",
  ...PAGE_SIZES.LETTER && {
    width: PAGE_SIZES.LETTER.pageWidth, height: PAGE_SIZES.LETTER.pageHeight,
    marginTop: PAGE_SIZES.LETTER.marginTop, marginBottom: PAGE_SIZES.LETTER.marginBottom,
    marginLeft: PAGE_SIZES.LETTER.marginLeft, marginRight: PAGE_SIZES.LETTER.marginRight,
  },
  headerLeft: "", headerRight: "", footerLeft: "", footerRight: "Page {page} of {total}",
  differentFirstPage: false,
  oddEven: false,
  firstHeader: { left: "", right: "" },
  firstFooter: { left: "", right: "" },
  evenHeader: { left: "", right: "" },
  evenFooter: { left: "", right: "" },
  pnFormat: "decimal",
  pnStart: 1,
};

declare module "@tiptap/core" {
  interface Storage {
    KxPageSetup: { setup: PageSetup };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wrap text so it renders centered inside the (float-left) slot. */
const center = (html: string) => `<span class="kx-hf-center">${html}</span>`;

/**
 * Where a page-number spec lands in the header/footer slots.
 * PaginationPlus exposes only left/right slots — center is an
 * absolutely-positioned span in the left slot.
 */
export function numberMarkup(format: "plain" | "page-of" = "plain"): string {
  return format === "page-of" ? `Page {page} of {total}` : `{page}`;
}

export function slotFor(align: "left" | "center" | "right", text: string): HfPair {
  const html = esc(text);
  if (align === "right") return { left: "", right: html };
  if (align === "center") return { left: center(html), right: "" };
  return { left: html, right: "" };
}

/** Detect which align produced an existing pair (best effort). */
export function alignOf(pair: HfPair): "left" | "center" | "right" {
  if (pair.left.includes("kx-hf-center")) return "center";
  if (!pair.left && pair.right) return "right";
  return "left";
}

const STYLE_ID = "kx-page-number-style";

function applyNumberStyle(setup: PageSetup) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const start = Math.max(0, setup.pnStart);
  // page-number resets to start-1 (footers live inside the break that
  // increments them); page-number-plus resets to start (the first-page
  // header sits outside any break, headers offset by one).
  el.textContent = `
.rm-with-pagination, .rm-with-pagination .rm-first-page-header {
  counter-reset: page-number ${start - 1} page-number-plus ${start} !important;
}
.rm-with-pagination .rm-page-number::before {
  content: counter(page-number, ${setup.pnFormat}) !important;
}
.rm-with-pagination .rm-page-number-plus::before {
  content: counter(page-number-plus, ${setup.pnFormat}) !important;
}`;
}

interface HfStorage {
  headerLeft: string; headerRight: string; footerLeft: string; footerRight: string;
  customHeader: Record<number, { headerLeft: string; headerRight: string }>;
  customFooter: Record<number, { footerLeft: string; footerRight: string }>;
}

const expand = (text: string, total: number) => text.replace(/\{total\}/g, String(total));

/** Resolve the effective header/footer pair for a 1-based page number. */
export function pairFor(setup: PageSetup, page: number, region: "header" | "footer"): HfPair {
  const base: HfPair = region === "header"
    ? { left: setup.headerLeft, right: setup.headerRight }
    : { left: setup.footerLeft, right: setup.footerRight };
  if (setup.differentFirstPage && page === 1) {
    return region === "header" ? setup.firstHeader : setup.firstFooter;
  }
  if (setup.oddEven && page % 2 === 0) {
    return region === "header" ? setup.evenHeader : setup.evenFooter;
  }
  return base;
}

const pageCountOf = (view: { dom: HTMLElement }) =>
  view.dom.querySelectorAll(".rm-page-break").length || 1;

/**
 * Resolve the whole header/footer state for the live page count:
 * expands {total}, derives per-page variants, writes storage directly
 * (the paginator's deepEqual check picks it up on the next transaction).
 */
function syncVariants(editor: Editor, setup: PageSetup) {
  const s = editor.storage.PaginationPlus as unknown as HfStorage;
  const count = pageCountOf(editor.view);
  const baseH: HfPair = { left: expand(setup.headerLeft, count), right: expand(setup.headerRight, count) };
  const baseF: HfPair = { left: expand(setup.footerLeft, count), right: expand(setup.footerRight, count) };
  s.headerLeft = baseH.left; s.headerRight = baseH.right;
  s.footerLeft = baseF.left; s.footerRight = baseF.right;

  const same = (a: HfPair, b: HfPair) => a.left === b.left && a.right === b.right;
  const customHeader: Record<number, { headerLeft: string; headerRight: string }> = {};
  const customFooter: Record<number, { footerLeft: string; footerRight: string }> = {};
  for (let p = 1; p <= count; p++) {
    const h = pairFor(setup, p, "header");
    const f = pairFor(setup, p, "footer");
    const he = { left: expand(h.left, count), right: expand(h.right, count) };
    const fe = { left: expand(f.left, count), right: expand(f.right, count) };
    if (!same(he, baseH)) customHeader[p] = { headerLeft: he.left, headerRight: he.right };
    if (!same(fe, baseF)) customFooter[p] = { footerLeft: fe.left, footerRight: fe.right };
  }
  s.customHeader = customHeader;
  s.customFooter = customFooter;
}

/** Read current pagination config — prefers our stored setup (storage holds expanded text). */
export function readPageSetup(editor: Editor): PageSetup {
  const saved = (editor.storage.KxPageSetup as { setup?: PageSetup } | undefined)?.setup;
  const s = editor.storage.PaginationPlus;
  const sizeName = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find(
    (k) => PAGE_SIZES[k].pageWidth === s.pageWidth && PAGE_SIZES[k].pageHeight === s.pageHeight,
  ) ?? "CUSTOM";
  return {
    ...DEFAULT_SETUP,
    ...(saved ?? {}),
    sizeName,
    width: s.pageWidth, height: s.pageHeight,
    marginTop: s.marginTop, marginBottom: s.marginBottom,
    marginLeft: s.marginLeft, marginRight: s.marginRight,
    // only fall back to live storage when no setup was ever applied
    ...(saved ? {} : {
      headerLeft: s.headerLeft ?? "", headerRight: s.headerRight ?? "",
      footerLeft: s.footerLeft ?? "", footerRight: s.footerRight ?? "",
    }),
  };
}

/** Apply a PageSetup to the live editor. */
export function applyPageSetup(editor: Editor, setup: PageSetup) {
  const size: PageSize = {
    pageWidth: setup.width, pageHeight: setup.height,
    marginTop: setup.marginTop, marginBottom: setup.marginBottom,
    marginLeft: setup.marginLeft, marginRight: setup.marginRight,
  };
  editor.chain()
    .updatePageSize(size)
    .updateMargins({ top: setup.marginTop, bottom: setup.marginBottom, left: setup.marginLeft, right: setup.marginRight })
    .run();
  editor.storage.KxPageSetup = { setup };
  applyNumberStyle(setup);
  syncVariants(editor, setup);
  // nudge a rebuild so the paginator picks up customHeader/customFooter
  editor.view.dispatch(editor.state.tr.setMeta("kx-page-setup", true));
}

/**
 * Keeps per-page header/footer variants in sync with the live page count —
 * new pages get the correct odd/even treatment without user action.
 */
export const PageSetupSync = Extension.create({
  name: "KxPageSetup",

  addStorage() {
    return { setup: DEFAULT_SETUP };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("kxPageSetupSync"),
        view() {
          let lastCount = -1;
          let scheduled = false;
          return {
            update(view) {
              if (scheduled) return;
              if (!editor.storage.PaginationPlus) return;
              const count = pageCountOf(view);
              if (count === lastCount) return;
              lastCount = count;
              scheduled = true;
              requestAnimationFrame(() => {
                scheduled = false;
                if (view.isDestroyed) return;
                const setup = (editor.storage.KxPageSetup as { setup?: PageSetup })?.setup;
                if (!setup) return;
                syncVariants(editor, setup);
                view.dispatch(view.state.tr.setMeta("kx-page-setup", true));
              });
            },
            destroy() {},
          };
        },
      }),
    ];
  },
});

/* ------------------------------------------------------------------ */

export function PageNumbersDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const setup = readPageSetup(editor);
  const footerPair: HfPair = { left: setup.footerLeft, right: setup.footerRight };
  const headerPair: HfPair = { left: setup.headerLeft, right: setup.headerRight };
  const hasNumber = (p: HfPair) => (p.left + p.right).includes("{page}");
  const [position, setPosition] = useState<"header" | "footer">(hasNumber(headerPair) && !hasNumber(footerPair) ? "header" : "footer");
  const [align, setAlign] = useState<"left" | "center" | "right">(() =>
    alignOf(hasNumber(headerPair) && !hasNumber(footerPair) ? headerPair : footerPair));
  const [format, setFormat] = useState<PageNumberFormat>(setup.pnFormat);
  const [startAt, setStartAt] = useState(setup.pnStart);
  const [showOnFirst, setShowOnFirst] = useState(() => {
    if (!setup.differentFirstPage) return true;
    const fp = position === "header" ? setup.firstHeader : setup.firstFooter;
    return hasNumber(fp);
  });
  const [remove, setRemove] = useState(false);

  const apply = () => {
    const s = { ...readPageSetup(editor), pnFormat: format, pnStart: Math.max(0, startAt) };
    const target: HfPair = remove ? { left: "", right: "" } : slotFor(align, numberMarkup("page-of"));
    if (position === "header") {
      s.headerLeft = target.left; s.headerRight = target.right;
    } else {
      s.footerLeft = target.left; s.footerRight = target.right;
    }
    if (!showOnFirst || remove) {
      s.differentFirstPage = true;
      if (position === "header") s.firstHeader = remove ? { left: "", right: "" } : s.firstHeader;
      else s.firstFooter = remove ? { left: "", right: "" } : s.firstFooter;
      if (!showOnFirst && !remove) {
        if (position === "header") s.firstHeader = { left: "", right: "" };
        else s.firstFooter = { left: "", right: "" };
      }
    }
    applyPageSetup(editor, s);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ps-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Page numbers">
        <h3>Page numbers</h3>
        <div className="ps-row">
          <label className="ps-field"><span>Position</span>
            <select value={position} onChange={(e) => setPosition(e.target.value as "header" | "footer")}>
              <option value="header">Top of page (header)</option>
              <option value="footer">Bottom of page (footer)</option>
            </select>
          </label>
          <label className="ps-field"><span>Alignment</span>
            <select value={align} onChange={(e) => setAlign(e.target.value as typeof align)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>
        <div className="ps-row">
          <label className="ps-field"><span>Number format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as PageNumberFormat)}>
              <option value="decimal">1, 2, 3…</option>
              <option value="lower-roman">i, ii, iii…</option>
              <option value="upper-roman">I, II, III…</option>
              <option value="lower-alpha">a, b, c…</option>
              <option value="upper-alpha">A, B, C…</option>
            </select>
          </label>
          <label className="ps-field"><span>Start at</span>
            <input type="number" min={0} value={startAt}
              onChange={(e) => setStartAt(Math.max(0, parseInt(e.target.value) || 0))} />
          </label>
        </div>
        <div className="ps-row">
          <label className="ps-check">
            <input type="checkbox" checked={showOnFirst} onChange={(e) => setShowOnFirst(e.target.checked)} />
            <span>Show on first page</span>
          </label>
          <label className="ps-check">
            <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
            <span>Remove page numbers</span>
          </label>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function HfFields({ label, pair, onChange }: { label: string; pair: HfPair; onChange: (p: HfPair) => void }) {
  return (
    <div className="ps-row">
      <label className="ps-field grow"><span>{label} — left</span>
        <input value={pair.left} onChange={(e) => onChange({ ...pair, left: e.target.value })} /></label>
      <label className="ps-field grow"><span>{label} — right</span>
        <input value={pair.right} onChange={(e) => onChange({ ...pair, right: e.target.value })} /></label>
    </div>
  );
}

const stripCenter = (p: HfPair): HfPair => ({
  left: p.left.replace(/<\/?span[^>]*>/g, ""),
  right: p.right.replace(/<\/?span[^>]*>/g, ""),
});

export function PageSetupDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [s, setS] = useState<PageSetup>(() => {
    const raw = readPageSetup(editor);
    return {
      ...raw,
      firstHeader: stripCenter(raw.firstHeader), firstFooter: stripCenter(raw.firstFooter),
      evenHeader: stripCenter(raw.evenHeader), evenFooter: stripCenter(raw.evenFooter),
    };
  });
  const set = <K extends keyof PageSetup>(k: K, v: PageSetup[K]) => setS((p) => ({ ...p, [k]: v }));

  const pickSize = (name: string) => {
    const p = PAGE_SIZES[name as keyof typeof PAGE_SIZES];
    if (!p) return;
    setS((prev) => ({
      ...prev, sizeName: name, width: p.pageWidth, height: p.pageHeight,
      marginTop: p.marginTop, marginBottom: p.marginBottom,
      marginLeft: p.marginLeft, marginRight: p.marginRight,
    }));
  };

  const rotate = () => setS((p) => ({ ...p, sizeName: "CUSTOM", width: p.height, height: p.width }));

  const num = (k: keyof PageSetup, label: string) => (
    <label className="ps-field">
      <span>{label}</span>
      <input type="number" min={0} value={s[k] as number}
        onChange={(e) => set(k, Math.max(0, parseInt(e.target.value) || 0))} />
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ps-card ps-card-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Page setup">
        <h3>Page setup</h3>
        <div className="ps-row">
          <label className="ps-field"><span>Paper size</span>
            <select value={s.sizeName} onChange={(e) => pickSize(e.target.value)}>
              {Object.keys(PAGE_SIZES).map((k) => <option key={k} value={k}>{k}</option>)}
              <option value="CUSTOM">Custom</option>
            </select>
          </label>
          <button className="btn-ghost btn-sm" onClick={rotate} title="Swap width/height">Orientation: portrait ⇄ landscape</button>
        </div>
        <div className="ps-row">
          {num("width", "Width px")}{num("height", "Height px")}
        </div>
        <div className="ps-row">
          {num("marginTop", "Margin top")}{num("marginBottom", "Margin bottom")}
        </div>
        <div className="ps-row">
          {num("marginLeft", "Margin left")}{num("marginRight", "Margin right")}
        </div>
        <h4 className="ps-section">Header &amp; footer <small>({"{page}"} / {"{total}"} tokens)</small></h4>
        <div className="ps-row">
          <label className="ps-field grow"><span>Header left</span>
            <input value={s.headerLeft} onChange={(e) => set("headerLeft", e.target.value)} /></label>
          <label className="ps-field grow"><span>Header right</span>
            <input value={s.headerRight} onChange={(e) => set("headerRight", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Footer left</span>
            <input value={s.footerLeft} onChange={(e) => set("footerLeft", e.target.value)} /></label>
          <label className="ps-field grow"><span>Footer right</span>
            <input value={s.footerRight} onChange={(e) => set("footerRight", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-check">
            <input type="checkbox" checked={s.differentFirstPage}
              onChange={(e) => set("differentFirstPage", e.target.checked)} />
            <span>Different first page</span>
          </label>
          <label className="ps-check">
            <input type="checkbox" checked={s.oddEven}
              onChange={(e) => set("oddEven", e.target.checked)} />
            <span>Different odd &amp; even pages</span>
          </label>
        </div>
        {s.differentFirstPage && (
          <>
            <HfFields label="First page header" pair={s.firstHeader} onChange={(p) => set("firstHeader", p)} />
            <HfFields label="First page footer" pair={s.firstFooter} onChange={(p) => set("firstFooter", p)} />
          </>
        )}
        {s.oddEven && (
          <>
            <HfFields label="Even page header" pair={s.evenHeader} onChange={(p) => set("evenHeader", p)} />
            <HfFields label="Even page footer" pair={s.evenFooter} onChange={(p) => set("evenFooter", p)} />
          </>
        )}
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => { applyPageSetup(editor, s); onClose(); }}>Apply</button>
        </div>
      </div>
    </div>
  );
}
