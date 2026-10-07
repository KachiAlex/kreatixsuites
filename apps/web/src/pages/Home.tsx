import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { api, ApiError } from "../lib/api";
import type { AiQuota } from "../ai/AiPanel";
import { useT } from "../lib/i18n";
import { useFiles, useItemActions } from "../lib/hooks";
import { FileList } from "../components/FileList";
import { AppIcon } from "../components/AppIcon";
import { openLocalFile } from "../lib/offline/openLocal";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { TemplatesDialog } from "../components/TemplatesDialog";

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
  const [askWs, setAskWs] = useState(false);
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; reply: string; sources: { fileId: string; name: string }[] } | null>(null);

  // AI quota — blocks doc-creation when the workspace is out of credits so
  // no orphan doc gets created for a prompt that will immediately 402
  const [aiQuota, setAiQuota] = useState<AiQuota | null>(null);
  useEffect(() => {
    api.get<{ quota?: AiQuota }>("/api/ai/status")
      .then((r) => setAiQuota(r.quota ?? null)).catch(() => {});
  }, []);

  const open = (it: DriveItem) =>
    navigate(it.kind === "folder" ? `/drive/folder/${it.id}` : `/edit/${it.id}`);

  const attachable = useMemo(() => items.filter((i) => i.kind !== "folder"), [items]);

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
    if (aiQuota) {
      const out = aiQuota.plan === "trial"
        ? (aiQuota.trialRequestsUsed ?? 0) >= (aiQuota.trialRequestsLimit ?? 1)
        : aiQuota.orgTokensUsed >= aiQuota.orgTokensLimit;
      if (out) {
        toast(t("home.aiQuotaDone"));
        navigate("/admin");
        return;
      }
    }
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

  /** Workspace Q&A — retrieval over the search index, answered inline with
   *  source citations. Doesn't create a document. */
  const askWorkspace = async (text: string) => {
    setAsking(true); setAnswer(null);
    try {
      const r = await api.post<{ reply: string; sources: { fileId: string; name: string }[] }>(
        "/api/ai/ask", { question: text });
      setAnswer({ q: text, reply: r.reply, sources: r.sources });
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "ai_not_in_plan") { toast(t("home.aiQuotaDone")); navigate("/admin"); }
      else toast(err.message ?? t("shell.aiOpenFailed"));
    } finally { setAsking(false); }
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    if (!text && !attached) return;
    if (askWs && !attached) void askWorkspace(text);
    else void askAi(text);
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
                placeholder={askWs ? t("home.aiAskPlaceholder") : t("home.aiPlaceholder")}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); } }} />
              <div className="prompt-footer" style={{ position: "relative" }}>
                <span className="add" role="button" tabIndex={0} style={{ cursor: "pointer" }}
                  onClick={() => setPickFiles((v) => !v)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPickFiles((v) => !v); } }}>
                  {t("home.aiAddFiles")}
                </span>
                <span className={`chip${askWs ? " on" : ""}`} role="button" tabIndex={0} title={t("home.aiAskHint")}
                  style={{ cursor: "pointer", opacity: askWs ? 1 : 0.7 }}
                  onClick={() => { setAskWs((v) => !v); setAttached(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setAskWs((v) => !v); setAttached(null); } }}>
                  {t("home.aiAskToggle")}
                </span>
                {attached && (
                  <span className="chip" style={{ cursor: "default" }}>
                    {attached.name}
                    <button className="iconbtn" style={{ marginLeft: 4, fontSize: 10, lineHeight: 1 }} title={t("home.remove")}
                      onClick={() => setAttached(null)}>✕</button>
                  </span>
                )}
                <button className="send" title={t("home.aiSend")} disabled={(!prompt.trim() && !attached) || asking}
                  onClick={sendPrompt}>{asking ? "…" : "↗"}</button>
                {pickFiles && (
                  <div className="file-menu" style={{ position: "absolute", bottom: 34, left: 0, right: 0, top: "auto" }}>
                    {attachable.length === 0 && (
                      <button disabled>{t("home.aiNoFiles")}</button>
                    )}
                    {attachable.slice(0, 8).map((i) => (
                      <button key={i.id} onClick={() => { setAttached(i); setPickFiles(false); }}>
                        <b>{i.name}</b> <small style={{ color: "var(--muted)" }}> · {i.kind}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {asking && <div className="ai-answer"><em>{t("home.aiThinking")}</em></div>}
            {answer && (
              <div className="ai-answer">
                <div className="ai-answer-q">{answer.q}</div>
                <div className="ai-answer-r">{answer.reply}</div>
                {answer.sources.length > 0 && (
                  <div className="ai-answer-src">
                    {t("home.aiSources")}
                    {answer.sources.map((s) => (
                      <a key={s.fileId} onClick={() => navigate(`/edit/${s.fileId}`)}>{s.name}</a>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="chips">
              <span className="chip" role="button" tabIndex={0} onClick={() => { setAskWs(false); chip(t("home.chipTextDraft")); }}>{t("home.chipDraft")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => { setAskWs(false); chip(t("home.chipTextAnalyze"), true); }}>{t("home.chipAnalyze")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => { setAskWs(false); chip(t("home.chipTextSlides")); }}>{t("home.chipSlides")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => { setAskWs(false); chip(t("home.chipTextSummarize"), true); }}>{t("home.chipSummarize")}</span>
              <span className="chip" role="button" tabIndex={0} onClick={() => { setAskWs(true); chip(t("home.chipTextAskWs")); }}>{t("home.chipAskWs")}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="section-head"><h2>{t("home.templates")}</h2><a onClick={() => setTplOpen(true)} style={{ cursor: "pointer" }}>{t("home.browseTemplates")}</a></div>
      <section className="templates">
        {[
          { titleKey: "home.tplProposal", subKey: "home.tplWriterSub", kind: "writer" as const, body: (
            <div className="tp-doc">
              <div className="tp-doc-band" />
              <div className="tp-doc-body">
                <div className="tp-doc-head"><span className="tp-logo" /><i className="tp-t" style={{ width: "34%" }} /></div>
                <i className="tp-t tp-t-hd" style={{ width: "72%" }} />
                <i className="tp-t" style={{ width: "94%" }} /><i className="tp-t" style={{ width: "88%" }} />
                <div className="tp-doc-foot">
                  <svg viewBox="0 0 44 10" className="tp-squig" aria-hidden="true"><path d="M2 7 Q8 1 14 6 T26 5 T42 6" fill="none" stroke="#8A8078" strokeWidth="1.3" /></svg>
                  <i className="tp-t" style={{ width: "26%" }} />
                </div>
              </div>
            </div>
          ) },
          { titleKey: "home.tplModel", subKey: "home.tplSheetsSub", kind: "sheets" as const, body: (
            <div className="tp-sheet">
              <div className="tp-sheet-row tp-sheet-head"><i /><i /><i /><i /><i /></div>
              <div className="tp-sheet-row"><i className="lbl" /><i /><i className="up" /><i /><i className="up" /></div>
              <div className="tp-sheet-row"><i className="lbl" /><i /><i /><i className="dn" /><i /></div>
              <div className="tp-sheet-row"><i className="lbl" /><i className="up" /><i /><i /><i /></div>
              <div className="tp-sheet-row tp-sheet-total"><i /><i /><i /><i /><i /></div>
            </div>
          ) },
          { titleKey: "home.tplDeck", subKey: "home.tplPresentSub", kind: "present" as const, body: (
            <div className="tp-slide">
              <div className="tp-slide-txt">
                <i className="tp-t tp-title" style={{ width: "78%" }} />
                <i className="tp-t" style={{ width: "52%" }} />
                <i className="tp-t" style={{ width: "64%" }} />
                <i className="tp-t" style={{ width: "40%" }} />
              </div>
              <div className="tp-slide-bars"><span style={{ height: "42%" }} /><span style={{ height: "70%" }} /><span style={{ height: "92%" }} /></div>
            </div>
          ) },
          { titleKey: "home.tplContract", subKey: "home.tplPdfSub", kind: "pdf" as const, body: (
            <div className="tp-doc">
              <div className="tp-doc-body">
                <i className="tp-t tp-t-hd" style={{ width: "48%" }} />
                <i className="tp-t" style={{ width: "92%" }} />
                <div className="tp-hl"><i className="tp-t" style={{ width: "84%" }} /></div>
                <i className="tp-t" style={{ width: "70%" }} />
                <div className="tp-doc-foot">
                  <svg viewBox="0 0 44 10" className="tp-squig" aria-hidden="true"><path d="M2 6 Q10 0 16 6 T30 4 T42 7" fill="none" stroke="#8A8078" strokeWidth="1.3" /></svg>
                  <span className="tp-stamp" />
                </div>
              </div>
            </div>
          ) },
        ].map((tpl) => (
          <div className="template" key={tpl.titleKey} role="button" tabIndex={0} style={{ cursor: "pointer" }}
            onClick={() => setTplOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setTplOpen(true); } }}>
            <div className="preview">
              {tpl.body}
              <span className="tp-badge"><AppIcon kind={tpl.kind} size={15} /></span>
            </div>
            <div className="template-info"><h4>{t(tpl.titleKey)}</h4><p>{t(tpl.subKey)}</p></div>
          </div>
        ))}
      </section>

      <footer>{t("home.footer")}</footer>

      {sharing && <ShareDialog item={sharing} onClose={() => setSharing(null)} toast={toast} />}
      {versions && <VersionsPanel item={versions} onClose={() => setVersions(null)} toast={toast} />}
      {tplOpen && <TemplatesDialog onClose={() => setTplOpen(false)} toast={toast} />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </>
  );
}
