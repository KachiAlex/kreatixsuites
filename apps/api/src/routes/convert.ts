import type { FastifyInstance } from "fastify";
import { requireAuth, type AuthedRequest } from "../auth.js";

const MAX_BYTES = 30 * 1024 * 1024;
const CONVERTER = () => process.env.KREATIX_CONVERTER_URL ?? "";

/** Word → PDF. The browser sends the exported .docx; the internal LibreOffice
 *  converter returns the PDF with the document's own fonts, tables, margins and
 *  page numbers. Only signed-in users can call it. */
export function convertRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth);

  app.post("/api/convert/pdf", async (req, reply) => {
    const { user } = req as AuthedRequest;
    if (!CONVERTER()) return reply.code(503).send({ error: "converter_unavailable", message: "PDF conversion isn't configured" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "bad_request", message: "Send the .docx file" });
    if (body.length > MAX_BYTES) return reply.code(413).send({ error: "too_large", message: "Document is too large to convert" });
    try {
      const upstream = await fetch(`${CONVERTER()}/convert`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(150_000),
      });
      if (!upstream.ok) {
        req.log.warn({ status: upstream.status, user: user.id }, "pdf conversion failed");
        return reply.code(502).send({ error: "conversion_failed", message: "Couldn't convert this document to PDF" });
      }
      reply.header("content-type", "application/pdf");
      return reply.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      req.log.warn({ err: String(e) }, "converter unreachable");
      return reply.code(502).send({ error: "converter_unavailable", message: "PDF conversion is unavailable right now" });
    }
  });
}
