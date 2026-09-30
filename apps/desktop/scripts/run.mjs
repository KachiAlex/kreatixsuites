// Launcher — spawns Electron with a clean env. Some dev machines export
// ELECTRON_RUN_AS_NODE globally, which would run the main entry under plain
// Node instead of the Electron runtime.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronBin = require("electron"); // path to the binary
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [root, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
