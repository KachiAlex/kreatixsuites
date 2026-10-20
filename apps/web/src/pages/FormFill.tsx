import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { API_BASE } from "../lib/platform";
import { getToken } from "../lib/api";

// Public form-fill page — no auth required unless the form demands it; the
// share token is the credential. Plain fetch so anonymous/offline sessions
// never detour through the mirror. `hp` honeypot is invisible to humans;
// bots that fill it get a fake success and nothing is stored.

interface PubField {
  id: string; label: string; type: string; required?: boolean;
  description?: string; options?: string[]; allowOther?: boolean;
  min?: number; max?: number; minLen?: number; maxLen?: number;
  scaleMin?: number; scaleMax?: number; scaleLow?: string; scaleHigh?: string;
  showIf?: { field: string; equals: string };
  payAmount?: number; payLabel?: string;
}
interface PubForm {
  title: string | null; description: string | null; fields: PubField[];
  closedReason: string | null; confirmMsg: string | null; collectName: boolean;
  layout: "classic" | "chat"; showProgress: boolean; accent: string | null;
  requireSignIn: boolean; orgOnly: boolean; quiz: boolean; shuffleOptions: boolean;
  editAfterSubmit?: boolean;
}

type Answer = string | number | boolean | string[] | { itemId: string; name: string };
const answered = (v: Answer | undefined) =>
  v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);

export function FormFill() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [form, setForm] = useState<PubForm | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [respondent, setRespondent] = useState("");
  const [hp, setHp] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ score: number | null; max: number | null } | null>(null);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [payState, setPayState] = useState<"checking" | "ok" | "pending" | null>(null);
  const [err, setErr] = useState("");
  const [step, setStep] = useState(0);
  const [uploading, setUploading] = useState<string | null>(null);
  const signedIn = !!getToken();
  const editing = !!params.get("edit");

  useEffect(() => {
    // returning from Paystack — confirm the payment server-side before
    // showing anything (the ?paid= ref alone proves nothing)
    const ref = params.get("paid");
    if (ref) {
      setPayState("checking");
      fetch(`${API_BASE}/api/forms/public/${token}/verify?ref=${encodeURIComponent(ref)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          setPayState(j.paid ? "ok" : "pending");
        })
        .catch(() => setPayState("pending"));
    }
    const edit = params.get("edit") ?? "";
    fetch(`${API_BASE}/api/forms/public/${token}${edit ? `?edit=${encodeURIComponent(edit)}` : ""}`)
      .then(async (r) => {
        if (!r.ok) { setGone("This form is closed or doesn't exist."); return; }
        const j = await r.json();
        setForm(j.form);
        if (j.prior) { // edit-after-submit: prefill the stored answers
          setAnswers(j.prior.answers ?? {});
          setRespondent(j.prior.respondent ?? "");
          setEditToken(edit);
        }
      })
      .catch(() => setGone("Couldn't reach the server — check your connection."));
  }, [token, params]);

  // options are shuffled once per load when the form asks for it
  const shuffled = useMemo(() => {
    const m: Record<string, string[]> = {};
    if (!form?.shuffleOptions) return m;
    for (const f of form.fields) {
      if (!f.options?.length) continue;
      const o = [...f.options];
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [o[i], o[j]] = [o[j], o[i]];
      }
      m[f.id] = o;
    }
    return m;
  }, [form]);

  if (gone) return <div className="auth-wrap"><div className="empty">{gone}</div></div>;
  if (payState === "checking")
    return <div className="auth-wrap"><div className="empty">Confirming your payment…</div></div>;
  if (payState === "ok")
    return <div className="auth-wrap"><div className="panel" style={{ maxWidth: 480, padding: 28, textAlign: "center" }}>
      <h2>Payment confirmed</h2>
      <p className="d-sub">Thanks — your response was recorded.</p>
    </div></div>;
  if (!form) return <div className="auth-wrap"><div className="empty">Loading…</div></div>;
  if (form.closedReason) return <div className="auth-wrap"><div className="empty">{form.closedReason}</div></div>;

  const accentStyle = (form.accent ? { "--k-orange": form.accent } : {}) as CSSProperties;
  const opts = (f: PubField) => shuffled[f.id] ?? f.options ?? [];

  // showIf mirrors the server: hidden fields are skipped entirely
  const visible = form.fields.filter((f) =>
    f.type === "section" || !f.showIf || String(answers[f.showIf.field] ?? "") === f.showIf.equals);
  const questions = visible.filter((f) => f.type !== "section" && f.type !== "payment");
  const answeredCount = questions.filter((f) => answered(answers[f.id])).length;
  const chat = form.layout === "chat";

  const set = (id: string, v: Answer) => setAnswers((a) => ({ ...a, [id]: v }));
  const toggle = (id: string, opt: string) =>
    setAnswers((a) => {
      const cur = Array.isArray(a[id]) ? (a[id] as string[]) : [];
      return { ...a, [id]: cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt] };
    });

  const missing = (f: PubField) => f.required && !answered(answers[f.id]);

  const upload = async (f: PubField, file: File) => {
    setUploading(f.id); setErr("");
    try {
      const r = await fetch(
        `${API_BASE}/api/forms/public/${token}/files?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          ...(signedIn ? { authorization: `Bearer ${getToken()}` } : {}),
        },
        body: file,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j.message ?? "Upload failed");
      else set(f.id, { itemId: j.item.id, name: j.item.name });
    } catch { setErr("Upload failed — try again"); }
    setUploading(null);
  };

  const submit = async () => {
    const miss = questions.find(missing);
    if (miss) { setErr(`"${miss.label}" is required`); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API_BASE}/api/forms/public/${token}`, {
        method: editToken ? "PUT" : "POST",
        headers: {
          "content-type": "application/json",
          ...(signedIn ? { authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({
          answers, respondent: respondent.trim() || undefined, hp: hp || undefined,
          ...(editToken ? { editToken } : {}),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) setErr("You must be signed in to respond — sign in, then reopen this link.");
      else if (r.status === 409) setErr(j.message ?? "You've already responded.");
      else if (!r.ok) setErr(j.message ?? "Submit failed");
      else if (j.payUrl) {
        if (j.editToken) try { localStorage.setItem(`formedit.${token}`, j.editToken); } catch { /* private mode */ }
        location.href = j.payUrl; // → Paystack checkout, returns to ?paid=<ref>
      }
      else {
        if (j.editToken) try { localStorage.setItem(`formedit.${token}`, j.editToken); } catch { /* private mode */ }
        if (j.editToken) setEditToken(j.editToken);
        setDone({ score: j.score ?? null, max: j.maxScore ?? null });
      }
    } catch { setErr("Network error — try again"); }
    setBusy(false);
  };

  const storedEdit = (() => {
    try { return localStorage.getItem(`formedit.${token}`); } catch { return null; }
  })();

  const doneCard = (
    <div className="auth-wrap" style={accentStyle}>
      <div className="panel" style={{ maxWidth: 480, padding: 28, textAlign: "center" }}>
        <h2>{form.quiz && done ? "Quiz submitted" : "Response recorded"}</h2>
        {done?.score !== null && done?.score !== undefined
          ? <p className="formfill-score">You scored <b>{done.score}</b>{done.max ? ` / ${done.max}` : ""}</p>
          : <p className="d-sub">{form.confirmMsg ?? "Thanks — your answers were submitted."}</p>}
        {form.editAfterSubmit && (editToken || storedEdit) && (
          <p><Link className="btn-ghost btn-sm" to={`/f/${token}?edit=${editToken ?? storedEdit}`}>Edit your response</Link></p>
        )}
      </div>
    </div>
  );

  if (done) return doneCard;

  if (form.requireSignIn && !signedIn) return (
    <div className="auth-wrap" style={accentStyle}>
      <div className="panel" style={{ maxWidth: 480, padding: 28, textAlign: "center" }}>
        <h2>{form.title}</h2>
        <p className="d-sub">{form.orgOnly
          ? "This form is only open to members of its workspace — sign in with your work account."
          : "This form requires sign-in so your response can be verified."}</p>
        <div className="dlg-actions" style={{ justifyContent: "center" }}>
          <Link className="btn-primary" to={`/login?next=/f/${token}`}>Sign in</Link>
          <Link className="btn-ghost" to={`/register?next=/f/${token}`}>Create account</Link>
        </div>
      </div>
    </div>
  );

  const fieldBody = (f: PubField) => {
    switch (f.type) {
      case "section":
        return (
          <div className="formfill-section" key={f.id}>
            <h3>{f.label}</h3>
            {f.description && <p className="d-sub">{f.description}</p>}
          </div>
        );
      case "textarea":
        return <textarea rows={4} value={String(answers[f.id] ?? "")} onChange={(e) => set(f.id, e.target.value)} />;
      case "choice":
        return (
          <div className="formfill-opts">
            {opts(f).map((o) => (
              <label key={o} className="formfill-opt">
                <input type="radio" name={f.id} checked={answers[f.id] === o}
                  onChange={() => set(f.id, o)} /> {o}
              </label>
            ))}
            {f.allowOther && (
              <label className="formfill-opt">
                <input type="radio" name={f.id}
                  checked={answers[f.id] !== undefined && !opts(f).includes(String(answers[f.id]))}
                  onChange={() => set(f.id, otherText[f.id] ?? "")} /> Other:
                <input style={{ flex: 1 }} value={otherText[f.id] ?? ""}
                  onChange={(e) => { setOtherText((m) => ({ ...m, [f.id]: e.target.value })); set(f.id, e.target.value); }} />
              </label>
            )}
          </div>
        );
      case "multiselect":
        return (
          <div className="formfill-opts">
            {opts(f).map((o) => (
              <label key={o} className="formfill-opt">
                <input type="checkbox"
                  checked={Array.isArray(answers[f.id]) && (answers[f.id] as string[]).includes(o)}
                  onChange={() => toggle(f.id, o)} /> {o}
              </label>
            ))}
            {f.allowOther && (
              <label className="formfill-opt">Other:
                <input style={{ flex: 1 }} value={otherText[f.id] ?? ""}
                  onChange={(e) => {
                    const prev = otherText[f.id] ?? "";
                    setOtherText((m) => ({ ...m, [f.id]: e.target.value }));
                    // replace the previous "other" entry in-place — otherwise
                    // every keystroke appends a new option to the array
                    setAnswers((a) => {
                      const cur = (a[f.id] as string[]) ?? [];
                      const next = cur.filter((x) => x !== prev);
                      if (e.target.value.trim()) next.push(e.target.value);
                      return { ...a, [f.id]: next };
                    });
                  }} />
              </label>
            )}
          </div>
        );
      case "checkbox":
        return (
          <label className="formfill-opt">
            <input type="checkbox" checked={answers[f.id] === true}
              onChange={(e) => set(f.id, e.target.checked)} /> Yes
          </label>
        );
      case "rating":
        return (
          <div className="formfill-rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button"
                className={`formfill-star${Number(answers[f.id]) >= n ? " on" : ""}`}
                onClick={() => set(f.id, n)}>★</button>
            ))}
          </div>
        );
      case "scale": {
        const lo = f.scaleMin ?? 1, hi = f.scaleMax ?? 10;
        return (
          <div className="formfill-scale">
            <span className="d-sub">{f.scaleLow ?? lo}</span>
            {Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((n) => (
              <button key={n} type="button"
                className={`formfill-scale-n${answers[f.id] === n ? " on" : ""}`}
                onClick={() => set(f.id, n)}>{n}</button>
            ))}
            <span className="d-sub">{f.scaleHigh ?? hi}</span>
          </div>
        );
      }
      case "file": {
        const a = answers[f.id] as { itemId: string; name: string } | undefined;
        return (
          <div>
            {a?.name
              ? <span className="formfill-file">📎 {a.name} <button type="button" className="btn-ghost btn-sm" onClick={() => set(f.id, "")}>Remove</button></span>
              : <input type="file" disabled={uploading === f.id}
                  onChange={(e) => { const x = e.target.files?.[0]; if (x) void upload(f, x); e.target.value = ""; }} />}
            {uploading === f.id && <span className="d-sub"> Uploading…</span>}
          </div>
        );
      }
      case "nps":
        return (
          <div className="formfill-scale">
            <span className="d-sub">Not likely</span>
            {Array.from({ length: 11 }, (_, i) => i).map((n) => (
              <button key={n} type="button"
                className={`formfill-scale-n${answers[f.id] === n ? " on" : ""}`}
                onClick={() => set(f.id, n)}>{n}</button>
            ))}
            <span className="d-sub">Extremely likely</span>
          </div>
        );
      case "ranking": {
        const order = (Array.isArray(answers[f.id]) ? answers[f.id] as string[] : null) ?? opts(f);
        const shift = (i: number, dir: -1 | 1) => {
          const next = [...order]; const j = i + dir;
          if (j < 0 || j >= next.length) return;
          [next[i], next[j]] = [next[j], next[i]];
          set(f.id, next);
        };
        return (
          <div className="formfill-opts">
            {order.map((o, i) => (
              <div key={o} className="formfill-opt" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="d-sub" style={{ width: 18, textAlign: "right" }}>{i + 1}.</span>
                <span style={{ flex: 1 }}>{o}</span>
                <button type="button" className="iconbtn" disabled={i === 0} onClick={() => shift(i, -1)}>↑</button>
                <button type="button" className="iconbtn" disabled={i === order.length - 1} onClick={() => shift(i, 1)}>↓</button>
              </div>
            ))}
          </div>
        );
      }
      case "payment":
        return (
          <div className="formfill-pay">
            <b>{f.payLabel ?? "Payment"} — ₦{Number(f.payAmount ?? 0).toLocaleString()}</b>
            <span className="d-sub">You'll be sent to Paystack's secure checkout after submitting.</span>
          </div>
        );
      default:
        return (
          <input
            type={f.type === "email" ? "email" : f.type === "number" ? "number"
              : f.type === "date" ? "date" : f.type === "time" ? "time"
              : f.type === "url" ? "url" : f.type === "phone" ? "tel" : "text"}
            {...(f.type === "number" && f.min !== undefined ? { min: f.min } : {})}
            {...(f.type === "number" && f.max !== undefined ? { max: f.max } : {})}
            value={String(answers[f.id] ?? "")}
            onChange={(e) => set(f.id, f.type === "number" ? e.target.valueAsNumber || "" : e.target.value)} />
        );
    }
  };

  const fieldCard = (f: PubField) => (
    <label key={f.id} className={`formfill-field${missing(f) && err ? " formfill-req" : ""}`}>
      <span className="formfill-label">{f.label}{f.required ? " *" : ""}</span>
      {f.description && <span className="d-sub" style={{ fontSize: 12 }}>{f.description}</span>}
      {fieldBody(f)}
    </label>
  );

  // conversational layout: one question (or section) per screen
  const chatSteps = visible;
  const cur = chatSteps[Math.min(step, chatSteps.length - 1)];
  const progress = chat
    ? Math.round(((step + (done ? 1 : 0)) / Math.max(1, chatSteps.length)) * 100)
    : questions.length ? Math.round((answeredCount / questions.length) * 100) : 0;

  return (
    <div className="auth-wrap" style={{ alignItems: "flex-start", paddingTop: "6vh", ...accentStyle }}>
      <div className="panel formfill">
        <h2 style={{ margin: "0 0 4px" }}>{form.title}</h2>
        {form.description && <p className="d-sub">{form.description}</p>}
        {editing && <p className="d-sub" style={{ color: "var(--k-orange)" }}>Editing your previous response</p>}
        {payState === "pending" && (
          <p className="formfill-err">We couldn't confirm your payment yet — if checkout completed, wait a minute and refresh this page.</p>
        )}
        {(form.showProgress || chat) && (
          <div className="formfill-progress"><div className="formfill-progress-fill" style={{ width: `${progress}%` }} /></div>
        )}
        {/* honeypot — hidden from humans, irresistible to bots */}
        <input value={hp} onChange={(e) => setHp(e.target.value)} tabIndex={-1} autoComplete="off"
          aria-hidden="true" style={{ position: "absolute", left: -9999, opacity: 0, height: 0 }} />

        {chat ? (
          <>
            {cur && fieldCard(cur)}
            <div className="dlg-actions" style={{ justifyContent: "space-between" }}>
              <button className="btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>← Back</button>
              <span className="d-sub">{step + 1} / {chatSteps.length}</span>
              {step < chatSteps.length - 1
                ? <button className="btn-primary" disabled={!!cur?.required && !answered(answers[cur.id])}
                    onClick={() => setStep((s) => s + 1)}>Next →</button>
                : <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
                    {busy ? "Submitting…" : editing ? "Save changes" : "Submit"}</button>}
            </div>
          </>
        ) : (
          <>
            {visible.map(fieldCard)}
            {form.collectName && (
              <label className="formfill-field">
                <span className="formfill-label">Your name or email (optional)</span>
                <input value={respondent} onChange={(e) => setRespondent(e.target.value)} />
              </label>
            )}
            {err && <p className="formfill-err">{err}</p>}
            <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Submitting…" : editing ? "Save changes" : "Submit"}
            </button>
          </>
        )}
        {chat && err && <p className="formfill-err">{err}</p>}
        {chat && form.collectName && step === chatSteps.length - 1 && (
          <label className="formfill-field" style={{ marginTop: 10 }}>
            <span className="formfill-label">Your name or email (optional)</span>
            <input value={respondent} onChange={(e) => setRespondent(e.target.value)} />
          </label>
        )}
      </div>
    </div>
  );
}
