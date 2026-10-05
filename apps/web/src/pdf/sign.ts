/**
 * Real cryptographic signing (adbe.pkcs7.detached / CMS).
 *
 * pdf-lib writes the /Sig field + widget with fixed-width /ByteRange and
 * /Contents placeholders, the file is saved uncompressed, then the two byte
 * ranges are hashed and a detached PKCS#7 is produced with node-forge and
 * spliced in place — the same technique as @signpdf/placeholder-pdf-lib.
 *
 * Cert source: an imported .p12/.pfx (password-protected) or a generated
 * self-signed RSA-2048 ID.
 */
import { PDFName, PDFString, PDFHexString, PDFArray, PDFDict, StandardFonts } from "pdf-lib";
import type * as forge from "node-forge";
import { loadPdfForEdit } from "./pages";

export type CertSource =
  | { kind: "p12"; data: Uint8Array; password: string }
  | { kind: "self"; name: string; email?: string; org?: string };

export interface SignOpts {
  page: number;                                  // 0-based
  rect: [number, number, number, number];        // x, y, w, h — PDF points
  name: string;
  reason?: string;
  location?: string;
  cert: CertSource;
}

const CONTENT_BYTES = 16384; // hex placeholder size — CMS blobs are typically 2–8KB
const BR_SLOT = 10;          // fixed-width digits reserved per ByteRange entry

const pdfDate = (d: Date) =>
  `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}` +
  `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;

// appearance-stream text: ASCII + escaped delimiters only
const apText = (s: string) => s.replace(/[^\x20-\x7e]/g, "?").replace(/[\\()]/g, (c) => "\\" + c);

export async function signPdf(input: ArrayBuffer, o: SignOpts): Promise<Uint8Array> {
  const forgeMod = await import("node-forge");
  const forge = (forgeMod as unknown as { default?: typeof forgeMod }).default ?? forgeMod;
  const pdfDoc = await loadPdfForEdit(input);
  const ctx = pdfDoc.context;
  const now = new Date();

  // ---- credentials ----
  let key: forge.pki.PrivateKey, cert: forge.pki.Certificate;
  if (o.cert.kind === "p12") {
    const asn1 = forge.asn1.fromDer(forge.util.binary.raw.encode(o.cert.data));
    const pfx = forge.pkcs12.pkcs12FromAsn1(asn1, o.cert.password);
    const certBag = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert;
    const keyBag =
      pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key ??
      pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
    if (!certBag || !keyBag) throw new Error("No certificate + key pair in that file");
    cert = certBag; key = keyBag as forge.pki.PrivateKey;
  } else {
    const pair = forge.pki.rsa.generateKeyPair(2048);
    cert = forge.pki.createCertificate();
    cert.serialNumber = "01";
    cert.validity.notBefore = now;
    cert.validity.notAfter = new Date(now.getFullYear() + 10, now.getMonth(), now.getDate());
    const attrs = [
      { name: "commonName", value: o.cert.name },
      ...(o.cert.email ? [{ name: "emailAddress", value: o.cert.email }] : []),
      ...(o.cert.org ? [{ name: "organizationName", value: o.cert.org }] : []),
    ];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.publicKey = pair.publicKey;
    cert.sign(pair.privateKey, forge.md.sha256.create());
    key = pair.privateKey;
  }

  // ---- signature dictionary + widget with placeholders ----
  const [x, y, w, h] = o.rect;
  const hexRun = "0".repeat(CONTENT_BYTES * 2); // declared before use in the dict below
  const sigDict = ctx.obj({
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached",
    ByteRange: ctx.obj([0, 9999999999, 9999999999, 9999999999]), // sentinel digits — patched in place post-save
    Contents: PDFHexString.of(hexRun),                           // serializes as <00…00> placeholder
    Name: PDFString.of(o.name), M: PDFString.of(pdfDate(now)),
    ...(o.reason ? { Reason: PDFString.of(o.reason) } : {}),
    ...(o.location ? { Location: PDFString.of(o.location) } : {}),
  });
  const sigRef = ctx.register(sigDict);

  // visible appearance — bordered "Digitally signed by" box
  const helv = await pdfDoc.embedStandardFont(StandardFonts.Helvetica);
  const fs1 = Math.max(5, Math.min(10, h / 4)), fs2 = Math.max(4, Math.min(7, h / 6));
  const apContent =
    `q 0.35 0.55 0.9 RG 1.2 w 0.6 0.6 ${(w - 1.2).toFixed(1)} ${(h - 1.2).toFixed(1)} re S Q ` +
    `BT /Helv ${fs1.toFixed(1)} Tf 4 ${(h * 0.58).toFixed(1)} Td (Digitally signed by ${apText(o.name)}) Tj ET ` +
    `BT /Helv ${fs2.toFixed(1)} Tf 4 ${(h * 0.22).toFixed(1)} Td (Date: ${apText(now.toLocaleString())}) Tj ET`;
  const apRef = ctx.register(ctx.flateStream(new TextEncoder().encode(apContent), {
    Type: "XObject", Subtype: "Form", FormType: 1, BBox: [0, 0, w, h],
    Resources: { Font: { Helv: helv.ref } },
  }));

  const page = pdfDoc.getPages()[o.page];
  const widget = ctx.obj({
    Type: "Annot", Subtype: "Widget", FT: "Sig",
    T: PDFString.of(`Signature_${now.getTime()}`),
    Rect: [x, y, x + w, y + h], F: 132, P: page.ref, V: sigRef,
    AP: { N: apRef },
  });
  const widgetRef = ctx.register(widget);
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) { annots = ctx.obj([]); page.node.set(PDFName.of("Annots"), annots); }
  annots.push(widgetRef);
  let acro = pdfDoc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!acro) { acro = ctx.obj({ Fields: [] }); pdfDoc.catalog.set(PDFName.of("AcroForm"), acro); }
  acro.set(PDFName.of("SigFlags"), ctx.obj(3)); // signatures exist + append-only
  let fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) { fields = ctx.obj([]); acro.set(PDFName.of("Fields"), fields); }
  fields.push(widgetRef);

  const out = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });

  // ---- locate the placeholders in the saved bytes ----
  const latin1 = new TextDecoder("latin1").decode(out);
  const hexStart = latin1.indexOf(hexRun);
  if (hexStart < 0) throw new Error("signature placeholder not found in saved file");
  const ltPos = hexStart - 1;              // '<' opening the hex string
  const gtPos = hexStart + hexRun.length;  // '>' closing it
  const brMatch = /\/ByteRange\s*\[\s*0\s+9{10}\s+9{10}\s+9{10}\s*\]/.exec(latin1);
  if (!brMatch) throw new Error("ByteRange placeholder not found");
  const stars = [...latin1.slice(brMatch.index).matchAll(/9{10}/g)]
    .slice(0, 3).map((mm) => brMatch.index + (mm.index as number));

  const fin = out.slice();
  const enc = new TextEncoder();
  const ranges = [ltPos, gtPos + 1, out.length - gtPos - 1]; // [0, lt) + [gt+1, end)
  ranges.forEach((n, i) => {
    const s = String(n);
    if (s.length > BR_SLOT) throw new Error("file too large to sign");
    fin.set(enc.encode(s.padStart(BR_SLOT, "0")), stars[i]);
  });

  // ---- detached PKCS#7 over the byte ranges — built from `fin` so the
  // patched ByteRange digits are part of the signed content ----
  const signed = new Uint8Array(ltPos + out.length - gtPos - 1);
  signed.set(fin.slice(0, ltPos), 0);
  signed.set(fin.slice(gtPos + 1), ltPos);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(signed as unknown as ArrayBuffer);
  p7.addCertificate(cert);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.signingTime, value: now.toISOString() },
      { type: forge.pki.oids.messageDigest }, // forge computes it during sign()
    ],
  });
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  const hex = der.split("").map((b) => b.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  if (hex.length > hexRun.length) throw new Error("signature larger than reserved space");
  fin.set(enc.encode(hex.padEnd(hexRun.length, "0")), hexStart);
  return fin;
}
