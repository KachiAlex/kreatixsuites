import JSZip from "jszip";
import { textOf, hasMark, isText, type Block, type Inline, type Json } from "./common";

/** TipTap JSON → minimal .odt (OpenDocument Text — zip package). */

const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function spans(nodes: Inline[] | undefined, listStyle = ""): string {
  return (nodes ?? []).map((n) => {
    if (n.type === "hardBreak") return "<text:line-break/>";
    if (n.type === "inlineMath") return `<text:span>${escXml((n.attrs?.latex as string) ?? "")}</text:span>`;
    if (!isText(n)) return "";
    const styles: string[] = [];
    if (hasMark(n, "bold")) styles.push("B");
    if (hasMark(n, "italic")) styles.push("I");
    if (hasMark(n, "underline")) styles.push("U");
    if (hasMark(n, "strike")) styles.push("ST");
    if (hasMark(n, "code") || hasMark(n, "superscript") || hasMark(n, "subscript")) styles.push("M");
    const ts = hasMark(n, "textStyle");
    const href = hasMark(n, "link")?.attrs?.href as string | undefined;
    let inner = escXml(n.text);
    if (href) inner = `<text:a xlink:href="${escXml(href)}" xlink:type="simple">${inner}</text:a>`;
    const key = styles.sort().join("") + (ts?.attrs?.color ?? "") + (ts?.attrs?.fontFamily ?? "") + (ts?.attrs?.fontSize ?? "");
    if (key) inner = `<text:span text:style-name="K_${listStyle}${hash(key)}">${inner}</text:span>`;
    return inner;
  }).join("");
}

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

function blockXml(node: Block, depth = 0): string {
  switch (node.type) {
    case "heading": {
      const lvl = Math.min(6, (node.attrs?.level as number) ?? 1);
      return `<text:h text:style-name="Heading_${lvl}" text:outline-level="${lvl}">${spans(node.content as Inline[])}</text:h>`;
    }
    case "paragraph": {
      const a = node.attrs?.textAlign;
      const st = a && a !== "left" ? ` text:style-name="P_${a}"` : "";
      return `<text:p${st}>${spans(node.content as Inline[])}</text:p>`;
    }
    case "blockquote":
      return (node.content as Block[]).map(blockXml).join("");
    case "bulletList": case "taskList":
      return `<text:list text:style-name="L1">${(node.content as Block[]).map((li) =>
        `<text:list-item>${(li.content as Block[]).map((c) => blockXml(c, depth + 1)).join("")}</text:list-item>`).join("")}</text:list>`;
    case "orderedList":
      return `<text:list text:style-name="L2">${(node.content as Block[]).map((li) =>
        `<text:list-item>${(li.content as Block[]).map((c) => blockXml(c, depth + 1)).join("")}</text:list-item>`).join("")}</text:list>`;
    case "codeBlock":
      return `<text:p text:style-name="Pre">${escXml(textOf(node))}</text:p>`;
    case "horizontalRule": case "pageBreak":
      return node.type === "pageBreak"
        ? `<text:p text:style-name="PageBreak"/>`
        : `<text:p text:style-name="HR"/>`;
    case "table": {
      const rows = (node.content ?? []) as Block[];
      const cols = Math.max(...rows.map((r) => (r.content?.length ?? 0)));
      return `<table:table table:name="t">${Array.from({ length: cols }, () => "<table:table-column/>").join("")}${rows.map((r) =>
        `<table:table-row>${((r.content ?? []) as Block[]).map((c) =>
          `<table:table-cell office:value-type="string">${((c.content ?? []) as Block[]).map((b) => blockXml(b)).join("")}</table:table-cell>`).join("")}</table:table-row>`).join("")}</table:table>`;
    }
    case "image":
      return `<text:p>[image]</text:p>`;
    case "blockMath":
      return `<text:p text:style-name="Pre">${escXml((node.attrs?.latex as string) ?? "")}</text:p>`;
    default:
      return `<text:p>${spans(node.content as Inline[] | undefined)}</text:p>`;
  }
}

export async function odtBlob(doc: Json, title: string): Promise<Blob> {
  const body = ((doc.content ?? []) as Block[]).map((n) => blockXml(n)).join("\n");

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
<office:automatic-styles>
<style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="P_center" style:family="paragraph"><style:paragraph-properties fo:text-align="center" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
<style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="P_right" style:family="paragraph"><style:paragraph-properties fo:text-align="end" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
<style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="P_justify" style:family="paragraph"><style:paragraph-properties fo:text-align="justify" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
<style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="Pre" style:family="paragraph"><style:text-properties style:font-name="Courier New" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"/></style:style>
<style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" style:name="PageBreak" style:family="paragraph"><style:paragraph-properties fo:page-break-before="always" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"/></style:style>
</office:automatic-styles>
<office:body><office:text>${body}</office:text></office:body>
</office:document-content>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
<office:styles>
<style:style style:name="Standard" style:family="paragraph"/>
${[1, 2, 3, 4, 5, 6].map((l) => `<style:style style:name="Heading_${l}" style:family="paragraph"><style:text-properties fo:font-weight="bold" fo:font-size="${[28, 22, 18, 15, 13, 12][l - 1]}pt"/></style:style>`).join("\n")}
<style:style style:name="L1" style:family="text"><text:list-style/></style:style>
</office:styles>
</office:document-styles>`;

  const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

  const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
<office:meta><dc:title>${escXml(title)}</dc:title></office:meta>
</office:document-meta>`;

  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file("content.xml", contentXml);
  zip.file("styles.xml", stylesXml);
  zip.file("meta.xml", metaXml);
  zip.file("META-INF/manifest.xml", manifestXml);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.oasis.opendocument.text" });
}
