import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";

// Kreatix Forms — org forms with a public share link (Microsoft Forms model).
// Builder edits a field list; the /f/<token> route is public for respondents.

interface Field { id: string; label: string; type: string; required?: boolean; options?: string[] }
interface Form {
  id: string; title: string | null; description: string | null;
  fields: Field[]; open: boolean; token: string;
  createdBy: string; createdByName: string | null; responses: number; updatedAt: string;
}
interface Resp { id: string; answers: Record<string, string | number | boolean>; respondent: string | null; createdAt: string }

const TYPES: { v: string; label: string }[] = [
  { v: "text", label: "Short text" }, { v: "textarea", label: "Paragraph" },
  { v: "email", label: "Email" }, { v: "number", label: "Number" },
  { v: "date", label: "Date" }, { v: "choice", label: "Choice" },
  { v: "checkbox", label: "Yes/No" }, { v: "rating", label: "Rating (1-5)" },
];
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const publicUrl = (token: string) => `${location.origin}/f/${token}`;

export function Forms() {
  const { user } = useAuth();
  const { msg, toast } = useToast();
  const [forms, setForms] = useState<Form[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Form | null>(null);
  const [respForm, setRespForm] = useState<Form | null>(null);
  const [responses, setResponses] = useState<Resp[]>([]);
  const [busy, setBusy] = useState(false);
  const [fTitle, setFTitle] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fFields, setFFields] = useState<Field[]>([]);

  const load = useCallback(async () => {
    try { setForms((await api.get<{ forms: Form[] }>("/api/forms")).forms); }
    catch (e) { toast((e as Error).message); }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  const openNew = () => {
    setEditing(null); setFTitle(""); setFDesc("");
    setFFields([{ id: uid(), label: "", type: "text", required: false }]);
    setEditOpen(true);
  };
  const openEdit = (f: Form) => {
    setEditing(f); setFTitle(f.title ?? ""); setFDesc(f.description ?? "");
    setFFields(f.fields.length ? f.fields : [{ id: uid(), label: "", type: "text" }]);
    setEditOpen(true);
  };
  const setField = (i: number, patch: Partial<Field>) =>
    setFFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const save = async () => {
    const fields = fFields.filter((f) => f.label.trim());
    if (!fTitle.trim() || !fields.length) return;
    setBusy(true);
    try {
      const body = { title: fTitle.trim(), description: fDesc.trim() || undefined, fields };
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
    try { await api.del(`/api/forms/${f.id}`); void load(); }
    catch (e) { toast((e as Error).message); }
  };
  const copyLink = async (f: Form) => {
    await navigator.clipboard.writeText(publicUrl(f.token));
    toast("Share link copied");
  };
  const viewResponses = async (f: Form) => {
    try {
      const r = await api.get<{ responses: Resp[] }>(`/api/forms/${f.id}/responses`);
      setResponses(r.responses); setRespForm(f);
    } catch (e) { toast((e as Error).message); }
  };
  const canEdit = (f: Form) => f.createdBy === user?.id || user?.role === "owner" || user?.role === "admin";

  return (
    <>
      <div className="crumbs">
        <b>Forms</b><span className="d-sub" style={{ marginLeft: 8 }}>surveys &amp; intake</span>
        <button className="btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={openNew}>＋ New form</button>
      </div>

      <div className="panel">
        {!forms.length && <div className="empty" style={{ padding: 24 }}>No forms yet — create one and share the link.</div>}
        {forms.map((f) => (
          <div key={f.id} className="meet-row">
            <span className={`meet-status ${f.open ? "live" : "ended"}`}>{f.open ? "open" : "closed"}</span>
            <div className="meet-row-main">
              <b>{f.title}</b>
              <span className="d-sub">
                {f.fields.length} field{f.fields.length === 1 ? "" : "s"} · {f.responses} response{f.responses === 1 ? "" : "s"}
                {f.createdByName ? ` · ${f.createdByName}` : ""} · {fmtWhen(f.updatedAt)}
              </span>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => void copyLink(f)}>🔗 Share</button>
            <button className="btn-ghost btn-sm" disabled={!f.responses} onClick={() => void viewResponses(f)}>
              Responses{f.responses ? ` (${f.responses})` : ""}
            </button>
            {canEdit(f) && (
              <>
                <button className="btn-ghost btn-sm" onClick={() => openEdit(f)}>Edit</button>
                <button className="btn-ghost btn-sm" onClick={() => void toggleOpen(f)}>{f.open ? "Close" : "Open"}</button>
                <button className="btn-ghost btn-sm" onClick={() => void del(f)}>Delete</button>
              </>
            )}
          </div>
        ))}
      </div>

      {editOpen && (
        <Modal label={editing ? "Edit form" : "New form"} onClose={() => setEditOpen(false)} style={{ width: 560 }}>
          <div className="ob-body">
            <input placeholder="Form title" value={fTitle} onChange={(e) => setFTitle(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }} autoFocus />
            <input placeholder="Description (optional)" value={fDesc} onChange={(e) => setFDesc(e.target.value)}
              style={{ width: "100%", marginBottom: 12 }} />
            {fFields.map((f, i) => (
              <div key={f.id} className="form-field-row">
                <input placeholder="Question" value={f.label} style={{ flex: 1 }}
                  onChange={(e) => setField(i, { label: e.target.value })} />
                <select value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
                  {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
                <label className="cal-check" style={{ marginBottom: 0 }}>
                  <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Req
                </label>
                <button className="iconbtn" title="Remove" onClick={() => setFFields((fs) => fs.filter((_, j) => j !== i))}>✕</button>
                {f.type === "choice" && (
                  <input placeholder="Options, comma-separated" style={{ gridColumn: "1 / -1" }}
                    value={(f.options ?? []).join(", ")}
                    onChange={(e) => setField(i, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
                )}
              </div>
            ))}
            <button className="btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}
              onClick={() => setFFields((fs) => [...fs, { id: uid(), label: "", type: "text" }])}>＋ Add question</button>
            <div className="dlg-actions">
              <button className="btn-ghost" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="btn-primary" disabled={busy || !fTitle.trim() || !fFields.some((f) => f.label.trim())}
                onClick={() => void save()}>{editing ? "Save" : "Create form"}</button>
            </div>
          </div>
        </Modal>
      )}

      {respForm && (
        <Modal label={`Responses — ${respForm.title}`} onClose={() => setRespForm(null)} style={{ width: 640, maxWidth: "94vw" }}>
          <div className="ob-body" style={{ maxHeight: "70vh", overflow: "auto" }}>
            {!responses.length && <div className="empty">No responses yet.</div>}
            {responses.map((r) => (
              <div key={r.id} className="form-resp">
                <div className="d-sub" style={{ marginBottom: 6 }}>
                  {fmtWhen(r.createdAt)}{r.respondent ? ` · ${r.respondent}` : " · anonymous"}
                </div>
                {respForm.fields.map((f) => (
                  <div key={f.id} className="form-resp-row">
                    <span className="form-resp-q">{f.label}</span>
                    <span>{String(r.answers[f.id] ?? "—")}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
