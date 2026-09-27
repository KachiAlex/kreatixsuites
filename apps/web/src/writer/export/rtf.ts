import { textOf, hasMark, isText, type Block, type Inline, type Json } from "./common";

/** TipTap JSON → RTF 1.9 (Word/LibreOffice compatible). */

const escRtf = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
    .replace(/\n/g, "\\line ")
    .replace(/[^\x00-\x7F]/g, (c) => `\\u${c.codePointAt(0)! > 0x7FFF ? (c.codePointAt(0)! - 65536) : c.codePointAt(0)}?`);

function hexToRtf(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

export function jsonToRtf(doc: Block, title: string): string {
  // collect colors + fonts for the tables
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  const colorIdx = (hex: string | undefined) => {
    if (!hex) return 0;
    if (!colors.has(hex)) colors.set(hex, colors.size + 1);
    return colors.get(hex)!;
  };
  const fontIdx = (fam: string | undefined) => {
    const f = (fam ?? "").replace(/['"]/g, "").split(",")[0].trim() || "Arial";
    if (!fonts.has(f)) fonts.set(f, fonts.size);
    return fonts.get(f)!;
  };

  const scan = (n: Block | Inline) => {
    if (isText(n)) {
      const ts = hasMark(n, "textStyle");
      if (ts?.attrs?.color) colorIdx(ts.attrs.color as string);
      if (ts?.attrs?.fontFamily) fontIdx(ts.attrs.fontFamily as string);
    }
    ((n as Block).content ?? []).forEach(scan);
  };
  (doc.content ?? []).forEach(scan);
  fontIdx(undefined); // ensure f0 exists

  const fontTable = [...fonts.keys()].map((f, i) => `{\\f${i}\\fnil ${f};}`).join("");
  const colorTable = [...colors.keys()].map((hex) => {
    const c = hexToRtf(hex)!;
    return `\\red${c.r}\\green${c.g}\\blue${c.b};`;
  }).join("");

  const runs = (nodes: Inline[] | undefined): string =>
    (nodes ?? []).map((n) => {
      if (n.type === "hardBreak") return "\\line ";
      if (n.type === "inlineMath") return `{\\i ${escRtf((n.attrs?.latex as string) ?? "")}}`;
      if (!isText(n)) return "";
      const ts = hasMark(n, "textStyle");
      const link = hasMark(n, "link");
      const size = (ts?.attrs?.fontSize as string) ? `\\fs${Math.round(parseInt(ts!.attrs!.fontSize as string) * 2)}` : "";
      const open =
        (hasMark(n, "bold") ? "\\b " : "") +
        (hasMark(n, "italic") ? "\\i " : "") +
        (hasMark(n, "underline") ? "\\ul " : "") +
        (hasMark(n, "strike") ? "\\strike " : "") +
        (hasMark(n, "code") ? `\\f${fontIdx("Courier New")} ` : "") +
        (hasMark(n, "superscript") ? "\\super " : "") +
        (hasMark(n, "subscript") ? "\\sub " : "") +
        (ts?.attrs?.color ? `\\cf${colorIdx(ts.attrs.color as string)} ` : "") +
        (ts?.attrs?.fontFamily ? `\\f${fontIdx(ts.attrs.fontFamily as string)} ` : "") +
        size + (size ? " " : "");
      const text = link
        ? `{\\field{\\*\\fldinst HYPERLINK "${link.attrs?.href}"}{\\fldrslt ${escRtf(n.text)}}}`
        : escRtf(n.text);
      return open ? `{${open}${text}}` : text;
    }).join("");

  const blockRtf = (node: Block, depth = 0): string => {
    switch (node.type) {
      case "heading": {
        const lvl = (node.attrs?.level as number) ?? 1;
        const fs = [56, 44, 36, 30, 26, 24][lvl - 1] ?? 24;
        return `\\par\\pard\\fs${fs}\\b ${runs(node.content as Inline[])}\\b0\\fs24\\par`;
      }
      case "paragraph": {
        const a = node.attrs?.textAlign;
        const align = a === "center" ? "\\qc" : a === "right" ? "\\qr" : a === "justify" ? "\\qj" : "\\ql";
        const indent = (node.attrs?.indent as number) ? `\\li${(node.attrs!.indent as number) * 480}` : "";
        return `\\pard${align}${indent} ${runs(node.content as Inline[])}\\par`;
      }
      case "blockquote":
        return (node.content as Block[]).map(blockRtf).join("")
          .replace(/^/, "\\pard\\li400 ");
      case "bulletList":
        return (node.content as Block[]).map((li) =>
          `\\pard\\li${360 + depth * 360}\\fi-180 \\bullet  ${(li.content as Block[]).map((c) => c.type === "paragraph" ? runs(c.content as Inline[]) : blockRtf(c, depth + 1)).join("")}\\par`).join("");
      case "orderedList":
        return (node.content as Block[]).map((li, i) =>
          `\\pard\\li${360 + depth * 360}\\fi-180 ${i + 1}.  ${(li.content as Block[]).map((c) => c.type === "paragraph" ? runs(c.content as Inline[]) : blockRtf(c, depth + 1)).join("")}\\par`).join("");
      case "taskList":
        return (node.content as Block[]).map((li) =>
          `\\pard\\li360\\fi-180 ${li.attrs?.checked ? "\\'02" : "\\'a8"}  ${(li.content as Block[]).map((c) => c.type === "paragraph" ? runs(c.content as Inline[]) : blockRtf(c)).join("")}\\par`).join("");
      case "codeBlock":
        return `\\pard\\f${fontIdx("Courier New")} ${escRtf(textOf(node))}\\par`;
      case "horizontalRule": case "pageBreak":
        return node.type === "pageBreak" ? "\\page" : "\\par\\pard\\brdrb\\brdrs \\par";
      case "table":
        return (node.content as Block[]).map((r) =>
          `\\pard ${(r.content as Block[]).map((c) =>
            `${((c.content ?? []) as Block[]).map((b) => b.type === "paragraph" ? runs(b.content as Inline[]) : blockRtf(b)).join("")}\\tab`).join("")}\\par`).join("");
      case "image":
        return `\\pard [image: ${escRtf((node.attrs?.alt as string) || (node.attrs?.src as string) || "")}]\\par`;
      case "blockMath":
        return `\\pard\\qc\\i ${escRtf((node.attrs?.latex as string) ?? "")}\\par`;
      default:
        return `\\pard ${runs(node.content as Inline[] | undefined)}\\par`;
    }
  };

  const body = (doc.content ?? []).map((n) => blockRtf(n as Block)).join("\n");
  return `{\\rtf1\\ansi\\deff0{\\fonttbl${fontTable}}{\\colortbl;${colorTable}}{\\info{\\title ${escRtf(title)}}{\\author Kreatix Writer}}\\fs28\n${body}\n}`;
}

export function rtfBlob(doc: Json, title: string): Blob {
  return new Blob([jsonToRtf(doc as unknown as Block, title)], { type: "application/rtf" });
}
