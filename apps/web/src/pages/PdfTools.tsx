// Standalone PDF utilities — merge / split / compress without opening the
// full editor. Everything runs client-side via pdf-lib (+ pdf.js for
// raster compression); results download or upload straight into Drive.
import { useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { useToast } from "../lib/hooks";
import { api } from "../lib/api";
import { saveFile } from "../lib/saveFile";
import { loadPdfForEdit, extractPages } from "../pdf/pages";
import { compressPdf, type CompressLevel } from "../pdf/compress";
import { AppIcon } from "../components/AppIcon";

type ToolId = "merge" | "split" | "compress";

interface SrcFile { name: string; buf: ArrayBuffer; pages: number; size: number }
interface Result { name: string; bytes: Uint8Array }

const fmtSize = (n: number) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const baseName = (n: string) => n.replace(/\.pdf$/i, "");

async function readPdf(f: File): Promise<SrcFile> {
  const buf = await f.arrayBuffer();
  const doc = await loadPdfForEdit(buf);
  return { name: f.name, buf, pages: doc.getPageCount(), size: buf.byteLength };
}

function ResultBar({ results, toast }: { results: Result[]; toast: (m: string) => void }) {
  const t = useT();
  const download = async () => {
    if (results.length === 1) {
      await saveFile(new Blob([results[0].bytes.buffer as ArrayBuffer], { type: "application/pdf" }), results[0].name);
      return;
    }
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const r of results) zip.file(r.name, r.bytes);
    const blob = await zip.generateAsync({ type: "blob" });
    await saveFile(blob, `${baseName(results[0].name)}-files.zip`);
  };
  const toDrive = async (r: Result) => {
    try {
      await api.upload(`/api/drive/upload?name=${encodeURIComponent(r.name)}&kind=pdf`,
        new Blob([r.bytes.buffer as ArrayBuffer], { type: "application/pdf" }));
      toast(t("pdfTools.savedDrive", { name: r.name }));
    } catch { toast(t("pdfTools.saveFailed")); }
  };
  return (
    <div className="pt-results">
      {results.map((r) => (
        <div className="pt-result" key={r.name}>
          <span className="pt-result-name"><AppIcon kind="pdf" size={16} />{r.name}</span>
          <span className="pt-result-size">{fmtSize(r.bytes.byteLength)}</span>
          <button className="rb" onClick={() => void toDrive(r)} title={t("pdfTools.saveDrive")}>⤴ {t("pdfTools.saveDrive")}</button>
        </div>
      ))}
      <button className="btn-primary" onClick={() => void download()}>
        {results.length > 1 ? t("pdfTools.downloadZip") : t("pdfTools.download")}
      </button>
    </div>
  );
}

function Picker({ multiple, onPick, label }: { multiple?: boolean; onPick: (f: FileList) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="application/pdf,.pdf" multiple={multiple} hidden
        onChange={(e) => { if (e.target.files?.length) onPick(e.target.files); e.target.value = ""; }} />
      <button className="pt-drop" onClick={() => ref.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }}
        onDragLeave={(e) => e.currentTarget.classList.remove("over")}
        onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove("over"); if (e.dataTransfer.files.length) onPick(e.dataTransfer.files); }}>
        <AppIcon kind="pdf" size={28} />
        <span>{label}</span>
      </button>
    </>
  );
}

function MergeTool({ toast }: { toast: (m: string) => void }) {
  const t = useT();
  const [files, setFiles] = useState<SrcFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const add = async (list: FileList) => {
    setBusy(true);
    try {
      const read: SrcFile[] = [];
      for (const f of Array.from(list)) {
        if (!/\.pdf$/i.test(f.name)) { toast(t("pdfTools.onlyPdf", { name: f.name })); continue; }
        read.push(await readPdf(f));
      }
      setFiles((prev) => [...prev, ...read]);
      setResults(null);
    } catch (e) { toast(e instanceof Error ? e.message : t("pdfTools.readFailed")); }
    finally { setBusy(false); }
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= files.length) return;
    setFiles((prev) => { const n = [...prev]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  };
  const run = async () => {
    setBusy(true);
    try {
      const { PDFDocument } = await import("pdf-lib");
      const out = await PDFDocument.create();
      for (const f of files) {
        const src = await loadPdfForEdit(f.buf);
        for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
      }
      const bytes = await out.save({ useObjectStreams: true });
      const name = `${baseName(files[0].name)}-merged.pdf`;
      setResults([{ name, bytes }]);
      toast(t("pdfTools.merged", { count: out.getPageCount() }));
    } catch { toast(t("pdfTools.mergeFailed")); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Picker multiple onPick={(l) => void add(l)} label={t("pdfTools.pickPdfs")} />
      {files.length > 0 && (
        <div className="pt-list">
          {files.map((f, i) => (
            <div className="pt-row" key={`${f.name}-${i}`}>
              <span className="pt-name" title={f.name}>{f.name}</span>
              <span className="pt-meta">{t("pdfTools.pageCount", { count: f.pages })} · {fmtSize(f.size)}</span>
              <button className="rb" disabled={i === 0} onClick={() => move(i, -1)} title={t("pdfTools.up")}>↑</button>
              <button className="rb" disabled={i === files.length - 1} onClick={() => move(i, 1)} title={t("pdfTools.down")}>↓</button>
              <button className="rb" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} title={t("pdfTools.remove")}>✕</button>
            </div>
          ))}
        </div>
      )}
      {files.length > 1 && !busy &&
        <button className="btn-primary" onClick={() => void run()}>{t("pdfTools.mergeBtn", { count: files.length })}</button>}
      {busy && <div className="pt-progress">{t("pdfTools.working")}</div>}
      {results && <ResultBar results={results} toast={toast} />}
    </>
  );
}

/** "1-3,5,8-10" → inclusive ranges, clamped to pageCount. */
function parseRanges(input: string, pageCount: number): [number, number][] {
  const out: [number, number][] = [];
  for (const part of input.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) throw new Error("bad range");
    let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, Math.min(a, pageCount));
    b = Math.max(1, Math.min(b, pageCount));
    out.push([a, b]);
  }
  if (!out.length) throw new Error("bad range");
  return out;
}

function SplitTool({ toast }: { toast: (m: string) => void }) {
  const t = useT();
  const [src, setSrc] = useState<SrcFile | null>(null);
  const [mode, setMode] = useState<"at" | "ranges" | "each">("ranges");
  const [at, setAt] = useState(1);
  const [ranges, setRanges] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);

  const pick = async (l: FileList) => {
    try { setSrc(await readPdf(l[0])); setResults(null); setRanges(""); }
    catch (e) { toast(e instanceof Error ? e.message : t("pdfTools.readFailed")); }
  };

  const run = async () => {
    if (!src) return;
    setBusy(true);
    try {
      const base = baseName(src.name);
      const out: Result[] = [];
      if (mode === "at") {
        if (at <= 1 || at > src.pages) throw new Error("bad page");
        out.push(
          { name: `${base}-p1-${at - 1}.pdf`, bytes: await extractPages(src.buf, range(1, at - 1)) },
          { name: `${base}-p${at}-${src.pages}.pdf`, bytes: await extractPages(src.buf, range(at, src.pages)) },
        );
      } else if (mode === "ranges") {
        for (const [a, b] of parseRanges(ranges, src.pages))
          out.push({ name: a === b ? `${base}-p${a}.pdf` : `${base}-p${a}-${b}.pdf`, bytes: await extractPages(src.buf, range(a, b)) });
      } else {
        for (let p = 1; p <= src.pages; p++)
          out.push({ name: `${base}-p${p}.pdf`, bytes: await extractPages(src.buf, [p]) });
      }
      setResults(out);
      toast(t("pdfTools.splitDone", { count: out.length }));
    } catch {
      toast(mode === "at" ? t("pdfTools.badPage") : t("pdfTools.badRanges"));
    } finally { setBusy(false); }
  };

  return (
    <>
      <Picker onPick={(l) => void pick(l)} label={t("pdfTools.pickPdf")} />
      {src && (
        <>
          <div className="pt-row pt-src">
            <span className="pt-name">{src.name}</span>
            <span className="pt-meta">{t("pdfTools.pageCount", { count: src.pages })} · {fmtSize(src.size)}</span>
          </div>
          <div className="pt-modes">
            <label className={`pt-mode ${mode === "ranges" ? "on" : ""}`}>
              <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
              {t("pdfTools.modeRanges")}
            </label>
            <label className={`pt-mode ${mode === "at" ? "on" : ""}`}>
              <input type="radio" checked={mode === "at"} onChange={() => setMode("at")} />
              {t("pdfTools.modeAt")}
            </label>
            <label className={`pt-mode ${mode === "each" ? "on" : ""}`}>
              <input type="radio" checked={mode === "each"} onChange={() => setMode("each")} />
              {t("pdfTools.modeEach")}
            </label>
          </div>
          {mode === "ranges" && (
            <input className="pt-input" value={ranges} onChange={(e) => setRanges(e.target.value)}
              placeholder={t("pdfTools.rangesHint")} />
          )}
          {mode === "at" && (
            <label className="pt-inline">{t("pdfTools.atLabel")}
              <input className="pt-input pt-num" type="number" min={2} max={src.pages} value={at}
                onChange={(e) => setAt(parseInt(e.target.value, 10) || 1)} />
            </label>
          )}
          {!busy && <button className="btn-primary" disabled={mode === "ranges" && !ranges.trim()}
            onClick={() => void run()}>{t("pdfTools.splitBtn")}</button>}
        </>
      )}
      {busy && <div className="pt-progress">{t("pdfTools.working")}</div>}
      {results && <ResultBar results={results} toast={toast} />}
    </>
  );
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const LEVELS: { id: CompressLevel; key: string; hint: string }[] = [
  { id: "lossless", key: "pdfTools.lvlLossless", hint: "pdfTools.lvlLosslessHint" },
  { id: "balanced", key: "pdfTools.lvlBalanced", hint: "pdfTools.lvlBalancedHint" },
  { id: "strong", key: "pdfTools.lvlStrong", hint: "pdfTools.lvlStrongHint" },
];

function CompressTool({ toast }: { toast: (m: string) => void }) {
  const t = useT();
  const [src, setSrc] = useState<SrcFile | null>(null);
  const [level, setLevel] = useState<CompressLevel>("balanced");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [res, setRes] = useState<{ bytes: Uint8Array; before: number; after: number; rasterized: boolean } | null>(null);

  const pick = async (l: FileList) => {
    try { setSrc(await readPdf(l[0])); setRes(null); }
    catch (e) { toast(e instanceof Error ? e.message : t("pdfTools.readFailed")); }
  };
  const run = async () => {
    if (!src) return;
    setBusy(true);
    try {
      const r = await compressPdf(src.buf, level,
        (done, total) => setProg(t("pdfTools.pageProg", { done, total })));
      setRes(r);
      toast(r.after < r.before
        ? t("pdfTools.saved", { pct: Math.round((1 - r.after / r.before) * 100) })
        : t("pdfTools.noSaving"));
    } catch { toast(t("pdfTools.compressFailed")); }
    finally { setBusy(false); setProg(""); }
  };

  const savedPct = res ? Math.round((1 - res.after / res.before) * 100) : 0;
  return (
    <>
      <Picker onPick={(l) => void pick(l)} label={t("pdfTools.pickPdf")} />
      {src && (
        <>
          <div className="pt-row pt-src">
            <span className="pt-name">{src.name}</span>
            <span className="pt-meta">{t("pdfTools.pageCount", { count: src.pages })} · {fmtSize(src.size)}</span>
          </div>
          <div className="pt-modes pt-levels">
            {LEVELS.map((l) => (
              <label className={`pt-mode ${level === l.id ? "on" : ""}`} key={l.id}>
                <input type="radio" checked={level === l.id} onChange={() => setLevel(l.id)} />
                <b>{t(l.key)}</b>
                <small>{t(l.hint)}</small>
              </label>
            ))}
          </div>
          {!busy && <button className="btn-primary" onClick={() => void run()}>{t("pdfTools.compressBtn")}</button>}
        </>
      )}
      {busy && <div className="pt-progress">{prog || t("pdfTools.working")}</div>}
      {res && (
        <div className="pt-stats">
          <div><small>{t("pdfTools.before")}</small><b>{fmtSize(res.before)}</b></div>
          <div className="pt-arrow">→</div>
          <div><small>{t("pdfTools.after")}</small><b>{fmtSize(res.after)}</b></div>
          <div className={`pt-pct ${savedPct > 0 ? "good" : ""}`}>{savedPct > 0 ? `−${savedPct}%` : `+${-savedPct}%`}</div>
        </div>
      )}
      {res?.rasterized && <div className="pt-note">{t("pdfTools.rasterNote")}</div>}
      {res && <ResultBar results={[{ name: `${baseName(src!.name)}-compressed.pdf`, bytes: res.bytes }]} toast={toast} />}
    </>
  );
}

export function PdfTools() {
  const t = useT();
  const { msg, toast } = useToast();
  const [tool, setTool] = useState<ToolId>("merge");
  const tools: { id: ToolId; ico: string; key: string; hint: string }[] = [
    { id: "merge", ico: "⧉+", key: "pdfTools.merge", hint: "pdfTools.mergeHint" },
    { id: "split", ico: "✂", key: "pdfTools.split", hint: "pdfTools.splitHint" },
    { id: "compress", ico: "🗜", key: "pdfTools.compress", hint: "pdfTools.compressHint" },
  ];
  return (
    <div className="pdf-tools">
      <header className="pt-head">
        <h1>{t("pdfTools.title")}</h1>
        <p>{t("pdfTools.sub")}</p>
      </header>
      <div className="pt-tabs">
        {tools.map((x) => (
          <button key={x.id} className={`pt-tab ${tool === x.id ? "on" : ""}`} onClick={() => setTool(x.id)}>
            <span className="pt-tab-ico">{x.ico}</span>
            <b>{t(x.key)}</b>
            <small>{t(x.hint)}</small>
          </button>
        ))}
      </div>
      <div className="pt-card">
        {tool === "merge" && <MergeTool toast={toast} />}
        {tool === "split" && <SplitTool toast={toast} />}
        {tool === "compress" && <CompressTool toast={toast} />}
      </div>
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
