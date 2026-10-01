/**
 * Static audit: find menu/button items that declare a label but no action.
 * Scans tsx sources for `{ label: "..."` object literals lacking onClick/submenu/
 * custom/divider/href — the signature of a dead menu row. Prints file:line.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts)$/.test(f)) yield p;
  }
}

let hits = 0;
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  // find `{ label: ... }` literals; capture until matching close brace (roughly, by brace counting)
  let idx = 0;
  while ((idx = src.indexOf("{ label:", idx)) !== -1) {
    let depth = 1, i = idx + 1, inStr = "", esc = false;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === inStr) inStr = ""; }
      else if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    const body = src.slice(idx, i);
    const hasAction = /\bonClick\b|\bsubmenu\b|\bcustom\b|\bdivider\b|\bhref\b|\bchecked\b/.test(body);
    if (!hasAction) {
      const line = src.slice(0, idx).split("\n").length;
      const label = body.match(/label:\s*["'`]([^"'`]+)/)?.[1] ?? "?";
      console.log(`${relative(SRC, file)}:${line}  DEAD? "${label}"`);
      hits++;
    }
    idx = i;
  }
}
console.log(`\n${hits} suspicious label-only items`);
