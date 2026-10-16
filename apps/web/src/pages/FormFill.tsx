import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "../lib/platform";

// Public form-fill page — no auth; the share token is the credential. Uses
// plain fetch so anonymous/offline sessions never detour through the mirror.

interface Field { id: string; label: string; type: string; required?: boolean; options?: string[] }
interface PubForm { title: string | null; description: string | null; fields: Field[] }

export function FormFill() {
  const { token } = useParams();
  const [form, setForm] = useState<PubForm | null>(null);
  const [gone, setGone] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const [respondent, setRespondent] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/forms/public/${token}`)
      .then(async (r) => (r.ok ? setForm((await r.json()).form) : setGone(true)))
      .catch(() => setGone(true));
  }, [token]);

  const set = (id: string, v: string | number | boolean) => setAnswers((a) => ({ ...a, [id]: v }));

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API_BASE}/api/forms/public/${token}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, respondent: respondent.trim() || undefined }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.message ?? "Submit failed"); }
      else setDone(true);
    } catch { setErr("Network error — try again"); }
    setBusy(false);
  };

  if (gone) return (
    <div className="auth-wrap"><div className="empty">This form is closed or doesn't exist.</div></div>
  );
  if (!form) return <div className="auth-wrap"><div className="empty">Loading…</div></div>;
  if (done) return (
    <div className="auth-wrap">
      <div className="panel" style={{ maxWidth: 480, padding: 28, textAlign: "center" }}>
        <h2>Response recorded</h2>
        <p className="d-sub">Thanks — your answers were submitted.</p>
      </div>
    </div>
  );

  return (
    <div className="auth-wrap" style={{ alignItems: "flex-start", paddingTop: "6vh" }}>
      <div className="panel formfill">
        <h2 style={{ margin: "0 0 4px" }}>{form.title}</h2>
        {form.description && <p className="d-sub">{form.description}</p>}
        {form.fields.map((f) => (
          <label key={f.id} className="formfill-field">
            <span className="formfill-label">{f.label}{f.required ? " *" : ""}</span>
            {f.type === "textarea" ? (
              <textarea rows={3} value={String(answers[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />
            ) : f.type === "choice" ? (
              <select value={String(answers[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)}>
                <option value="">Choose…</option>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <input type="checkbox" checked={!!answers[f.id]} onChange={(e) => set(f.id, e.target.checked)} />
            ) : f.type === "rating" ? (
              <div className="formfill-rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button"
                    className={`formfill-star${Number(answers[f.id]) >= n ? " on" : ""}`}
                    onClick={() => set(f.id, n)}>★</button>
                ))}
              </div>
            ) : (
              <input type={f.type === "email" ? "email" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                value={String(answers[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />
            )}
          </label>
        ))}
        <label className="formfill-field">
          <span className="formfill-label">Your name or email (optional)</span>
          <input value={respondent} onChange={(e) => setRespondent(e.target.value)} />
        </label>
        {err && <p className="formfill-err">{err}</p>}
        <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
