import type { Editor } from "@tiptap/react";
import { downloadBlob, baseName, type Json } from "./common";
import { jsonToMarkdown } from "./markdown";
import { rtfBlob } from "./rtf";
import { odtBlob } from "./odt";

export { mdToHtml } from "./markdown";

const PRINT_CSS = `
body{font-family:'Inter',Georgia,serif;font-size:11pt;line-height:1.6;color:#1a1a1a;max-width:700px;margin:40px auto;padding:0 20px}
h1{font-size:26pt}h2{font-size:20pt}h3{font-size:16pt}h4{font-size:13pt}h5,h6{font-size:11pt}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 8px}
blockquote{border-left:3px solid #ccc;padding-left:14px;margin-left:0;color:#444}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto}
code{font-family:'JetBrains Mono','Courier New',monospace}
img{max-width:100%}
ul[data-type=taskList]{list-style:none;padding-left:8px}
ul[data-type=taskList] li{list-style:none}
.page-break,.rm-page-break{page-break-after:always}
hr{border:none;border-top:1px solid #bbb}
@media print{body{max-width:none;margin:0}}
`;

/** Standalone .html file — embeds the editor-rendered HTML with print styles. */
export function downloadHtml(name: string, html: string) {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>${PRINT_CSS}</style></head><body>${html}</body></html>`;
  downloadBlob(new Blob([page], { type: "text/html" }), `${baseName(name)}.html`);
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

/** PDF export via a print-ready window — layout-faithful, uses the browser's PDF printer. */
export function exportPdf(html: string, name: string) {
  const win = window.open("", "_blank", "width=900,height=1200");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>${PRINT_CSS}</style></head><body>${html}<scr` + `ipt>window.onload=()=>{window.print()}</scr` + `ipt></body></html>`);
  win.document.close();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
