// Copies pdf.js viewer icon assets into public/pdfjs-images/ so the scoped
// pdf_viewer.css (injected via ?inline) can reach them at /pdfjs-images/*.
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "web", "images");
const dst = path.join(here, "..", "public", "pdfjs-images");

mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("pdf.js viewer icons →", path.relative(process.cwd(), dst));
