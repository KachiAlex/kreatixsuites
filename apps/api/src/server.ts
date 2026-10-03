import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { scimRoutes } from "./routes/scim.js";
import { driveRoutes } from "./routes/drive.js";
import { contentRoutes } from "./routes/content.js";
import { sharingRoutes } from "./routes/sharing.js";
import { commentRoutes } from "./routes/comments.js";
import { searchRoutes } from "./routes/search.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { ssoRoutes, ssoEnabled } from "./routes/sso.js";
import { samlRoutes } from "./routes/saml.js";
import { collabRoutes } from "./collab.js";
import { billingRoutes } from "./routes/billing.js";
import { superadminRoutes } from "./routes/superadmin.js";
import { ensureSubscription, effectiveState, ensureSuperAdmin, billingNotices, confirmPayment, paystackVerify, sweepPendingPaystack } from "./billing.js";
import { onResponseMetric } from "./metrics.js";
import { migrate, one } from "./db.js";
import { reindexAll } from "./indexer.js";
import { sweepRetention } from "./policies.js";
import { encryptionEnabled } from "./crypto.js";

/** Auth/session tokens must never land in access logs — strip the query
 *  params that carry them (?t= media auth, ?token= collab WS auth). */
const redactUrl = (url: string) =>
  url.replace(/([?&])(t|token)=[^&]*/g, "$1$2=[redacted]").replace(/[?&]$/, "");

/** Origins allowed to make credentialed cross-origin calls. Everything else
 *  gets no ACAO header — browsers still send the request but can't read it. */
function corsOrigins(): string[] {
  const out = new Set<string>([
    "http://localhost:5173", "http://127.0.0.1:5173", // vite dev
    "capacitor://localhost", "http://localhost", "https://localhost", // Capacitor shells
  ]);
  for (const v of [process.env.KREATIX_PUBLIC_URL, process.env.KREATIX_CORS_ORIGINS]) {
    for (const o of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      try { out.add(new URL(o).origin); } catch { /* not a URL — skip */ }
    }
  }
  return [...out];
}

async function main() {
  await migrate(); // Postgres schema — idempotent, auto-creates the database
  await ensureSuperAdmin(); // seeds admin@…/env-password if configured
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required in production");
  }
  const app = Fastify({
    bodyLimit: 50 * 1024 * 1024, trustProxy: true,
    logger: {
      serializers: {
        req(req) {
          return { method: req.method, url: redactUrl(req.url), hostname: req.hostname, remoteAddress: req.ip };
        },
      },
    },
  });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || corsOrigins().includes(origin)),
    credentials: true,
  });
  // Opt-in per-route limits (auth brute-force, share-link password, etc.) —
  // registered globally but disabled unless a route sets config.rateLimit.
  await app.register(rateLimit, { global: false });
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

  // Baseline security headers at the app layer so they hold regardless of the
  // fronting proxy (nginx sets the same set in deploy/ but isn't guaranteed).
  const CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
    "font-src 'self' data:; connect-src 'self' wss: ws:; worker-src 'self' blob:; " +
    "media-src 'self' blob: data:; frame-src 'self' https:; object-src 'none'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'self'; manifest-src 'self'";
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    if (!reply.getHeader("content-security-policy")) {
      reply.header("Content-Security-Policy", CSP);
    }
  });

  // ---- subscription write-gate ----
  // Locked workspaces keep read access (data is never held hostage) but all
  // mutations 402 until billing is settled. Auth/billing/admin paths stay open
  // — the admin needs them to fix the subscription.
  const GATE_EXEMPT = /^\/api\/(auth|billing|superadmin|admin)\b/;
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (!req.url.startsWith("/api/") || GATE_EXEMPT.test(req.url)) return;
    const header = req.headers.authorization;
    const cookieToken = (req.headers.cookie ?? "")
      .split(";").map((c) => c.trim()).find((c) => c.startsWith("kx_t="))?.slice(5);
    const token = header?.startsWith("Bearer ") ? header.slice(7) : cookieToken;
    if (!token) return; // requireAuth will handle the 401
    try {
      const { jwtVerify } = await import("jose");
      const { payload } = await jwtVerify(token, new TextEncoder().encode(
        process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production"));
      const user = await one<{ org_id: string }>("SELECT org_id FROM users WHERE id = $1", [payload.sub as string]);
      if (!user) return;
      const sub = await ensureSubscription(user.org_id);
      if (effectiveState(sub).state === "locked") {
        return reply.code(402).send({
          error: "subscription_locked",
          message: "Workspace subscription has expired — the workspace is read-only until billing is renewed.",
        });
      }
    } catch { /* invalid token → requireAuth 401s downstream */ }
  });

  app.get("/api/health", async () => ({ ok: true, service: "kreatix-api", ts: new Date().toISOString() }));

  /**
   * Paystack webhook — lives outside billingRoutes' requireAuth so Paystack can
   * reach it. Trust comes from re-verifying the transaction server-side rather
   * than the payload (a forged body just triggers a verify of a real ref).
   */
  app.post("/api/billing/paystack/webhook", async (req, reply) => {
    if (!process.env.KREATIX_PAYSTACK_SECRET) return reply.code(404).send({ error: "not_found" });
    const body = req.body as { event?: string; data?: { reference?: string } };
    const reference = body?.event === "charge.success" ? body.data?.reference : undefined;
    if (!reference) return { ok: true };
    const payment = await one<{ id: string; status: string }>(
      "SELECT id, status FROM payments WHERE reference = $1", [reference]);
    if (!payment || payment.status === "confirmed") return { ok: true };
    const v = await paystackVerify(reference);
    if (v.ok) await confirmPayment(payment.id, null);
    return { ok: true };
  });

  app.register(authRoutes);
  app.register(accountRoutes);
  app.register(scimRoutes);
  app.register(driveRoutes);
  app.register(contentRoutes);
  app.register(sharingRoutes);
  app.register(commentRoutes);
  app.register(searchRoutes);
  app.register(aiRoutes);
  app.register(adminRoutes);
  app.register(ssoRoutes);
  app.register(samlRoutes);
  app.register(billingRoutes);
  app.register(superadminRoutes);
  app.register(collabRoutes);

  // Production: serve the built SPA with client-side routing fallback
  const webDist = process.env.KREATIX_WEB_DIST ?? join(process.cwd(), "..", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDist,
      // explicit GET / route below picks index-landing vs index
      index: false,
      setHeaders(res, path) {
        // hashed bundles under /assets are immutable — cache forever;
        // everything else (index.html, manifest, icons) revalidates
        res.header("Cache-Control", path.includes("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache");
      },
    });
    // `/` serves the prerendered landing page (real HTML for crawlers/no-JS);
    // React mounts over it — identical markup for guests, redirect for auth.
    app.get("/", (_req, reply) => {
      const landing = existsSync(join(webDist, "index-landing.html"));
      return reply.header("Cache-Control", "no-cache").sendFile(landing ? "index-landing.html" : "index.html");
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

  // trash-retention sweep + billing notices (trial-ending / locked emails): daily
  const sweep = () => {
    sweepRetention()
      .then((purged) => { if (purged) app.log.info({ purged }, "retention sweep purged trashed items"); })
      .catch((e) => app.log.warn(e, "retention sweep failed"));
    billingNotices(app.log)
      .then((n) => { if (n.warned || n.locked) app.log.info(n, "billing notices sent"); })
      .catch((e) => app.log.warn(e, "billing notice sweep failed"));
  };
  setImmediate(sweep);
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();

  // pending-Paystack sweep every 5min — stands in for a shared webhook slot
  const paySweep = () => {
    sweepPendingPaystack(app.log)
      .then((n) => { if (n.confirmed) app.log.info(n, "paystack payments confirmed"); })
      .catch((e) => app.log.warn(e, "paystack sweep failed"));
  };
  setTimeout(paySweep, 30_000).unref();
  setInterval(paySweep, 5 * 60 * 1000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
