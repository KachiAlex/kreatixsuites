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
import { siteRoutes } from "./routes/sites.js";
import { contentRoutes } from "./routes/content.js";
import { sharingRoutes } from "./routes/sharing.js";
import { commentRoutes } from "./routes/comments.js";
import { searchRoutes } from "./routes/search.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes, integrationAdminRoutes, brandingRoutes } from "./routes/admin.js";
import { ssoRoutes, ssoEnabled } from "./routes/sso.js";
import { samlRoutes } from "./routes/saml.js";
import { collabRoutes } from "./collab.js";
import { mailRoutes } from "./routes/mail.js";
import { meetRoutes, meetIngestRoutes } from "./routes/meet.js";
import { chatRoutes } from "./routes/chat.js";
import { calendarRoutes, sweepCalendarReminders } from "./routes/calendar.js";
import { taskRoutes } from "./routes/tasks.js";
import { rulesRoutes } from "./routes/rules.js";
import { runScheduleSweep } from "./rules.js";
import { sweepWebhookDeliveries } from "./integrations.js";
import { formRoutes, formPublicRoutes, sweepFormRetention } from "./routes/forms.js";
import { noteRoutes } from "./routes/notes.js";
import { publicApiRoutes } from "./routes/publicApi.js";
import { billingRoutes } from "./routes/billing.js";
import { maybeRunDailyBackup } from "./backup.js";
import { monitorSweep } from "./monitor.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { downloadRoutes } from "./routes/downloads.js";
import { superadminRoutes } from "./routes/superadmin.js";
import { ensureSubscription, effectiveState, ensureSuperAdmin, billingNotices, confirmPayment, paystackVerify, sweepPendingPaystack, sweepVersionRetention, getPlans } from "./billing.js";
import { aiBudgetNotices } from "./aiQuota.js";
import { onResponseMetric } from "./metrics.js";
import { migrate, one, runSweep } from "./db.js";
import { reindexAll } from "./indexer.js";
import { sweepRetention, sweepLibraryRetention, getPolicies, ipAllowed } from "./policies.js";
import { encryptionEnabled } from "./crypto.js";
import { resolveSession } from "./auth.js";

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
    "kx://app", // Electron desktop shell — custom privileged scheme
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
    // explicit — a bare GET,HEAD,POST list blocks every mutating API call
    // (PUT content saves, PATCH renames, DELETE trash) from browser shells
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "if-match", "if-none-match", "x-requested-with"],
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
  // The Jitsi origin (KREATIX_MEET_BASE) must be script-src'd — Meet mounts
  // external_api.js from it — and needs camera/mic delegation for the iframe.
  const meetOrigin = (() => {
    try { return process.env.KREATIX_MEET_BASE ? new URL(process.env.KREATIX_MEET_BASE).origin : ""; }
    catch { return ""; }
  })();
  const CSP =
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com${meetOrigin ? ` ${meetOrigin}` : ""}; ` +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
    "font-src 'self' data:; connect-src 'self' wss: https://cloudflareinsights.com; worker-src 'self' blob:; " +
    "media-src 'self' blob: data:; frame-src 'self' https:; object-src 'none'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'self'; manifest-src 'self'";
  // the Sheets script sandbox needs eval — scoped to that page only, which is
  // additionally isolated by sandbox="allow-scripts" (opaque origin)
  const SANDBOX_CSP =
    "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'none'; base-uri 'none'; form-action 'none'";
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy",
      `microphone=(self${meetOrigin ? ` "${meetOrigin}"` : ""}), camera=(self${meetOrigin ? ` "${meetOrigin}"` : ""}), geolocation=(), display-capture=(self${meetOrigin ? ` "${meetOrigin}"` : ""})`);
    if ((req.raw.socket as { encrypted?: boolean }).encrypted
      || req.headers["x-forwarded-proto"] === "https") {
      reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
    if (!reply.getHeader("content-security-policy")) {
      const path = (req.url ?? "").split("?")[0];
      reply.header("Content-Security-Policy", path === "/script-sandbox.html" ? SANDBOX_CSP : CSP);
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
    const { user } = await resolveSession(req);
    if (!user) return; // requireAuth will handle the 401
    {
      const sub = await ensureSubscription(user.org_id);
      if (effectiveState(sub).state === "locked") {
        return reply.code(402).send({
          error: "subscription_locked",
          message: "Workspace subscription has expired — the workspace is read-only until billing is renewed.",
        });
      }
    }
  });

  // ---- conditional access: org IP allowlist ----
  // If the caller's org sets policies.allowedIpRanges, every authed request
  // must come from inside one of the ranges (IPv4 CIDR or literal). Unauthed
  // requests pass through — requireAuth decides them downstream.
  app.addHook("preHandler", async (req, reply) => {
    // only pre-auth endpoints are exempt — session endpoints like /api/auth/me
    // still respect the allowlist (they run on an existing token)
    if (!req.url.startsWith("/api/") || /^\/api\/auth\/(login|register|mfa|invite|forgot|reset|verify)\b/.test(req.url)) return;
    const { payload, user } = await resolveSession(req);
    if (!user || user.is_super) return;
    const { allowedIpRanges, requireDesktopClient } = await getPolicies(user.org_id);
    if (allowedIpRanges.length && !ipAllowed(req.ip, allowedIpRanges)) {
      return reply.code(403).send({
        error: "ip_restricted",
        message: "Your network isn't allowed to access this workspace",
      });
    }
    // device posture — orgs can require the desktop client (Entra's
    // "approved client app" grant); tokens predate the claim count as web
    if (requireDesktopClient && payload?.client !== "desktop") {
      return reply.code(403).send({
        error: "device_restricted",
        message: "This workspace requires the Kreatix desktop app",
      });
    }
  });

  // ---- superadmin confinement ----
  // is_super accounts are platform operators, not workspace users: whatever
  // their org role says, they may only reach /api/superadmin/* plus auth and
  // session endpoints (login session, logout, MFA). Same self-verify pattern
  // as the write-gate — route-level requireAuth hasn't run yet at this point.
  const SUPER_ALLOW = /^\/api\/(superadmin|auth|health)\b/;
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || SUPER_ALLOW.test(req.url)) return;
    const { user } = await resolveSession(req);
    if (user?.is_super) {
      return reply.code(403).send({
        error: "superadmin_only",
        message: "This account is restricted to the platform portal.",
      });
    }
  });

  app.get("/api/health", async () => ({ ok: true, service: "kreatix-api", ts: new Date().toISOString() }));

  /**
   * Public status probe for uptime monitors/status pages — liveness only,
   * no tenant data. Reports the pieces an operator actually pages on:
   * db round-trip, blob writability, backup freshness, version.
   */
  const bootedAt = Date.now();
  app.get("/api/status", async (_req, reply) => {
    const t0 = Date.now();
    let dbMs: number | null = null;
    try { await one("SELECT 1 AS ok"); dbMs = Date.now() - t0; } catch { /* below */ }
    const lastBackup = await one<{ created_at: string; status: string }>(
      "SELECT created_at, status FROM backup_runs WHERE kind='db' ORDER BY created_at DESC LIMIT 1",
    ).catch(() => null);
    const ok = dbMs !== null;
    return reply.code(ok ? 200 : 503).send({
      ok,
      uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
      version: process.env.KREATIX_VERSION ?? null,
      checks: {
        db: dbMs !== null ? { ok: true, ms: dbMs } : { ok: false },
        backup: lastBackup ? {
          ageH: Math.round((Date.now() - Date.parse(lastBackup.created_at)) / 3.6e6 * 10) / 10,
          ok: lastBackup.status === "ok",
        } : { ok: false, never: true },
      },
      ts: new Date().toISOString(),
    });
  });

  /**
   * Public plan catalog — the landing page renders pricing straight from this,
   * so superadmin edits in the portal surface on the site within a minute.
   * No auth: prices and feature flags are public marketing data.
   */
  app.get("/api/plans", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    const plans = await getPlans(true);
    return {
      plans: plans.map((p) => ({
        slug: p.slug, name: p.name,
        priceNgn: p.price_ngn, memberPriceNgn: p.member_price_ngn,
        features: p.features ?? {}, limits: p.limits ?? {},
      })),
    };
  });

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
  app.register(siteRoutes);
  app.register(contentRoutes);
  app.register(sharingRoutes);
  app.register(commentRoutes);
  app.register(searchRoutes);
  app.register(aiRoutes);
  app.register(adminRoutes);
  app.register(ssoRoutes);
  app.register(samlRoutes);
  app.register(billingRoutes);
  app.register(feedbackRoutes);
  app.register(downloadRoutes);
  app.register(superadminRoutes);
  app.register(collabRoutes);
  app.register(mailRoutes);
  app.register(meetRoutes);
  app.register(meetIngestRoutes);
  app.register(chatRoutes);
  app.register(calendarRoutes);
  app.register(taskRoutes);
  app.register(rulesRoutes);
  app.register(formRoutes);
  app.register(formPublicRoutes);
  app.register(noteRoutes);
  app.register(publicApiRoutes);
  app.register(integrationAdminRoutes);
  app.register(brandingRoutes);

  // Client crash reports — the web ErrorBoundary + global handlers post here.
  // Unauthenticated (crashes can precede login), strictly capped and logged —
  // there's no Sentry in this stack, so server logs are the observability path.
  app.post("/api/client-error", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = (req.body ?? {}) as { message?: string; stack?: string; componentStack?: string; url?: string; ua?: string; kind?: string };
    app.log.error({
      clientError: {
        message: String(b.message ?? "").slice(0, 500),
        stack: String(b.stack ?? "").slice(0, 4000),
        componentStack: String(b.componentStack ?? "").slice(0, 2000),
        url: String(b.url ?? "").slice(0, 200),
        ua: String(b.ua ?? "").slice(0, 200),
        kind: String(b.kind ?? "boundary"),
      },
    }, "client-side error report");
    return { ok: true };
  });

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

  // trash-retention sweep + billing notices (trial-ending / locked emails): daily.
  // Each named sweep is wrapped in a pg advisory lock — only one API instance
  // runs it; others return null immediately (multi-instance safe).
  const sweep = () => {
    runSweep("retention.trash", 717001, () => sweepRetention())
      .then((purged) => { if (purged) app.log.info({ purged }, "retention sweep purged trashed items"); })
      .catch((e) => app.log.warn(e, "retention sweep failed"));
    runSweep("retention.library", 717002, () => sweepLibraryRetention())
      .then((trashed) => { if (trashed) app.log.info({ trashed }, "library retention sweep auto-trashed stale items"); })
      .catch((e) => app.log.warn(e, "library retention sweep failed"));
    runSweep("billing.notices", 717003, () => billingNotices(app.log))
      .then((n) => { if (n && (n.warned || n.locked)) app.log.info(n, "billing notices sent"); })
      .catch((e) => app.log.warn(e, "billing notice sweep failed"));
    runSweep("ai.budget", 717004, () => aiBudgetNotices(app.log))
      .then((n) => { if (n && (n.orgs || n.platform)) app.log.info(n, "AI budget notices sent"); })
      .catch((e) => app.log.warn(e, "AI budget notice sweep failed"));
    runSweep("retention.versions", 717005, () => sweepVersionRetention())
      .then((n) => { if (n) app.log.info({ pruned: n }, "free-tier version retention applied"); })
      .catch((e) => app.log.warn(e, "version retention sweep failed"));
    runSweep("retention.forms", 717009, () => sweepFormRetention())
      .then((n) => { if (n) app.log.info({ deleted: n }, "form response retention applied"); })
      .catch((e) => app.log.warn(e, "form retention sweep failed"));
  };
  setImmediate(sweep);
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();

  // pending-Paystack sweep every 5min — stands in for a shared webhook slot
  const paySweep = () => {
    runSweep("billing.paystack", 717006, () => sweepPendingPaystack(app.log))
      .then((n) => { if (n && n.confirmed) app.log.info(n, "paystack payments confirmed"); })
      .catch((e) => app.log.warn(e, "paystack sweep failed"));
  };
  setTimeout(paySweep, 30_000).unref();
  setInterval(paySweep, 5 * 60 * 1000).unref();

  // automation sweep: schedule.daily digests + task.overdue fires, hourly
  const ruleSweep = () =>
    runSweep("automation.rules", 717007, () => runScheduleSweep(app.log))
      .catch((e) => app.log.warn(e, "automation sweep failed"));
  setTimeout(ruleSweep, 60_000).unref();
  setInterval(ruleSweep, 60 * 60 * 1000).unref();

  // webhook retry sweep — every 2 minutes, advisory-locked for multi-instance
  const hookSweep = () =>
    runSweep("webhook.retry", 717008, () => sweepWebhookDeliveries())
      .then((n) => { if (n) app.log.info({ retried: n }, "webhook deliveries retried"); })
      .catch((e) => app.log.warn(e, "webhook sweep failed"));
  setTimeout(hookSweep, 45_000).unref();
  setInterval(hookSweep, 2 * 60 * 1000).unref();

  // calendar reminders — every 60s; fires bell notifications at reminder_mins
  const calSweep = () =>
    runSweep("calendar.reminders", 717009, () => sweepCalendarReminders())
      .then((n) => { if (n) app.log.info({ sent: n }, "calendar reminders sent"); })
      .catch((e) => app.log.warn(e, "calendar reminder sweep failed"));
  setTimeout(calSweep, 20_000).unref();
  setInterval(calSweep, 60_000).unref();

  // ops sweep — health checks/alerts hourly + daily backup when due
  const opsSweep = () => {
    runSweep("ops.monitor", 717009, () => monitorSweep(app.log))
      .then((r) => { if (r && r.alerts) app.log.warn({ alerts: r.alerts }, "health alerts sent"); })
      .catch((e) => app.log.warn(e, "monitor sweep failed"));
    runSweep("ops.backup", 717010, () => maybeRunDailyBackup())
      .then((s) => { if (s) app.log.info({ status: s }, "daily backup completed"); })
      .catch((e) => app.log.warn(e, "backup sweep failed"));
  };
  setTimeout(opsSweep, 90_000).unref();
  setInterval(opsSweep, 60 * 60 * 1000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
