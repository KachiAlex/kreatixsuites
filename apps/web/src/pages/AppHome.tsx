// Single-app window for a file-based suite app (Writer, Sheets, Present, Board,
// PDF). Installed desktop shortcuts open straight here: the app's own files and
// a New button, with no other apps in view.
import { useNavigate } from "react-router-dom";
import { SUITE_APPS, type SuiteApp } from "@kreatix/shared";
import { api } from "../lib/api";
import { useFiles } from "../lib/hooks";
import { useI18n } from "../lib/i18n";

const NEW_NAME_KEY: Record<string, string> = {
  writer: "home.untitledDoc", sheets: "home.untitledSheet", present: "home.untitledDeck",
};

export function AppHome({ slug }: { slug: SuiteApp }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { items, loading } = useFiles("all", "");
  const app = SUITE_APPS.find((a) => a.slug === slug)!;
  const kind = app.itemKind!;
  const mine = items.filter((i) => i.kind === kind);
  const canCreate = kind !== "pdf";

  const create = async () => {
    const name = NEW_NAME_KEY[kind] ? t(NEW_NAME_KEY[kind]) : t("nav.untitled");
    const r = await api.post<{ item: { id: string } }>("/api/drive", { name, kind });
    navigate(`/edit/${r.item.id}`);
  };

  return (
    <div className="page" style={{ maxWidth: 900, margin: "0 auto", padding: "28px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 24, flex: 1 }}>{app.name}</h1>
        {canCreate
          ? <button className="btn-primary" onClick={() => void create()}>New {app.name.toLowerCase()}</button>
          : <button className="btn-primary" onClick={() => navigate("/pdf-tools")}>Open PDF tools</button>}
      </div>
      {loading && <div className="empty">{t("app.loading")}</div>}
      {!loading && !mine.length && <div className="empty">No {app.name} files yet.</div>}
      <div>
        {mine.map((i) => (
          <button key={i.id} onClick={() => navigate(`/edit/${i.id}`)}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", marginBottom: 8,
              border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface)", cursor: "pointer", fontWeight: 600 }}>
            {i.name}
          </button>
        ))}
      </div>
    </div>
  );
}
