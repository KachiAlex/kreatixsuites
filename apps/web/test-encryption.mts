// Agile-encryption (password-protected OOXML) test harness.
// Fixtures in test-fixtures/ were produced by the independent
// msoffcrypto-tool (ECMA376Agile.encrypt), so byte-identical decrypt is a
// real cross-implementation check.
// Passwords: agile-password.docx → "Verify42!", agile-password.xlsx → "Sheet99!"
// Run: npx tsx test-encryption.mts
import { DOMParser as LDParser } from "linkedom";
(globalThis as Record<string, unknown>).DOMParser ??= LDParser;
import { readFileSync } from "node:fs";
import { isEncryptedOoxml, ooxmlEncScheme, decryptOoxml, WrongPasswordError } from "./src/lib/ooxmlCrypto";
import { xlsxToWorkbook } from "./src/sheets/io";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name); }
};
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const fx = (n: string) => new Uint8Array(readFileSync(`test-fixtures/${n}`));

const plainDocx = fx("plain.docx"), encDocx = fx("agile-password.docx");
const plainXlsx = fx("plain.xlsx"), encXlsx = fx("agile-password.xlsx");

check("plain docx not flagged", !isEncryptedOoxml(plainDocx));
check("plain xlsx not flagged", !isEncryptedOoxml(plainXlsx));
check("enc docx flagged", isEncryptedOoxml(encDocx));
check("enc xlsx flagged", isEncryptedOoxml(encXlsx));
check("scheme = agile", ooxmlEncScheme(encDocx) === "agile" && ooxmlEncScheme(encXlsx) === "agile");

for (const [name, bytes, pw] of [
  ["docx", encDocx, "Verify42!"],
  ["xlsx", encXlsx, "Sheet99!"],
] as const) {
  let threw = false;
  try { await decryptOoxml(bytes, "definitely-wrong"); }
  catch (e) { threw = e instanceof WrongPasswordError; }
  check(`${name} wrong password → WrongPasswordError`, threw);
}

const t0 = Date.now();
check("docx decrypt byte-identical", sameBytes(await decryptOoxml(encDocx, "Verify42!"), plainDocx));
check("xlsx decrypt byte-identical", sameBytes(await decryptOoxml(encXlsx, "Sheet99!"), plainXlsx));
console.log(`decrypt elapsed ${Date.now() - t0}ms`);

// decrypted zip parses through the real XLSX importer
const zip = await decryptOoxml(encXlsx, "Sheet99!");
const wb = await xlsxToWorkbook(new File([zip.buffer as ArrayBuffer], "book.xlsx"));
check("imported sheet name", wb.sheets[0].name === "S1");
check("imported cell A1 = 42", wb.sheets[0].cells["A1"]?.v === 42);
check("imported cell B1 = hi", wb.sheets[0].cells["B1"]?.v === "hi");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
