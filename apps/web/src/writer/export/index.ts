import type { Editor } from "@tiptap/react";
import katexCssUrl from "katex/dist/katex.min.css?url";
import { downloadBlob, baseName, type Json } from "./common";
import { jsonToMarkdown } from "./markdown";
import { rtfBlob } from "./rtf";
import { odtBlob } from "./odt";
import type { PageSetup } from "../PageSetup";

export { mdToHtml } from "./markdown";

// KaTeX ships as a hashed asset — reference it by URL (not inline) so the
// relative font paths inside it still resolve.
const katexHref = new URL(katexCssUrl, location.origin).href;

const PRINT_CSS = `
body{font-family:'Inter',Georgia,serif;font-size:11pt;line-height:1.6;color:#1a1a1a;max-width:700px;margin:40px auto;padding:0 20px}
h1{font-size:26pt}h2{font-size:20pt}h3{font-size:16pt}h4{font-size:13pt}h5,h6{font-size:11pt}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 8px}
blockquote{border-left:3px solid #ccc;padding-left:14px;margin-left:0;color:#444}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto}
code{font-family:'JetBrains Mono','Courier New',monospace}
img{max-width:100%}
ul[data-type=taskList]{list-style:none;padding-left:8px}
ul[data-type=taskList] li{list-style:none;display:flex;gap:8px}
ul[data-type=taskList] li[data-checked=true]>div{text-decoration:line-through;color:#888}
.page-break,.rm-page-break{page-break-after:always}
hr{border:none;border-top:1px solid #bbb}
.doc-image figcaption{font-size:10pt;color:#666;text-align:center}
.doc-image.align-center img{margin:0 auto;display:block}
.doc-image.align-left{float:left;margin:4px 14px 8px 0}
.doc-image.align-right{float:right;margin:4px 0 8px 14px}
.doc-toc{border:1px solid #ddd;border-radius:8px;padding:12px 16px;background:#fafafa}
.doc-embed iframe{width:100%;aspect-ratio:16/9;border:1px solid #ccc}
pre code{white-space:pre-wrap}
@media print{body{max-width:none;margin:0}}
`;

/** @page rule matching the doc's page setup so print/PDF honors size + margins. */
function pageRule(setup?: PageSetup): string {
  if (!setup) return "";
  const mm = (px: number) => `${(px * 25.4 / 96).toFixed(1)}mm`;
  const size = setup.width >= setup.height ? `${mm(setup.width)} ${mm(setup.height)}` : `${mm(setup.width)} ${mm(setup.height)}`;
  return `@page{size:${size};margin:${mm(setup.marginTop)} ${mm(setup.marginRight)} ${mm(setup.marginBottom)} ${mm(setup.marginLeft)}}`;
}

function pageShell(name: string, html: string, setup?: PageSetup): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)}</title>` +
    `<link rel="stylesheet" href="${katexHref}">` +
    `<style>${pageRule(setup)}${PRINT_CSS}</style></head><body>${html}</body></html>`;
}

/** Standalone .html file — embeds the editor-rendered HTML with print styles. */
export function downloadHtml(name: string, html: string, setup?: PageSetup) {
  downloadBlob(new Blob([pageShell(name, html, setup)], { type: "text/html" }), `${baseName(name)}.html`);
}

export function downloadMd(doc: Json, name: string) {
  downloadBlob(new Blob([jsonToMarkdown(doc as never)], { type: "text/markdown" }), `${baseName(name)}.md`);
}

export function downloadTxt(editor: Editor, name: string) {
  downloadBlob(new Blob([editor.getText({ blockSeparator: "\n\n" })], { type: "text/plain" }), `${baseName(name)}.txt`);
}

export function downloadRtf(doc: Json, name: string) {
  downloadBlob(rtfBlob(doc, name), `${baseName(name)}.rtf`);
}

export async function downloadOdt(doc: Json, name: string) {
  downloadBlob(await odtBlob(doc, name), `${baseName(name)}.odt`);
}

/** PDF export via a print-ready window — honors the doc's page setup and renders KaTeX. */
export function exportPdf(html: string, name: string, setup?: PageSetup) {
  const win = window.open("", "_blank", "width=900,height=1200");
  if (!win) return;
  win.document.write(pageShell(name, html, setup).replace("</body>", `<scr` + `ipt>window.onload=()=>{setTimeout(()=>window.print(),300)}</scr` + `ipt></body>`));
  win.document.close();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
