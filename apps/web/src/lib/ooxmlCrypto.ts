// ECMA-376 "Agile Encryption" decryption for password-protected OOXML
// packages (.docx/.xlsx/.pptx saved with Encrypt-with-Password, Office 2010+).
//
// An encrypted OOXML file is a CFB (compound binary) container with two
// streams: "EncryptionInfo" (an XML descriptor) and "EncryptedPackage"
// (the real ZIP, AES-CBC encrypted in 4096-byte segments). The package key
// is itself AES-encrypted under a key derived from the password by a
// salted, iterated SHA-512 hash ("spin count").
//
// AES is implemented here in plain JS rather than WebCrypto because
// crypto.subtle's AES-CBC applies PKCS#7 unpadding — the verifier and
// package segments are raw stream data, not padded messages. SHA-512 uses
// @noble/hashes synchronously: the 100k-iteration KDF spin would cost ~12s
// through 100k awaited subtle.digest calls (~1s sync).

import * as CFB from "cfb";
import { sha512 as sha512sum } from "@noble/hashes/sha2";

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** True when bytes look like an encrypted Office file: CFB container that
 *  carries the EncryptionInfo/EncryptedPackage stream pair. (Legacy .doc/
 *  .xls binaries are CFB too but lack these streams — this must not
 *  misclassify them.) */
export function isEncryptedOoxml(bytes: Uint8Array): boolean {
  return ooxmlEncScheme(bytes) !== null;
}

/**
 * Which ECMA-376 scheme an encrypted OOXML container uses, or null when the
 * bytes aren't an encrypted package. "agile" (v4.4) is the modern default;
 * "standard" (v3.2/4.2, RC4-era) is rare but exists in old files.
 */
export function ooxmlEncScheme(bytes: Uint8Array): "agile" | "standard" | "extensible" | null {
  if (bytes.length < 8 || !CFB_MAGIC.every((m, i) => bytes[i] === m)) return null;
  try {
    const cfb = CFB.read(bytes, { type: "array" });
    const info = CFB.find(cfb, "EncryptionInfo");
    if (!info || !CFB.find(cfb, "EncryptedPackage")) return null;
    const b = new Uint8Array(info.content);
    const dv = new DataView(b.buffer, b.byteOffset);
    const major = dv.getUint16(0, true), minor = dv.getUint16(2, true);
    if (major === 4 && minor === 4) return "agile";
    if ((major === 2 || major === 3 || major === 4) && minor === 2) return "standard";
    if ((major === 3 || major === 4) && minor === 3) return "extensible";
    return "standard";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- AES ----

const gm = (a: number, b: number): number => {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = (a & 0x80) ? ((a << 1) ^ 0x11b) & 0xff : (a << 1) & 0xff;
    b >>= 1;
  }
  return p;
};

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  const inv = new Uint8Array(256);
  for (let x = 1; x < 256; x++)
    for (let y = 1; y < 256; y++) if (gm(x, y) === 1) { inv[x] = y; break; }
  const rol8 = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff;
  for (let x = 0; x < 256; x++) {
    const b = inv[x];
    SBOX[x] = (b ^ rol8(b, 1) ^ rol8(b, 2) ^ rol8(b, 3) ^ rol8(b, 4) ^ 0x63) & 0xff;
    INV_SBOX[SBOX[x]] = x;
  }
}

/** Expand an AES-256 key into the 15 round keys (60 words → 240 bytes). */
function aes256Expand(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(240);
  w.set(key);
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    let t0 = w[4 * i - 4], t1 = w[4 * i - 3], t2 = w[4 * i - 2], t3 = w[4 * i - 1];
    if (i % 8 === 0) {
      const r = t0;
      t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[r];
      rcon = gm(rcon, 2);
    } else if (i % 8 === 4) {
      t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3];
    }
    w[4 * i] = w[4 * i - 32] ^ t0;
    w[4 * i + 1] = w[4 * i - 31] ^ t1;
    w[4 * i + 2] = w[4 * i - 30] ^ t2;
    w[4 * i + 3] = w[4 * i - 29] ^ t3;
  }
  return w;
}

/** AES inverse cipher on one 16-byte block (state is column-major). */
function aesBlockDecrypt(rk: Uint8Array, blk: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  // start with the last round key applied to the ciphertext
  for (let i = 0; i < 16; i++) s[i] = blk[i] ^ rk[224 + i];
  const invShiftSub = () => {
    const t = s.slice();
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        s[r + 4 * c] = INV_SBOX[t[r + 4 * ((c - r + 4) % 4)]];
  };
  const invMix = () => {
    for (let c = 0; c < 4; c++) {
      const a = s[4 * c], b = s[4 * c + 1], d = s[4 * c + 2], e = s[4 * c + 3];
      s[4 * c]     = gm(a, 14) ^ gm(b, 11) ^ gm(d, 13) ^ gm(e, 9);
      s[4 * c + 1] = gm(a, 9)  ^ gm(b, 14) ^ gm(d, 11) ^ gm(e, 13);
      s[4 * c + 2] = gm(a, 13) ^ gm(b, 9)  ^ gm(d, 14) ^ gm(e, 11);
      s[4 * c + 3] = gm(a, 11) ^ gm(b, 13) ^ gm(d, 9)  ^ gm(e, 14);
    }
  };
  for (let round = 13; round >= 1; round--) {
    invShiftSub();
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
    invMix();
  }
  invShiftSub();
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  return s;
}

/** AES-256-CBC decrypt of arbitrary block-aligned data — no padding removal. */
function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const rk = aes256Expand(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 16) {
    const blk = data.subarray(off, off + 16);
    const dec = aesBlockDecrypt(rk, blk);
    for (let i = 0; i < 16; i++) out[off + i] = dec[i] ^ prev[i];
    prev = blk;
  }
  return out;
}

// ------------------------------------------------------------- helpers ----

const b64dec = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const utf16le = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[2 * i] = s.charCodeAt(i) & 0xff;
    b[2 * i + 1] = s.charCodeAt(i) >> 8;
  }
  return b;
};

const le32 = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

const sha512 = (...parts: Uint8Array[]): Uint8Array => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const cat = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { cat.set(p, off); off += p.length; }
  return sha512sum(cat);
};

/** Pull a named attribute out of the EncryptionInfo XML (per-element scope). */
function xmlAttr(el: string, name: string): string | null {
  const m = el.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/** Slice the <elName .../> element text out of the descriptor XML. */
function xmlEl(xml: string, local: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${local}\\b[^>]*/?>`, ""));
  return m ? m[0] : null;
}

// --------------------------------------------------------------- agile ----

// Fixed blockKey constants that tag what each derived key protects.
const BK_VERIFIER_INPUT = Uint8Array.from([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BK_VERIFIER_HASH  = Uint8Array.from([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BK_KEY_VALUE      = Uint8Array.from([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);

export class WrongPasswordError extends Error {
  constructor() { super("Incorrect password"); this.name = "WrongPasswordError"; }
}

/**
 * Decrypt an agile-encrypted OOXML container. Returns the plain ZIP bytes
 * (the .docx/.xlsx/.pptx content). Throws WrongPasswordError when the
 * verifier check fails, or Error for schemes we don't support.
 */
export async function decryptOoxml(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const cfb = CFB.read(bytes, { type: "array" });
  const info = CFB.find(cfb, "EncryptionInfo");
  const pkg = CFB.find(cfb, "EncryptedPackage");
  if (!info || !pkg) throw new Error("Not an encrypted Office file");

  const infoBytes = new Uint8Array(info.content);
  const pkgBytes = new Uint8Array(pkg.content);
  const dv = new DataView(infoBytes.buffer, infoBytes.byteOffset);
  const major = dv.getUint16(0, true), minor = dv.getUint16(2, true);
  if (major !== 4 || minor !== 4)
    throw new Error("This file uses an older Office encryption scheme that Kreatix can't open yet");

  const xml = new TextDecoder("utf-8").decode(infoBytes.subarray(8));
  const keyData = xmlEl(xml, "keyData");
  const encKeyEl = xmlEl(xml, "encryptedKey");
  if (!keyData || !encKeyEl) throw new Error("Unrecognized EncryptionInfo descriptor");

  const get = (el: string, name: string, fallback = ""): string =>
    xmlAttr(el, name) ?? fallback;
  const pkgSalt = b64dec(get(keyData, "saltValue"));
  const pkgKeyBytes = Number(get(keyData, "keyBits", "256")) / 8;
  const hashAlg = get(keyData, "hashAlgorithm", "SHA512");
  if (hashAlg !== "SHA512" || get(keyData, "cipherAlgorithm", "AES") !== "AES")
    throw new Error(`Unsupported Office encryption parameters (${hashAlg})`);

  const spin = Number(get(encKeyEl, "spinCount", "100000"));
  const salt = b64dec(get(encKeyEl, "saltValue"));
  const blockSize = Number(get(encKeyEl, "blockSize", "16"));
  const keyBytes = Number(get(encKeyEl, "keyBits", "256")) / 8;
  const hashSize = Number(get(encKeyEl, "hashSize", "64"));

  // password → iterated hash → per-purpose AES key = H(h || blockKey)
  let h = sha512(salt, utf16le(password));
  for (let i = 0; i < spin; i++) h = sha512(le32(i), h);
  const derive = (blockKey: Uint8Array): Uint8Array =>
    sha512(h, blockKey).subarray(0, keyBytes);
  const iv = salt.subarray(0, blockSize);

  // password check: decrypt verifier input and hash, compare
  const verInput = aesCbcDecrypt(derive(BK_VERIFIER_INPUT), iv,
    b64dec(get(encKeyEl, "encryptedVerifierHashInput")));
  const verHash = aesCbcDecrypt(derive(BK_VERIFIER_HASH), iv,
    b64dec(get(encKeyEl, "encryptedVerifierHashValue")));
  const actual = sha512(verInput);
  for (let i = 0; i < hashSize; i++)
    if (actual[i] !== verHash[i]) throw new WrongPasswordError();

  // unwrap the package key, then decrypt the ZIP in 4096-byte segments —
  // each segment's IV is H(packageSalt || segmentIndex)
  const pkgKey = aesCbcDecrypt(derive(BK_KEY_VALUE), iv,
    b64dec(get(encKeyEl, "encryptedKeyValue"))).subarray(0, pkgKeyBytes);

  const totalLen = Number(new DataView(pkgBytes.buffer, pkgBytes.byteOffset).getBigUint64(0, true));
  const body = pkgBytes.subarray(8);
  const out = new Uint8Array(Math.min(totalLen, body.length));
  for (let seg = 0; seg * 4096 < body.length && seg * 4096 < totalLen; seg++) {
    const chunk = body.subarray(seg * 4096, Math.min((seg + 1) * 4096, body.length));
    const segIv = sha512(pkgSalt, le32(seg)).subarray(0, blockSize);
    const plain = aesCbcDecrypt(pkgKey, segIv, chunk.subarray(0, chunk.length - (chunk.length % 16)));
    out.set(plain.subarray(0, Math.min(plain.length, totalLen - seg * 4096)), seg * 4096);
  }
  if (out[0] !== 0x50 || out[1] !== 0x4b) // 'PK' — sanity check on the ZIP
    throw new Error("Decryption produced invalid data");
  return out;
}
