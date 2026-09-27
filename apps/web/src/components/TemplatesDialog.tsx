import { useNavigate } from "react-router-dom";
import { TEMPLATES, type Template } from "../lib/templates";
import { createDoc } from "../lib/create";
import { useState } from "react";

const KIND_STYLE: Record<string, string> = { writer: "writer", sheets: "sheets", present: "present" };
const KIND_LABEL: Record<string, string> = { writer: "Writer", sheets: "Sheets", present: "Present" };

export function TemplatesDialog({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (t: Template) => {
    if (busy) return;
    setBusy(t.id);
    try {
      const item = await createDoc(t.kind, t.name, t.build());
      navigate(`/edit/${item.id}`);
    } catch {
      toast("Could not create from template");
      setBusy(null);
    }
  };

  const groups = (["writer", "sheets", "present"] as const).map((k) => ({
    kind: k, items: TEMPLATES.filter((t) => t.kind === k),
  }));

  return (
    <div className="dlg-back" onClick={onClose}>
      <div className="dlg tpl-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="sp-head" style={{ padding: "0 0 12px", borderBottom: "1px solid var(--line)" }}>
          <h3>Templates</h3>
          <button className="sp-close" onClick={onClose}>✕</button>
        </div>
        {groups.map((g) => (
          <div key={g.kind} style={{ marginTop: 16 }}>
            <div className="section-label" style={{ padding: 0, marginBottom: 8 }}>{KIND_LABEL[g.kind]}</div>
            <div className="tpl-grid">
              {g.items.map((t) => (
                <button key={t.id} className="tpl-card" disabled={busy !== null} onClick={() => void pick(t)}>
                  <span className={`cm-ico ${KIND_STYLE[g.kind]}`}>{KIND_LABEL[g.kind][0]}</span>
                  <b>{t.name}</b>
                  <span className="tpl-desc">{busy === t.id ? "Creating…" : t.desc}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
