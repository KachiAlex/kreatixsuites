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
        { type: "text", marks: [{ type: "textStyle", attrs: { fontFamily: "'Georgia'", color: "#1A1A2E", fontSize: "22pt" } }], text: " styled run" },
      ] },
      { type: "taskList", content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done item" }] }] },
        { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Todo item" }] }] },
      ] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "after break" }] },
      { type: "sectionBreak", attrs: { type: "nextPage", marginTop: 72, pnStart: 5, pnFmt: "lower-roman", headerLeft: "S2H", footerLeft: "S2F" } },
      { type: "columns", attrs: { count: 3, gap: 48 }, content: [
        { type: "paragraph", content: [{ type: "text", text: "columned one" }] },
        { type: "paragraph", content: [{ type: "text", text: "columned two" }] },
      ] },
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
          { type: "tableCell", attrs: { backgroundColor: "#00FF00" }, content: [{ type: "paragraph", content: [{ type: "text", text: "c2" }] }] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c3" }] }] },
        ] },
      ] },
      { type: "blockMath", attrs: { latex: "x^2+y^2" } },
    ],
  };
  const blob = await exportDocxBytes(doc as never, "report");
  const html = (await importDocx(fileOf(await blob.arrayBuffer(), "report.docx"))).html;
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
    check("docx: math as OMML", !!xml && xml.includes("oMathPara") && xml.includes("<m:sSup>"));
    check("docx: math round-trips", /data-type="(inline|block)-math"[^>]*data-latex="x\^2\+y\^2"/.test(html));
    check("docx: math keeps omml attr", /data-type="block-math"[^>]*data-omml="[A-Za-z0-9+/=]+"/.test(html));
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
    check("docx: pgNumType start", !!xml && /<w:pgNumType[^>]*w:start="5"/.test(xml));
    check("docx: pgNumType fmt", !!xml && /<w:pgNumType[^>]*w:fmt="lowerRoman"/.test(xml));
    check("docx: cols export", !!xml && /<w:cols[^>]*w:num="3"/.test(xml));
    const hfParts = await Promise.all([
      zip.file("word/header2.xml")?.async("text"), zip.file("word/footer2.xml")?.async("text"),
      zip.file("word/header1.xml")?.async("text"), zip.file("word/footer1.xml")?.async("text"),
    ]);
    check("docx: sect header part", hfParts.some((t) => t && t.includes("S2H")));
    check("docx: sect footer part", hfParts.some((t) => t && t.includes("S2F")));
    // re-import: annotations survive
    check("docx: section-break node", html.includes('data-type="section-break"') && html.includes('data-section-type="nextPage"'));
    check("docx: pnStart reimport", html.includes('data-pn-start="5"'));
    check("docx: pnFmt reimport", html.includes('data-pn-fmt="lower-roman"'));
    check("docx: sect header reimport", html.includes('data-header-left="S2H"'));
    check("docx: sect footer reimport", html.includes('data-footer-left="S2F"'));
    check("docx: columns reimport", html.includes('data-type="columns"') && html.includes('data-cols="3"'));
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
    // direct formatting (w:jc / w:spacing / rPr) survives export→import —
    // mammoth drops it; the sentinel pass must restore it
    check("docx: direct align reimport", /<p[^>]*style="[^"]*text-align:center/.test(html));
    check("docx: direct spacing reimport", /margin-top:12px/.test(html));
    check("docx: direct run font reimport", /font-family:'Georgia'/.test(html));
    check("docx: direct run size+color", /font-size:22pt/.test(html) && /color:#1A1A2E/i.test(html));
    // vMerge alignment: c2's XML cell follows a vMerge-continue placeholder that
    // mammoth drops — the annotator must skip it so #00FF00 lands on c2, not c3
    {
      const d = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
      const tds = [...d.querySelectorAll("td")];
      const c2 = tds.find((t) => t.textContent === "c2");
      const c3 = tds.find((t) => t.textContent === "c3");
      check("docx: vMerge align (bg on c2)", !!c2 && (c2 as HTMLElement).getAttribute("style")?.includes("00FF00") === true);
      check("docx: vMerge align (none on c3)", !!c3 && !(c3 as HTMLElement).getAttribute("style")?.includes("00FF00"));
    }
  }
  check("docx: valid zip", (await blob.arrayBuffer()).byteLength > 500);
}

// ---------- DOCX: tracked changes (insertion/deletion marks) round-trip ----------
{
  const JSZip = (await import("jszip")).default;
  const doc = {
    type: "doc",
    content: [{ type: "paragraph", content: [
      { type: "text", text: "keep " },
      { type: "text", text: "added", marks: [{ type: "insertion", attrs: { changeId: "7", authorName: "Ada" } }] },
      { type: "text", text: " mid " },
      { type: "text", text: "gone", marks: [{ type: "deletion", attrs: { changeId: "8", authorName: "Bob" } }] },
    ] }],
  };
  const blob = await exportDocxBytes(doc as never, "tracked");
  const ab = await blob.arrayBuffer();
  const zip = await JSZip.loadAsync(ab);
  const xml = await zip.file("word/document.xml")!.async("text");
  check("track: w:ins emitted", /<w:ins\b[^>]*w:author="Ada"/.test(xml));
  check("track: w:del emitted", /<w:del\b[^>]*w:author="Bob"/.test(xml) && /<w:delText[^>]*>gone<\/w:delText>/.test(xml));
  const html = (await importDocx(fileOf(ab, "tracked.docx"))).html;
  check("track: ins mark reimport", /<ins\b[^>]*data-change-id="[^"]*"[^>]*>added<\/ins>/.test(html));
  check("track: del mark reimport", /<del\b[^>]*data-change-id="[^"]*"[^>]*>gone<\/del>/.test(html));
  check("track: del keeps author", /<del\b[^>]*data-author-name="Bob"/.test(html));
}

// ---------- DOCX: redact mark scrubs exported text ----------
{
  const JSZip = (await import("jszip")).default;
  const { scrubRedactions } = await import("./src/writer/extensions/extras");
  const doc = { type: "doc", content: [{ type: "paragraph", content: [
    { type: "text", text: "public " },
    { type: "text", text: "SECRET12", marks: [{ type: "redact" }] },
  ] }] };
  scrubRedactions(doc as never);
  const blob = await exportDocxBytes(doc as never, "redacted");
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml")!.async("text");
  check("redact: blocks in docx", xml.includes("████████") && !xml.includes("SECRET12"));
  check("redact: scrub preserves neighbors", xml.includes("public"));
}

// ---------- DOCX: w:sdt content controls round-trip ----------
{
  const JSZip = (await import("jszip")).default;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const PR_TEXT = `<w:sdtPr><w:alias w:val="Customer name"/><w:tag w:val="customer"/><w:id w:val="111"/><w:text/></w:sdtPr>`;
  const PR_CHECK = `<w:sdtPr><w:id w:val="222"/><w14:checkbox><w14:checked w14:val="0"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr>`;
  const PR_DROP = `<w:sdtPr><w:alias w:val="Pick a color"/><w:id w:val="333"/><w:dropDownList><w:listItem w:displayText="Red" w:value="1"/><w:listItem w:displayText="Blue" w:value="2"/></w:dropDownList></w:sdtPr>`;
  const PR_BLOCK = `<w:sdtPr><w:alias w:val="Section group"/><w:id w:val="444"/><w:group/></w:sdtPr>`;
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [
        { type: "text", text: "Name: " },
        { type: "text", marks: [{ type: "sdt", attrs: { pr: b64(PR_TEXT), kind: "text", alias: "Customer name" } }], text: "Ada Lovelace" },
        { type: "text", text: " tail" },
      ] },
      { type: "paragraph", content: [
        { type: "text", marks: [{ type: "sdt", attrs: { pr: b64(PR_CHECK), kind: "checkbox", checked: "1" } }], text: "☒" },
      ] },
      { type: "paragraph", content: [
        { type: "text", marks: [{ type: "sdt", attrs: { pr: b64(PR_DROP), kind: "dropDownList" } }], text: "Blue" },
      ] },
      { type: "paragraph", attrs: { sdt: b64(PR_BLOCK) }, content: [{ type: "text", text: "Inside grouped block" }] },
      { type: "paragraph", attrs: { sdt: b64(PR_BLOCK) }, content: [{ type: "text", text: "Second grouped para" }] },
      { type: "paragraph", content: [{ type: "text", text: "Outside" }] },
    ],
  };
  const blob = await exportDocxBytes(doc as never, "sdt");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = (await zip.file("word/document.xml")?.async("text")) ?? "";
  check("sdt export: inline <w:sdt>", /<w:sdt>/.test(xml));
  check("sdt export: sdtPr verbatim", xml.includes('w:val="Customer name"') && xml.includes('w:val="customer"'));
  check("sdt export: content wraps run", /<w:sdtContent>[\s\S]*?Ada Lovelace[\s\S]*?<\/w:sdtContent>/.test(xml));
  check("sdt export: checkbox val patched", xml.includes("w14:checkbox") && /<w14:checked w14:val="1"\/>/.test(xml));
  check("sdt export: listItems survive", xml.includes('w:displayText="Red"') && xml.includes('w:displayText="Blue"'));
  check("sdt export: block groups paras", /<w:sdt>[\s\S]*?<w:group\/>[\s\S]*?<w:sdtContent>[\s\S]*?Inside grouped block[\s\S]*?Second grouped para[\s\S]*?<\/w:sdtContent>/.test(xml));
  check("sdt export: single block wrapper", (xml.match(/<w:group\/>/g) ?? []).length === 1);

  // real Word markup in — mammoth drops the control, sentinels carry it
  const CRAFT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>
<w:p><w:r><w:t>Name: </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Customer name"/><w:tag w:val="customer"/><w:id w:val="111"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Ada Lovelace</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t> tail</w:t></w:r></w:p>
<w:p><w:sdt><w:sdtPr><w:id w:val="222"/><w14:checkbox><w14:checked w14:val="1"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic"/></w:rPr><w:t>☒</w:t></w:r></w:sdtContent></w:sdt><w:r><w:t> agree</w:t></w:r></w:p>
<w:sdt><w:sdtPr><w:alias w:val="Section group"/><w:id w:val="444"/><w:group/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Inside grouped block</w:t></w:r></w:p><w:p><w:r><w:t>Second grouped para</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:p><w:r><w:t>Outside</w:t></w:r></w:p>
</w:body></w:document>`;
  const zip2 = await JSZip.loadAsync(await blob.arrayBuffer());
  zip2.file("word/document.xml", CRAFT);
  const html = (await importDocx(new File([await zip2.generateAsync({ type: "arraybuffer" })], "sdt-in.docx"))).html;
  check("sdt import: inline span", /<span data-sdt="[^"]+" data-sdt-kind="text" data-sdt-alias="Customer name">Ada Lovelace<\/span>/.test(html));
  check("sdt import: checkbox kind+state", /data-sdt-kind="checkbox" data-sdt-checked="1"/.test(html));
  check("sdt import: block paras carry attr", /<p data-sdt="[^"]+">Inside grouped block/.test(html) && /<p data-sdt="[^"]+">Second grouped para/.test(html));
  check("sdt import: outside para clean", /<p>Outside<\/p>/.test(html));
  check("sdt import: no sentinel leak", !html.includes("⟦"));
}

// ---------- DOCX: OMML equations round-trip ----------
{
  const JSZip = (await import("jszip")).default;
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  // authored linear math → real structured OMML (not literal "x^2" text)
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [
      { type: "text", text: "Energy: " },
      { type: "inlineMath", attrs: { latex: "E = mc^2" } },
    ] },
    { type: "paragraph", content: [
      { type: "inlineMath", attrs: { latex: "\\frac{a+b}{c}" } },
    ] },
    { type: "paragraph", content: [
      { type: "inlineMath", attrs: { latex: "\\sqrt{x_i} + \\sum_{i=1}^{n} x_i" } },
    ] },
    { type: "blockMath", attrs: { latex: "\\alpha + \\beta \\geq \\gamma" } },
  ] };
  const xml = await (async () => {
    const zip = await JSZip.loadAsync(await (await exportDocxBytes(doc as never, "eq")).arrayBuffer());
    return (await zip.file("word/document.xml")?.async("text")) ?? "";
  })();
  check("omml export: superscript structure", /<m:sSup>[\s\S]*?<m:t[^>]*>c<\/m:t>[\s\S]*?<m:t[^>]*>2<\/m:t>/.test(xml));
  check("omml export: fraction structure", /<m:f>[\s\S]*?<m:num>[\s\S]*?<m:t[^>]*>a<\/m:t>[\s\S]*?<\/m:num>[\s\S]*?<m:den>/.test(xml));
  check("omml export: radical structure", /<m:rad>[\s\S]*?<m:sSub>/.test(xml));
  check("omml export: n-ary limits", /<m:sSubSup>[\s\S]*?∑[\s\S]*?<\/m:sSubSup>/.test(xml));
  check("omml export: greek glyphs", xml.includes("α") && xml.includes("≥") && xml.includes("γ"));
  check("omml export: block → oMathPara", /<m:oMathPara>[\s\S]*?<m:oMath>/.test(xml));
  check("omml export: no literal caret leak", !xml.includes("mc^2"));

  // foreign OMML in → linear source + verbatim OMML out
  const OMATH = `<m:oMath><m:f><m:fPr><m:ctrlPr/></m:fPr><m:num><m:r><m:t>a+b</m:t></m:r></m:num><m:den><m:r><m:t>c-d</m:t></m:r></m:den></m:f><m:r><m:t>≈</m:t></m:r><m:sSup><m:e><m:r><m:t>π</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>`;
  const OPARA = `<m:oMathPara><m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr><m:oMath><m:sSub><m:e><m:r><m:t>a</m:t></m:r></m:e><m:sub><m:r><m:t>n</m:t></m:r></m:sub></m:sSub></m:oMath></m:oMathPara>`;
  const CRAFT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<w:body>
<w:p><w:r><w:t>Ratio </w:t></w:r>${OMATH}<w:r><w:t> done.</w:t></w:r></w:p>
${OPARA}
<w:p><w:r><w:t>after</w:t></w:r></w:p>
</w:body></w:document>`;
  const carrier = await exportDocxBytes({ type: "doc", content: [{ type: "paragraph" }] } as never, "carrier");
  const zin = await JSZip.loadAsync(await carrier.arrayBuffer());
  zin.file("word/document.xml", CRAFT);
  const htmlIn = (await importDocx(fileOf(await zin.generateAsync({ type: "arraybuffer" }), "foreign.docx"))).html;
  check("omml import: inline zone", htmlIn.includes('data-type="inline-math"'));
  check("omml import: block zone", htmlIn.includes('data-type="block-math"'));
  check("omml import: linear source recovered", htmlIn.includes('\\frac{a+b}{c-d}') && htmlIn.includes('π^2'));
  check("omml import: subscript recovered", htmlIn.includes('data-latex="a_n"'));
  const ommlB64 = /data-omml="([^"]+)"/.exec(htmlIn)?.[1] ?? "";
  check("omml import: raw OMML carried", ommlB64.length > 0 && Buffer.from(ommlB64, "base64").toString("utf8").startsWith("<m:oMath>"));

  // nodes carrying raw OMML re-export byte-for-byte
  const reXml = await (async () => {
    const zip = await JSZip.loadAsync(await (await exportDocxBytes({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "inlineMath", attrs: { latex: "\\frac{a+b}{c-d}≈π^2", omml: ommlB64 } }] },
      { type: "blockMath", attrs: { latex: "a_n", omml: b64(OPARA) } },
    ] } as never, "re")).arrayBuffer());
    return (await zip.file("word/document.xml")?.async("text")) ?? "";
  })();
  check("omml re-export: inline verbatim", reXml.includes("<m:num>") && reXml.includes("<m:t>a+b</m:t>"));
  check("omml re-export: block verbatim", reXml.includes('<m:jc m:val="center"') && reXml.includes("<m:oMathPara"));
}
{
  const { Paragraph } = await import("docx");
  void Paragraph;
  const JSZip = (await import("jszip")).default;
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { styleName: "title" }, content: [{ type: "text", text: "Spec Doc" }] },
      { type: "paragraph", attrs: { styleName: "myStyle" }, content: [{ type: "text", text: "styled body" }] },
      { type: "orderedList", attrs: { listStyle: "lower-roman", start: 3 }, content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "three" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "four" }] }] },
      ] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b1" }] }] },
      ] },
      { type: "paragraph", content: [
        { type: "text", text: "plain " },
        { type: "text", text: "commented", marks: [{ type: "comment", attrs: { commentId: "c-1" } }] },
        { type: "text", text: " tail" },
      ] },
      { type: "paragraph", attrs: { indentPx: 60, indentRight: "40px", firstLine: "32px", lineSpacingRule: "exact:28px", dir: "rtl" },
        content: [{ type: "text", text: "fmt para" }] },
    ],
  };
  const blob = await exportDocxBytes(doc as never, "styled", {
    styles: { myStyle: { key: "myStyle", label: "My Style", node: "paragraph", italic: true, color: "#123456" } },
    comments: [{ anchor: "c-1", body: "a note", author: "Ann" }],
    docProps: { title: "Spec Title", subject: "QA", author: "Kreatix", keywords: "a, b", category: "spec", comments: "notes here" },
    pageSetup: { sizeName: "A4", width: 794, height: 1123, marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96 } as never,
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const stylesXml = await zip.file("word/styles.xml")?.async("text") ?? "";
  check("docx styles.xml: custom style", stylesXml.includes('w:styleId="kx-myStyle"') && stylesXml.includes('w:val="My Style"'));
  check("docx styles.xml: title def", stylesXml.includes('w:styleId="kx-title"'));
  const numXml = await zip.file("word/numbering.xml")?.async("text") ?? "";
  check("docx numbering: lowerRoman", numXml.includes('w:val="lowerRoman"'));
  check("docx numbering: bullet", numXml.includes('w:val="bullet"'));
  const commentsXml = await zip.file("word/comments.xml")?.async("text") ?? "";
  check("docx comments.xml: body", commentsXml.includes("a note"));
  const docXml2 = await zip.file("word/document.xml")?.async("text") ?? "";
  check("docx comment range", docXml2.includes("commentRangeStart") && docXml2.includes("commentReference"));
  check("docx pStyle ref", docXml2.includes('w:pStyle w:val="kx-myStyle"'));
  check("docx numPr ref", docXml2.includes("w:numId"));
  check("docx exact spacing", docXml2.includes('w:lineRule="exact"') || docXml2.includes('w:lineRule="atLeast"'));
  check("docx bidi", docXml2.includes("<w:bidi"));
  const coreXml = await zip.file("docProps/core.xml")?.async("text") ?? "";
  check("docx core.xml: title", coreXml.includes("<dc:title>Spec Title</dc:title>"));
  check("docx core.xml: author", coreXml.includes("<dc:creator>Kreatix</dc:creator>"));
  const sectXml = docXml2;
  check("docx sectPr: gutter+A4", sectXml.includes("w:gutter") && /w:pgSz[^>]*w:w="11910"/.test(sectXml));

  // re-import — styles/numbering/comments/props come back
  const res = await importDocx(fileOf(await blob.arrayBuffer(), "styled.docx"));
  check("docx re: pStyle→data-style", /data-style="(title|imp_kx-myStyle)"/.test(res.html));
  check("docx re: imported defs", Object.keys(res.styles).length > 0);
  check("docx re: roman ol", /list-style-type:lower-roman/.test(res.html));
  check("docx re: ol start", res.html.includes('start="3"'));
  check("docx re: comment mark", res.html.includes('data-comment-id="docx-'));
  check("docx re: comment body", res.comments.some((c) => c.body === "a note"));
  check("docx re: docProps", res.docProps.title === "Spec Title" && res.docProps.author === "Kreatix");
}

// ---------- vMerge flattening (imported forms) ----------
// rowspan cells make a table atomic; under the paginator's float-band layout an
// atomic block taller than a band falls below all walls and buries the doc.
// flattenTableVMerges expands them into per-row ghost cells pre-pagination.
{
  const { getSchema } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { KxTable, KxTableRow, KxTableCell, KxTableHeader, flattenTableVMerges } =
    await import("./src/writer/extensions/table");
  const schema = getSchema([StarterKit, KxTable, KxTableRow, KxTableCell, KxTableHeader]);
  const mkCell = (text: string, attrs: Record<string, unknown> = {}) => ({
    type: "tableCell", attrs,
    content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
  });
  const table = schema.nodeFromJSON({
    type: "table", content: [
      { type: "tableRow", content: [
        { ...mkCell("Q", {}), attrs: { rowspan: 3 } },
        mkCell("a1"),
      ] },
      { type: "tableRow", content: [mkCell("a2")] },
      { type: "tableRow", content: [mkCell("a3")] },
    ],
  });
  const flat = flattenTableVMerges(table);
  check("vmerge: no rowspan remains", (() => {
    let bad = false;
    flat.forEach((row) => row.forEach((c) => { if ((c.attrs.rowspan || 1) > 1) bad = true; }));
    return !bad;
  })());
  check("vmerge: row count preserved", flat.childCount === 3);
  check("vmerge: ghost cells added", flat.child(1).childCount === 2 && flat.child(2).childCount === 2);
  check("vmerge: ghost seam borders transparent",
    flat.child(0).child(0).attrs.borders?.bottom?.color === "transparent" &&
    flat.child(1).child(0).attrs.borders?.top?.color === "transparent");
  check("vmerge: source content kept", flat.child(0).child(0).textContent === "Q");
  check("vmerge: siblings untouched", flat.child(1).child(1).textContent === "a2");

  // numbered-list distribution: one item per ghost row, continuation numbering
  const listTable = schema.nodeFromJSON({
    type: "table", content: [
      { type: "tableRow", content: [
        { type: "tableCell", attrs: { rowspan: 2 }, content: [
          { type: "orderedList", attrs: { start: 1 }, content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
          ] },
        ] },
        mkCell("b1"),
      ] },
      { type: "tableRow", content: [mkCell("b2")] },
    ],
  });
  const flatList = flattenTableVMerges(listTable);
  const firstList = flatList.child(0).child(0).firstChild!;
  const ghostList = flatList.child(1).child(0).firstChild!;
  check("vmerge list: item 0 on first row", firstList.child(0).textContent === "one");
  check("vmerge list: item 1 on ghost row", ghostList.child(0).textContent === "two");
  check("vmerge list: ghost continues numbering", ghostList.attrs.start === 2);
}

// ---------- DOCX: shared numId numbering continues across cells ----------
// Word counts one numbering instance document-wide; a form that puts
// numbered questions in separate table cells must render 1,2,3… not 1,1,1.
{
  const doc = {
    type: "doc",
    content: [{
      type: "table",
      content: [
        { type: "tableRow", content: [
          { type: "tableCell", content: [
            { type: "orderedList", content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "q1" }] }] },
            ] },
          ] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a1" }] }] },
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", content: [
            { type: "orderedList", content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "q2" }] }] },
            ] },
          ] },
          { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a2" }] }] },
        ] },
      ],
    }],
  };
  const blob = await exportDocxBytes(doc as never, "numcont");
  const html = (await importDocx(fileOf(await blob.arrayBuffer(), "numcont.docx"))).html;
  const ols = [...html.matchAll(/<ol[^>]*>/g)].map((m) => m[0]);
  check("num: first cell stays 1", !!ols[0] && !/start="/.test(ols[0]));
  check("num: second cell continues at 2", /<ol start="2"/.test(ols[1] ?? ""));
}

// cell tcW is a cell's TOTAL span width — per-column colwidth must come from
// tblGrid instead, or a colspan'd cell inflates one grid column and crushes
// its neighbors (questionnaire: grid 468|2227|360|90|5940 dxa)
{
  const JSZip = (await import("jszip")).default;
  const GRID_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:tbl>
<w:tblPr><w:tblW w:w="9085" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>
<w:tblGrid><w:gridCol w:w="468"/><w:gridCol w:w="2227"/><w:gridCol w:w="360"/><w:gridCol w:w="90"/><w:gridCol w:w="5940"/></w:tblGrid>
<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>
<w:tc><w:tcPr><w:tcW w:w="468" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="2227" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="6390" w:type="dxa"/><w:gridSpan w:val="3"/></w:tcPr><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
<w:tc><w:tcPr><w:tcW w:w="468" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="2695" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>E</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="6390" w:type="dxa"/><w:gridSpan w:val="3"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>F</w:t></w:r></w:p></w:tc>
</w:tr>
<w:tr>
<w:tc><w:tcPr><w:tcW w:w="468" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>G</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="2695" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p><w:r><w:t>E-cont</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="6390" w:type="dxa"/><w:gridSpan w:val="3"/><w:vMerge/></w:tcPr><w:p><w:r><w:t>F-cont</w:t></w:r></w:p></w:tc>
</w:tr>
</w:tbl>
</w:body></w:document>`;
  const carrier = await exportDocxBytes({ type: "doc", content: [{ type: "paragraph" }] } as never, "carrier");
  const zin = await JSZip.loadAsync(await carrier.arrayBuffer());
  zin.file("word/document.xml", GRID_DOC);
  const html = (await importDocx(fileOf(await zin.generateAsync({ type: "arraybuffer" }), "grid.docx"))).html;
  // 468/15=31, 2227/15=148, 360/15=24, 90/15=6, 5940/15=396 px
  check("grid: narrow cols get own width", /<td[^>]*colwidth="31"[^>]*>/.test(html) && /<td[^>]*colwidth="148"[^>]*>/.test(html));
  check("grid: span-3 cell gets per-col widths", html.includes('colwidth="24,6,396"'));
  check("grid: span-2 cell after offset gets per-col widths", html.includes('colwidth="148,24"'));
  check("grid: span-3 at offset 3", html.includes('colwidth="6,396"'));
  check("grid: tcW total never used as colwidth", !html.includes('colwidth="426"') && !html.includes('colwidth="6390"'));
  // trHeight without hRule is a MINIMUM (atLeast) — must not hard-clip rows
  check("grid: trHeight atLeast → min-height", html.includes('min-height:20px'));
}

// Wingdings/Symbol bullet glyphs (numFmt=bullet + private-use lvlText) must
// become real Unicode markers — mammoth drops them to plain <ul> discs
{
  const JSZip = (await import("jszip")).default;
  const BUL_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>Private Company</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>Public Company</w:t></w:r></w:p>
</w:body></w:document>`;
  const BUL_NUM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>
<w:num w:numId="9"><w:abstractNumId w:val="7"/></w:num>
</w:numbering>`;
  const carrier = await exportDocxBytes({ type: "doc", content: [{ type: "paragraph" }] } as never, "carrier");
  const zin = await JSZip.loadAsync(await carrier.arrayBuffer());
  zin.file("word/document.xml", BUL_DOC);
  zin.file("word/numbering.xml", BUL_NUM);
  const html = (await importDocx(fileOf(await zin.generateAsync({ type: "arraybuffer" }), "bul.docx"))).html;
  check("bullet: Wingdings ü → ✓ glyph", html.includes("--kx-bullet:'✓'"));
  check("bullet: ul flagged", html.includes("<ul data-kx-bullet"));
  check("bullet: no private-use leak", !html.includes(""));
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
        A1: { v: "Item", s: { b: true, bg: "#F2782E" } }, B1: { v: "Amount" },
        A2: { v: "Revenue" }, B2: { v: 1200, s: { fmt: "#,##0.00" } },
        A3: { v: "Costs" }, B3: { v: 800 },
        A4: { v: "Profit" }, B4: { f: "B2-B3" },
        A6: { v: "merged" },
      }, merges: [{ c1: 0, r1: 5, c2: 2, r2: 5 }] as never,
        colWidths: { 1: 160 }, hiddenCols: [2],
        filter: { range: "A1:B4", cols: {} },
        freeze: { rows: 1, cols: 0 }, tabColor: "#4472C4",
        validations: [{ range: "A2:A10", type: "list", list: "Yes,No" }] as never,
        cf: [{ range: "B2:B4", type: "value", op: ">", value: 500, bg: "#FF0000" }] as never,
        tables: [{ name: "Sales", range: "A1:B4", style: "banded" }] as never,
      },
      { name: "Notes", cells: { A1: { v: "second sheet" } }, hidden: true },
    ],
    props: { title: "P&L Book", author: "Kreatix" },
    names: { TaxRate: "'P&L'!$B$2" },
    print: { orientation: "landscape", gridlines: true, header: "Confidential" },
    calc: { mode: "manual" },
  };
  const bytes = await workbookToXLSXBytes(wb as never);
  const back = await xlsxToWorkbook(fileOf(bytes, "book.xlsx"));
  check("xlsx: two sheets", back.sheets.length === 2 && back.sheets[0].name === "P&L");
  check("xlsx: values", back.sheets[0].cells.A2?.v === "Revenue" && back.sheets[0].cells.B2?.v === 1200);
  check("xlsx: formula survives", back.sheets[0].cells.B4?.f === "B2-B3");
  check("xlsx: second sheet text", back.sheets[1].cells.A1?.v === "second sheet");
  // S8 fidelity: styles + merges + widths + hidden + autofilter
  check("xlsx: bg style", back.sheets[0].cells.A1?.s?.bg?.toLowerCase() === "#f2782e");
  check("xlsx: numfmt", back.sheets[0].cells.B2?.s?.fmt === "#,##0.00");
  check("xlsx: merges", back.sheets[0].merges?.length === 1);
  check("xlsx: col width", back.sheets[0].colWidths?.[1] === 160);
  check("xlsx: hidden col", back.sheets[0].hiddenCols?.includes(2));
  check("xlsx: autofilter", back.sheets[0].filter?.range === "A1:B4");
  // deep styles via styles.xml side-channel + freeze + names + hidden
  check("xlsx: bold font", back.sheets[0].cells.A1?.s?.b === true);
  check("xlsx: freeze pane", back.sheets[0].freeze?.rows === 1);
  check("xlsx: defined name", back.names?.TaxRate === "'P&L'!$B$2");
  check("xlsx: hidden sheet", back.sheets[1].hidden === true);
  // export-side parity: validations, conditional formatting (+dxf), tables, print, calc
  check("xlsx: validation rt", back.sheets[0].validations?.[0]?.type === "list"
    && back.sheets[0].validations?.[0]?.list === "Yes,No");
  check("xlsx: cf rt", back.sheets[0].cf?.[0]?.type === "value"
    && back.sheets[0].cf?.[0]?.op === ">" && back.sheets[0].cf?.[0]?.value === 500);
  check("xlsx: cf dxf bg", !!back.sheets[0].cf?.[0]?.bg);
  check("xlsx: table rt", back.sheets[0].tables?.[0]?.name === "Sales"
    && back.sheets[0].tables?.[0]?.style === "banded");
  check("xlsx: print rt", back.print?.orientation === "landscape" && back.print?.gridlines === true);
  check("xlsx: calc rt", back.calc?.mode === "manual");
}

// ---------- XFDF ----------
{
  const { parseFdf } = await import("./src/pdf/fdf");
  const xfdf = `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots><highlight page="0" rect="100,700,200,720" color="#FF0000" title="Ann" contents="mark this" coords="100,720,200,720,100,700,200,700"/>
<line page="1" start="10,20" end="110,20" head="OpenArrow" color="#00FF00"/>
<text page="2" rect="50,50,60,60" title="Bob" contents="note here"/></annots></xfdf>`;
  const anns = parseFdf(xfdf);
  check("xfdf: highlight parsed", anns.some((a) => a.type === "highlight" && a.page === 1 && a.author === "Ann"));
  check("xfdf: line arrow", anns.some((a) => a.type === "arrow" && a.page === 2));
  check("xfdf: note", anns.some((a) => a.type === "note" && a.page === 3));
  // nested-dict FDF — the annot dict contains /Border <<>>; a lazy regex
  // would truncate at the inner >> and drop /Rect entirely
  const fdf = `%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [\n<< /Type /Annot /Subtype /Square /Page 0 /C [1 0 0] /Rect [10 20 110 120] /Border << /W 2 /S /S >> >>\n] >> >>\nendobj\n%%EOF\n`;
  const a2 = parseFdf(fdf);
  check("fdf: nested-dict annot", a2.length === 1 && a2[0].type === "rect" && a2[0].rects?.[0]?.[2] === 100);
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

// ---------- DOCX salvage / format guards ----------
{
  const JSZip = (await import("jszip")).default;
  const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const zipOf = async (documentXml: string, extra?: Record<string, string | Uint8Array>) => {
    const z = new JSZip();
    z.file("[Content_Types].xml", CT);
    z.file("_rels/.rels", RELS);
    z.file("word/document.xml", documentXml);
    for (const [k, v] of Object.entries(extra ?? {})) z.file(k, v);
    return z.generateAsync({ type: "arraybuffer" });
  };
  const doc = (body: string) =>
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  // text living only in a w:txbxContent text box must not open blank
  const txbx = await zipOf(doc(
    `${para("Body text.")}<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${para("Text box content.")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`));
  const txRes = await importDocx(fileOf(txbx, "textbox.docx"));
  check("docx: text box content imported", txRes.html.includes("Text box content."));

  // anchored objects: wp:anchor geometry must reach the text box node —
  // previously every box was flattened to a plain paragraph at the doc end
  const anchored = await zipOf(
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${para("Before.")}<w:p><w:r><w:drawing><wp:anchor behindDoc="0" layoutInCell="0" allowOverlap="1" relativeHeight="0" simplePos="0" locked="0" distT="0" distB="0" distL="0" distR="0"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>914400</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>457200</wp:posOffset></wp:positionV><wp:extent cx="1828800" cy="914400"/><wp:wrapSquare wrapText="bothSides"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx><w:txbxContent>${para("Boxed callout.")}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>${para("After.")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>`);
  const boxRes = await importDocx(fileOf(anchored, "anchored.docx"));
  check("docx: anchored text box → kx-textbox",
    boxRes.html.includes('data-type="kx-textbox"') && boxRes.html.includes("Boxed callout."));
  check("docx: anchored box keeps wrap + size",
    /data-wrap="square"/.test(boxRes.html) && /data-w="192"/.test(boxRes.html));
  check("docx: box renders at anchor position, not doc end",
    boxRes.html.indexOf("Boxed callout") < boxRes.html.indexOf("After."));

  // section vertical alignment: body-sectPr vAlign → first block; pPr-level
  // vAlign → the sectionBreak introducing that section
  const vaXml = await zipOf(
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para("S1 title")}<w:p><w:pPr><w:sectPr><w:vAlign w:val="center"/></w:sectPr></w:pPr></w:p>${para("S2 body")}<w:sectPr><w:vAlign w:val="bottom"/></w:sectPr></w:body></w:document>`);
  const vaRes = await importDocx(fileOf(vaXml, "valign.docx"));
  check("docx: first-section vAlign on first block",
    /<[a-z0-9]+[^>]*data-v-align="center"/.test(vaRes.html));
  check("docx: following-section vAlign on section break",
    /data-type="section-break"[^>]*data-v-align="bottom"/.test(vaRes.html));

  // settings.xml → doc-level setup flags
  const hyph = await zipOf(doc(para("Hyphenated document text.")), {
    "word/settings.xml": `<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:autoHyphenation/><w:hyphenationZone w:val="360"/><w:consecutiveHyphenLimit w:val="2"/><w:evenAndOddHeaders/></w:settings>`,
  });
  const hyRes = await importDocx(fileOf(hyph, "hyph.docx"));
  check("docx: autoHyphenation imported", hyRes.settings?.hyphenate === true);
  check("docx: hyphenationZone + limit + evenOdd", hyRes.settings?.hyphenZone === 24
    && hyRes.settings?.hyphenLimit === 2 && hyRes.settings?.evenOdd === true);

  // suppressAutoHyphens keeps a paragraph out of hyphenation
  const nh = await zipOf(doc(
    `<w:p><w:pPr><w:suppressAutoHyphens/></w:pPr><w:r><w:t>No hyphenation here.</w:t></w:r></w:p>`));
  const nhRes = await importDocx(fileOf(nh, "nh.docx"));
  check("docx: suppressAutoHyphens → hyphens:manual", nhRes.html.includes("hyphens:manual"));

  // vAlign must survive our own export → import round trip
  const vaDoc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Cover" }] },
    { type: "sectionBreak", attrs: { vAlign: "center" } },
    { type: "paragraph", content: [{ type: "text", text: "Body" }] },
  ] };
  const vaBlob = await exportDocxBytes(vaDoc as never, "va");
  const vaBack = await importDocx(fileOf(await vaBlob.arrayBuffer(), "va.docx"));
  check("docx: vAlign export→import round trip", vaBack.html.includes('data-v-align="center"'));

  // w:sdt content controls must be unwrapped, not dropped
  const sdt = await zipOf(doc(
    `<w:sdt><w:sdtPr/><w:sdtContent>${para("Content control text.")}</w:sdtContent></w:sdt>`));
  const sdtRes = await importDocx(fileOf(sdt, "sdt.docx"));
  check("docx: sdt content imported", sdtRes.html.includes("Content control text."));

  // legacy .doc (OLE compound) → descriptive error, not a blank document
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
  let oleMsg = "";
  await importDocx(fileOf(ole, "old.doc")).catch((e) => { oleMsg = (e as Error).message; });
  check("docx: .doc rejected with readable error", oleMsg.includes(".doc"));

  // RTF → descriptive error
  const rtf = new TextEncoder().encode("{\\rtf1\\ansi hello}");
  let rtfMsg = "";
  await importDocx(fileOf(rtf, "note.rtf")).catch((e) => { rtfMsg = (e as Error).message; });
  check("docx: .rtf rejected with readable error", rtfMsg.includes("RTF"));
}

// ---------- spellcheck dictionary ----------
{
  const fs = await import("node:fs");
  const { loadDictionary, checkWord, suggest, docVocabulary } = await import("./src/writer/proofing");
  await loadDictionary(
    fs.readFileSync("src/writer/dict-en/en_US.aff"),
    fs.readFileSync("src/writer/dict-en/en_US.dic"),
  );
  // words a real document uses that the old ~1.5k-word list flagged
  const common = ["platform", "development", "streaming", "infrastructure", "ownership",
    "stakeholders", "launching", "economically", "resilience", "proposal"];
  check("spellcheck: common words pass", common.every((w) => checkWord(w)));
  check("spellcheck: real typos still fail", !checkWord("platfrom") && !checkWord("infrastrcture"));
  const sugg = suggest("platfrom", docVocabulary(""), 5);
  check("spellcheck: suggestion offered", sugg.includes("platform"));
  // accepting a suggestion must clear the squiggle → every suggestion must
  // itself pass the checker
  check("spellcheck: suggestions all pass checkWord", sugg.every((s) => checkWord(s)));
  // doc-vocabulary must not feed flagged words back as suggestions
  const vocab = docVocabulary("platfrom is not a word and neither is qwzxv");
  check("spellcheck: doc vocab filtered", !vocab.has("platfrom") && !vocab.has("qwzxv"));
  check("spellcheck: proper nouns + acronyms pass", checkWord("Sairtek") && checkWord("NASA"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
