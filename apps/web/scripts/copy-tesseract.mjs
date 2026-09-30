// Copies tesseract.js runtime assets into public/tesseract/ so OCR is fully
// self-hosted (no CDN in CSP). Run automatically before `vite build`/`vite dev`.
//   worker.min.js                    — the OCR web worker
//   tesseract-core-simd-lstm.wasm.js — wasm+JS core (self-contained, SIMD LSTM)
//   eng.traineddata.gz               — English model (4.0.0_best_int, lstmOnly)
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const outDir = new URL("../public/tesseract", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(outDir, { recursive: true });

const req = createRequire(import.meta.url);
const tessPkg = dirname(req.resolve("tesseract.js/package.json"));
const reqTess = createRequire(join(tessPkg, "package.json"));
const corePkg = dirname(reqTess.resolve("tesseract.js-core/package.json"));

const copies = [
  [join(tessPkg, "dist", "worker.min.js"), join(outDir, "worker.min.js")],
  [join(corePkg, "tesseract-core-simd-lstm.wasm.js"), join(outDir, "tesseract-core-simd-lstm.wasm.js")],
];
for (const [src, dst] of copies) {
  if (!existsSync(dst) || statSync(src).size !== statSync(dst).size) {
    copyFileSync(src, dst);
    console.log(`tesseract: copied ${dst.split("/").pop()}`);
  }
}

// lang model — downloaded once (not bundled with the npm packages)
const langFile = join(outDir, "eng.traineddata.gz");
if (!existsSync(langFile)) {
  const url = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(langFile, Buffer.from(await res.arrayBuffer()));
  console.log("tesseract: downloaded eng.traineddata.gz");
}
console.log("tesseract assets ready");
