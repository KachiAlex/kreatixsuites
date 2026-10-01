import { useState } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
  /** Doc-level flag: when set, all editors are locked into suggest mode. */
  trackingLocked?: boolean;
  /** Page orientation — applied by normalizing width/height. */
  orientation?: "portrait" | "landscape";
  /** Extra inner (binding) margin in px, added to the left margin. */
  gutter?: number;
  /** Line numbers in the left margin, restarting per page. */
  lineNumbers?: boolean;
  /** CSS hyphenation of body text. */
  hyphenate?: boolean;
  /** Hyphenation zone width in px (Word w:hyphenationZone). */
  hyphenZone?: number;
  /** Max consecutive hyphenated lines (Word w:consecutiveHyphenLimit). */
  hyphenLimit?: number;
  /** Diagonal watermark text; "" disables. */
  watermark?: string;
  /** Page background color; "" = default white. */
  pageColor?: string;
  /** Border frame around each page. */
  pageBorder?: "" | "single" | "double" | "dashed" | "shadow";
  /** Footnote/endnote number formats (decimal/alpha/roman CSS counter names). */
  fnFmt?: string;
  enFmt?: string;
  /** Restart footnote numbering on each page. */
  fnRestart?: boolean;
  /** Restrict-editing mode: "" | "readonly" | "comments" | "tracked". */
  restrict?: string;
  /** SHA-256 hex of the unprotect password ("" = none). */
  restrictKey?: string;
  /** CSV source persisted for mail merge. */
  mergeCsv?: string;
  /** Heading auto-numbering (1 / 1.1 / 1.1.1) via CSS counters. */
  headNums?: boolean;
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

/** A sectionBreak node resolved to the 1-based page its following section starts on. */
interface SectionBoundary {
  startPage: number;
  attrs: Record<string, unknown>;
}

/**
 * Map section-break elements to page numbers. Walls and break elements
 * interleave in float-flow, so count the walls whose rect sits above each
 * break — the break ends its section on that page; the new section's first
 * page is two bands later (band after the wall the break pads into).
 */
function sectionBoundaries(view: Editor["view"]): SectionBoundary[] {
  const dom = view.dom;
  const wallTops = [...dom.querySelectorAll("#pages > .rm-page-break")]
    .map((w) => w.querySelector(".breaker")?.getBoundingClientRect().top
      ?? w.getBoundingClientRect().top)
    .sort((a, b) => a - b);
  const out: SectionBoundary[] = [];
  for (const el of dom.querySelectorAll<HTMLElement>(".page-break.section-break")) {
    let attrs: Record<string, unknown> = {};
    try {
      const pos = view.posAtDOM(el, 0);
      const node = view.state.doc.nodeAt(pos);
      if (node?.type.name === "sectionBreak") attrs = node.attrs;
    } catch {
      /* fall back to data-* attrs */
      attrs = {
        headerLeft: el.getAttribute("data-header-left"),
        headerRight: el.getAttribute("data-header-right"),
        footerLeft: el.getAttribute("data-footer-left"),
        footerRight: el.getAttribute("data-footer-right"),
        pnStart: el.getAttribute("data-pn-start"),
      };
    }
    const top = el.getBoundingClientRect().top;
    const before = wallTops.filter((t) => t < top + 1).length;
    out.push({ startPage: before + 2, attrs });
  }
  return out.sort((a, b) => a.startPage - b.startPage);
}

/** The section boundary governing page p (last boundary at or before it). */
const sectionForPage = (bounds: SectionBoundary[], p: number) => {
  let cur: SectionBoundary | null = null;
  for (const b of bounds) if (b.startPage <= p) cur = b;
  return cur;
};

/* ------------------ per-section page geometry ------------------ */

export interface SectGeo {
  pageWidth?: number; pageHeight?: number;
  marginTop?: number; marginBottom?: number;
  marginLeft?: number; marginRight?: number;
}

const GEO_KEYS = ["pageWidth", "pageHeight", "marginTop", "marginBottom", "marginLeft", "marginRight"] as const;

/** Geometry overrides a boundary introduces; null when it inherits the doc setup. */
function sectGeoOf(attrs: Record<string, unknown>): SectGeo | null {
  const g: SectGeo = {};
  let any = false;
  for (const k of GEO_KEYS) {
    const v = attrs[k];
    if (typeof v === "number" && v > 0) { g[k] = v; any = true; }
  }
  return any ? g : null;
}

/** Global geometry the paginator currently uses (section base = doc setup). */
function globalGeo(editor: Editor): Required<SectGeo> {
  const s = editor.storage.PaginationPlus as unknown as Record<string, number> | undefined;
  return {
    pageWidth: s?.pageWidth ?? 816, pageHeight: s?.pageHeight ?? 1056,
    marginTop: s?.marginTop ?? 76, marginBottom: s?.marginBottom ?? 76,
    marginLeft: s?.marginLeft ?? 84, marginRight: s?.marginRight ?? 84,
  };
}

/**
 * Margins that shift a block into a section's content band: paper centered
 * on the paper column, content inset by the section's own margins.
 */
function blockMargins(geo: SectGeo, g: Required<SectGeo>): { ml: number; mr: number } {
  const sectW = geo.pageWidth ?? g.pageWidth;
  const dx = (g.pageWidth - sectW) / 2;
  return {
    ml: dx + (geo.marginLeft ?? g.marginLeft) - g.marginLeft,
    mr: dx + (geo.marginRight ?? g.marginRight) - g.marginRight,
  };
}

/**
 * Per-section geometry for the live paginator:
 *  - a DecorationSet that shifts every top-level block in a section to that
 *    section's content band (page width / horizontal margins);
 *  - a layout-driven page→geometry map pushed into storage.pageGeometry,
 *    which our PaginationPlus patch turns into per-page wall geometry
 *    (page size, paper paint, header/footer margin vars).
 * Page count/band heights are recomputed by the patched paginator; this
 * plugin only feeds it the map and re-feeds it when breaks move bands.
 */
export const SectionGeometry = Extension.create({
  name: "kxSectionGeometry",

  addProseMirrorPlugins() {
    const editor = this.editor;
    const buildDecos = (doc: import("@tiptap/pm/model").Node) => {
      const g = globalGeo(editor);
      const decos: Decoration[] = [];
      let cur: SectGeo | null = null;
      doc.forEach((node, offset) => {
        if (node.type.name === "sectionBreak") { cur = sectGeoOf(node.attrs); return; }
        if (!cur) return;
        const { ml, mr } = blockMargins(cur, g);
        if (Math.abs(ml) > 0.5 || Math.abs(mr) > 0.5) {
          decos.push(Decoration.node(offset, offset + node.nodeSize, {
            class: "kx-sect-block",
            style: `margin-left:${ml.toFixed(1)}px;margin-right:${mr.toFixed(1)}px`,
          }));
        }
      });
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin({
        key: new PluginKey("kxSectionGeometry"),
        state: {
          init: (_, s) => buildDecos(s.doc),
          apply: (tr, set, _os, ns) => {
            const next = tr.docChanged ? buildDecos(ns.doc) : set.map(tr.mapping, tr.doc);
            return next;
          },
        },
        props: {
          decorations(state) { return this.getState(state); },
        },
        view() {
          let lastSig = "";
          let scheduled = false;
          return {
            update(view) {
              if (scheduled || !editor.storage.PaginationPlus) return;
              scheduled = true;
              requestAnimationFrame(() => {
                scheduled = false;
                if (view.isDestroyed || !editor.storage.PaginationPlus) return;
                try {
                const bounds = sectionBoundaries(view);
                // map keyed by section start page — the paginator falls back to
                // the nearest earlier entry, so ranges don't need filling
                const geo: Record<number, SectGeo> = {};
                for (const b of bounds) {
                  const g = sectGeoOf(b.attrs);
                  if (g) geo[b.startPage] = g;
                }
                // themed pages (color/border/watermark/line numbers) need a real
                // per-page paper element — seed the map with the doc geometry at
                // page 1 so the paginator enters per-page-paper mode
                const setup = (editor.storage.KxPageSetup as { setup?: PageSetup } | undefined)?.setup;
                if (setup && isPageThemed(setup)) geo[1] = { ...globalGeo(editor), ...geo[1] };
                const sig = JSON.stringify([bounds.map((b) => b.startPage), geo, isPageThemed(setup)]);
                if (sig === lastSig) return;
                lastSig = sig;
                const store = editor.storage.PaginationPlus as { pageGeometry?: Record<number, SectGeo> };
                const hasGeo = Object.keys(geo).length > 0;
                store.pageGeometry = hasGeo ? geo : undefined;
                view.dom.toggleAttribute("data-kx-sections", hasGeo);
                view.dispatch(view.state.tr.setMeta("kx-page-setup", true));
                } catch (e) { console.error("kxSectionGeometry", e); }
              });
            },
            destroy() {},
          };
        },
      }),
    ];
  },
});

const SECTION_STYLE_ID = "kx-section-style";

/** Page-number restarts: counter-reset on the wall that prints page P's footer. */
function syncSectionResets(bounds: SectionBoundary[]) {
  let el = document.getElementById(SECTION_STYLE_ID) as HTMLStyleElement | null;
  const rules = bounds
    .filter((b) => typeof b.attrs.pnStart === "number" && (b.attrs.pnStart as number) >= 0)
    .map((b) => `#pages > .rm-page-break:nth-child(${b.startPage}) { counter-reset: page-number ${(b.attrs.pnStart as number) - 1} !important; }`)
    .join("\n");
  if (!rules) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = SECTION_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== rules) el.textContent = rules;
}

/**
 * Resolve the whole header/footer state for the live page count:
 * expands {total}, derives per-page variants, writes storage directly
 * (the paginator's deepEqual check picks it up on the next transaction).
 */
function syncVariants(editor: Editor, setup: PageSetup) {
  const s = editor.storage.PaginationPlus as unknown as HfStorage;
  const count = pageCountOf(editor.view);
  const bounds = sectionBoundaries(editor.view);
  syncSectionResets(bounds);
  const baseH: HfPair = { left: expand(setup.headerLeft, count), right: expand(setup.headerRight, count) };
  const baseF: HfPair = { left: expand(setup.footerLeft, count), right: expand(setup.footerRight, count) };
  s.headerLeft = baseH.left; s.headerRight = baseH.right;
  s.footerLeft = baseF.left; s.footerRight = baseF.right;

  const same = (a: HfPair, b: HfPair) => a.left === b.left && a.right === b.right;
  const customHeader: Record<number, { headerLeft: string; headerRight: string }> = {};
  const customFooter: Record<number, { footerLeft: string; footerRight: string }> = {};
  for (let p = 1; p <= count; p++) {
    let h = pairFor(setup, p, "header");
    let f = pairFor(setup, p, "footer");
    const b = sectionForPage(bounds, p);
    // non-null section header/footer attrs replace the global resolution
    if (b && (b.attrs.headerLeft != null || b.attrs.headerRight != null))
      h = { left: String(b.attrs.headerLeft ?? ""), right: String(b.attrs.headerRight ?? "") };
    if (b && (b.attrs.footerLeft != null || b.attrs.footerRight != null))
      f = { left: String(b.attrs.footerLeft ?? ""), right: String(b.attrs.footerRight ?? "") };
    const he = { left: expand(h.left, count), right: expand(h.right, count) };
    const fe = { left: expand(f.left, count), right: expand(f.right, count) };
    if (!same(he, baseH)) customHeader[p] = { headerLeft: he.left, headerRight: he.right };
    if (!same(fe, baseF)) customFooter[p] = { footerLeft: fe.left, footerRight: fe.right };
  }
  s.customHeader = customHeader;
  s.customFooter = customFooter;
}

/** True when any page-look option needs the per-page paper DOM (geo mode). */
export function isPageThemed(s: PageSetup | undefined): boolean {
  if (!s) return false;
  return !!(s.watermark || s.pageBorder || s.lineNumbers ||
    (s.pageColor && s.pageColor !== "#fff" && s.pageColor !== "#ffffff"));
}

/** Read current pagination config — prefers our stored setup (storage holds expanded text). */
export function readPageSetup(editor: Editor): PageSetup {
  const saved = (editor.storage.KxPageSetup as { setup?: PageSetup } | undefined)?.setup;
  // storage is absent while the editor is pre-mount/re-creating — never throw here
  const s = (editor.storage.PaginationPlus ?? {}) as unknown as Record<string, number | string | undefined>;
  const gutter = saved?.gutter ?? 0;
  const pw = typeof s.pageWidth === "number" ? s.pageWidth : 816;
  const ph = typeof s.pageHeight === "number" ? s.pageHeight : 1056;
  const sizeName = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find(
    (k) => PAGE_SIZES[k].pageWidth === pw && PAGE_SIZES[k].pageHeight === ph,
  ) ?? "CUSTOM";
  return {
    ...DEFAULT_SETUP,
    ...(saved ?? {}),
    sizeName,
    width: pw, height: ph,
    marginTop: (s.marginTop as number) ?? 76, marginBottom: (s.marginBottom as number) ?? 76,
    marginLeft: ((s.marginLeft as number) ?? 84) - gutter, marginRight: (s.marginRight as number) ?? 84,
    // only fall back to live storage when no setup was ever applied
    ...(saved ? {} : {
      headerLeft: (s.headerLeft as string) ?? "", headerRight: (s.headerRight as string) ?? "",
      footerLeft: (s.footerLeft as string) ?? "", footerRight: (s.footerRight as string) ?? "",
    }),
  };
}

/** Apply a PageSetup to the live editor. */
export function applyPageSetup(editor: Editor, setup: PageSetup) {
  // pre-mount editors have no view — callers defer to "create", this is a backstop
  if (!editor.isInitialized) return;
  // orientation normalizes the paper — landscape means width > height
  let { width, height } = setup;
  if (setup.orientation === "landscape" && width < height) [width, height] = [height, width];
  if (setup.orientation === "portrait" && width > height) [width, height] = [height, width];
  const marginLeft = setup.marginLeft + (setup.gutter ?? 0);
  const size: PageSize = {
    pageWidth: width, pageHeight: height,
    marginTop: setup.marginTop, marginBottom: setup.marginBottom,
    marginLeft, marginRight: setup.marginRight,
  };
  const normalized: PageSetup = { ...setup, width, height };
  editor.chain()
    .updatePageSize(size)
    .updateMargins({ top: setup.marginTop, bottom: setup.marginBottom, left: marginLeft, right: setup.marginRight })
    .run();
  editor.storage.KxPageSetup = { setup: normalized };
  // page-look vars must live on .doc-page (parent of the paginator DOM) so
  // .rm-with-pagination and .kx-page-paper can inherit them; data attrs and
  // behavior classes stay on the ProseMirror root for descendant selectors.
  const dom = editor.view.dom;
  const host = (dom.closest(".doc-page") as HTMLElement | null) ?? dom;
  for (const el of [host, dom]) {
    el.style.setProperty("--kx-pg-bg", normalized.pageColor || "#fff");
    el.style.setProperty("--kx-wm", JSON.stringify(normalized.watermark ?? ""));
  }
  if (normalized.pageBorder) dom.setAttribute("data-pg-border", normalized.pageBorder);
  else dom.removeAttribute("data-pg-border");
  dom.classList.toggle("kx-linenums", !!normalized.lineNumbers);
  dom.classList.toggle("kx-hyphens", !!normalized.hyphenate);
  dom.style.setProperty("--kx-hyphen-zone", normalized.hyphenZone ? `${normalized.hyphenZone}px` : "10%");
  dom.style.setProperty("--kx-hyphen-limit", normalized.hyphenLimit ? String(normalized.hyphenLimit) : "no-limit");
  dom.classList.toggle("kx-headnum", !!normalized.headNums);
  dom.setAttribute("data-fnfmt", normalized.fnFmt ?? "decimal");
  dom.setAttribute("data-enfmt", normalized.enFmt ?? "lower-roman");
  dom.setAttribute("data-fnrestart", normalized.fnRestart ? "1" : "0");
  dom.setAttribute("lang", "en");
  applyNumberStyle(normalized);
  syncVariants(editor, normalized);
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
          let lastSig = "";
          let scheduled = false;
          return {
            update(view) {
              if (scheduled || !editor.storage.PaginationPlus) return;
              // re-resolve when page count OR break positions change —
              // section breaks shift bands while forced pads settle
              const sig = pageCountOf(view) + "|" +
                [...view.dom.querySelectorAll(".page-break.section-break")]
                  .map((el) => Math.round(el.getBoundingClientRect().top))
                  .join(",");
              if (sig === lastSig) return;
              lastSig = sig;
              scheduled = true;
              requestAnimationFrame(() => {
                scheduled = false;
                if (view.isDestroyed) return;
                const setup = (editor.storage.KxPageSetup as { setup?: PageSetup })?.setup;
                if (!setup) return;
                const s = editor.storage.PaginationPlus as unknown as HfStorage;
                const before = JSON.stringify([s.customHeader, s.customFooter]);
                syncVariants(editor, setup);
                // only nudge a paginator rebuild if the records changed
                if (JSON.stringify([s.customHeader, s.customFooter]) !== before) {
                  view.dispatch(view.state.tr.setMeta("kx-page-setup", true));
                }
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

  const setOrientation = (o: "portrait" | "landscape") =>
    setS((p) => {
      let { width, height } = p;
      if (o === "landscape" && width < height) [width, height] = [height, width];
      if (o === "portrait" && width > height) [width, height] = [height, width];
      return { ...p, orientation: o, sizeName: "CUSTOM", width, height };
    });

  const num = (k: keyof PageSetup, label: string) => (
    <label className="ps-field">
      <span>{label}</span>
      <input type="number" min={0} value={(s[k] as number) ?? 0}
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
          <div className="ps-field">
            <span>Orientation</span>
            <div className="ps-toggle">
              <button type="button" className={`btn-ghost btn-sm ${(s.orientation ?? "portrait") === "portrait" ? "on" : ""}`}
                onClick={() => setOrientation("portrait")}>Portrait</button>
              <button type="button" className={`btn-ghost btn-sm ${s.orientation === "landscape" ? "on" : ""}`}
                onClick={() => setOrientation("landscape")}>Landscape</button>
            </div>
          </div>
        </div>
        <div className="ps-row">
          {num("width", "Width px")}{num("height", "Height px")}{num("gutter", "Gutter")}
        </div>
        <div className="ps-row">
          {num("marginTop", "Margin top")}{num("marginBottom", "Margin bottom")}
        </div>
        <div className="ps-row">
          {num("marginLeft", "Margin left")}{num("marginRight", "Margin right")}
        </div>
        <h4 className="ps-section">Page look</h4>
        <div className="ps-row">
          <label className="ps-field grow"><span>Watermark text</span>
            <input value={s.watermark ?? ""} placeholder="e.g. DRAFT, CONFIDENTIAL"
              onChange={(e) => set("watermark", e.target.value)} /></label>
          <label className="ps-field"><span>Page color</span>
            <input type="color" value={s.pageColor || "#ffffff"}
              onChange={(e) => set("pageColor", e.target.value)} /></label>
          <label className="ps-field"><span>Page border</span>
            <select value={s.pageBorder ?? ""} onChange={(e) => set("pageBorder", e.target.value as PageSetup["pageBorder"])}>
              <option value="">None</option>
              <option value="single">Single</option>
              <option value="double">Double</option>
              <option value="dashed">Dashed</option>
              <option value="shadow">Shadow</option>
            </select></label>
        </div>
        <div className="ps-row">
          <label className="ps-check">
            <input type="checkbox" checked={!!s.lineNumbers} onChange={(e) => set("lineNumbers", e.target.checked)} />
            <span>Line numbers</span>
          </label>
          <label className="ps-check">
            <input type="checkbox" checked={!!s.hyphenate} onChange={(e) => set("hyphenate", e.target.checked)} />
            <span>Automatic hyphenation</span>
          </label>
          {(s.watermark || s.pageBorder || s.pageColor) && (
            <button type="button" className="btn-ghost btn-sm"
              onClick={() => setS((p) => ({ ...p, watermark: "", pageBorder: "", pageColor: "" }))}>Clear look</button>
          )}
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
