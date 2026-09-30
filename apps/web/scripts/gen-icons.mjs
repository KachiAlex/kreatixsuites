// Generates PNG brand assets from the SVG mark via @resvg/resvg-js (dev-only).
// Usage: node scripts/gen-icons.mjs   → writes into ../public/
import { Resvg } from "@resvg/resvg-js";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const ORANGE = "#F2782E";
const ORANGE_DARK = "#D45A14";
const INK = "#26221F";

// The K mark: vertical bar + chevron, drawn relative to a unit box.
const kMark = (x, y, w, h, color = "#fff") => `
  <rect x="${x + w * 0.05}" y="${y}" width="${w * 0.28}" height="${h}" rx="${w * 0.14}" fill="${color}"/>
  <path d="M${x + w * 0.95} ${y} L${x + w * 0.40} ${y + h * 0.5} L${x + w * 0.95} ${y + h} Z" fill="${color}"/>`;

const render = (svg, w, file) => {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: w },
    font: { fontFiles: ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf"], loadSystemFonts: true, defaultFontFamily: "Segoe UI" },
  }).render().asPng();
  writeFileSync(join(pub, file), png);
  console.log("wrote", file, png.length, "bytes");
  return png;
};

const favSvg = (size, rounded = true, scale = 0.72) => {
  const g = size * scale, off = (size - g) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" ${rounded ? `rx="${size * 0.22}"` : ""} fill="${ORANGE}"/>
    ${kMark(off, off + g * 0.04, g, g * 0.92)}
  </svg>`;
};

// --- favicons + touch + manifest icons ---
const png32 = render(favSvg(64), 32, "favicon-32.png");
const png16 = render(favSvg(64), 16, "favicon-16.png");
render(favSvg(180, false, 0.78), 180, "apple-touch-icon.png");
render(favSvg(512, true, 0.72), 192, "icon-192.png");
render(favSvg(512, true, 0.72), 512, "icon-512.png");
render(favSvg(512, false, 0.62), 512, "icon-maskable-512.png"); // full-bleed, safe-zone glyph

// --- favicon.ico = PNG-in-ICO container (Vista+) ---
const ico = (png, size) => {
  const head = Buffer.alloc(22); // 6-byte header + 16-byte dir entry
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(size >= 256 ? 0 : size, 6); head.writeUInt8(size >= 256 ? 0 : size, 7);
  head.writeUInt16LE(1, 12); head.writeUInt16LE(32, 14); // planes, bpp
  head.writeUInt32LE(png.length, 16); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
};
writeFileSync(join(pub, "favicon.ico"), ico(png32, 32));
console.log("wrote favicon.ico");

// --- og.png social card 1200×630 ---
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFF4EC"/>
      <stop offset="1" stop-color="#FFE3CC"/>
    </linearGradient>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ORANGE}"/>
      <stop offset="1" stop-color="${ORANGE_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1080" cy="80" r="220" fill="${ORANGE}" opacity="0.10"/>
  <circle cx="1120" cy="560" r="160" fill="${ORANGE}" opacity="0.08"/>
  <rect x="90" y="185" width="260" height="260" rx="58" fill="url(#tile)"/>
  ${kMark(90 + 260 * 0.17, 185 + 260 * 0.15, 260 * 0.66, 260 * 0.7)}
  <text x="400" y="300" font-family="Segoe UI" font-size="92" font-weight="800" fill="${INK}">Kreatix Suites</text>
  <text x="403" y="372" font-family="Segoe UI" font-size="38" font-weight="600" fill="#8B8480">AI-native office productivity suite</text>
  <text x="403" y="428" font-family="Segoe UI" font-size="30" font-weight="600" fill="${ORANGE_DARK}">Writer · Sheets · Present · PDF · Drive · AI</text>
</svg>`;
render(og, 1200, "og.png");

console.log("done");
