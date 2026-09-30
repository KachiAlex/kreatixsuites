import { Link } from "react-router-dom";
import { AppIcon, BrandLockup, type AppKind } from "../components/AppIcon";

const APPS: { kind: AppKind; name: string; desc: string }[] = [
  { kind: "writer", name: "Writer", desc: "Rich documents with styles, tables, track changes, citations, mail merge — full DOCX fidelity." },
  { kind: "sheets", name: "Sheets", desc: "A real spreadsheet engine — 200+ functions, pivots, charts, what-if analysis, XLSX in and out." },
  { kind: "present", name: "Present", desc: "Slide decks with layouts, transitions, presenter view, and PPTX round-trip." },
  { kind: "pdf", name: "PDF", desc: "View, annotate, redact, sign, fill forms, and organize pages — a complete PDF workbench." },
  { kind: "folder", name: "Drive", desc: "One home for every file — folders, versions, granular sharing, roles, and full-text search." },
  { kind: "suites", name: "Kreatix AI", desc: "Summarize, draft, and transform content across every app — AI built into the suite." },
];

const POINTS = [
  { title: "Real-time collaboration", desc: "Edit together with live cursors and presence — powered by CRDT sync, no conflicts." },
  { title: "Office formats, honored", desc: "DOCX, XLSX, PPTX, and PDF in and out — work stays compatible with the tools your partners use." },
  { title: "Private by design", desc: "Encryption at rest, per-file permissions, share links, and self-hostable on your own infrastructure." },
  { title: "Work offline", desc: "Drafts save locally and sync when you're back — the suite installs as an app on any device." },
];

export function Landing() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <BrandLockup size={36} />
        <nav>
          <a href="#apps">Apps</a>
          <a href="#why">Why Kreatix</a>
          <Link to="/login">Sign in</Link>
          <Link to="/register" className="btn-primary lp-cta">Get started</Link>
        </nav>
      </header>

      <main>
        <section className="lp-hero">
          <h1>One suite for all your <em>work</em></h1>
          <p className="lp-sub">
            Kreatix Suites is a modern, AI-native office productivity platform —
            documents, spreadsheets, slides, and PDFs in one collaborative workspace.
          </p>
          <div className="lp-hero-cta">
            <Link to="/register" className="btn-primary" style={{ padding: "12px 26px", fontSize: 15 }}>Create free workspace</Link>
            <Link to="/login" className="btn-ghost" style={{ padding: "12px 26px", fontSize: 15 }}>Sign in</Link>
          </div>
        </section>

        <section id="apps" className="lp-section">
          <h2>Every app you need</h2>
          <p className="lp-lead">Five full editors plus Drive and Kreatix AI — sharing one workspace, one search, one set of permissions.</p>
          <div className="lp-grid">
            {APPS.map((a) => (
              <article key={a.name} className="lp-card">
                <AppIcon kind={a.kind} size={46} />
                <h3>{a.name}</h3>
                <p>{a.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="why" className="lp-section">
          <h2>Built for how teams actually work</h2>
          <div className="lp-grid lp-grid-2">
            {POINTS.map((p) => (
              <article key={p.title} className="lp-card lp-card-flat">
                <h3>{p.title}</h3>
                <p>{p.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-section lp-end">
          <h2>Ready when you are</h2>
          <p className="lp-lead">Create a workspace in seconds — no credit card, no install.</p>
          <Link to="/register" className="btn-primary" style={{ padding: "12px 26px", fontSize: 15 }}>Get started free</Link>
        </section>
      </main>

      <footer className="lp-foot">
        <BrandLockup size={24} />
        <span>© {new Date().getFullYear()} Kreatix</span>
        <Link to="/login">Sign in</Link>
      </footer>
    </div>
  );
}
