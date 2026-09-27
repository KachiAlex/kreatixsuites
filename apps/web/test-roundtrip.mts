// OOXML round-trip harness — build a model, export to bytes, re-import, assert.
// Run: npx tsx test-roundtrip.mts
import { DOMParser as LDParser } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import { exportDocxBytes, importDocx } from "./src/writer/docx";
import { workbookToXLSXBytes, xlsxToWorkbook, sheetToCSV, csvToSheet } from "./src/sheets/io";
import { exportPptxBytes } from "./src/present/export";
import { importPptx } from "./src/present/import";
import type { Deck } from "./src/present/model";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name); }
};
const fileOf = (buf: ArrayBuffer | Uint8Array | Blob, name: string) =>
  new File([buf instanceof Uint8Array ? buf as unknown as ArrayBuffer : buf], name);

// ---------- DOCX ----------
{
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarterly Report" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Revenue grew " },
        { type: "text", marks: [{ type: "bold" }], text: "42 percent" },
      ] },
      { type: "table", content: [
        { type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Metric" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
        ] },
      ] },
    ],
  };
  const blob = await exportDocxBytes(doc as never, "report");
  const html = await importDocx(fileOf(await blob.arrayBuffer(), "report.docx"));
  check("docx: heading text", html.includes("Quarterly Report"));
  check("docx: inline text", html.includes("Revenue grew") && html.includes("42 percent"));
  check("docx: table cells", html.includes("Metric") && html.includes("Value"));
  check("docx: valid zip", (await blob.arrayBuffer()).byteLength > 500);
}

// ---------- XLSX ----------
{
  const wb = {
    sheets: [
      { name: "P&L", cells: {
        A1: { v: "Item" }, B1: { v: "Amount" },
        A2: { v: "Revenue" }, B2: { v: 1200 },
        A3: { v: "Costs" }, B3: { v: 800 },
        A4: { v: "Profit" }, B4: { f: "B2-B3" },
      } },
      { name: "Notes", cells: { A1: { v: "second sheet" } } },
    ],
  };
  const bytes = await workbookToXLSXBytes(wb as never);
  const back = await xlsxToWorkbook(fileOf(bytes, "book.xlsx"));
  check("xlsx: two sheets", back.sheets.length === 2 && back.sheets[0].name === "P&L");
  check("xlsx: values", back.sheets[0].cells.A2?.v === "Revenue" && back.sheets[0].cells.B2?.v === 1200);
  check("xlsx: formula survives", back.sheets[0].cells.B4?.f === "B2-B3");
  check("xlsx: second sheet text", back.sheets[1].cells.A1?.v === "second sheet");
}

// ---------- CSV ----------
{
  const sheet = { name: "T", cells: { A1: { v: "a,b" }, B1: { v: "quoted" }, A2: { v: 7 } } };
  const csv = sheetToCSV(sheet as never);
  const back = csvToSheet("T", csv);
  check("csv: quoted comma value", back.cells.A1?.v === "a,b");
  check("csv: plain + numeric", back.cells.B1?.v === "quoted" && String(back.cells.A2?.v) === "7");
}

// ---------- PPTX ----------
{
  const deck: Deck = {
    theme: "kreatix",
    slides: [
      { id: "s1", objects: [
        { id: "o1", type: "text", x: 60, y: 60, w: 600, h: 60, z: 0,
          html: "Launch <b>Plan</b>", fontSize: 32, bold: true, color: "#171717" },
        { id: "o2", type: "chart", x: 60, y: 160, w: 500, h: 300, z: 1,
          chart: { type: "bar", labels: ["Q1", "Q2"], title: "Sales",
            series: [{ name: "East", values: [10, 20] }, { name: "West", values: [5, 15] }] } },
        { id: "o3", type: "table", x: 600, y: 160, w: 300, h: 150, z: 2,
          table: [["Region", "Total"], ["East", "30"], ["West", "20"]] },
      ], bg: "#FFEE00", notes: "speaker notes here" },
      { id: "s2", objects: [
        { id: "o4", type: "shape", shape: "ellipse", x: 100, y: 100, w: 200, h: 120, z: 0,
          fill: "#F2782E", stroke: "#171717", html: "oval label" },
      ] },
    ],
  };
  const buf = await exportPptxBytes(deck, "deck");
  check("pptx: valid zip magic", new Uint8Array(buf).slice(0, 2).join(",") === "80,75");
  const back = await importPptx(fileOf(buf, "deck.pptx"));
  check("pptx: two slides", back.slides.length === 2);
  const texts = JSON.stringify(back);
  check("pptx: text survived", texts.includes("Launch") && texts.includes("Plan"));
  const chart = back.slides[0].objects.find((o) => o.type === "chart")?.chart;
  check("pptx: multi-series chart", (chart?.series?.length ?? 0) === 2
    && chart?.series?.[0].name === "East" && chart.series[1].values[1] === 15);
  const tbl = back.slides[0].objects.find((o) => o.type === "table")?.table;
  check("pptx: table cells", tbl?.[0]?.[0] === "Region" && tbl?.[2]?.[1] === "20");
  check("pptx: slide bg", back.slides[0].bg === "#FFEE00");
  check("pptx: speaker notes", (back.slides[0].notes ?? "").includes("speaker notes"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
