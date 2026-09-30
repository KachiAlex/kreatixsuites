/**
 * Digital-signature inspection — Acrobat's signature panel core.
 * Locates /ByteRange + /Contents in the raw bytes, verifies the CMS/PKCS#7
 * messageDigest against a hash of the byte ranges (document-integrity check),
 * and where the signature algorithm is supported (RSA or ECDSA) verifies the
 * signature value itself with WebCrypto. Certificate-chain trust (AATL/EUTL)
 * cannot be established without a root store, so results report integrity +
 * cryptographic validity, plus signer identity — never "trusted".
 */

export interface SigReport {
  field: string | null;      // field /T name found near the signature dict
  signer: string;            // subject CN/O of the signer certificate
  issuer: string;            // issuer CN/O
  signedAt: string | null;   // signingTime signed attribute
  digestAlgo: string;
  digestOk: boolean | null;  // byte-range hash == signedAttrs messageDigest; null = unverifiable
  sigOk: boolean | null;     // cryptographic verify; null = unsupported algo
  trailingBytes: boolean;    // data appended after the signed range
}

// ---------- minimal DER/ASN.1 ----------
interface Tlv { tag: number; val: number; end: number }
const tlv = (b: Uint8Array, off: number): Tlv => {
  const tag = b[off++];
  let len = b[off++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[off++]; }
  return { tag, val: off, end: off + len };
};
const kids = function* (b: Uint8Array, t: Tlv): Generator<Tlv> {
  let p = t.val;
  while (p < t.end) { const k = tlv(b, p); yield k; p = k.end; }
};
const bytes = (b: Uint8Array, t: Tlv) => b.slice(t.val, t.end);
const oidStr = (b: Uint8Array, t: Tlv): string => {
  const d = bytes(b, t);
  const parts = [Math.floor(d[0] / 40), d[0] % 40];
  let v = 0;
  for (let i = 1; i < d.length; i++) { v = v * 128 + (d[i] & 0x7f); if (!(d[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join(".");
};
const intBytes = (b: Uint8Array, t: Tlv) => bytes(b, t);
const timeStr = (b: Uint8Array, t: Tlv) => new TextDecoder().decode(bytes(b, t));

/** extract CN/O/OU from an X.501 Name sequence */
const nameStr = (b: Uint8Array, t: Tlv): string => {
  const out: string[] = [];
  for (const rdn of kids(b, t))
    for (const atv of kids(b, rdn)) {
      const [o, v] = [...kids(b, atv)];
      const oid = o ? oidStr(b, o) : "";
      const label = { "2.5.4.3": "CN", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST" }[oid];
      if (label && v) out.push(`${label}=${timeStr(b, v)}`);
    }
  return out.join(", ");
};

interface CertInfo { issuerRaw: Uint8Array; serialRaw: Uint8Array; subject: string; issuer: string; spki: Uint8Array; curveOid: string | null }

/** Certificate SEQUENCE → issuer/serial/subject/SPKI */
function parseCert(b: Uint8Array, t: Tlv): CertInfo | null {
  const tbs = tlv(b, t.val); // tbsCertificate
  const tbsKids = [...kids(b, tbs)];
  // [0] version (optional) | serial | signatureAlg | issuer | validity | subject | spki
  let i = 0;
  if (tbsKids[0] && (tbsKids[0].tag & 0xe0) === 0xa0) i++;
  const serial = tbsKids[i], issuer = tbsKids[i + 2], subject = tbsKids[i + 4], spkiT = tbsKids[i + 5];
  if (!serial || !issuer || !subject || !spkiT) return null;
  // curve OID lives in spki.algorithm.parameters for EC keys
  const alg = tlv(b, spkiT.val);
  const algKids = [...kids(b, alg)];
  const curveOid = algKids[1] && algKids[1].tag === 0x06 ? oidStr(b, algKids[1]) : null;
  return {
    issuerRaw: b.slice(tlvFromStart(b, issuer), issuer.end),
    serialRaw: intBytes(b, serial),
    subject: nameStr(b, subject), issuer: nameStr(b, issuer),
    spki: b.slice(tlvFromStart(b, spkiT), spkiT.end), curveOid,
  };
}
/** offset of a TLV's tag byte — DER uses minimal-length headers, so it's exact from the length */
const tlvFromStart = (_b: Uint8Array, t: Tlv): number => {
  const len = t.end - t.val;
  const lenBytes = len < 0x80 ? 1 : len < 0x100 ? 2 : len < 0x10000 ? 3 : len < 0x1000000 ? 4 : 5;
  return t.val - 1 - lenBytes;
};

const HASH: Record<string, string> = {
  "1.3.14.3.2.26": "SHA-1",
  "2.16.840.1.101.3.4.2.1": "SHA-256", "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
  "1.2.840.113549.2.5": "MD5",
};
const SIGALG: Record<string, { kind: "rsa" | "ec"; hash: string }> = {
  "1.2.840.113549.1.1.4": { kind: "rsa", hash: "MD5" },
  "1.2.840.113549.1.1.5": { kind: "rsa", hash: "SHA-1" },
  "1.2.840.113549.1.1.11": { kind: "rsa", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { kind: "rsa", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { kind: "rsa", hash: "SHA-512" },
  "1.2.840.10045.4.1": { kind: "ec", hash: "SHA-1" },
  "1.2.840.10045.4.3.2": { kind: "ec", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { kind: "ec", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { kind: "ec", hash: "SHA-512" },
};
const CURVES: Record<string, string> = {
  "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521",
};
const OID_ATTR_MSG_DIGEST = "1.2.840.113549.1.9.4";
const OID_ATTR_SIGNING_TIME = "1.2.840.113549.1.9.5";

/** DER ECDSA signature SEQ{r,s} → IEEE-P1363 r||s for WebCrypto */
const ecSigToRaw = (sig: Uint8Array, size: number): Uint8Array | null => {
  try {
    const seq = tlv(sig, 0);
    const [r, s] = [...kids(sig, seq)];
    const strip = (t: Tlv) => { let d = sig.slice(t.val, t.end); while (d.length > size && d[0] === 0) d = d.slice(1); return d; };
    const rr = strip(r), ss = strip(s);
    if (rr.length > size || ss.length > size) return null;
    const out = new Uint8Array(size * 2);
    out.set(rr, size - rr.length); out.set(ss, size * 2 - ss.length);
    return out;
  } catch { return null; }
};

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const unescapeT = (s: string) => s.replace(/\\([\\()])/g, "$1");

export async function verifySignatures(pdf: ArrayBuffer): Promise<SigReport[]> {
  const u8 = new Uint8Array(pdf);
  const text = new TextDecoder("latin1").decode(u8);
  const reports: SigReport[] = [];
  const brRe = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = brRe.exec(text))) {
    const [a, b1, c, d] = [1, 2, 3, 4].map((i) => parseInt(m![i], 10));
    // /Contents <hex> sits inside the same dict, just after /ByteRange —
    // the CMS blob is tens of KB, so scan a wide window (bounded by the regex's `>`)
    let hexLen = text.slice(m.index, Math.min(text.length, m.index + 500_000))
      .match(/\/Contents\s*<([0-9a-fA-F\s]+)>/)?.[1].replace(/\s+/g, "") ?? "";
    if (!hexLen) {
      // some producers put /Contents before /ByteRange in the dict
      const before = [...text.slice(Math.max(0, m.index - 500_000), m.index)
        .matchAll(/\/Contents\s*<([0-9a-fA-F\s]+)>/g)].pop();
      hexLen = before?.[1].replace(/\s+/g, "") ?? "";
    }
    if (!hexLen) continue;
    const hex = hexLen.length % 2 ? hexLen + "0" : hexLen;
    const cms = new Uint8Array(hex.length / 2);
    for (let i = 0; i < cms.length; i++) cms[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    const rep: SigReport = {
      field: null, signer: "Unknown", issuer: "Unknown", signedAt: null,
      digestAlgo: "?", digestOk: null, sigOk: null,
      trailingBytes: c + d < u8.length,
    };
    // nearest preceding /T (fieldName) is the widget's name — best effort
    const back = text.slice(Math.max(0, m.index - 600), m.index);
    rep.field = [...back.matchAll(/\/T\s*\((.*?)\)/gs)].map((x) => unescapeT(x[1])).pop() ?? null;

    try {
      const signed = new Uint8Array(b1 + d);
      signed.set(u8.slice(a, a + b1), 0);
      signed.set(u8.slice(c, c + d), b1);

      // ContentInfo → signedData → SignedData
      const ci = tlv(cms, 0);
      const ciKids = [...kids(cms, ci)];
      if (!ciKids[0] || oidStr(cms, ciKids[0]) !== "1.2.840.113549.1.2.1") { reports.push(rep); continue; }
      const sd = tlv(cms, ciKids[1].val); // [0] → SignedData SEQ
      const sdKids = [...kids(cms, sd)];
      // version INTEGER, digestAlgs SET, contentInfo SEQ, [0] certs?, [1] crls?, signerInfos SET
      let certs: CertInfo[] = [];
      let signerInfos: Tlv | null = null;
      for (const k of sdKids.slice(3)) {
        if (k.tag === 0xa0) certs = [...kids(cms, k)].filter((x) => x.tag === 0x30).map((x) => parseCert(cms, x)).filter((x): x is CertInfo => !!x);
        else if (k.tag === 0x31) signerInfos = k;
      }
      const si = signerInfos ? [...kids(cms, signerInfos)][0] : null;
      if (!si) { reports.push(rep); continue; }
      const siKids = [...kids(cms, si)];
      // version, sid(SEQ issuerAndSerial | [0] SKI), digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature OCTET
      const sid = siKids[1], digestAlgT = siKids[2];
      rep.digestAlgo = HASH[oidStr(cms, tlv(cms, digestAlgT.val))] ?? oidStr(cms, tlv(cms, digestAlgT.val));
      const attrsT = siKids.find((k) => k.tag === 0xa0);
      const sigIdx = siKids.findIndex((k) => k.tag === 0x04);
      const sigT = sigIdx >= 0 ? siKids[sigIdx] : null;
      const sigAlgT = sigIdx > 0 ? siKids[sigIdx - 1] : null;
      let msgDigest: Uint8Array | null = null;
      let tbs: Uint8Array | null = null;
      if (attrsT) {
        for (const attr of kids(cms, attrsT)) {
          const [ao, av] = [...kids(cms, attr)];
          if (!ao || !av) continue;
          const aoid = oidStr(cms, ao);
          if (aoid === OID_ATTR_MSG_DIGEST) { const v = tlv(cms, av.val); if (v.tag === 0x04) msgDigest = bytes(cms, v); }
          if (aoid === OID_ATTR_SIGNING_TIME) { const v = tlv(cms, av.val); rep.signedAt = timeStr(cms, v); }
        }
        // signature covers signedAttrs re-encoded as SET OF (swap [0] tag → 0x31)
        const raw = cms.slice(tlvFromStart(cms, attrsT), attrsT.end);
        tbs = raw.slice(); tbs[0] = 0x31;
      }
      // signer cert by issuer+serial (sid SEQ) — [0] = subjectKeyIdentifier (match by SKI skipped)
      let signer: CertInfo | null = null;
      if (sid.tag === 0x30) {
        const [iss, ser] = [...kids(cms, sid)];
        const issRaw = cms.slice(tlvFromStart(cms, iss), iss.end);
        const serRaw = intBytes(cms, ser);
        signer = certs.find((ct) => eq(ct.issuerRaw, issRaw) && eq(ct.serialRaw, serRaw)) ?? certs[0] ?? null;
      } else signer = certs[0] ?? null;
      if (signer) { rep.signer = signer.subject || "Unknown"; rep.issuer = signer.issuer || "Unknown"; }

      // integrity: byte-range hash vs messageDigest signed attribute
      const hashName = rep.digestAlgo;
      if (msgDigest && hashName !== "MD5" && hashName in HASH) {
        const h = new Uint8Array(await crypto.subtle.digest(hashName, signed));
        rep.digestOk = eq(h, msgDigest);
      }

      // cryptographic signature verify (RSA/ECDSA via WebCrypto)
      const sigAlgOid = sigAlgT ? oidStr(cms, tlv(cms, sigAlgT.val)) : "";
      const alg = SIGALG[sigAlgOid];
      const sigBytes = sigT ? bytes(cms, sigT) : null;
      if (alg && signer && sigBytes && tbs) {
        try {
          if (alg.kind === "rsa") {
            const key = await crypto.subtle.importKey("spki", signer.spki.buffer.slice(0) as ArrayBuffer, { name: "RSASSA-PKCS1-v1_5", hash: alg.hash }, false, ["verify"]);
            rep.sigOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes.buffer.slice(0) as ArrayBuffer, tbs.buffer.slice(0) as ArrayBuffer);
          } else {
            const curve = CURVES[signer.curveOid ?? ""] ?? "P-256";
            const key = await crypto.subtle.importKey("spki", signer.spki.buffer.slice(0) as ArrayBuffer, { name: "ECDSA", namedCurve: curve }, false, ["verify"]);
            const size = { "P-256": 32, "P-384": 48, "P-521": 66 }[curve] ?? 32;
            const raw = ecSigToRaw(sigBytes, size);
            rep.sigOk = raw ? await crypto.subtle.verify({ name: "ECDSA", hash: alg.hash }, key, raw.buffer.slice(0) as ArrayBuffer, tbs.buffer.slice(0) as ArrayBuffer) : null;
          }
        } catch { rep.sigOk = null; }
      }
    } catch { /* parse failure → report integrity-unknown */ }
    reports.push(rep);
  }
  return reports;
}
