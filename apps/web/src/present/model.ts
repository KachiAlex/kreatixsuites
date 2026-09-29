// Kreatix Present — deck data model (stored as file content JSON)

export interface SlideObject {
  id: string;
  type: "text" | "shape" | "image" | "table" | "chart" | "line" | "connector" | "media";
  x: number; y: number; w: number; h: number;
  rotate?: number;
  z: number;
  groupId?: string;
  name?: string;    // P7 — selection-pane display name
  hidden?: boolean; // P7 — selection-pane eye toggle (hidden in editor + presenter)

  // text
  html?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  fontFamily?: string;

  // shape — P1.3 expanded catalog (~40 presets; see SHAPE_MENU in SlideCanvas)
  shape?: string;
  fill?: string;
  stroke?: string;
  strokeW?: number;

  // media — P6.4: audio/video embed (data URL)
  mediaSrc?: string;
  mediaKind?: "audio" | "video";

  // image — P1.6: crop fractions (0-1 per edge), flips, css filter
  src?: string;
  alt?: string;
  imgCrop?: { l: number; t: number; r: number; b: number };
  imgFlipH?: boolean;
  imgFlipV?: boolean;
  imgOpacity?: number;           // 0-1
  imgFilter?: "none" | "grayscale" | "sepia" | "invert" | "blur";

  // table — P1.5: merges/styles ride in tableMeta so legacy string[][] keeps working
  table?: string[][];
  tableMeta?: {
    merges?: { r: number; c: number; rs: number; cs: number }[];
    cellStyle?: Record<string, { bg?: string; align?: "left" | "center" | "right" }>;
    headerRow?: boolean;
    banded?: boolean;
  };

  // chart — multi-series; `values` kept as the legacy single-series shortcut
  chart?: {
    type: "bar" | "line" | "pie";
    labels: string[];
    values?: number[];
    series?: { name: string; values: number[] }[];
    title?: string;
  };

  // line
  x2?: number; y2?: number;

  // connector (P1.4) — absolute endpoints; when `from`/`to` are set the
  // endpoint is derived live from the target object's anchor
  conn?: {
    kind: "straight" | "elbow" | "curve";
    x1: number; y1: number; x2: number; y2: number;
    from?: { id: string; side: "t" | "r" | "b" | "l" };
    to?: { id: string; side: "t" | "r" | "b" | "l" };
  };

  // hyperlink — P1.7: object-level URL (run-level links live inside `html`)
  link?: string;

  // animation (KBS-PRESENT-005 + P3): entrances, exits, emphasis, motion paths
  anim?: {
    type: AnimType;
    order: number;                       // sequence position
    trigger?: "click" | "with" | "after"; // P3.3 — click consumes a step; with/after chain
    duration?: number;                   // ms
    delay?: number;                      // ms (with/after compute from chain)
    motion?: { dx: number; dy: number }; // P3.2 — motion-path destination offset
  };
}

export type AnimType =
  | "fade" | "slide-up" | "slide-left" | "zoom" | "wipe" | "float" | "spin-in"          // entrances
  | "fade-out" | "slide-out" | "zoom-out" | "wipe-out"                                   // exits
  | "pulse" | "grow" | "shake" | "color"                                                 // emphasis
  | "path";                                                                              // motion path

export const animKind = (t?: AnimType | string): "enter" | "exit" | "emphasis" | "path" | null =>
  !t ? null : t === "path" ? "path" : t.endsWith("-out") ? "exit"
    : t === "pulse" || t === "grow" || t === "shake" || t === "color" ? "emphasis" : "enter";

/** P3.3 — the click-step + fire delay for each animated object.
 *  click anims consume a step; with/after join the running group (after = sequential). */
export function animSteps(objects: SlideObject[]): Map<string, { step: number; delay: number }> {
  const m = new Map<string, { step: number; delay: number }>();
  const sorted = objects.filter((o) => o.anim).sort((a, b) => a.anim!.order - b.anim!.order);
  let step = 0, chain = 0;
  for (const o of sorted) {
    const a = o.anim!;
    const trig = a.trigger ?? "click";
    if (trig === "click" || step === 0) { step++; chain = 0; }
    m.set(o.id, { step, delay: trig === "after" ? chain : a.delay ?? 0 });
    chain += a.duration ?? 450;
  }
  return m;
}

export const maxAnimStep = (objects: SlideObject[]): number =>
  [...animSteps(objects).values()].reduce((mx, v) => Math.max(mx, v.step), 0);

export type TransitionType =
  | "none" | "fade" | "slide" | "zoom" | "push" | "wipe" | "split" | "blinds"
  | "dissolve" | "morph" | "flip" | "cover";
export type TransitionDir = "l" | "r" | "t" | "b" | "h" | "v";
export const TRANSITION_DIRS: Partial<Record<TransitionType, TransitionDir[]>> = {
  slide: ["l", "r", "t", "b"], push: ["l", "r", "t", "b"], cover: ["l", "r", "t", "b"],
  wipe: ["l", "r", "t", "b"], split: ["h", "v"], blinds: ["h", "v"],
};

export interface Slide {
  id: string;
  objects: SlideObject[];
  notes?: string;
  bg?: string;
  layout?: string;
  transition?: { type: TransitionType; duration?: number; dir?: TransitionDir };
  hidden?: boolean;        // P2.3 — skipped during presentation
  sectionStart?: string;   // P2.2 — this slide heads a named section
  bgImage?: string;        // P2.5 — picture background (data URL), layered over `bg`
  advanceAfter?: number;   // P5.2 — auto-advance after N ms (from rehearse or manual)
}

export interface Deck {
  theme?: string;
  customTheme?: Theme; // set when a file brings its own palette (e.g. PPTX import)
  slides: Slide[];
  // P2.1 — slide master: objects rendered beneath EVERY slide (logo, footer…)
  master?: SlideObject[];
  // P2.1 — live-linked custom layouts: slides whose `layout` names a key here
  // render these objects beneath their own (edit once → all slides update)
  layouts?: Record<string, SlideObject[]>;
  // P2.4 — slide canvas size (default 960×540 = 16:9)
  slideW?: number;
  slideH?: number;
  // P2.6 — per-deck saved theme variants (apply via deck.customTheme)
  themeVariants?: Theme[];
  // P5.2 — kiosk mode: loop back to the first slide at the end
  showLoop?: boolean;
  // P5.3 — named subsets of the deck (slide indices)
  shows?: { name: string; slides: number[] }[];
  // P5.4 — persistent guide lines (slide coords)
  guides?: { v?: number[]; h?: number[] };
  showGrid?: boolean;
  showRuler?: boolean;
}

export const deckSize = (deck: Deck): { w: number; h: number } =>
  ({ w: deck.slideW ?? SLIDE_W, h: deck.slideH ?? SLIDE_H });

export const masterObjects = (deck: Deck): SlideObject[] => deck.master ?? [];
export const layoutObjects = (deck: Deck, slide: Slide): SlideObject[] =>
  slide.layout ? deck.layouts?.[slide.layout] ?? [] : [];

export const chartSeries = (c: NonNullable<SlideObject["chart"]>): { name: string; values: number[] }[] =>
  c.series ?? [{ name: "Series 1", values: c.values ?? [] }];

export const SLIDE_W = 960;
export const SLIDE_H = 540;

export interface Theme {
  id: string; name: string; bg: string; ink: string; accent: string; soft: string; font: string;
}

export const THEMES: Theme[] = [
  { id: "kreatix", name: "Kreatix", bg: "#FFFFFF", ink: "#171717", accent: "#F2782E", soft: "#FFF1E8", font: "Inter" },
  { id: "midnight", name: "Midnight", bg: "#15171C", ink: "#F2F0EE", accent: "#F2782E", soft: "#23262E", font: "Inter" },
  { id: "forest", name: "Forest", bg: "#F4F7F4", ink: "#1C2B22", accent: "#1F9D66", soft: "#DFF0E7", font: "Georgia" },
  { id: "ocean", name: "Ocean", bg: "#F5F8FC", ink: "#16233A", accent: "#3578E5", soft: "#DFEAFB", font: "Inter" },
  { id: "noir", name: "Noir", bg: "#1A1A1A", ink: "#ECE8E3", accent: "#E9B44C", soft: "#2A2A2A", font: "Georgia" },
];

export const themeOf = (deck: Deck): Theme =>
  deck.customTheme ?? THEMES.find((t) => t.id === deck.theme) ?? THEMES[0];

export interface LayoutSpec {
  id: string; name: string;
  build: (t: Theme) => Omit<SlideObject, "id" | "z">[];
}

export const LAYOUTS: LayoutSpec[] = [
  {
    id: "blank", name: "Blank", build: () => [],
  },
  {
    id: "title", name: "Title slide", build: (t) => [
      { type: "text", x: 80, y: 180, w: 800, h: 90, html: "Title", fontSize: 54, bold: true, color: t.ink, align: "center", shape: undefined },
      { type: "text", x: 160, y: 290, w: 640, h: 44, html: "Subtitle", fontSize: 22, color: t.accent, align: "center" },
    ],
  },
  {
    id: "title-content", name: "Title + content", build: (t) => [
      { type: "text", x: 48, y: 32, w: 864, h: 64, html: "Slide title", fontSize: 34, bold: true, color: t.ink },
      { type: "text", x: 48, y: 116, w: 864, h: 380, html: "• Point one\n• Point two\n• Point three", fontSize: 22, color: t.ink },
      { type: "shape", shape: "rect", x: 48, y: 100, w: 120, h: 4, fill: t.accent, stroke: "none" },
    ],
  },
  {
    id: "two-col", name: "Two columns", build: (t) => [
      { type: "text", x: 48, y: 32, w: 864, h: 64, html: "Slide title", fontSize: 34, bold: true, color: t.ink },
      { type: "text", x: 48, y: 120, w: 408, h: 380, html: "Left column", fontSize: 20, color: t.ink },
      { type: "text", x: 504, y: 120, w: 408, h: 380, html: "Right column", fontSize: 20, color: t.ink },
    ],
  },
  {
    id: "section", name: "Section header", build: (t) => [
      { type: "shape", shape: "rect", x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: t.accent, stroke: "none" },
      { type: "text", x: 80, y: 220, w: 800, h: 90, html: "Section", fontSize: 48, bold: true, color: "#FFFFFF", align: "left" },
    ],
  },
  {
    id: "image-caption", name: "Image + caption", build: (t) => [
      { type: "text", x: 48, y: 32, w: 864, h: 64, html: "Slide title", fontSize: 34, bold: true, color: t.ink },
      { type: "shape", shape: "rect", x: 120, y: 116, w: 720, h: 340, fill: t.soft, stroke: "#E4DFD9" },
      { type: "text", x: 120, y: 468, w: 720, h: 36, html: "Caption", fontSize: 16, color: t.ink, align: "center" },
    ],
  },
];

export const newId = () => crypto.randomUUID().slice(0, 8);

export function applyLayout(slide: Slide, layoutId: string, theme: Theme): Slide {
  const spec = LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[0];
  const objects: SlideObject[] = spec.build(theme).map((o, i) => ({ ...o, id: newId(), z: i } as SlideObject));
  return { ...slide, objects, layout: layoutId };
}

export function blankSlide(theme: Theme): Slide {
  return { id: newId(), objects: [], layout: "blank", bg: theme.bg };
}

// ---------- P1.4 connectors ----------

export type ConnSide = "t" | "r" | "b" | "l";

export function anchorPoint(o: SlideObject, side: ConnSide): { x: number; y: number } {
  switch (side) {
    case "t": return { x: o.x + o.w / 2, y: o.y };
    case "b": return { x: o.x + o.w / 2, y: o.y + o.h };
    case "l": return { x: o.x, y: o.y + o.h / 2 };
    case "r": return { x: o.x + o.w, y: o.y + o.h / 2 };
  }
}

/** Live endpoint resolution — attached ends track their target object. */
export function resolveConn(o: SlideObject, slide: Slide): { x1: number; y1: number; x2: number; y2: number } {
  const c = o.conn ?? { kind: "straight" as const, x1: o.x, y1: o.y, x2: o.x + o.w, y2: o.y + o.h };
  const from = c.from ? slide.objects.find((x) => x.id === c.from!.id) : null;
  const to = c.to ? slide.objects.find((x) => x.id === c.to!.id) : null;
  const p1 = from ? anchorPoint(from, c.from!.side) : { x: c.x1, y: c.y1 };
  const p2 = to ? anchorPoint(to, c.to!.side) : { x: c.x2, y: c.y2 };
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

export function connBBox(p: { x1: number; y1: number; x2: number; y2: number }): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) };
}

/** Nearest anchor on the object under/near a slide point (attach radius). */
export function hitAnchor(slide: Slide, px: number, py: number, excludeId: string, radius = 24): { id: string; side: ConnSide } | null {
  let best: { id: string; side: ConnSide; d: number } | null = null;
  for (const o of slide.objects) {
    if (o.id === excludeId || o.type === "connector") continue;
    for (const side of ["t", "r", "b", "l"] as const) {
      const p = anchorPoint(o, side);
      const d = Math.hypot(px - p.x, py - p.y);
      if (d <= radius && (!best || d < best.d)) best = { id: o.id, side, d };
    }
  }
  return best ? { id: best.id, side: best.side } : null;
}
