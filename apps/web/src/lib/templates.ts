// Template gallery — starter content for each suite app. `build()` returns the
// canonical content JSON for the file's kind (same shape the editors save).
import type { FileKind } from "@kreatix/shared";

export interface Template {
  id: string;
  kind: Exclude<FileKind, "folder" | "file" | "pdf">;
  name: string;
  desc: string;
  build: () => unknown;
}

// ---- writer helpers (ProseMirror JSON) ----
const p = (text = "") => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const ul = (items: string[]) => ({
  type: "bulletList",
  content: items.map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })),
});
const cell = (text: string, header = false) => ({
  type: header ? "tableHeader" : "tableCell",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
});
const tbl = (rows: string[][]) => ({
  type: "table",
  content: rows.map((r, i) => ({ type: "tableRow", content: r.map((c) => cell(c, i === 0)) })),
});
const writerDoc = (content: object[]) => ({ kind: "writer", doc: { type: "doc", content } });

// ---- sheets helpers ----
const sheet = (name: string, cells: Record<string, { v?: string | number; f?: string }>) => ({ name, cells });
const workbook = (sheets: object[]) => ({ kind: "sheets", workbook: { sheets } });

// ---- present helpers ----
const txt = (html: string, x: number, y: number, w: number, h: number, o: object = {}) =>
  ({ id: Math.random().toString(36).slice(2, 10), type: "text", x, y, w, h, z: 0, html, fontSize: 20, ...o });
const box = (x: number, y: number, w: number, h: number, fill: string, shape = "rect") =>
  ({ id: Math.random().toString(36).slice(2, 10), type: "shape", shape, x, y, w, h, z: 0, fill, stroke: "none" });
const slide = (objects: object[], extra: object = {}) =>
  ({ id: Math.random().toString(36).slice(2, 10), objects, ...extra });
const deck = (slides: object[]) => ({ kind: "present", deck: { theme: "kreatix", slides } });

export const TEMPLATES: Template[] = [
  // ---------- Writer ----------
  {
    id: "w-blank", kind: "writer", name: "Blank document", desc: "Start from scratch",
    build: () => writerDoc([p()]),
  },
  {
    id: "w-notes", kind: "writer", name: "Meeting notes", desc: "Agenda, decisions, action items",
    build: () => writerDoc([
      h(1, "Meeting notes"),
      p("Date:  ·  Attendees: "),
      h(2, "Agenda"), ul(["Topic one", "Topic two", "Topic three"]),
      h(2, "Decisions"), ul(["…"]),
      h(2, "Action items"), ul(["Owner — task — due", "Owner — task — due"]),
    ]),
  },
  {
    id: "w-letter", kind: "writer", name: "Letter", desc: "Formal business letter",
    build: () => writerDoc([
      p("Your name"), p("Address"), p("City, ZIP"), p(),
      p("Date"), p(),
      p("Recipient name"), p("Company"), p("Address"), p(),
      p("Dear …,"), p(),
      p("Body of the letter…"), p(),
      p("Sincerely,"), p(), p(), p("Your name"),
    ]),
  },
  {
    id: "w-report", kind: "writer", name: "Status report", desc: "Summary, progress table, risks, next steps",
    build: () => writerDoc([
      h(1, "Status report"), p("Week of …"),
      h(2, "Summary"), p("High-level status…"),
      h(2, "Progress"),
      tbl([["Workstream", "Status", "Notes"], ["—", "On track", ""], ["—", "At risk", ""]]),
      h(2, "Risks"), ul(["…"]),
      h(2, "Next week"), ul(["…"]),
    ]),
  },
  // ---------- Sheets ----------
  {
    id: "s-blank", kind: "sheets", name: "Blank spreadsheet", desc: "Start from scratch",
    build: () => workbook([sheet("Sheet1", {})]),
  },
  {
    id: "s-budget", kind: "sheets", name: "Budget tracker", desc: "Planned vs actual with diffs + totals",
    build: () => workbook([sheet("Budget", {
      A1: { v: "Item" }, B1: { v: "Category" }, C1: { v: "Planned" }, D1: { v: "Actual" }, E1: { v: "Diff" },
      A2: { v: "Rent" }, B2: { v: "Office" }, C2: { v: 2000 }, D2: { v: 2000 }, E2: { f: "C2-D2" },
      A3: { v: "Software" }, B3: { v: "Tools" }, C3: { v: 350 }, D3: { v: 412 }, E3: { f: "C3-D3" },
      A4: { v: "Travel" }, B4: { v: "Ops" }, C4: { v: 800 }, D4: { v: 0 }, E4: { f: "C4-D4" },
      A6: { v: "Total" }, C6: { f: "SUM(C2:C4)" }, D6: { f: "SUM(D2:D4)" }, E6: { f: "C6-D6" },
    })]),
  },
  {
    id: "s-tracker", kind: "sheets", name: "Project tracker", desc: "Task / owner / status / due",
    build: () => workbook([sheet("Tasks", {
      A1: { v: "Task" }, B1: { v: "Owner" }, C1: { v: "Status" }, D1: { v: "Due" }, E1: { v: "Notes" },
      A2: { v: "Kickoff" }, B2: { v: "—" }, C2: { v: "Done" }, D2: { v: "Mon" },
      A3: { v: "Draft spec" }, B3: { v: "—" }, C3: { v: "In progress" }, D3: { v: "Wed" },
      A4: { v: "Review" }, B4: { v: "—" }, C4: { v: "Todo" }, D4: { v: "Fri" },
    })]),
  },
  {
    id: "s-invoice", kind: "sheets", name: "Invoice", desc: "Line items, tax, total",
    build: () => workbook([sheet("Invoice", {
      A1: { v: "Invoice" }, A2: { v: "Bill to:" }, A3: { v: "Date:" },
      A5: { v: "Description" }, B5: { v: "Qty" }, C5: { v: "Rate" }, D5: { v: "Amount" },
      A6: { v: "Service" }, B6: { v: 1 }, C6: { v: 100 }, D6: { f: "B6*C6" },
      A7: { v: "Service" }, B7: { v: 1 }, C7: { v: 100 }, D7: { f: "B7*C7" },
      C9: { v: "Subtotal" }, D9: { f: "SUM(D6:D7)" },
      C10: { v: "Tax 10%" }, D10: { f: "D9*0.1" },
      C11: { v: "Total" }, D11: { f: "D9+D10" },
    })]),
  },
  // ---------- Present ----------
  {
    id: "p-blank", kind: "present", name: "Blank deck", desc: "One empty slide",
    build: () => deck([slide([])]),
  },
  {
    id: "p-pitch", kind: "present", name: "Pitch deck", desc: "Title → problem → solution → ask",
    build: () => deck([
      slide([
        box(0, 0, 960, 540, "#F2782E"),
        txt("Your pitch", 80, 200, 800, 90, { fontSize: 52, bold: true, color: "#FFFFFF" }),
        txt("One-line description", 80, 300, 800, 40, { fontSize: 22, color: "#FFE3D0" }),
      ]),
      slide([
        txt("The problem", 48, 32, 864, 64, { fontSize: 34, bold: true }),
        txt("• Pain point one\n• Pain point two\n• Pain point three", 48, 120, 600, 300, { fontSize: 22 }),
        box(48, 100, 120, 4, "#F2782E"),
      ]),
      slide([
        txt("Our solution", 48, 32, 864, 64, { fontSize: 34, bold: true }),
        txt("• What we do\n• Why it works\n• Why now", 48, 120, 600, 300, { fontSize: 22 }),
        box(48, 100, 120, 4, "#F2782E"),
      ]),
      slide([
        box(0, 0, 960, 540, "#171717"),
        txt("The ask", 80, 220, 800, 80, { fontSize: 48, bold: true, color: "#FFFFFF" }),
        txt("What you want from the audience", 80, 310, 800, 40, { fontSize: 20, color: "#C9C2BC" }),
      ]),
    ]),
  },
  {
    id: "p-review", kind: "present", name: "Team review", desc: "Wins, metrics, blockers, next",
    build: () => deck([
      slide([
        txt("Team review", 80, 200, 800, 90, { fontSize: 48, bold: true, align: "center" }),
        txt("Sprint / month — team name", 80, 300, 800, 40, { fontSize: 20, align: "center", color: "#6B6259" }),
      ]),
      slide([
        txt("Wins", 48, 32, 420, 56, { fontSize: 30, bold: true }),
        txt("• …", 48, 110, 420, 300, { fontSize: 20 }),
        txt("Metrics", 504, 32, 420, 56, { fontSize: 30, bold: true }),
        txt("• KPI — value\n• KPI — value", 504, 110, 420, 300, { fontSize: 20 }),
      ]),
      slide([
        txt("Blockers & next steps", 48, 32, 864, 64, { fontSize: 34, bold: true }),
        txt("Blockers\n• …\n\nNext\n• …", 48, 120, 720, 340, { fontSize: 20 }),
      ]),
    ]),
  },
];
