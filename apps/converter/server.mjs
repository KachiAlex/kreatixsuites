// Document converter — turns an uploaded .docx into a PDF with LibreOffice
// (headless). Internal service: reachable only on the compose network, never
// published. One conversion at a time keeps memory inside the container limit.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3100);
const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

let queue = Promise.resolve();

function convert(docx) {
  const dir = path.join(os.tmpdir(), `lo-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "in.docx");
  fs.writeFileSync(input, docx);
  return new Promise((resolve, reject) => {
    const proc = spawn("soffice", [
      `-env:UserInstallation=file://${dir}/profile`,
      "--headless", "--norestore", "--nolockcheck",
      "--convert-to", "pdf", "--outdir", dir, input,
    ], { stdio: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
    const finish = (err, data) => {
      clearTimeout(timer);
      fs.rm(dir, { recursive: true, force: true }, () => {});
      err ? reject(err) : resolve(data);
    };
    proc.on("error", (e) => finish(e));
    proc.on("exit", (code) => {
      const out = path.join(dir, "in.pdf");
      if (code === 0 && fs.existsSync(out)) finish(null, fs.readFileSync(out));
      else finish(new Error(`soffice exited with ${code}`));
    });
  });
}

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/convert") { res.writeHead(404).end(); return; }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) { tooLarge = true; res.writeHead(413).end(); req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => {
    if (tooLarge) return;
    queue = queue
      .then(() => convert(Buffer.concat(chunks)))
      .then(
        (pdf) => { res.writeHead(200, { "content-type": "application/pdf" }); res.end(pdf); },
        (e) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); },
      );
  });
  req.on("error", () => {});
}).listen(PORT, () => console.log(`converter listening on ${PORT}`));
