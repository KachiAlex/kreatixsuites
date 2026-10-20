import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getToken } from "../lib/api";
import { API_BASE } from "../lib/platform";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";
import { createDoc } from "../lib/create";
import { saveFile } from "../lib/saveFile";
import type { CellData } from "../sheets/model";

// Kreatix Forms — org forms with a public share link. Builder edits an
// ordered field list + form settings; /f/<token> is public for respondents.

interface ShowIf { field: string; equals: string }
interface Field {
  id: string; label: string; type: string; required?: boolean;
  description?: string; options?: string[]; allowOther?: boolean;
  min?: number; max?: number; minLen?: number; maxLen?: number;
  scaleMin?: number; scaleMax?: number; scaleLow?: string; scaleHigh?: string;
  showIf?: ShowIf; correct?: string; points?: number;
  payAmount?: number; payLabel?: string;
}
interface Settings {
  confirmMsg?: string; closeAt?: string; closeAfter?: number;
  requireSignIn?: boolean; orgOnly?: boolean; onePerUser?: boolean;
  collectName?: boolean; showProgress?: boolean; accent?: string;
  layout?: "classic" | "chat"; quiz?: boolean; dlp?: boolean;
  requiresReview?: boolean; retentionDays?: number; shuffleOptions?: boolean;
  editAfterSubmit?: boolean; syncSheet?: string;
  requireSignature?: boolean; signatories?: string[];
}
interface Form {
  id: string; title: string | null; description: string | null;
  fields: Field[]; settings: Settings; open: boolean; token: string;
  createdBy: string; createdByName: string | null; responses: number; updatedAt: string;
  viewCount: number;
}
interface Resp {
  id: string; answers: Record<string, unknown>; respondent: string | null;
  verified: boolean; status: string; score: number | null; createdAt: string;
  paidAt?: string | null; payRef?: string | null;
  signedBy?: string | null; signedAt?: string | null; signMethod?: string | null;
}
interface OrgMember { id: string; name: string; initials: string | null; role: string }
interface SummaryField {
  id: string; label: string; type: string; answered: number;
  buckets?: { v: string; n: number }[]; avg?: number | null; samples?: string[];
  nps?: number | null; rankAvg?: boolean;
}

const TYPES: { v: string; label: string }[] = [
  { v: "text", label: "Short text" }, { v: "textarea", label: "Paragraph" },
  { v: "email", label: "Email" }, { v: "number", label: "Number" },
  { v: "date", label: "Date" }, { v: "time", label: "Time" },
  { v: "url", label: "Link / URL" }, { v: "phone", label: "Phone" },
  { v: "choice", label: "Multiple choice" }, { v: "multiselect", label: "Checkboxes" },
  { v: "checkbox", label: "Yes/No" }, { v: "rating", label: "Rating (1-5)" },
  { v: "scale", label: "Linear scale" }, { v: "nps", label: "NPS (0-10)" },
  { v: "ranking", label: "Ranking" }, { v: "section", label: "Section header" },
  { v: "file", label: "File upload" }, { v: "payment", label: "Payment (₦)" },
];

// starter templates — prefilled schema + settings, editable before save
const TEMPLATES: { name: string; desc: string; title: string; fields: Omit<Field, "id">[]; settings?: Settings }[] = [
  { name: "Blank form", desc: "Start from scratch", title: "", fields: [{ label: "", type: "text" }] },
  {
    name: "Contact / lead intake", desc: "Name, email, message",
    title: "Contact us",
    fields: [
      { label: "Your name", type: "text", required: true },
      { label: "Email", type: "email", required: true },
      { label: "Message", type: "textarea", required: true },
    ],
  },
  {
    name: "Event RSVP", desc: "Attendance, guests, dietary needs",
    title: "RSVP",
    fields: [
      { label: "Your name", type: "text", required: true },
      { label: "Will you attend?", type: "choice", required: true, options: ["Yes", "No", "Maybe"] },
      { label: "Number of guests", type: "number", min: 0, max: 10 },
      { label: "Dietary requirements", type: "text" },
    ],
    settings: { collectName: false },
  },
  {
    name: "Customer feedback (NPS)", desc: "0-10 score + free text",
    title: "How are we doing?",
    fields: [
      { label: "How likely are you to recommend us to a friend?", type: "nps", required: true },
      { label: "What's the main reason for your score?", type: "textarea" },
      { label: "Overall satisfaction", type: "rating" },
    ],
    settings: { collectName: false },
  },
  {
    name: "Job application", desc: "Details + résumé upload",
    title: "Job application",
    fields: [
      { label: "Full name", type: "text", required: true },
      { label: "Email", type: "email", required: true },
      { label: "Phone", type: "phone" },
      { label: "Portfolio / LinkedIn", type: "url" },
      { label: "Résumé", type: "file", required: true },
      { label: "Why this role?", type: "textarea" },
    ],
    settings: { collectName: false, requireSignIn: false },
  },
  {
    name: "Paid registration", desc: "Sign-up + Paystack payment",
    title: "Registration",
    fields: [
      { label: "Full name", type: "text", required: true },
      { label: "Email", type: "email", required: true },
      { label: "Phone", type: "phone" },
      { label: "Registration fee", type: "payment", payLabel: "Registration", payAmount: 5000 },
    ],
    settings: { collectName: false },
  },
  {
    name: "Quiz", desc: "Sample scored questions",
    title: "Quiz",
    fields: [
      { label: "What is 2 + 2?", type: "choice", required: true, options: ["3", "4", "5"], correct: "4", points: 1 },
      { label: "The sky is blue.", type: "checkbox", required: true, correct: "true", points: 1 },
    ],
    settings: { quiz: true, collectName: true },
  },
  {
    name: "Bug report", desc: "Summary, severity, screenshot",
    title: "Report a bug",
    fields: [
      { label: "What happened?", type: "text", required: true },
      { label: "Severity", type: "choice", required: true, options: ["Cosmetic", "Annoying", "Broken", "Data loss"] },
      { label: "Steps to reproduce", type: "textarea" },
      { label: "Screenshot", type: "file" },
    ],
    settings: { collectName: false },
  },
];
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const publicUrl = (token: string) => `${location.origin}/f/${token}`;
const hasOptions = (t: string) => t === "choice" || t === "multiselect" || t === "ranking";
const answerable = (f: Field) => f.type !== "section" && f.type !== "payment";

const ans = (v: unknown): string =>
  Array.isArray(v) ? v.join(", ")
    : typeof v === "object" && v !== null ? (v as { name?: string }).name ?? "file"
    : v === true ? "Yes" : v === false ? "No" : v == null ? "—" : String(v);

/** Digitized signature capture — freehand canvas strokes, or a typed name
 *  rendered in a handwriting font. Produces a PNG data URL. */
function SignaturePad({ onSign, onClose }: {
  onSign: (dataUrl: string, method: "drawn" | "typed") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [mode, setMode] = useState<"drawn" | "typed">("drawn");
  const [typed, setTyped] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#1b1b1f"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true; setDirty(true);
    const ctx = ref.current!.getContext("2d")!;
    const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    ref.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext("2d")!;
    const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
  };
  const up = () => { drawing.current = false; };

  const clear = () => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    setDirty(false);
  };

  const signTyped = () => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#1b1b1f";
    ctx.font = "italic 56px 'Dancing Script','Segoe Script',cursive";
    ctx.textBaseline = "middle";
    ctx.fillText(typed.slice(0, 40), 20, c.height / 2);
    return c.toDataURL("image/png");
  };

  return (
    <div>
      <div className="dlg-tabs" style={{ marginBottom: 10 }}>
        <button className={`dlg-tab${mode === "drawn" ? " on" : ""}`} onClick={() => setMode("drawn")}>Draw</button>
        <button className={`dlg-tab${mode === "typed" ? " on" : ""}`} onClick={() => setMode("typed")}>Type name</button>
      </div>
      <canvas ref={ref} width={460} height={160} className="sig-canvas"
        onPointerDown={mode === "drawn" ? down : undefined}
        onPointerMove={mode === "drawn" ? move : undefined}
        onPointerUp={up} onPointerLeave={up} />
      {mode === "typed" && (
        <input placeholder="Type your full name" value={typed} autoFocus
          onChange={(e) => setTyped(e.target.value)} style={{ width: "100%", marginTop: 8 }} />
      )}
      <p className="d-sub" style={{ margin: "8px 0 0" }}>
        Signing authorizes this response — your name, timestamp, and IP are recorded with it.
      </p>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={clear}>Clear</button>
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary"
          disabled={mode === "drawn" ? !dirty : !typed.trim()}
          onClick={() => {
            const c = ref.current!;
            onSign(mode === "typed" ? signTyped() : c.toDataURL("image/png"), mode);
          }}>Sign &amp; authorize</button>
      </div>
    </div>
  );
}

export function Forms() {
  const { user } = useAuth();
  const { msg, toast } = useToast();
  const navigate = useNavigate();
  const [forms, setForms] = useState<Form[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [tab, setTab] = useState<"questions" | "settings">("questions");
  const [editing, setEditing] = useState<Form | null>(null);
  const [respForm, setRespForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<Resp[]>([]);
  const [sumForm, setSumForm] = useState<Form | null>(null);
  const [summary, setSummary] = useState<SummaryField[]>([]);
  const [sumStats, setSumStats] = useState<{
    total: number; avgScore: number | null; views: number; completionRate: number | null;
  } | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragArmed, setDragArmed] = useState<number | null>(null); // grip held → card becomes draggable
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [signResp, setSignResp] = useState<Resp | null>(null);   // response being signed
  const [signOnly, setSignOnly] = useState(false);               // viewing signables as a signatory
  const [sigPng, setSigPng] = useState<Record<string, string>>({}); // rid → object URL

  useEffect(() => {
    api.get<{ members: OrgMember[] }>("/api/forms/members")
      .then((r) => setMembers(r.members)).catch(() => {});
  }, []);
  const [embedForm, setEmbedForm] = useState<Form | null>(null);
  const [qr, setQr] = useState("");
  const [busy, setBusy] = useState(false);
  const [fTitle, setFTitle] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fFields, setFFields] = useState<Field[]>([]);
  const [fSettings, setFSettings] = useState<Settings>({});
  const [respStatus, setRespStatus] = useState("all");

  const load = useCallback(async () => {
    try { setForms((await api.get<{ forms: Form[] }>("/api/forms")).forms); }
    catch (e) { toast((e as Error).message); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const openNew = () => setTplOpen(true);
  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    setEditing(null); setFTitle(t.title); setFDesc(t.desc);
    setFFields(t.fields.map((f) => ({ ...f, id: uid() } as Field)));
    setFSettings(t.settings ?? {}); setTab("questions"); setTplOpen(false); setEditOpen(true);
  };
  const openEdit = (f: Form) => {
    setEditing(f); setFTitle(f.title ?? ""); setFDesc(f.description ?? "");
    setFFields(f.fields.length ? f.fields : [{ id: uid(), label: "", type: "text" }]);
    setFSettings(f.settings ?? {}); setTab("questions"); setEditOpen(true);
  };
  const setField = (i: number, patch: Partial<Field>) =>
    setFFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const moveField = (i: number, dir: -1 | 1) =>
    setFFields((fs) => {
      const j = i + dir;
      if (j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const moveTo = (from: number, to: number) =>
    setFFields((fs) => {
      if (from === to || from < 0 || to < 0 || from >= fs.length || to >= fs.length) return fs;
      const next = [...fs];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return next;
    });
  const setSet = (patch: Partial<Settings>) => setFSettings((s) => ({ ...s, ...patch }));

  const save = async () => {
    const fields = fFields.filter((f) => f.label.trim());
    if (!fTitle.trim() || !fields.length) return;
    setBusy(true);
    try {
      const body = { title: fTitle.trim(), description: fDesc.trim() || undefined, fields, settings: fSettings };
      if (editing) await api.patch(`/api/forms/${editing.id}`, body);
      else await api.post("/api/forms", body);
      setEditOpen(false); void load();
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  const toggleOpen = async (f: Form) => {
    try { await api.patch(`/api/forms/${f.id}`, { open: !f.open }); void load(); }
    catch (e) { toast((e as Error).message); }
  };
  const del = async (f: Form) => {
    if (!confirm(`Delete "${f.title}" and all its responses?`)) return;
    try { await api.del(`/api/forms/${f.id}`); void load(); }
    catch (e) { toast((e as Error).message); }
  };
  const dupe = async (f: Form) => {
    try { await api.post(`/api/forms/${f.id}/duplicate`, {}); void load(); toast("Form duplicated (closed — open it when ready)"); }
    catch (e) { toast((e as Error).message); }
  };
  const copyLink = async (f: Form) => {
    await navigator.clipboard.writeText(publicUrl(f.token));
    toast("Share link copied");
  };
  const openEmbed = async (f: Form) => {
    setEmbedForm(f); setQr("");
    try {
      const QR = await import("qrcode");
      setQr(await QR.toDataURL(publicUrl(f.token), { width: 220, margin: 1 }));
    } catch { /* QR optional — snippet still shows */ }
  };

  const viewResponses = async (f: Form) => {
    try {
      const r = await api.get<{ responses: Resp[] }>(`/api/forms/${f.id}/responses`);
      setResponses(r.responses); setRespForm(f); setRespStatus("all"); setSignOnly(false);
      r.responses.forEach((x) => { if (x.signedAt) void showSignature(f, x.id); });
    } catch (e) {
      // signatories who can't manage the form still get the pending queue
      if ((e as Error & { status?: number }).status === 403 && (f.settings.signatories ?? []).includes(user?.id ?? "")) {
        try {
          const r = await api.get<{ responses: Resp[] }>(`/api/forms/${f.id}/signables`);
          setResponses(r.responses); setRespForm(f); setRespStatus("pending"); setSignOnly(true);
          return;
        } catch (e2) { toast((e2 as Error).message); return; }
      }
      toast((e as Error).message);
    }
  };
  const setResp = async (f: Form, rid: string, status: string) => {
    try {
      await api.patch(`/api/forms/${f.id}/responses/${rid}`, { status });
      setResponses((rs) => rs.map((r) => (r.id === rid ? { ...r, status } : r)));
    } catch (e) { toast((e as Error).message); }
  };
  const delResp = async (f: Form, rid: string) => {
    try {
      await api.del(`/api/forms/${f.id}/responses/${rid}`);
      setResponses((rs) => rs.filter((r) => r.id !== rid));
    } catch (e) { toast((e as Error).message); }
  };

  const signResponse = async (f: Form, rid: string, dataUrl: string, method: "drawn" | "typed") => {
    try {
      await api.post(`/api/forms/${f.id}/responses/${rid}/sign`, { method, dataUrl });
      setResponses((rs) => rs.map((r) => r.id === rid
        ? { ...r, status: "approved", signedBy: user?.displayName ?? null, signedAt: new Date().toISOString(), signMethod: method }
        : r));
      setSignResp(null);
      toast("Response signed and authorized");
    } catch (e) { toast((e as Error).message); }
  };

  const showSignature = async (f: Form, rid: string) => {
    if (sigPng[rid]) return;
    try {
      const r = await fetch(`${API_BASE}/api/forms/${f.id}/responses/${rid}/signature.png`,
        { headers: { authorization: `Bearer ${getToken()}` } });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      setSigPng((m) => ({ ...m, [rid]: url }));
    } catch { /* no artifact */ }
  };

  const viewSummary = async (f: Form) => {
    try {
      const r = await api.get<{
        total: number; avgScore: number | null; views: number;
        completionRate: number | null; summary: SummaryField[];
      }>(`/api/forms/${f.id}/summary`);
      setSummary(r.summary);
      setSumStats({ total: r.total, avgScore: r.avgScore, views: r.views, completionRate: r.completionRate });
      setSumForm(f);
    } catch (e) { toast((e as Error).message); }
  };

  const exportCsv = async (f: Form) => {
    try {
      const r = await fetch(`${API_BASE}/api/forms/${f.id}/responses.csv`,
        { headers: { authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error("Export failed");
      await saveFile(new Blob([await r.blob()], { type: "text/csv" }), `${(f.title ?? "responses").replace(/[^\w-]+/g, "_")}.csv`);
    } catch (e) { toast((e as Error).message); }
  };

  const toSheets = async (f: Form) => {
    try {
      const r = await api.get<{ responses: Resp[] }>(`/api/forms/${f.id}/responses`);
      const fields = f.fields.filter(answerable);
      const hasPay = f.fields.some((x) => x.type === "payment");
      const cells: Record<string, CellData> = {};
      const cols = ["Submitted", "Respondent", ...fields.map((x) => x.label),
        ...(f.settings.quiz ? ["Score"] : []), ...(hasPay ? ["Paid"] : [])];
      // A1-style column names — past Z needs AA/AB/… (forms can have 100 fields)
      const col = (i: number) => {
        let s = ""; let n = i + 1;
        while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
        return s;
      };
      cols.forEach((c, i) => { cells[`${col(i)}1`] = { v: c, s: { b: true } }; });
      r.responses.filter((x) => x.status !== "unpaid").slice().reverse().forEach((resp, ri) => {
        const row = ri + 2;
        cells[`A${row}`] = { v: fmtWhen(resp.createdAt) };
        cells[`B${row}`] = { v: resp.respondent ?? "anonymous" };
        fields.forEach((fd, ci) => {
          const v = resp.answers[fd.id];
          if (v !== undefined) cells[`${col(ci + 2)}${row}`] = { v: ans(v) };
        });
        if (f.settings.quiz && resp.score !== null)
          cells[`${col(fields.length + 2)}${row}`] = { v: resp.score };
        if (hasPay) cells[`${col(cols.length - 1)}${row}`] = { v: resp.paidAt ? "yes" : "" };
      });
      const item = await createDoc("sheets", `${f.title ?? "Form"} — Responses`, {
        kind: "sheets",
        workbook: { sheets: [{ name: "Responses", cells, freeze: { rows: 1, cols: 0 } }] },
      });
      // link for live sync — every new response appends a row server-side
      await api.patch(`/api/forms/${f.id}`, { settings: { ...f.settings, syncSheet: item.id } });
      void load();
      toast("Linked — new responses will append to this workbook live");
      navigate(`/edit/${item.id}`);
    } catch (e) { toast((e as Error).message); }
  };

  const canEdit = (f: Form) => f.createdBy === user?.id || user?.role === "owner" || user?.role === "admin";
  const filteredResp = responses.filter((r) => respStatus === "all" || r.status === respStatus);
  const showIfTargets = (i: number) => fFields.slice(0, i).filter((f) => f.label.trim() && f.type !== "section" && f.type !== "file");

  return (
    <>
      <div className="crumbs">
        <b>Forms</b><span className="d-sub" style={{ marginLeft: 8 }}>surveys &amp; intake</span>
        <button className="btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={openNew}>＋ New form</button>
      </div>

      <div className="panel">
        {!forms.length && <div className="empty" style={{ padding: 24 }}>No forms yet — create one and share the link.</div>}
        {forms.map((f) => (
          <div key={f.id} className="meet-row" style={{ flexWrap: "wrap" }}>
            <span className={`meet-status ${f.open ? "live" : "ended"}`}>{f.open ? "open" : "closed"}</span>
            <div className="meet-row-main">
              <b>{f.title}</b>
              <span className="d-sub">
                {f.fields.filter(answerable).length} question{f.fields.filter(answerable).length === 1 ? "" : "s"} · {f.responses} response{f.responses === 1 ? "" : "s"}
                {f.viewCount ? ` · ${f.viewCount} views` : ""}
                {f.settings.quiz ? " · quiz" : ""}{f.settings.requiresReview ? " · review on" : ""}
                {f.settings.syncSheet ? " · ⇄ Sheets live" : ""}
                {f.createdByName ? ` · ${f.createdByName}` : ""} · {fmtWhen(f.updatedAt)}
              </span>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => void copyLink(f)} title="Copy share link">🔗 Share</button>
            <button className="btn-ghost btn-sm" disabled={!f.responses} onClick={() => void viewResponses(f)}>Responses{f.responses ? ` (${f.responses})` : ""}</button>
            <button className="btn-ghost btn-sm" disabled={!f.responses} onClick={() => void viewSummary(f)}>Summary</button>
            {canEdit(f) && (
              <>
                <button className="btn-ghost btn-sm" onClick={() => openEdit(f)}>Edit</button>
                <button className="btn-ghost btn-sm" onClick={() => void openEmbed(f)}>Embed</button>
                <button className="btn-ghost btn-sm" disabled={!f.responses} onClick={() => void exportCsv(f)}>CSV</button>
                <button className="btn-ghost btn-sm" title="Export current responses and link live sync"
                  onClick={() => void toSheets(f)}>⇄ Sheets</button>
                <button className="btn-ghost btn-sm" onClick={() => void dupe(f)}>Duplicate</button>
                <button className="btn-ghost btn-sm" onClick={() => void toggleOpen(f)}>{f.open ? "Close" : "Open"}</button>
                <button className="btn-ghost btn-sm" onClick={() => void del(f)}>Delete</button>
              </>
            )}
          </div>
        ))}
      </div>

      {tplOpen && (
        <Modal label="New form" onClose={() => setTplOpen(false)} style={{ width: 560, maxWidth: "94vw" }}>
          <div className="ob-body" style={{ maxHeight: "70vh", overflow: "auto" }}>
            <div className="form-tpl-grid">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="form-tpl" onClick={() => applyTemplate(t)}>
                  <b>{t.name}</b>
                  <span className="d-sub">{t.fields.length} question{t.fields.length === 1 ? "" : "s"} · {t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {editOpen && (
        <Modal label={editing ? "Edit form" : "New form"} onClose={() => setEditOpen(false)} style={{ width: 680, maxWidth: "96vw" }}>
          <div className="dlg-tabs">
            <button className={`dlg-tab${tab === "questions" ? " on" : ""}`} onClick={() => setTab("questions")}>Questions</button>
            <button className={`dlg-tab${tab === "settings" ? " on" : ""}`} onClick={() => setTab("settings")}>Settings</button>
          </div>
          <div className="ob-body" style={{ maxHeight: "72vh", overflow: "auto" }}>
            <input placeholder="Form title" value={fTitle} onChange={(e) => setFTitle(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }} autoFocus />
            {tab === "questions" && (
              <input placeholder="Description (optional)" value={fDesc} onChange={(e) => setFDesc(e.target.value)}
                style={{ width: "100%", marginBottom: 12 }} />
            )}

            {tab === "questions" && fFields.map((f, i) => (
              <div key={f.id} className={`form-field-card${dragIdx === i ? " dragging" : ""}`}
                draggable={dragArmed === i}
                onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (dragIdx !== null) moveTo(dragIdx, i); setDragIdx(null); setDragArmed(null); }}
                onDragEnd={() => { setDragIdx(null); setDragArmed(null); }}>
                <div className="form-field-row">
                  <span className="form-grip" title="Drag to reorder"
                    onMouseDown={() => setDragArmed(i)} onMouseUp={() => setDragArmed(null)}>⠿</span>
                  <input placeholder={f.type === "section" ? "Section title" : "Question"} value={f.label} style={{ flex: 1 }}
                    onChange={(e) => setField(i, { label: e.target.value })} />
                  <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as Field["type"] })}>
                    {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                  </select>
                  {f.type !== "section" && f.type !== "payment" && (
                    <label className="cal-check" style={{ marginBottom: 0 }}>
                      <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Req
                    </label>
                  )}
                  <button className="iconbtn" title="Move up" disabled={i === 0} onClick={() => moveField(i, -1)}>↑</button>
                  <button className="iconbtn" title="Move down" disabled={i === fFields.length - 1} onClick={() => moveField(i, 1)}>↓</button>
                  <button className="iconbtn" title="Remove" onClick={() => setFFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
                </div>
                <input placeholder="Help text (optional)" value={f.description ?? ""} style={{ width: "100%", marginTop: 6 }}
                  onChange={(e) => setField(i, { description: e.target.value || undefined })} />

                {hasOptions(f.type) && (
                  <div style={{ marginTop: 8 }}>
                    {(f.options ?? []).map((o, oi) => (
                      <div key={oi} className="dlg-inline">
                        <input value={o} style={{ flex: 1 }}
                          onChange={(e) => setField(i, { options: (f.options ?? []).map((x, j) => (j === oi ? e.target.value : x)) })} />
                        <button className="iconbtn" onClick={() => setField(i, { options: (f.options ?? []).filter((_, j) => j !== oi) })}>✕</button>
                      </div>
                    ))}
                    <div className="dlg-inline">
                      <button className="btn-ghost btn-sm" onClick={() => setField(i, { options: [...(f.options ?? []), `Option ${(f.options ?? []).length + 1}`] })}>＋ Option</button>
                      <label className="cal-check" style={{ marginBottom: 0 }}>
                        <input type="checkbox" checked={!!f.allowOther} onChange={(e) => setField(i, { allowOther: e.target.checked })} /> Allow "Other"
                      </label>
                    </div>
                  </div>
                )}
                {f.type === "number" && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <input type="number" placeholder="Min" style={{ width: 90 }} value={f.min ?? ""}
                      onChange={(e) => setField(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <input type="number" placeholder="Max" style={{ width: 90 }} value={f.max ?? ""}
                      onChange={(e) => setField(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </div>
                )}
                {(f.type === "text" || f.type === "textarea") && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <input type="number" placeholder="Min chars" style={{ width: 100 }} value={f.minLen ?? ""}
                      onChange={(e) => setField(i, { minLen: e.target.value === "" ? undefined : Number(e.target.value) })} />
                    <input type="number" placeholder="Max chars" style={{ width: 100 }} value={f.maxLen ?? ""}
                      onChange={(e) => setField(i, { maxLen: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </div>
                )}
                {f.type === "scale" && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <input type="number" placeholder="From" style={{ width: 70 }} value={f.scaleMin ?? 1}
                      onChange={(e) => setField(i, { scaleMin: Number(e.target.value) || 1 })} />
                    <input type="number" placeholder="To" style={{ width: 70 }} value={f.scaleMax ?? 10}
                      onChange={(e) => setField(i, { scaleMax: Number(e.target.value) || 10 })} />
                    <input placeholder="Low label" style={{ flex: 1 }} value={f.scaleLow ?? ""}
                      onChange={(e) => setField(i, { scaleLow: e.target.value || undefined })} />
                    <input placeholder="High label" style={{ flex: 1 }} value={f.scaleHigh ?? ""}
                      onChange={(e) => setField(i, { scaleHigh: e.target.value || undefined })} />
                  </div>
                )}
                {f.type === "payment" && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <input placeholder="Label" style={{ flex: 1 }} value={f.payLabel ?? ""}
                      onChange={(e) => setField(i, { payLabel: e.target.value || undefined })} />
                    <span className="d-sub">₦</span>
                    <input type="number" min={1} placeholder="Amount" style={{ width: 110 }} value={f.payAmount ?? ""}
                      onChange={(e) => setField(i, { payAmount: e.target.value === "" ? undefined : Math.round(Number(e.target.value)) })} />
                  </div>
                )}
                {showIfTargets(i).length > 0 && f.type !== "section" && f.type !== "payment" && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <label className="cal-check" style={{ marginBottom: 0 }}>
                      <input type="checkbox" checked={!!f.showIf}
                        onChange={(e) => setField(i, { showIf: e.target.checked ? { field: showIfTargets(i)[0].id, equals: "" } : undefined })} />
                      Show only if
                    </label>
                    {f.showIf && (
                      <>
                        <select value={f.showIf.field} onChange={(e) => setField(i, { showIf: { ...f.showIf!, field: e.target.value } })}>
                          {showIfTargets(i).map((t) => <option key={t.id} value={t.id}>{t.label.slice(0, 40)}</option>)}
                        </select>
                        <span className="d-sub">=</span>
                        <input placeholder="answer" style={{ width: 120 }} value={f.showIf.equals}
                          onChange={(e) => setField(i, { showIf: { ...f.showIf!, equals: e.target.value } })} />
                      </>
                    )}
                  </div>
                )}
                {fSettings.quiz && (hasOptions(f.type) || f.type === "checkbox" || f.type === "rating" || f.type === "scale") && (
                  <div className="dlg-inline" style={{ marginTop: 6 }}>
                    <span className="d-sub">Correct:</span>
                    <select value={f.correct ?? ""} onChange={(e) => setField(i, { correct: e.target.value || undefined })}>
                      <option value="">—</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                      {f.type === "checkbox" && <><option value="true">Yes</option><option value="false">No</option></>}
                      {(f.type === "rating" || f.type === "scale") &&
                        Array.from({ length: ((f.type === "scale" ? (f.scaleMax ?? 10) : 5) - (f.type === "scale" ? (f.scaleMin ?? 1) : 1)) + 1 },
                          (_, n) => String(n + (f.type === "scale" ? (f.scaleMin ?? 1) : 1)))
                          .map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <input type="number" placeholder="Pts" style={{ width: 60 }} value={f.points ?? ""}
                      onChange={(e) => setField(i, { points: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </div>
                )}
              </div>
            ))}
            {tab === "questions" && (
              <button className="btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}
                onClick={() => setFFields((fs) => [...fs, { id: uid(), label: "", type: "text" }])}>＋ Add question</button>
            )}

            {tab === "settings" && (
              <div className="form-settings">
                <label className="form-set-row"><span>Confirmation message</span>
                  <input value={fSettings.confirmMsg ?? ""} placeholder="Thanks — your response was recorded"
                    onChange={(e) => setSet({ confirmMsg: e.target.value || undefined })} /></label>
                <label className="form-set-row"><span>Layout</span>
                  <select value={fSettings.layout ?? "classic"} onChange={(e) => setSet({ layout: e.target.value as Settings["layout"] })}>
                    <option value="classic">All questions on one page</option>
                    <option value="chat">One question at a time</option>
                  </select></label>
                <label className="form-set-row"><span>Accent color</span>
                  <span className="dlg-inline" style={{ marginBottom: 0 }}>
                    <input type="color" value={fSettings.accent ?? "#F2782E"} onChange={(e) => setSet({ accent: e.target.value })} />
                    {fSettings.accent && <button className="btn-ghost btn-sm" onClick={() => setSet({ accent: undefined })}>Clear</button>}
                  </span></label>
                <label className="form-set-row"><span>Close at date/time</span>
                  <input type="datetime-local" value={fSettings.closeAt
                      ? new Date(new Date(fSettings.closeAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
                    onChange={(e) => setSet({ closeAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })} /></label>
                <label className="form-set-row"><span>Close after N responses</span>
                  <input type="number" min={1} style={{ width: 120 }} value={fSettings.closeAfter ?? ""}
                    onChange={(e) => setSet({ closeAfter: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
                <label className="form-set-row"><span>Auto-delete responses after (days)</span>
                  <input type="number" min={1} max={3650} style={{ width: 120 }} value={fSettings.retentionDays ?? ""}
                    onChange={(e) => setSet({ retentionDays: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
                <div className="form-set-grid">
                  <label className="cal-check"><input type="checkbox" checked={fSettings.collectName !== false}
                    onChange={(e) => setSet({ collectName: e.target.checked })} /> Ask for name/email</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.requireSignIn}
                    onChange={(e) => setSet({ requireSignIn: e.target.checked })} /> Require sign-in</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.orgOnly}
                    onChange={(e) => setSet({ orgOnly: e.target.checked })} /> Workspace members only</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.onePerUser}
                    onChange={(e) => setSet({ onePerUser: e.target.checked })} /> One response per person</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.showProgress}
                    onChange={(e) => setSet({ showProgress: e.target.checked })} /> Show progress bar</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.shuffleOptions}
                    onChange={(e) => setSet({ shuffleOptions: e.target.checked })} /> Shuffle answer options</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.quiz}
                    onChange={(e) => setSet({ quiz: e.target.checked })} /> Quiz mode (score answers)</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.requiresReview}
                    onChange={(e) => setSet({ requiresReview: e.target.checked })} /> Review before counting</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.dlp}
                    onChange={(e) => setSet({ dlp: e.target.checked })} /> Scan answers with DLP rules</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.editAfterSubmit}
                    onChange={(e) => setSet({ editAfterSubmit: e.target.checked })} /> Let respondents edit their response</label>
                  <label className="cal-check"><input type="checkbox" checked={!!fSettings.requireSignature}
                    onChange={(e) => setSet({ requireSignature: e.target.checked, signatories: e.target.checked ? (fSettings.signatories ?? []) : undefined })} />
                    Require authorized signature</label>
                </div>
                {fSettings.requireSignature && (
                  <div className="form-sign-box">
                    <span className="d-sub" style={{ display: "block", marginBottom: 6 }}>
                      Authorized signatories — a response stays pending until one signs it:
                    </span>
                    <div className="form-sign-list">
                      {members.map((m) => (
                        <label key={m.id} className="cal-check" style={{ marginBottom: 0 }}>
                          <input type="checkbox" checked={(fSettings.signatories ?? []).includes(m.id)}
                            onChange={(e) => setSet({
                              signatories: e.target.checked
                                ? [...(fSettings.signatories ?? []), m.id]
                                : (fSettings.signatories ?? []).filter((x) => x !== m.id),
                            })} />
                          {m.name} <span className="d-sub">({m.role})</span>
                        </label>
                      ))}
                    </div>
                    {!(fSettings.signatories ?? []).length && (
                      <span className="formfill-err" style={{ display: "block", marginTop: 6 }}>
                        Pick at least one signatory, or nobody can authorize responses.
                      </span>
                    )}
                  </div>
                )}
                {fFields.some((f) => f.type === "payment") && (
                  <p className="d-sub" style={{ marginTop: 8 }}>
                    Payment field: responses settle to this workspace's Paystack account —
                    connect a key under <b>Admin → Workspace → Payments</b>.
                  </p>
                )}
                {fSettings.syncSheet && (
                  <p className="d-sub" style={{ marginTop: 4 }}>
                    ⇄ Live-linked to a Sheets workbook — each response appends a row.
                    <button className="btn-ghost btn-sm" style={{ marginLeft: 6 }}
                      onClick={() => setSet({ syncSheet: undefined })}>Unlink</button>
                  </p>
                )}
              </div>
            )}

            <div className="dlg-actions" style={{ position: "sticky", bottom: 0 }}>
              <button className="btn-ghost" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={busy || !fTitle.trim() || !fFields.some((f) => f.label.trim())}
                onClick={() => void save()}>{editing ? "Save" : "Create form"}</button>
            </div>
          </div>
        </Modal>
      )}

      {respForm && (
        <Modal label={`Responses — ${respForm.title}`} onClose={() => setRespForm(null)} style={{ width: 680, maxWidth: "96vw" }}>
          <div className="ob-body" style={{ maxHeight: "72vh", overflow: "auto" }}>
            <div className="dlg-inline">
              {["all", "approved", "pending", "rejected", "unpaid"].map((s) => (
                <button key={s}
                  className={`btn-ghost btn-sm${respStatus === s ? " on" : ""}`}
                  onClick={() => setRespStatus(s)}>{s}</button>
              ))}
            </div>
            {!filteredResp.length && <div className="empty">No responses{respStatus !== "all" ? ` with status "${respStatus}"` : ""} yet.</div>}
            {filteredResp.map((r) => (
              <div key={r.id} className="form-resp">
                <div className="d-sub" style={{ marginBottom: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span>{fmtWhen(r.createdAt)} · {r.respondent ?? "anonymous"}{r.verified ? " ✓" : ""}</span>
                  {r.status !== "approved" && <span className={`meet-status ${r.status === "pending" ? "live" : "ended"}`}>{r.status}</span>}
                  {r.paidAt && <span className="meet-status live">paid</span>}
                  {r.signedBy && <span className="meet-status live">✍ {r.signedBy}</span>}
                  {r.score !== null && <span className="d-sub">score {r.score}</span>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {r.status === "pending" && !r.signedBy &&
                      (signOnly || canEdit(respForm)) &&
                      respForm.settings.requireSignature && (
                      <button className="btn-primary btn-sm" onClick={() => setSignResp(r)}>Sign</button>
                    )}
                    {!signOnly && r.status !== "approved" && <button className="btn-ghost btn-sm" onClick={() => void setResp(respForm, r.id, "approved")}>Approve</button>}
                    {!signOnly && r.status !== "rejected" && <button className="btn-ghost btn-sm" onClick={() => void setResp(respForm, r.id, "rejected")}>Reject</button>}
                    {!signOnly && <button className="btn-ghost btn-sm" onClick={() => void delResp(respForm, r.id)}>Delete</button>}
                  </span>
                </div>
                {respForm.fields.filter(answerable).map((f) => (
                  <div key={f.id} className="form-resp-row">
                    <span className="form-resp-q">{f.label}</span>
                    <span>{ans(r.answers[f.id])}</span>
                  </div>
                ))}
                {r.signedAt && sigPng[r.id] && (
                  <div className="form-resp-sig">
                    <span className="d-sub">Authorized signature — {r.signedBy} · {fmtWhen(r.signedAt)}</span>
                    <img src={sigPng[r.id]} alt="signature" className="form-sig-img" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {sumForm && sumStats && (
        <Modal label={`Summary — ${sumForm.title}`} onClose={() => setSumForm(null)} style={{ width: 640, maxWidth: "94vw" }}>
          <div className="ob-body" style={{ maxHeight: "72vh", overflow: "auto" }}>
            <p className="d-sub">{sumStats.total} approved response{sumStats.total === 1 ? "" : "s"}
              {sumStats.avgScore !== null ? ` · avg score ${sumStats.avgScore}` : ""}
              {sumStats.views ? ` · ${sumStats.views} views` : ""}
              {sumStats.completionRate !== null ? ` · ${sumStats.completionRate}% completion` : ""}</p>
            {summary.map((f) => (
              <div key={f.id} className="form-sum">
                <b className="form-sum-q">{f.label}</b>
                <span className="d-sub">{f.answered} answer{f.answered === 1 ? "" : "s"}
                  {f.avg !== undefined && f.avg !== null ? ` · avg ${f.avg}` : ""}
                  {f.nps !== undefined && f.nps !== null ? ` · NPS ${f.nps > 0 ? "+" : ""}${f.nps}` : ""}</span>
                {f.buckets?.map((b) => {
                  if (f.rankAvg) return ( // ranking: n is mean position — ordered list, not a bar
                    <div key={b.v} className="form-sum-bar">
                      <span className="d-sub" style={{ width: 32 }}>#{b.n}</span>
                      <span className="form-sum-v" style={{ flex: 1 }}>{b.v}</span>
                    </div>
                  );
                  const pct = f.answered ? Math.round((b.n / f.answered) * 100) : 0;
                  return (
                    <div key={b.v} className="form-sum-bar">
                      <span className="form-sum-v">{b.v}</span>
                      <div className="form-sum-track"><div className="form-sum-fill" style={{ width: `${pct}%` }} /></div>
                      <span className="d-sub">{b.n} ({pct}%)</span>
                    </div>
                  );
                })}
                {f.samples?.map((s, i) => <div key={i} className="form-sum-sample">{s.slice(0, 200)}</div>)}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {signResp && respForm && (
        <Modal label={`Authorize response — ${respForm.title}`} onClose={() => setSignResp(null)} style={{ width: 520 }}>
          <div className="ob-body">
            <SignaturePad
              onSign={(dataUrl, method) => void signResponse(respForm, signResp.id, dataUrl, method)}
              onClose={() => setSignResp(null)} />
          </div>
        </Modal>
      )}

      {embedForm && (
        <Modal label={`Share — ${embedForm.title}`} onClose={() => setEmbedForm(null)} style={{ width: 480 }}>
          <div className="ob-body">
            <label className="d-sub">Link</label>
            <div className="dlg-inline">
              <input readOnly value={publicUrl(embedForm.token)} style={{ flex: 1 }}
                onFocus={(e) => e.target.select()} />
              <button className="btn-ghost btn-sm" onClick={() => void copyLink(embedForm)}>Copy</button>
            </div>
            {qr && <div style={{ textAlign: "center", margin: "10px 0" }}><img src={qr} alt="QR code" width={180} /></div>}
            <label className="d-sub">Embed</label>
            <textarea className="dlg-textarea" rows={3} readOnly style={{ width: "100%" }}
              value={`<iframe src="${publicUrl(embedForm.token)}" width="100%" height="640" frameborder="0" title="${embedForm.title ?? "Form"}"></iframe>`}
              onFocus={(e) => e.target.select()} />
          </div>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
