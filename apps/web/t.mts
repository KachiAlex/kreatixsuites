import { exportDocxBytes, importDocx } from "./src/writer/docx";
const doc = { type:"doc", content:[{ type:"table", attrs:{align:"center",widthMode:"pct",widthPct:60}, content:[{type:"tableRow",content:[{type:"tableCell",content:[{type:"paragraph",content:[{type:"text",text:"x"}]}]}]}]}] };
const blob = await exportDocxBytes(doc as never,"t");
const JSZip=(await import("jszip")).default;
const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml")!.async("text");
console.log("TBLPR:", xml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] ?? "none");
const html = await importDocx(new File([await blob.arrayBuffer()], "t.docx"));
console.log("TABLE TAG:", html.match(/<table[^>]*>/)?.[0] ?? "none");
