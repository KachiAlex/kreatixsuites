import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Public installer downloads. Binaries live in $KREATIX_DATA_DIR/downloads/
 *  (a compose volume — survives rebuilds and stays out of the image). The
 *  route streams them through the app so any proxy/front-end setup works
 *  without extra config; newest matching file wins. */
const DIR = join(process.env.KREATIX_DATA_DIR ?? "data", "downloads");

const PLATFORMS = {
  desktop: { rx: /\.exe$/i, mime: "application/vnd.microsoft.portable-executable" },
  android: { rx: /app-release.*\.apk$|\.apk$/i, mime: "application/vnd.android.package-archive" },
} as const;

type Platform = keyof typeof PLATFORMS;

interface DownloadEntry { name: string; size: number; updatedAt: number; version: string | null }

async function latest(rx: RegExp): Promise<DownloadEntry | null> {
  try {
    const files = await readdir(DIR);
    let best: DownloadEntry | null = null;
    for (const f of files) {
      if (!rx.test(f)) continue;
      const s = await stat(join(DIR, f)).catch(() => null);
      if (!s) continue;
      const v = /(\d+\.\d+\.\d+)/.exec(f)?.[1] ?? null;
      if (!best || s.mtimeMs > best.updatedAt) {
        best = { name: f, size: s.size, updatedAt: s.mtimeMs, version: v };
      }
    }
    return best;
  } catch {
    return null; // downloads dir doesn't exist yet
  }
}

export function downloadRoutes(app: FastifyInstance) {
  /** Manifest for the /download page — what installers exist + metadata. */
  app.get("/api/downloads", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async () => {
    const [desktop, android] = await Promise.all([
      latest(PLATFORMS.desktop.rx), latest(PLATFORMS.android.rx),
    ]);
    return { desktop, android };
  });

  /** Stream the newest installer for a platform. */
  app.get("/api/downloads/:platform", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const platform = (req.params as { platform: string }).platform as Platform;
    const cfg = PLATFORMS[platform];
    if (!cfg) return reply.code(404).send({ error: "not_found" });
    const entry = await latest(cfg.rx);
    if (!entry) return reply.code(404).send({ error: "not_found", message: "No installer published yet" });
    return reply
      .header("content-type", cfg.mime)
      .header("content-disposition", `attachment; filename="${entry.name}"`)
      .header("content-length", String(entry.size))
      .header("cache-control", "public, max-age=300")
      .send(createReadStream(join(DIR, entry.name)));
  });
}
