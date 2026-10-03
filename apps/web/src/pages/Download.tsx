import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { BrandLockup, AppIcon } from "../components/AppIcon";

interface DlEntry { name: string; size: number; updatedAt: number; version: string | null }
interface Manifest { desktop: DlEntry | null; android: DlEntry | null }

const MB = (n: number) => `${(n / 1048576).toFixed(0)} MB`;

function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path fill="#F2782E" d="M3 5.5 10.5 4.5v7H3zM11.5 4.4 21 3v8.5h-9.5zM3 12.5h7.5v7L3 18.5zM11.5 12.5H21V21l-9.5-1.4z"/>
    </svg>
  );
}
function AndroidGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path fill="#3DDC84" d="M7.5 10.5h9v7.5a1.5 1.5 0 0 1-1.5 1.5h-1v2.75a1 1 0 1 1-2 0V19h-1v2.75a1 1 0 1 1-2 0V19H8.5a1.5 1.5 0 0 1-1.5-1.5zM17.8 9.1l1.7-2.9a.45.45 0 0 0-.8-.4l-1.7 3a8.9 8.9 0 0 0-10.5 0l-1.7-3a.45.45 0 0 0-.8.4l1.7 2.9A9 9 0 0 0 3 15.5h18a9 9 0 0 0-3.2-6.4zM8.75 13a1.13 1.13 0 1 1 0-2.26 1.13 1.13 0 0 1 0 2.25zm6.5 0a1.13 1.13 0 1 1 0-2.26 1.13 1.13 0 0 1 0 2.25z"/>
      <path fill="#3DDC84" d="M4.6 11a1.4 1.4 0 0 0-1.4 1.4v4.2a1.4 1.4 0 1 0 2.8 0v-4.2A1.4 1.4 0 0 0 4.6 11zm14.8 0a1.4 1.4 0 0 0-1.4 1.4v4.2a1.4 1.4 0 1 0 2.8 0v-4.2a1.4 1.4 0 0 0-1.4-1.4z"/>
    </svg>
  );
}

export function Download() {
  const t = useT();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const year = new Date().getFullYear();

  useEffect(() => {
    document.title = `${t("dl.title")} · Kreatix Suites`;
    api.get<Manifest>("/api/downloads")
      .then(setManifest)
      .catch(() => {}); // keep null → buttons still render without size info
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meta = (e: DlEntry | null) =>
    e ? `v${e.version ?? "—"} · ${MB(e.size)}` : null;

  return (
    <div className="dl">
      <header className="dl-head">
        <Link to="/" className="dl-brand" aria-label="Kreatix Suites"><BrandLockup size={34} /></Link>
        <nav className="dl-nav">
          <Link to="/">{t("dl.nav.home")}</Link>
          <Link to="/login">{t("dl.nav.signin")}</Link>
          <Link to="/register" className="dl-cta">{t("dl.nav.getStarted")}</Link>
        </nav>
      </header>

      <main className="dl-main">
        <p className="dl-eyebrow">{t("dl.eyebrow")}</p>
        <h1>{t("dl.h1")}</h1>
        <p className="dl-sub">{t("dl.sub")}</p>

        <div className="dl-cards">
          <div className="dl-card primary">
            <div className="dl-card-top">
              <span className="dl-icon"><WindowsGlyph /></span>
              <div>
                <h2>{t("dl.win.name")}</h2>
                <p className="dl-meta">{meta(manifest?.desktop ?? null) ?? t("dl.win.meta")}</p>
              </div>
            </div>
            <p className="dl-desc">{t("dl.win.desc")}</p>
            {manifest?.desktop === null ? (
              <span className="dl-btn disabled">{t("dl.soon")}</span>
            ) : (
              <a className="dl-btn" href="/api/downloads/desktop">
                {t("dl.win.btn")} {manifest?.desktop && <span className="dl-btn-meta">{MB(manifest.desktop.size)}</span>}
              </a>
            )}
            <p className="dl-req">{t("dl.win.req")}</p>
          </div>

          <div className="dl-card">
            <div className="dl-card-top">
              <span className="dl-icon"><AndroidGlyph /></span>
              <div>
                <h2>{t("dl.and.name")}</h2>
                <p className="dl-meta">{meta(manifest?.android ?? null) ?? t("dl.and.meta")}</p>
              </div>
            </div>
            <p className="dl-desc">{t("dl.and.desc")}</p>
            {manifest?.android === null ? (
              <span className="dl-btn disabled">{t("dl.soon")}</span>
            ) : (
              <a className="dl-btn ghost" href="/api/downloads/android">
                {t("dl.and.btn")} {manifest?.android && <span className="dl-btn-meta">{MB(manifest.android.size)}</span>}
              </a>
            )}
            <p className="dl-req">{t("dl.and.req")}</p>
          </div>
        </div>

        <div className="dl-steps">
          {["dl.s1", "dl.s2", "dl.s3"].map((k, i) => (
            <div className="dl-step" key={k}>
              <span className="dl-num">{i + 1}</span>
              <div><b>{t(`${k}.h`)}</b><p>{t(`${k}.p`)}</p></div>
            </div>
          ))}
        </div>

        <p className="dl-web">
          {t("dl.web.line")} <Link to="/login">{t("dl.web.link")}</Link>
        </p>
      </main>

      <footer className="dl-foot">
        <AppIcon kind="suites" size={16} />
        <span>{t("lp.foot.rights", { year })}</span>
      </footer>
    </div>
  );
}
