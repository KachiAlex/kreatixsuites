import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { authRoutes } from "./routes/auth.js";
import { driveRoutes } from "./routes/drive.js";
import { contentRoutes } from "./routes/content.js";
import { sharingRoutes } from "./routes/sharing.js";
import { commentRoutes } from "./routes/comments.js";
import { searchRoutes } from "./routes/search.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { ssoRoutes, ssoEnabled } from "./routes/sso.js";
import { collabRoutes } from "./collab.js";
import { onResponseMetric } from "./metrics.js";
import { migrate } from "./db.js";
import { reindexAll } from "./indexer.js";
import { sweepRetention } from "./policies.js";
import { encryptionEnabled } from "./crypto.js";

async function main() {
  await migrate(); // Postgres schema — idempotent, auto-creates the database
  const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });

  await app.register(cors, { origin: true, credentials: true });
  // br/gzip for JSON API + statics — the host nginx has no brotli module, so
  // compression lives in the app layer. SSE routes use reply.hijack() +
  // reply.raw, which bypasses compress hooks entirely.
  await app.register(compress, { encodings: ["br", "gzip", "deflate"], threshold: 1024 });
  await app.register(websocket);

  // Binary uploads arrive as raw buffers (JSON keeps the default parser)
  app.addContentTypeParser("*", (_req, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on("data", (c: Buffer) => chunks.push(c));
    payload.on("end", () => done(null, Buffer.concat(chunks)));
    payload.on("error", done);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "bad_request", message: err.issues[0]?.message ?? "Invalid input" });
    }
    if (err.statusCode) return reply.code(err.statusCode).send({ error: "error", message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal", message: "Internal server error" });
  });

  // lightweight request metrics for the admin observability surface
  app.addHook("onResponse", (_req, reply, done) => {
    onResponseMetric(reply.statusCode);
    done();
  });

  app.get("/api/health", async () => ({ ok: true, service: "kreatix-api", ts: new Date().toISOString() }));

  app.register(authRoutes);
  app.register(driveRoutes);
  app.register(contentRoutes);
  app.register(sharingRoutes);
  app.register(commentRoutes);
  app.register(searchRoutes);
  app.register(aiRoutes);
  app.register(adminRoutes);
  app.register(ssoRoutes);
  app.register(collabRoutes);

  // Production: serve the built SPA with client-side routing fallback
  const webDist = process.env.KREATIX_WEB_DIST ?? join(process.cwd(), "..", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders(res, path) {
        // hashed bundles under /assets are immutable — cache forever;
        // everything else (index.html, manifest, icons) revalidates
        res.header("Cache-Control", path.includes("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });

  // backfill the search index in the background (fast: JSON head blobs only)
  setImmediate(() => {
    reindexAll()
      .then((n) => app.log.info({ indexed: n }, "search index rebuilt"))
      .catch((e) => app.log.warn(e, "search reindex failed"));
  });

  app.log.info(
    { encryptionAtRest: encryptionEnabled(), sso: ssoEnabled },
    "security posture",
  );

  // trash-retention sweep: at boot, then daily
  const sweep = () => {
    sweepRetention()
      .then((purged) => { if (purged) app.log.info({ purged }, "retention sweep purged trashed items"); })
      .catch((e) => app.log.warn(e, "retention sweep failed"));
  };
  setImmediate(sweep);
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
