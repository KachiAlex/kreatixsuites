import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";

type Sentiment = "good" | "ok" | "bad";
interface FbMsg { role: "user" | "system"; sentiment?: Sentiment; text: string }

const ICONS: Record<Sentiment, string> = { good: "🙂", ok: "😐", bad: "☹️" };

/** Floating feedback chat — bottom-right on every shell page. Each message
 *  posts to /api/feedback and is reviewed in the superadmin portal. */
export function FeedbackWidget() {
  const { user } = useAuth();
  const t = useI18n().t;
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [sentiment, setSentiment] = useState<Sentiment>("good");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<FbMsg[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight); }, [msgs, open]);

  // feedback needs a server account — anonymous/local-mode users have no workspace to attribute it to
  if (!user || user.id === "local") return null;

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setDraft("");
    setMsgs((m) => [...m, { role: "user", sentiment, text: message }]);
    try {
      await api.post("/api/feedback", { sentiment, message, page: loc.pathname });
      setMsgs((m) => [...m, { role: "system", text: t("fb.thanks") }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="fb-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("fb.title")}
        aria-expanded={open}
        title={t("fb.title")}
      >
        {open ? "✕" : "💬"}
      </button>
      {open && (
        <div className="fb-panel" role="dialog" aria-label={t("fb.title")}>
          <div className="fb-head">
            <b>{t("fb.title")}</b>
            <span>{t("fb.subtitle")}</span>
          </div>
          <div className="fb-body" ref={bodyRef}>
            <div className="fb-msg system">{t("fb.intro")}</div>
            {msgs.map((m, i) => (
              <div key={i} className={`fb-msg ${m.role}`}>
                {m.sentiment && <span className="fb-emoji">{ICONS[m.sentiment]}</span>}
                {m.text}
              </div>
            ))}
          </div>
          <div className="fb-sentiments" role="group" aria-label={t("fb.sentiment")}>
            {(["good", "ok", "bad"] as Sentiment[]).map((s) => (
              <button
                key={s}
                className={`fb-sent ${sentiment === s ? "on" : ""}`}
                onClick={() => setSentiment(s)}
                title={t(`fb.${s}`)}
                aria-pressed={sentiment === s}
              >
                {ICONS[s]} <span>{t(`fb.${s}`)}</span>
              </button>
            ))}
          </div>
          <div className="fb-input">
            <input
              value={draft}
              placeholder={t("fb.placeholder")}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            />
            <button className="btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
              {t("fb.send")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
