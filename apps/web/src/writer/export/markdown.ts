import { textOf, hasMark, isText, type Block, type Inline } from "./common";

/** TipTap JSON → Markdown. */
export function jsonToMarkdown(doc: Block): string {
  return (doc.content ?? []).map(blockToMd).filter(Boolean).join("\n\n").trim() + "\n";
}

function blockToMd(node: Block, depth = 0): string {
  const pad = "  ".repeat(depth);
  switch (node.type) {
    case "heading": {
      const lvl = (node.attrs?.level as number) ?? 1;
      return `${pad}${"#".repeat(lvl)} ${inlineMd(node.content as Inline[])}`;
    }
    case "paragraph":
      return pad + inlineMd(node.content as Inline[]);
    case "blockquote":
      return (node.content as Block[]).map((b) => `> ${blockToMd(b, depth)}`).join("\n>\n");
    case "bulletList":
      return (node.content as Block[]).map((li) => listItemMd(li, "- ", depth)).join("\n");
    case "orderedList":
      return (node.content as Block[]).map((li, i) => listItemMd(li, `${i + 1}. `, depth)).join("\n");
    case "taskList":
      return (node.content as Block[]).map((li) => {
        const box = li.attrs?.checked ? "[x] " : "[ ] ";
        return listItemMd(li, `${box}`, depth);
      }).join("\n");
    case "codeBlock":
      return `${pad}\`\`\`${(node.attrs?.language as string) ?? ""}\n${textOf(node)}\n${pad}\`\`\``;
    case "horizontalRule": case "pageBreak":
      return `${pad}---`;
    case "table":
      return tableMd(node);
    case "image":
      return `${pad}![${(node.attrs?.alt as string) ?? ""}](${(node.attrs?.src as string) ?? ""})`;
    case "blockMath":
      return `${pad}$$\n${(node.attrs?.latex as string) ?? ""}\n${pad}$$`;
    default:
      return pad + inlineMd(node.content as Inline[] | undefined);
  }
}

function listItemMd(li: Block, marker: string, depth: number): string {
  const pad = "  ".repeat(depth);
  const parts: string[] = [];
  for (const c of (li.content ?? []) as Block[]) {
    if (c.type === "paragraph") parts.push(`${pad}${marker}${inlineMd(c.content as Inline[])}`);
    else parts.push(blockToMd(c, depth + 1));
  }
  return parts.join("\n");
}

function tableMd(node: Block): string {
  const rows = (node.content ?? []) as Block[];
  if (!rows.length) return "";
  const cells = rows.map((r) =>
    ((r.content ?? []) as Block[]).map((c) =>
      ((c.content ?? []) as Block[]).map((b) => textOf(b)).join(" ")));
  const width = Math.max(...cells.map((r) => r.length));
  const lines = cells.map((r) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`);
  lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
  return lines.join("\n");
}

function inlineMd(nodes: Inline[] | undefined): string {
  return (nodes ?? []).map((n) => {
    if (n.type === "hardBreak") return "  \n";
    if (n.type === "inlineMath") return `$${(n.attrs?.latex as string) ?? ""}$`;
    if (!isText(n)) return "";
    let s = n.text;
    if (hasMark(n, "code")) s = `\`${s}\``;
    if (hasMark(n, "bold")) s = `**${s}**`;
    if (hasMark(n, "italic")) s = `*${s}*`;
    if (hasMark(n, "strike")) s = `~~${s}~~`;
    if (hasMark(n, "subscript")) s = `<sub>${s}</sub>`;
    if (hasMark(n, "superscript")) s = `<sup>${s}</sup>`;
    const link = hasMark(n, "link");
    if (link) s = `[${s}](${link.attrs?.href ?? ""})`;
    return s;
  }).join("");
}

/** Minimal Markdown → HTML for import (headings, bold/italic/code, lists, quotes, hr, code fences). */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const inline = (s: string) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const out: string[] = [];
  const lines = md.split("\n");
  let list: string | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeList();
      const lang = fence[1];
      const buf: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i]);
      out.push(`<pre><code class="language-${lang}">${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^---+\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    const q = line.match(/^>\s?(.*)/);
    if (q) { closeList(); out.push(`<blockquote><p>${inline(q[1])}</p></blockquote>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    const task = line.match(/^\s*\[([ xX])\]\s+(.*)/);
    if (task) {
      if (list !== "ul") { closeList(); out.push('<ul data-type="taskList">'); list = "ul"; }
      out.push(`<li data-type="taskItem" data-checked="${task[1] !== " "}"><p>${inline(task[2])}</p></li>`);
      continue;
    }
    if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (line.trim() === "") { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}
