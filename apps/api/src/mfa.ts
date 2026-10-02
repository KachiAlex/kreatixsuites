// TOTP (RFC 6238) + backup codes — HMAC-SHA1 over node:crypto, no deps.
// Secrets are base32 (RFC 4648); backup codes are stored as sha256 hashes
// and consumed on use.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function genSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(email: string, secret: string): string {
  const issuer = "Kreatix Suites";
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (n % 1_000_000).toString().padStart(6, "0");
}

/** ±1 step (30s) window tolerates minor clock drift — RFC 6238 §5.2. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const clean = code.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const t = Math.floor(now / 30000);
  for (const dt of [-1, 0, 1]) {
    const a = Buffer.from(hotp(secret, t + dt));
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

const normCode = (c: string) => c.toLowerCase().replace(/[\s-]/g, "");
const hashCode = (c: string) => createHash("sha256").update(normCode(c)).digest("hex");

/** 8 codes, "xxxx-xxxx" — shown to the user once, only hashes persist. */
export function genBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 8 },
    () => `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`);
  return { codes, hashes: codes.map(hashCode) };
}

/** If `code` matches a stored backup hash, consume it and return the reduced set. */
export function consumeBackupCode(code: string, hashesJson: string | null): string[] | null {
  let hashes: string[];
  try { hashes = JSON.parse(hashesJson ?? "[]"); } catch { return null; }
  const h = hashCode(code);
  const i = hashes.indexOf(h);
  if (i < 0) return null;
  hashes.splice(i, 1);
  return hashes;
}
