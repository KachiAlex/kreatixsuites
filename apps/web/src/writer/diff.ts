// Compare-lite: word-level diff between two plain-text versions, emitted as
// TipTap JSON carrying insertion/deletion marks (the same marks the
// track-changes extension renders, so the result looks like a reviewed doc).

type Mark = { type: "insertion" | "deletion"; attrs: Record<string, string> };
interface TText { type: "text"; text: string; marks?: Mark[] }
interface TPara { type: "paragraph"; content: TText[] }

const mark = (type: Mark["type"], id: number): Mark => ({
  type,
  attrs: {
    changeId: `cmp-${id}`, authorId: "compare", authorName: "Compare",
    authorColor: "#9333ea", timestamp: new Date().toISOString(),
  },
});

/** Classic LCS diff on a token sequence — returns op list. */
function lcsDiff(a: string[], b: string[]): { op: "eq" | "del" | "ins"; tok: string }[] {
  const n = a.length, m = b.length;
  // trim memory: use Int32 table only when the product is reasonable
  if (n * m > 4_000_000) {
    // huge inputs: fall back to whole-paragraph replace
    return [...a.map((t) => ({ op: "del" as const, tok: t })), ...b.map((t) => ({ op: "ins" as const, tok: t }))];
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
  const out: { op: "eq" | "del" | "ins"; tok: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: "eq", tok: a[i] }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { out.push({ op: "del", tok: a[i] }); i++; }
    else { out.push({ op: "ins", tok: b[j] }); j++; }
  }
  while (i < n) out.push({ op: "del", tok: a[i++] });
  while (j < m) out.push({ op: "ins", tok: b[j++] });
  return out;
}

const tokenize = (s: string) => s.match(/\S+|\s+/g) ?? [];

/** Paragraph-level alignment: pair up matching paragraphs, then word-diff each pair. */
export function diffDocs(oldText: string, newText: string): { type: "doc"; content: TPara[] } {
  const aParas = oldText.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean);
  const bParas = newText.split(/\n{2,}|\n/).map((s) => s.trim()).filter(Boolean);
  // align paragraphs via LCS on trimmed text
  const ops = lcsDiff(aParas, bParas);
  const out: TPara[] = [];
  let changeId = 1;
  const paraOf = (chunks: TText[]) => ({ type: "paragraph" as const, content: chunks.length ? chunks : [{ type: "text" as const, text: " " }] });
  const markedPara = (text: string, type: Mark["type"]) =>
    paraOf([{ type: "text", text, marks: [mark(type, changeId++)] }]);

  // walk ops; adjacent del+ins runs are word-diffed together
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === "eq") { out.push(paraOf([{ type: "text", text: ops[k].tok }])); k++; continue; }
    const dels: string[] = [], inss: string[] = [];
    while (k < ops.length && ops[k].op !== "eq") {
      (ops[k].op === "del" ? dels : inss).push(ops[k].tok); k++;
    }
    const pairs = Math.min(dels.length, inss.length);
    for (let i = 0; i < pairs; i++) {
      // word-level diff inside the aligned pair
      const wops = lcsDiff(tokenize(dels[i]), tokenize(inss[i]));
      const chunks: TText[] = [];
      for (const w of wops) {
        if (w.op === "eq") chunks.push({ type: "text", text: w.tok });
        else chunks.push({ type: "text", text: w.tok, marks: [mark(w.op === "ins" ? "insertion" : "deletion", changeId)] });
      }
      changeId++;
      out.push(paraOf(chunks));
    }
    for (const d of dels.slice(pairs)) out.push(markedPara(d, "deletion"));
    for (const s of inss.slice(pairs)) out.push(markedPara(s, "insertion"));
  }
  return { type: "doc", content: out };
}

/** Plain text of a TipTap doc (paragraph-separated). */
export function docText(doc: { descendants?: (cb: (n: { isText?: boolean; text?: string; isBlock?: boolean }, pos: number) => boolean | void) => void } | null): string {
  if (!doc?.descendants) return "";
  const paras: string[] = [];
  let cur: string[] = [];
  doc.descendants((n) => {
    if (n.isText && n.text) cur.push(n.text);
    if (n.isBlock && cur.length) { paras.push(cur.join("")); cur = []; }
    return true;
  });
  if (cur.length) paras.push(cur.join(""));
  return paras.join("\n");
}
