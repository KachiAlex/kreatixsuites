import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { FileList } from "../components/FileList";
import { AppIcon } from "../components/AppIcon";
import { openLocalFile } from "../lib/offline/openLocal";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { TemplatesDialog } from "../components/TemplatesDialog";

export function useFiles(view: string, parent?: string) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = parent !== undefined ? `parent=${parent}` : `view=${view}`;
      const r = await api.get<{ items: DriveItem[] }>(`/api/drive?${qs}`);
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  }, [view, parent]);
  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener("kreatix:refresh", h);
    return () => window.removeEventListener("kreatix:refresh", h);
  }, [refresh]);
  return { items, loading, refresh };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2600);
  }, []);
  return { msg, toast };
}

export function useItemActions(refresh: () => void) {
  const [sharing, setSharing] = useState<DriveItem | null>(null);
  const [versions, setVersions] = useState<DriveItem | null>(null);
  const { msg, toast } = useToast();
  return { sharing, setSharing, versions, setVersions, msg, toast, refresh };
}

export function Home() {
  const navigate = useNavigate();
  const t = useT();
  const { items, refresh } = useFiles("home");
  const { sharing, setSharing, versions, setVersions, msg, toast } = useItemActions(refresh);
  const [prompt, setPrompt] = useState("");
  const [attached, setAttached] = useState<DriveItem | null>(null);
  const [pickFiles, setPickFiles] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const open = (it: DriveItem) =>
    navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`);

  const createDoc = async () => {
    const r = await api.post<{ item: DriveItem }>("/api/drive", { name: t("home.untitledDoc"), kind: "writer" });
    navigate(`/edit/${r.item.id}`);
  };

  const openDoc = async () => {
    try {
      const id = await openLocalFile();
      if (id) navigate(`/edit/${id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : t("home.openFailed"));
    }
  };

  // AI is per-file — open the attached file's AI panel with the prompt
  // (auto-sends there), or start a fresh document when nothing is attached.
  const askAi = async (text: string) => {
    try {
      let id = attached?.id;
      if (!id) {
        const r = await api.post<{ item: DriveItem }>("/api/drive", { name: t("home.untitledDoc"), kind: "writer" });
        id = r.item.id;
      }
      navigate(`/edit/${id}?ai=${encodeURIComponent(text)}`);
    } catch {
      toast(t("shell.aiOpenFailed"));
    }
  };

  const chip = (text: string, attach = false) => {
    setPrompt(text);
    promptRef.current?.focus();
    if (attach) setPickFiles(true);
  };

  const apps = [
    { cls: "writer", name: "Kreatix Writer", desc: t("apps.writer.desc"), kind: "writer" },
    { cls: "sheets", name: "Kreatix Sheets", desc: t("apps.sheets.desc"), kind: "sheets" },
    { cls: "present", name: "Kreatix Present", desc: t("apps.present.desc"), kind: "present" },
    { cls: "pdf", name: "Kreatix PDF", desc: t("apps.pdf.desc"), kind: "pdf" },
  ];

  return (
    <>
      <section className="hero">
        <div className="hero-orange" /><div className="hero-shape" /><div className="hero-ring" />
        <div className="hero-content">
          <div className="hero-badge">✦ KREATIX AI</div>
          <h1>{t("home.heroTitle1")}<br />{t("home.heroTitle2")}</h1>
          <p>{t("home.heroSub")}</p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={createDoc}>{t("home.createFile")}</button>
            <button className="btn-secondary" onClick={() => void openDoc()}>{t("home.openDoc")}</button>
            <button className="btn-secondary" onClick={() => promptRef.current?.focus()}>{t("home.askAi")}</button>
          </div>
        </div>
      </section>

      <section className="apps">
        {apps.map((a) => (
          <div className="app-card" key={a.cls}
            onClick={async () => {
              const names: Record<string, string> = { writer: t("home.untitledDoc"), sheets: t("home.untitledSheet"), present: t("home.untitledDeck") };
              if (a.kind === "pdf") return navigate("/drive/all");
              const r = await api.post<{ item: DriveItem }>("/api/drive", { name: names[a.kind], kind: a.kind });
              navigate(`/edit/${r.item.id}`);
            }}>
            <div className={`app-ico ${a.cls}`}><AppIcon kind={a.cls} /></div>
            <div><h4>{a.name}</h4><p>{a.desc}</p></div>
            <div className="launch">›</div>
          </div>
        ))}
      </section>

      <div className="content-grid">
        <section>
          <div className="section-head"><h2>{t("home.continueWorking")}</h2><a onClick={() => navigate("/drive")} style={{ cursor: "pointer" }}>{t("home.viewAll")}</a></div>
          <FileList items={items} onOpen={open} onRefresh={refresh} onShare={setSharing} onVersions={setVersions} toast={toast} />
        </section>
        <section>
          <div className="section-head"><h2>Kreatix AI</h2><a onClick={() => void askAi(prompt)} style={{ cursor: "pointer" }}>{t("home.aiExpand")}</a></div>
          <div className="ai-panel">
            <div className="ai-head">
              <div className="ai-symbol">✦</div>
              <div><h3>{t("home.aiWhatCreating")}</h3><p>{t("home.aiSub")}</p></div>
            </div>
            <div className="prompt">
              <textarea ref={promptRef} value={prompt}
                placeholder={t("home.aiPlaceholder")}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void askAi(prompt); } }} />
              <div className="prompt-footer" style={{ position: "relative" }}>
                <span className="add" role="button" tabIndex={0} style={{ cursor: "pointer" }}
                  onClick={() => setPickFiles((v) => !v)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPickFiles((v) => !v); } }}>
                  {t("home.aiAddFiles")}
                </span>
                {attached && (
                  <span className="chip" style={{ cursor: "default" }}>
                    {attached.name}
                    <button className="iconbtn" style={{ marginLeft: 4, fontSize: 10, lineHeight: 1 }} title={t("home.remove")}
                      onClick={() => setAttached(null)}>✕</button>
                  </span>
                )}
                <button className="send" title={t("home.aiSend")} disabled={!prompt.trim() && !attached}
                  onClick={() => void askAi(prompt)}>↗</button>
                {pickFiles && (
                  <div className="file-menu" style={{ position: "absolute", bottom: 34, left: 0, right: 0, top: "auto" }}>
                    {items.filter((i) => i.kind !== "folder").length === 0 && (
                      <button disabled>{t("home.aiNoFiles")}</button>
                    )}
                    {items.filter((i) => i.kind !== "folder").slice(0, 8).map((i) => (
                      <button key={i.id} onClick={() => { setAttached(i); setPickFiles(false); }}>
                        <b>{i.name}</b> <small style={{ color: "var(--muted)" }}> · {i.kind}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="chips">
              <span className="chip" role="button" tabIndex={0} onClick={() => chip(t("home.chipTextDraft"))}>{t("home.chipDraft")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => chip(t("home.chipTextAnalyze"), true)}>{t("home.chipAnalyze")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => chip(t("home.chipTextSlides"))}>{t("home.chipSlides")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => chip(t("home.chipTextSummarize"), true)}>{t("home.chipSummarize")}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="section-head"><h2>{t("home.templates")}</h2><a onClick={() => setTplOpen(true)} style={{ cursor: "pointer" }}>{t("home.browseTemplates")}</a></div>
      <section className="templates">
        {[
          { titleKey: "home.tplProposal", subKey: "home.tplWriterSub", body: <div className="paper"><div className="line orange-line short" /><div className="line" /><div className="line mid" /><div className="line" /></div> },
          { titleKey: "home.tplModel", subKey: "home.tplSheetsSub", body: <div className="paper"><div className="line short" /><div className="grid">{Array.from({ length: 12 }).map((_, i) => <span key={i} />)}</div></div> },
          { titleKey: "home.tplDeck", subKey: "home.tplPresentSub", body: <div className="paper" style={{ background: "#202020" }}><div className="line orange-line short" /><div className="line" style={{ background: "#555" }} /><div style={{ width: 42, height: 42, borderRadius: "50%", background: "var(--k-orange)", marginTop: 10 }} /></div> },
          { titleKey: "home.tplContract", subKey: "home.tplPdfSub", body: <div className="paper"><div className="line orange-line short" /><div className="line" /><div className="line" /><div className="line mid" /></div> },
        ].map((tpl) => (
          <div className="template" key={tpl.titleKey} role="button" tabIndex={0} style={{ cursor: "pointer" }}
            onClick={() => setTplOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTplOpen(true); } }}>
            <div className="preview">{tpl.body}</div>
            <div className="template-info"><h4>{t(tpl.titleKey)}</h4><p>{t(tpl.subKey)}</p></div>
          </div>
        ))}
      </section>

      <div className="brand-strip">
        <div className="mini-logo"><AppIcon kind="suites" /></div>
        <div><strong>Kreatix Suites</strong><br /><span>{t("home.brandSub")}</span></div>
      </div>
      <footer>{t("home.footer")}</footer>

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} toast={toast} />}
      {tplOpen && <TemplatesDialog onClose={() => setTplOpen(false)} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
