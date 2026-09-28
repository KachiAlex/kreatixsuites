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
      // new node types must export without crashing and degrade gracefully
      { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "Details" }] },
      { type: "paragraph", attrs: { textAlign: "center", spaceBefore: 12, indent: 2 }, content: [
        { type: "text", text: "Centered para with footnote" },
        { type: "footnote", attrs: { note: "note body" } },
      ] },
      { type: "taskList", content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done item" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Todo item" }] }] },
      ] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "after break" }] },
      { type: "sectionBreak", attrs: { type: "nextPage", marginTop: 72 } },
      { type: "paragraph", content: [{ type: "text", text: "in section two" }] },
      { type: "table", attrs: { align: "center", widthMode: "pct", widthPct: 60, repeatHeader: true }, content: [
        { type: "tableRow", attrs: { height: 40, heightMode: "atLeast" }, content: [
          { type: "tableHeader", attrs: { backgroundColor: "#F2782E", vAlign: "middle" }, content: [{ type: "paragraph", content: [{ type: "text", text: "H1" }] }] },
          { type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "H23" }] }] },
        ] },
        { type: "tableRow", attrs: { cantSplit: true }, content: [
          { type: "tableCell", attrs: { rowspan: 2, borders: { top: { style: "dashed", width: 2, color: "#FF0000" } } }, content: [{ type: "paragraph", content: [{ type: "text", text: "merged" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "b2" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "b3" }] }] },
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c2" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c3" }] }] },
        ] },
      ] },
      { type: "blockMath", attrs: { latex: "x^2+y^2" } },
    ],
  };
  const blob = await exportDocxBytes(doc as never, "report");
  const html = await importDocx(fileOf(await blob.arrayBuffer(), "report.docx"));
  check("docx: heading text", html.includes("Quarterly Report"));
  check("docx: inline text", html.includes("Revenue grew") && html.includes("42 percent"));
  check("docx: table cells", html.includes("Metric") && html.includes("Value"));
  check("docx: h5 survives", html.includes("Details"));
  check("docx: task items", html.includes("Done item") && html.includes("Todo item"));
  check("docx: after page break", html.includes("after break"));
  // math exports as native OMML and re-imports as a math node
  {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")?.async("text");
    check("docx: math as OMML", !!xml && xml.includes("oMath") && xml.includes("x^2+y^2"));
    check("docx: math round-trips", /data-type="(inline|block)-math"[^>]*data-latex="x\^2\+y\^2"/.test(html));
    // table props in the exported OOXML
    check("docx: tbl center align", !!xml && /<w:jc w:val="center"\/>/.test(xml));
    check("docx: tbl width pct", !!xml && /<w:tblW [^>]*w:w="60%"/.test(xml));
    check("docx: tblHeader repeat", !!xml && xml.includes("tblHeader"));
    check("docx: trHeight", !!xml && xml.includes("trHeight"));
    check("docx: cantSplit", !!xml && xml.includes("cantSplit"));
    check("docx: cell shading", !!xml && /<w:shd [^>]*w:fill="F2782E"/.test(xml));
    check("docx: cell borders", !!xml && /<w:top w:val="dashed"/.test(xml));
    check("docx: vMerge", !!xml && xml.includes("vMerge"));
    check("docx: gridSpan", !!xml && xml.includes("gridSpan"));
    check("docx: section break", !!xml && /<w:sectPr[^>]*>[\s\S]*?w:val="nextPage"/.test(xml) || !!xml && xml.includes("nextPage"));
    // re-import: annotations survive
    check("docx: section-break node", html.includes('data-type="section-break"') && html.includes('data-section-type="nextPage"'));
    check("docx: tbl align reimport", html.includes('data-align="center"'));
    check("docx: tbl width reimport", /width:60%/.test(html));
    check("docx: repeat-header reimport", html.includes('data-repeat-header="true"'));
    check("docx: cell bg reimport", /background-color:#F2782E/i.test(html));
    check("docx: cell border reimport", /border-top:2px dashed #FF0000/i.test(html));
    check("docx: row height reimport", /height:40px/.test(html));
    check("docx: cantSplit reimport", html.includes('data-cant-split="true"'));
    check("docx: vAlign reimport", /vertical-align:middle/.test(html));
    check("docx: th from tblHeader", /<th\b/.test(html));
    check("docx: page-break node", html.includes('data-type="page-break"'));
  }
  check("docx: valid zip", (await blob.arrayBuffer()).byteLength > 500);
}

// ---------- MD / RTF / ODT exporters ----------
{
  const { jsonToMarkdown } = await import("./src/writer/export/markdown");
  const { rtfBlob } = await import("./src/writer/export/rtf");
  const { odtBlob } = await import("./src/writer/export/odt");
  const doc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Spec" }] },
      { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "bold claim" }] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "point a" }] }] },
      ] },
    ],
  };
  const md = jsonToMarkdown(doc as never);
  check("md: heading + bold + bullet", md.includes("## Spec") && md.includes("**bold claim**") && md.includes("- point a"));
  const rtf = await rtfBlob(doc as never, "spec").text();
  check("rtf: header + content", rtf.startsWith("{\\rtf1") && rtf.includes("bold claim") && rtf.includes("\\b"));
  const JSZip = (await import("jszip")).default;
  const odt = await odtBlob(doc as never, "spec");
  const zip = await JSZip.loadAsync(await odt.arrayBuffer());
  const content = await zip.file("content.xml")?.async("text");
  check("odt: zip + content.xml", !!content && content.includes("Spec") && content.includes("office:text"));
  check("odt: mimetype first", zip.file("mimetype") !== null);
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
