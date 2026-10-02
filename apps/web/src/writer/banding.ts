// Page-band geometry for the paginated Writer.
//
// PaginationPlus lays out content as a continuous flow sliced into "bands" by
// full-width floated elements: `.page` spacers (zero-height, marginTop = one
// band) and `.breaker` walls (page gap + header/footer for the next page).
// A band is the vertical region between two breakers where body text lands.
// To force visual page breaks we pad break elements (or paragraphs with
// page-break-before) so their content lands in the next band — the paginator's
// own metric logic then produces the extra page.
//
// Everything here is pure measurement: it reads DOM rects and returns desired
// padding values. The plugin in extensions/forcedBreaks.ts applies them as
// ProseMirror node decorations (which survive node re-renders, unlike inline
// styles).

export interface Bands {
  /** Flow-space y (relative to the editor root) of each band's start. */
  starts: number[];
  /** Flow-space y of each band's end (== next breaker's top). */
  ends: number[];
  /** Wall height following each band (0 for the synthesized open band). */
  wallHs: number[];
  /** Band-to-band pitch (start[i+1] - start[i]); used past the last band. */
  pitch: number;
}

const flowY = (el: Element, root: HTMLElement): number =>
  el.getBoundingClientRect().top - root.getBoundingClientRect().top;

const BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,table,pre,ul,ol,blockquote,hr,div[data-type]";

/** First real content block (skips the pages widget + first-page header). */
const firstBlock = (root: HTMLElement): HTMLElement | null => {
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.classList.contains("rm-pages-wrapper")) continue;
    if (child.classList.contains("rm-page-header")) continue;
    if (child.matches(BLOCK_SEL) || child.childElementCount || child.textContent?.trim()) return child;
  }
  return null;
};

const contentHeightVar = (root: HTMLElement): number => {
  const cs = getComputedStyle(root);
  const v = cs.getPropertyValue("--rm-page-content-general") || cs.getPropertyValue("--rm-page-content-first");
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Measure the current band layout under `root` (a .ProseMirror element).
 * Bands derive from `.breaker` wall positions (the `.rm-page-break` wrappers
 * are height-0 containers). When no breakers exist yet we synthesize a single
 * virtual band from the paginator's content-height CSS var so forced breaks
 * still work in short documents.
 */
export function measureBands(root: HTMLElement): Bands | null {
  const walls = [...root.querySelectorAll<HTMLElement>(".rm-page-break > .breaker")];
  const first = firstBlock(root);
  if (!first) return null;
  const starts: number[] = [flowY(first, root)];
  const ends: number[] = [];
  const wallHs: number[] = [];
  for (const w of walls) {
    const t = flowY(w, root);
    ends.push(t);
    wallHs.push(w.offsetHeight);
    starts.push(t + w.offsetHeight);
  }
  let pitch = 0;
  if (starts.length > 1) pitch = starts[1] - starts[0];
  else if (walls.length) pitch = (ends[0] - starts[0]) + walls[0].offsetHeight;
  if (!walls.length) {
    const h = contentHeightVar(root);
    if (!h) return null;
    ends.push(starts[0] + h);
    wallHs.push(0);
    pitch = h;
    return { starts, ends, wallHs, pitch };
  }
  ends.push(starts[starts.length - 1] + (ends[ends.length - 1] - starts[starts.length - 2]));
  wallHs.push(0);
  return { starts, ends, wallHs, pitch };
}

/** The band index containing flow-offset `y` (0-based). */
export function bandIndexAt(bands: Bands, y: number): number {
  for (let i = 0; i < bands.ends.length; i++) {
    if (y < bands.ends[i]) return i;
  }
  return bands.ends.length - 1;
}

/** Currently applied pad (our decorations render as element padding). */
const applied = (el: HTMLElement, side: "Top" | "Bottom"): number =>
  parseFloat(getComputedStyle(el)[side === "Top" ? "paddingTop" : "paddingBottom"]) || 0;

/**
 * Desired padding-bottom for a forced-break element so its box bottom lands
 * inside the wall region ending its band — mid-wall, not the edge: a boundary
 * landing flips bands under ±1px drift. `extraBelow` shifts the effective
 * bottom (e.g. element margin). Returns null when bands aren't measurable.
 */
export function bandPadBottom(
  el: HTMLElement, root: HTMLElement, extraBelow = 0,
  bandParity?: { skipTo: "odd" | "even" }, bands?: Bands | null,
): number | null {
  bands ??= measureBands(root);
  if (!bands) return null;
  const bottom = flowY(el, root) + el.offsetHeight
    - applied(el, "Top") - applied(el, "Bottom") + extraBelow;
  let i = bandIndexAt(bands, bottom);
  if (bandParity) {
    // landing band (i+1) must have the requested page parity: page n = band n-1,
    // odd page 1/3/5 => even band index 0/2/4
    const want = bandParity.skipTo === "odd" ? 0 : 1;
    while (i + 1 < bands.starts.length && (i + 1) % 2 !== want) i++;
  }
  const target = bands.ends[i] + (bands.wallHs[i] ? bands.wallHs[i] / 2 : 2);
  return Math.max(0, target - bottom);
}

/**
 * Desired padding-top so the element's content starts at the next band's
 * start (page-break-before semantics). Returns null when unmeasurable.
 */
export function bandPadTop(el: HTMLElement, root: HTMLElement, bands?: Bands | null): number | null {
  bands ??= measureBands(root);
  if (!bands) return null;
  const top = flowY(el, root); // border-box top ignores paddingTop
  const i = bandIndexAt(bands, top);
  if (top - bands.starts[i] < 2) return 0; // already at a band start
  const next = bands.starts[i + 1] ?? bands.starts[i] + bands.pitch;
  return Math.max(0, next - top);
}

/**
 * Keep-with-next: desired padding-top moving the element to the sibling's
 * band when the two are split across a wall. Null when unmeasurable.
 */
export function keepNextPadTop(el: HTMLElement, root: HTMLElement, bands?: Bands | null): number | null {
  bands ??= measureBands(root);
  if (!bands) return null;
  const sib = el.nextElementSibling as HTMLElement | null;
  if (!sib || sib.classList.contains("rm-pages-wrapper")) return 0;
  const top = flowY(el, root);
  const i = bandIndexAt(bands, top);
  if (flowY(sib, root) < bands.ends[i]) return 0; // same band already
  const next = bands.starts[i + 1] ?? bands.starts[i] + bands.pitch;
  return Math.max(0, next - top);
}

/**
 * Keep-lines / widow-orphan: desired padding-top that moves the whole block
 * below the wall when it would otherwise split with too little on one side.
 * Null when unmeasurable, 0 when it fits.
 */
export function splitPadTop(el: HTMLElement, root: HTMLElement, keepLines: boolean, bands?: Bands | null): number | null {
  bands ??= measureBands(root);
  if (!bands) return null;
  const top = flowY(el, root);
  const h = el.offsetHeight - applied(el, "Top") - applied(el, "Bottom");
  const i = bandIndexAt(bands, top);
  const wall = bands.ends[i];
  if (top + h <= wall) return 0;
  const lineH = parseFloat(getComputedStyle(el).lineHeight) || 20;
  const linesAbove = (wall - top) / lineH;
  const nextStart = bands.starts[i + 1] ?? wall + (bands.pitch - (wall - bands.starts[i]));
  const linesBelow = (top + h - nextStart) / lineH;
  return (keepLines || linesAbove < 2 || linesBelow < 2)
    ? Math.max(0, nextStart - top)
    : 0;
}

/**
 * Section vertical alignment (Word w:vAlign): desired padding-top on the
 * section's first block so its content sits centered/bottom in the band.
 * `el` is that first block — the caller resolves it from the marker element
 * (a sectionBreak div introduces the section; a vAlign'd block IS the first
 * block for the document's first section).
 *
 * Measured section height = the run of flow siblings until the next forced
 * break / page wall / vAlign boundary. Only applied when the whole section
 * fits on one page — Word's vAlign sees real use on title/cover pages;
 * multi-page sections render top-aligned. "both" (justified) approximates to
 * centered — true inter-paragraph spreading isn't representable.
 */
export function vAlignPadTop(el: HTMLElement, root: HTMLElement, mode: string, bands?: Bands | null): number | null {
  if (mode !== "center" && mode !== "bottom" && mode !== "both") return 0;
  // only meaningful on a top-level flow block — an element nested inside a
  // table/columns cell has no page band to center within
  if (el.parentElement !== root) return null;
  bands ??= measureBands(root);
  if (!bands) return null;
  const top = flowY(el, root);
  const i = bandIndexAt(bands, top);
  const bandH = bands.ends[i] - bands.starts[i];
  let h = 0;
  let sib: HTMLElement | null = el;
  while (sib) {
    if (sib !== el && (sib.hasAttribute("data-force-break") || sib.hasAttribute("data-v-align")
      || sib.classList.contains("rm-page-break") || sib.classList.contains("rm-pages-wrapper")
      || sib.classList.contains("page-break"))) break;
    const cs = getComputedStyle(sib);
    h += sib.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    sib = sib.nextElementSibling as HTMLElement | null;
  }
  if (h <= 0 || h >= bandH * 0.92) return 0; // fills or overflows the page — nothing to center
  const pad = mode === "bottom" ? bandH - h - 2 : Math.round((bandH - h) / 2);
  return Math.max(0, bands.starts[i] + pad - top);
}
