// Kreatix Present — deck data model (stored as file content JSON)

export interface SlideObject {
  id: string;
  type: "text" | "shape" | "image" | "table" | "chart" | "line";
  x: number; y: number; w: number; h: number;
  rotate?: number;
  z: number;
  groupId?: string;

  // text
  html?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  fontFamily?: string;

  // shape
  shape?: "rect" | "ellipse" | "triangle" | "arrow" | "star" | "roundrect";
  fill?: string;
  stroke?: string;
  strokeW?: number;

  // image
  src?: string;
  alt?: string;

  // table
  table?: string[][];

  // chart
  chart?: { type: "bar" | "line" | "pie"; labels: string[]; values: number[]; title?: string };

  // line
  x2?: number; y2?: number;

  // entrance animation (KBS-PRESENT-005)
  anim?: { type: "fade" | "slide-up" | "slide-left" | "zoom" | "wipe"; order: number };
}

export type TransitionType = "none" | "fade" | "slide" | "zoom" | "push";

export interface Slide {
  id: string;
  objects: SlideObject[];
  notes?: string;
  bg?: string;
  layout?: string;
  transition?: { type: TransitionType; duration?: number };
}

export interface Deck {
  theme?: string;
  slides: Slide[];
}

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
  THEMES.find((t) => t.id === deck.theme) ?? THEMES[0];

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
