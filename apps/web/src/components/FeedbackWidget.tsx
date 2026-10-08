import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";

type Sentiment = "good" | "ok" | "bad";
interface FbMsg { role: "user" | "bot"; sentiment?: Sentiment; text: string; team?: boolean; at?: string; read?: boolean }
interface FbRow {
  id: string; sender: "user" | "admin"; sentiment: Sentiment;
  message: string; read_at: string | null; created_at: string;
}

const ICONS: Record<Sentiment, string> = { good: "🙂", ok: "😐", bad: "☹️" };

const OPTS: { icon: string; bg: string; key: string; sentiment: Sentiment }[] = [
  { icon: "🐞", bg: "#FDEBE3", key: "optReport", sentiment: "bad" },
  { icon: "💡", bg: "#E8F0FE", key: "optIdea", sentiment: "ok" },
  { icon: "❓", bg: "#E6F6EC", key: "optHelp", sentiment: "ok" },
  { icon: "💬", bg: "#F1EAFE", key: "optFeedback", sentiment: "good" },
];

function time(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function BotAvatar() {
  return <span className="fb-botav" aria-hidden="true">K</span>;
}

/** Floating feedback chat — bottom-right on every shell page. Each message
 *  posts to /api/feedback and is reviewed in the superadmin portal. */
export function FeedbackWidget() {
  const { user } = useAuth();
  const t = useI18n().t;
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(false);
  const [sentiment, setSentiment] = useState<Sentiment>("good");
  const [hint, setHint] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<FbMsg[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [msgs, open, min]);

  // reload the thread on open, then poll — new portal replies land mid-chat
  useEffect(() => {
    if (!open || !user || user.id === "local") return;
    let dead = false;
    const pull = () =>
      api.get<{ feedback: FbRow[] }>("/api/feedback")
        .then((r) => {
          if (dead) return;
          setMsgs(r.feedback.map((f): FbMsg =>
            f.sender === "admin"
              ? { role: "bot", team: true, text: f.message, at: f.created_at }
              : { role: "user", sentiment: f.sentiment, text: f.message, at: f.created_at, read: !!f.read_at }));
        })
        .catch(() => { /* history is best-effort — the input still works */ });
    void pull();
    const iv = setInterval(pull, 15000);
    return () => { dead = true; clearInterval(iv); };
  }, [open, user]);

  // feedback needs a server account — anonymous/local-mode users have no workspace to attribute it to
  if (!user || user.id === "local") return null;

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setDraft("");
    const now = new Date().toISOString();
    setMsgs((m) => [...m, { role: "user", sentiment, text: message, at: now }]);
    try {
      await api.post("/api/feedback", { sentiment, message, page: loc.pathname });
      setMsgs((m) => [...m, { role: "bot", text: t("fb.thanks"), at: new Date().toISOString() }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "bot", text: (e as Error).message, at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };

  const showOpts = !msgs.some((m) => m.role === "user");
  const openedAt = new Date().toISOString();

  return (
    <>
      <button
        className="fb-fab"
        onClick={() => { setOpen((v) => !v); setMin(false); }}
        aria-label={t("fb.title")}
        aria-expanded={open}
        title={t("fb.title")}
      >
        {open ? "✕" : "💬"}
      </button>
      {open && (
        <div className="fb-panel" role="dialog" aria-label={t("fb.title")}>
          <div className="fb-head">
            <span className="fb-headav" aria-hidden="true">K</span>
            <div className="fb-headtxt">
              <b>{t("fb.title")}</b>
              <span>{t("fb.subtitle")}</span>
            </div>
            <div className="fb-headbtns">
              <button className="fb-hbtn" onClick={() => setMin((v) => !v)}
                aria-label={t("fb.minimize")} title={t("fb.minimize")}>–</button>
              <button className="fb-hbtn" onClick={() => setOpen(false)}
                aria-label={t("fb.close")} title={t("fb.close")}>✕</button>
            </div>
          </div>
          {!min && (
            <>
              <div className="fb-body" ref={bodyRef}>
                <div className="fb-row bot">
                  <BotAvatar />
                  <div className="fb-col">
                    <div className="fb-bubble bot">{t("fb.intro")}</div>
                    <span className="fb-time">{time(openedAt)}</span>
                  </div>
                </div>
                {showOpts && (
                  <>
                    <div className="fb-row bot">
                      <BotAvatar />
                      <div className="fb-col">
                        <div className="fb-bubble bot">{t("fb.choose")}</div>
                        <span className="fb-time">{time(openedAt)}</span>
                      </div>
                    </div>
                    <div className="fb-opts">
                      {OPTS.map((o) => (
                        <button key={o.key} className="fb-opt"
                          onClick={() => { setSentiment(o.sentiment); setHint(t(`fb.${o.key}Hint`)); }}>
                          <span className="fb-optico" style={{ background: o.bg }}>{o.icon}</span>
                          <span className="fb-opttxt">
                            <b>{t(`fb.${o.key}`)}</b>
                            <small>{t(`fb.${o.key}Sub`)}</small>
                          </span>
                          <span className="fb-optchev" aria-hidden="true">›</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {msgs.map((m, i) =>
                  m.role === "bot" ? (
                    <div key={i} className="fb-row bot">
                      <BotAvatar />
                      <div className="fb-col">
                        <div className="fb-bubble bot">
                          {m.team && <span className="fb-team">{t("fb.team")}</span>}
                          {m.text}
                        </div>
                        {m.at && <span className="fb-time">{time(m.at)}</span>}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="fb-row fb-user">
                      <div className="fb-col fb-user">
                        <div className="fb-bubble fb-user">
                          {m.sentiment && <span className="fb-emoji">{ICONS[m.sentiment]}</span>}
                          {m.text}
                        </div>
                        {m.at && <span className="fb-time">{time(m.at)} <b className="fb-check">{m.read ? "✓✓" : "✓"}</b></span>}
                      </div>
                    </div>
                  ),
                )}
              </div>
              <div className="fb-input">
                <input
                  value={draft}
                  placeholder={hint ?? t("fb.placeholder")}
                  maxLength={2000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                />
                <button className="fb-send" disabled={busy || !draft.trim()} onClick={() => void send()}
                  aria-label={t("fb.send")} title={t("fb.send")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3.4 20.4l17.3-8.4L3.4 3.6l-.01 6.53L14 12 3.39 13.87z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
