import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { authRoutes } from "./routes/auth.js";
import { driveRoutes } from "./routes/drive.js";
import { contentRoutes } from "./routes/content.js";
import { sharingRoutes } from "./routes/sharing.js";
import { commentRoutes } from "./routes/comments.js";
import { searchRoutes } from "./routes/search.js";

const app = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });

await app.register(cors, { origin: true, credentials: true });

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

app.get("/api/health", async () => ({ ok: true, service: "kreatix-api", ts: new Date().toISOString() }));

app.register(authRoutes);
app.register(driveRoutes);
app.register(contentRoutes);
app.register(sharingRoutes);
app.register(commentRoutes);
app.register(searchRoutes);

// Production: serve the built SPA with client-side routing fallback
const webDist = process.env.KREATIX_WEB_DIST ?? join(process.cwd(), "..", "web", "dist");
if (existsSync(join(webDist, "index.html"))) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
