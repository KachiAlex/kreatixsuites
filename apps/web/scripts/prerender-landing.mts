// Prerenders the marketing landing page into dist/index-landing.html.
// Crawlers and no-JS visitors get full content; React mounts over it identically
// (LandingOrHome renders <Landing/> for guests, redirects authed users).
// Runs after `vite build` (chained in the build script).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { readFileSync, writeFileSync } from "node:fs";
import { Landing } from "../src/pages/Landing";

const dist = new URL("../dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const index = readFileSync(`${dist}/index.html`, "utf8");

const markup = renderToString(
  createElement(StaticRouter, { location: "/" }, createElement(Landing)),
);

// swap the boot splash inside #root for the real page
const out = index.replace(
  /(<div id="root">)[\s\S]*?(<\/div>\s*<noscript>)/,
  `$1${markup}$2`,
);
if (out === index) throw new Error("prerender: #root/splash marker not found in index.html");

writeFileSync(`${dist}/index-landing.html`, out);
console.log(`prerendered landing → index-landing.html (${(markup.length / 1024).toFixed(1)}KB markup)`);
