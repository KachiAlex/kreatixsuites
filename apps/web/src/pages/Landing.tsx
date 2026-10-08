import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppIcon, BrandLockup, type AppKind } from "../components/AppIcon";
import { useT } from "../lib/i18n";

/* ===== interactive app showcase data (visual mockups stay English) ===== */

interface Demo {
  kind: AppKind;
  name: string;
  toolbar: string;
  canvas: ReactNode;
}

const DEMOS: Demo[] = [
  {
    kind: "writer", name: "Writer",
    toolbar: "File  Home  Insert  Layout  Review",
    canvas: (
      <div className="lp-paper">
        <div className="lp-paper-label">THE NEXT CHAPTER / STRATEGY</div>
        <h3>Ideas worth<br />building on.</h3>
        <p>A clear direction. A shared ambition. A practical plan to bring our next big idea to life.</p>
        <div className="lp-lines" /><div className="lp-lines" /><div className="lp-lines short" />
        <div className="lp-tag">✦ A stronger first draft starts here.</div>
      </div>
    ),
  },
  {
    kind: "sheets", name: "Sheets",
    toolbar: "File  Home  Formulas  Data  Charts",
    canvas: (
      <div style={{ width: "100%" }}>
        <table className="lp-sheet">
          <thead><tr><th>Launch budget</th><th>Planned</th><th>Actual</th></tr></thead>
          <tbody>
            <tr><td>Product development</td><td>₦450,000</td><td>₦420,000</td></tr>
            <tr><td>Brand & marketing</td><td>₦250,000</td><td>₦210,000</td></tr>
            <tr><td>Operations</td><td>₦150,000</td><td>₦125,000</td></tr>
            <tr><td>Total</td><td>₦850,000</td><td>₦755,000</td></tr>
          </tbody>
        </table>
        <div className="lp-bars">
          <i style={{ height: "90%" }} /><i style={{ height: "74%", background: "#87c699" }} />
          <i style={{ height: "58%" }} /><i style={{ height: "43%", background: "#87c699" }} />
        </div>
      </div>
    ),
  },
  {
    kind: "present", name: "Present",
    toolbar: "File  Home  Insert  Design  Transitions",
    canvas: (
      <div className="lp-slide">
        <small>THE NEXT CHAPTER · 01</small>
        <h3>Big ideas.<br />Real possibilities.</h3>
        <p>A new direction for the way we work.</p>
      </div>
    ),
  },
  {
    kind: "pdf", name: "PDF Editor",
    toolbar: "File  Edit  Annotate  Pages  Sign",
    canvas: (
      <div className="lp-paper">
        <div className="lp-paper-label" style={{ color: "#e02525" }}>PDF / DOCUMENT REVIEW</div>
        <h3>A clearer<br />agreement.</h3>
        <p><mark className="lp-mark">The project will be delivered in three stages,</mark> with review milestones at the end of each phase.</p>
        <div className="lp-lines" /><div className="lp-lines short" />
        <div className="lp-tag lp-tag-red">Review note: confirm the delivery schedule.</div>
      </div>
    ),
  },
];

const NAVLINKS = [
  { id: "products", key: "lp.nav.suite" },
  { id: "experience", key: "lp.nav.explore" },
  { id: "workflow", key: "lp.nav.why" },
  { id: "pricing", key: "lp.nav.pricing" },
  { id: "faq", key: "lp.nav.faq" },
];

/* ===== live pricing — served from the plan catalog the superadmin edits ===== */
interface PublicPlan {
  slug: string; name: string;
  priceNgn: number; memberPriceNgn: number;
  features: Record<string, boolean>; limits: Record<string, number>;
}
const FEATURE_LABELS: [string, string][] = [
  ["export", "lp.price.f.export"],
  ["pdf_sign", "lp.price.f.pdf_sign"],
  ["pdf_edit", "lp.price.f.pdf_edit"],
  ["share_protect", "lp.price.f.share_protect"],
  ["writer_advanced", "lp.price.f.writer_advanced"],
  ["sso", "lp.price.f.sso"],
  ["scim", "lp.price.f.scim"],
  ["priority_support", "lp.price.f.priority_support"],
];
const fmtGB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Landing() {
  const t = useT();
  /* selected showcase app is URL-driven (?app=writer) → deep-linkable */
  const [params, setParams] = useSearchParams();
  const app = Math.max(0, DEMOS.findIndex((d) => d.kind === params.get("app")));
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState("");
  const [openFaq, setOpenFaq] = useState<ReadonlySet<number>>(new Set([0]));
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);

  /* scroll-reveal via IntersectionObserver (graceful without it) */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !("IntersectionObserver" in window)) return;
    root.classList.add("lp-js");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("lp-visible"); io.unobserve(e.target); }
      }
    }, { threshold: 0.08 });
    root.querySelectorAll(".lp-reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /* scroll-spy: highlight the nav link for the section in view */
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const sections = NAVLINKS.map((l) => document.getElementById(l.id))
      .filter((el): el is HTMLElement => !!el);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  /* smooth anchor scrolling — .lp isn't the scroll container, so it must go
   * on <html>; restore whatever was there on unmount */
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    if (!reducedMotion()) html.style.scrollBehavior = "smooth";
    return () => { html.style.scrollBehavior = prev; };
  }, []);

  /* Escape or outside click closes the mobile menu */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menuOpen]);

  /* live plan catalog — superadmin edits surface here within a minute */
  useEffect(() => {
    let dead = false;
    fetch("/api/plans")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { plans: PublicPlan[] }) => { if (!dead) setPlans(d.plans); })
      .catch(() => { if (!dead) setPlans([]); });
    return () => { dead = true; };
  }, []);

  /* warm the post-signup bundle while the visitor reads the page */
  useEffect(() => {
    const warm = () => { void import("../components/Shell"); void import("./Home"); };
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) { w.requestIdleCallback(warm); return; }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);

  const selectApp = (i: number, scroll = false) => {
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("app", DEMOS[i].kind);
      return n;
    }, { replace: true });
    if (scroll) {
      /* move focus into the showcase so keyboard/AT users don't lose their
       * place, then bring it into view */
      document.getElementById(`lp-tab-${i}`)?.focus({ preventScroll: true });
      document.getElementById("experience")
        ?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
    }
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? DEMOS.length - 1
      : (i + (e.key === "ArrowRight" ? 1 : DEMOS.length - 1)) % DEMOS.length;
    selectApp(n);
    document.getElementById(`lp-tab-${n}`)?.focus();
  };

  const toggleFaq = (i: number) => setOpenFaq((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });

  const demo = DEMOS[app];
  const year = new Date().getFullYear();

  return (
    <div className="lp" ref={rootRef}>
      <a href="#lp-main" className="lp-skip">{t("lp.skip")}</a>

      <header className="lp-header">
        <nav className="lp-wrap lp-nav" ref={navRef}>
          <Link to="/" className="lp-brand" aria-label={t("lp.nav.home")}>
            <BrandLockup size={36} fetchPriority="high" />
          </Link>
          <div id="lp-links" className={`lp-links${menuOpen ? " open" : ""}`}>
            {NAVLINKS.map((l) => (
              <a key={l.id} href={`#${l.id}`} onClick={() => setMenuOpen(false)}
                className={active === l.id ? "current" : undefined}
                aria-current={active === l.id ? "true" : undefined}>
                {t(l.key)}
              </a>
            ))}
            <Link to="/download" onClick={() => setMenuOpen(false)}>{t("dl.title")}</Link>
            <Link to="/login" onClick={() => setMenuOpen(false)}>{t("lp.nav.signin")}</Link>
          </div>
          <Link to="/register" className="lp-btn lp-btn-orange lp-nav-cta">{t("lp.nav.getStarted")} <span aria-hidden="true">↗</span></Link>
          <button type="button" className="lp-menu" aria-expanded={menuOpen} aria-controls="lp-links" aria-label={t("lp.nav.toggle")}
            onClick={() => setMenuOpen((o) => !o)}>{menuOpen ? t("lp.nav.close") : t("lp.nav.menu")}</button>
        </nav>
      </header>

      <main id="lp-main">
        {/* ===== hero ===== */}
        <section className="lp-hero">
          <div className="lp-wrap">
            <div className="lp-hero-top">
              <div>
                <div className="lp-eyebrow"><span className="lp-dot" /> {t("lp.hero.eyebrow")}</div>
                <h1>{t("lp.hero.h1a")}<br />{t("lp.hero.h1pre")}<em>{t("lp.hero.h1em")}</em></h1>
              </div>
              <div className="lp-hero-copy">
                <p>{t("lp.hero.sub")}</p>
                <div className="lp-actions">
                  <Link to="/register" className="lp-btn lp-btn-orange">{t("lp.hero.cta")} <span aria-hidden="true">↗</span></Link>
                  <a href="#experience" className="lp-btn lp-btn-outline">{t("lp.hero.explore")} <span aria-hidden="true">↓</span></a>
                </div>
                <div className="lp-small">{t("lp.hero.small")}</div>
              </div>
            </div>

            <div className="lp-hero-preview">
              <div className="lp-window">
                <div className="lp-titlebar">
                  <span className="lp-lights"><i /><i /><i /></span>
                  <span className="lp-wsearch">⌕ &nbsp; {t("lp.win.search")}</span>
                  <span>Kreatix Business Suite</span>
                </div>
                <div className="lp-windowbody">
                  <aside className="lp-wside">
                    <div className="lp-wside-brand"><AppIcon kind="suites" size={26} /><b>Kreatix</b></div>
                    <div className="lp-sideitem active">⌂ &nbsp; {t("lp.win.home")}</div>
                    <div className="lp-sideitem">▤ &nbsp; {t("lp.win.allFiles")}</div>
                    <div className="lp-sideitem">☆ &nbsp; {t("lp.win.starred")}</div>
                    <div className="lp-sideitem">♧ &nbsp; {t("lp.win.shared")}</div>
                    <div className="lp-sideitem">◷ &nbsp; {t("lp.win.recent")}</div>
                    <div className="lp-sideitem lp-sideitem-label">{t("lp.win.workspaces").toUpperCase()}</div>
                    <div className="lp-sideitem"><span style={{ color: "#3578E5" }}>●</span> &nbsp; Design studio</div>
                    <div className="lp-sideitem"><span style={{ color: "#1F9D66" }}>●</span> &nbsp; My business</div>
                  </aside>
                  <div className="lp-workspace">
                    <div className="lp-greeting">
                      <div>
                        <h3>{t("lp.win.greet")}</h3>
                        <p>{t("lp.win.greetSub")}</p>
                      </div>
                      <div className="lp-avatars"><span>BN</span><span>EA</span><span>JD</span></div>
                    </div>
                    <div className="lp-app-row">
                      {DEMOS.map((d, i) => (
                        <button key={d.name} type="button" className="lp-app-mini" onClick={() => selectApp(i, true)}>
                          <AppIcon kind={d.kind} size={32} />
                          <span>{d.name}<small>{t(`lp.app.${d.kind}.sub`)}</small></span>
                        </button>
                      ))}
                    </div>
                    <div className="lp-filehead">
                      <span>{t("lp.win.pickup")}</span>
                      <span style={{ color: "#96968b", fontWeight: "normal" }}>{t("lp.win.viewAll")} ↗</span>
                    </div>
                    <div className="lp-file"><span><AppIcon kind="writer" size={20} />Brand strategy.docx</span><span className="lp-muted">Design studio</span><span className="lp-muted">{t("lp.win.justNow")}</span></div>
                    <div className="lp-file"><span><AppIcon kind="sheets" size={20} />Launch budget.xlsx</span><span className="lp-muted">My business</span><span className="lp-muted">{t("lp.win.minsAgo", { n: 12 })}</span></div>
                    <div className="lp-file"><span><AppIcon kind="present" size={20} />The next chapter.pptx</span><span className="lp-muted">Design studio</span><span className="lp-muted">{t("lp.win.today")}</span></div>
                  </div>
                </div>
              </div>
              <div className="lp-float-card">
                <b>✦ &nbsp; {t("lp.float.title")}</b>
                <p>{t("lp.float.body")}</p>
                <div className="lp-progress" />
              </div>
              <div className="lp-preview-note">{t("lp.preview.note")}</div>
            </div>

            <div className="lp-promise">
              <b>{t("lp.promise.lead")}</b>
              <span>{t("lp.promise.docs")}</span>
              <span>{t("lp.promise.decks")}</span>
              <span>{t("lp.promise.shared")}</span>
              <span>{t("lp.promise.ai")}</span>
            </div>
          </div>
        </section>

        {/* ===== products ===== */}
        <section className="lp-section" id="products">
          <div className="lp-wrap">
            <div className="lp-section-top lp-reveal">
              <div>
                <div className="lp-eyebrow">{t("lp.prod.eyebrow")}</div>
                <h2>{t("lp.prod.h1")}<br />{t("lp.prod.h2")}</h2>
              </div>
              <p>{t("lp.prod.lead")}</p>
            </div>
            <div className="lp-products">
              {DEMOS.map((d, i) => (
                <article className="lp-product lp-reveal" key={d.name}>
                  <AppIcon kind={d.kind} size={46} />
                  <span className="lp-num">0{i + 1}</span>
                  <h3>Kreatix {d.name}</h3>
                  <p>{t(`lp.app.${d.kind}.text`)}</p>
                  <button type="button" onClick={() => selectApp(i, true)}>{t("lp.prod.explore", { app: d.name })} <span aria-hidden="true">↗</span></button>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ===== interactive showcase ===== */}
        <section className="lp-section lp-showcase" id="experience">
          <div className="lp-wrap lp-demo-layout">
            <div className="lp-demo-copy lp-reveal">
              <div className="lp-eyebrow">{t("lp.demo.eyebrow")}</div>
              <h2>{t(`lp.app.${demo.kind}.h1`)}<br />{t(`lp.app.${demo.kind}.h2`)}</h2>
              <p>{t(`lp.app.${demo.kind}.desc`)}</p>
              <div className="lp-tabs" role="tablist" aria-label="Product previews">
                {DEMOS.map((d, i) => (
                  <button key={d.name} type="button" id={`lp-tab-${i}`} className="lp-tab" role="tab"
                    aria-selected={i === app} aria-controls="lp-preview"
                    tabIndex={i === app ? 0 : -1}
                    onClick={() => selectApp(i)} onKeyDown={(e) => onTabKey(e, i)}>
                    {d.name}
                  </button>
                ))}
              </div>
              <p className="lp-demo-note">{t("lp.demo.note")}</p>
            </div>
            <div className="lp-editor lp-reveal" role="tabpanel" id="lp-preview" tabIndex={0} aria-labelledby={`lp-tab-${app}`}>
              <div className="lp-editor-head">
                <span><AppIcon kind={demo.kind} size={22} /><b>Kreatix {demo.name}</b></span>
                <span style={{ color: "#7a8f71" }}>● &nbsp; {t("lp.demo.saved")}</span>
              </div>
              <div className="lp-toolbar">{demo.toolbar}</div>
              <div className="lp-canvas">{demo.canvas}</div>
            </div>
          </div>
        </section>

        {/* ===== workflow ===== */}
        <section className="lp-section" id="workflow">
          <div className="lp-wrap">
            <div className="lp-workflow">
              <div className="lp-reveal">
                <div className="lp-eyebrow">{t("lp.flow.eyebrow")}</div>
                <h2>{t("lp.flow.h1")}<br />{t("lp.flow.h2")}</h2>
                <p>{t("lp.flow.lead")}</p>
                <a href="#experience" className="lp-btn lp-btn-outline">{t("lp.flow.cta")} <span aria-hidden="true">↗</span></a>
              </div>
              <div className="lp-flowboard lp-reveal">
                <div className="lp-flowstep">
                  <AppIcon kind="writer" size={37} />
                  <div><b>{t("lp.flow.s1t")}</b><small>{t("lp.flow.s1s")}</small></div>
                </div>
                <div className="lp-flowstep">
                  <AppIcon kind="sheets" size={37} />
                  <div><b>{t("lp.flow.s2t")}</b><small>{t("lp.flow.s2s")}</small></div>
                </div>
                <div className="lp-flowstep">
                  <AppIcon kind="present" size={37} />
                  <div><b>{t("lp.flow.s3t")}</b><small>{t("lp.flow.s3s")}</small></div>
                </div>
              </div>
            </div>
            <div className="lp-features">
              {[1, 2, 3].map((n) => (
                <div className="lp-feature lp-reveal" key={n}>
                  <div className="lp-symbol">{["↗", "◈", "✦"][n - 1]}</div>
                  <h3>{t(`lp.feat.${n}t`)}</h3>
                  <p>{t(`lp.feat.${n}p`)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ===== Kreatix AI ===== */}
        <section className="lp-section lp-dark">
          <div className="lp-wrap lp-ai-layout">
            <div className="lp-reveal">
              <div className="lp-eyebrow" style={{ color: "#f59a59" }}>{t("lp.ai.eyebrow")}</div>
              <h2>{t("lp.ai.h1")}<br />{t("lp.ai.h2")}</h2>
              <p>{t("lp.ai.lead")}</p>
              <Link to="/register" className="lp-btn lp-btn-orange" style={{ marginTop: 15 }}>{t("lp.ai.cta")} <span aria-hidden="true">↗</span></Link>
            </div>
            <div className="lp-chat lp-reveal">
              <div className="lp-chat-title"><span>✦ &nbsp; Kreatix AI</span><span>{t("lp.ai.badge").toUpperCase()}</span></div>
              <div className="lp-chat-prompt">{t("lp.ai.prompt")}</div>
              <div className="lp-chat-response">
                <b>{t("lp.ai.resp1")}</b><br />
                01 &nbsp; {t("lp.ai.resp2")}<br />
                02 &nbsp; {t("lp.ai.resp3")}<br />
                03 &nbsp; {t("lp.ai.resp4")}
              </div>
              <div className="lp-typing" aria-hidden="true"><i /><i /><i /></div>
            </div>
          </div>
        </section>

        {/* ===== pricing — live from the superadmin-edited plan catalog ===== */}
        <section className="lp-section" id="pricing">
          <div className="lp-wrap">
            <div className="lp-section-top lp-reveal">
              <div>
                <div className="lp-eyebrow">{t("lp.price.eyebrow")}</div>
                <h2>{t("lp.price.h1")}<br />{t("lp.price.h2")}</h2>
              </div>
              <p>{t("lp.price.lead")}</p>
            </div>
            {plans === null ? (
              <div className="lp-plans" aria-busy="true">
                {[0, 1, 2].map((i) => <div key={i} className="lp-plan lp-plan-skel" />)}
              </div>
            ) : (
              <div className="lp-plans">
                {plans.map((p) => {
                  const members = p.limits.max_members ?? 0;
                  const vdays = p.limits.version_days ?? 0;
                  return (
                    <article key={p.slug} className={`lp-plan lp-reveal${p.slug === "pro" ? " popular" : ""}`}>
                      {p.slug === "pro" && <span className="lp-plan-badge">{t("lp.price.popular")}</span>}
                      <h3>{p.name}</h3>
                      <div className="lp-plan-price">
                        {p.priceNgn === 0
                          ? <b>{t("lp.price.free")}</b>
                          : <><b>₦{p.priceNgn.toLocaleString()}</b><span>{t("lp.price.perMonth")}</span></>}
                      </div>
                      {p.memberPriceNgn > 0 && (
                        <small className="lp-plan-member">{t("lp.price.member", { n: p.memberPriceNgn.toLocaleString() })}</small>
                      )}
                      <ul className="lp-plan-feats">
                        <li>{members === 1 ? t("lp.price.members.one", { n: 1 })
                          : members > 0 ? t("lp.price.members.many", { n: members })
                          : t("lp.price.members.all")}</li>
                        <li>{t("lp.price.storage", { n: fmtGB(p.limits.storage_mb ?? 0) })}</li>
                        <li>{p.features.ai ? t("lp.price.ai", { n: p.limits.ai_daily ?? 0 }) : t("lp.price.ai.none")}</li>
                        <li>{vdays > 0 ? t("lp.price.versions", { n: vdays }) : t("lp.price.versions.all")}</li>
                        {FEATURE_LABELS.map(([k, key]) => (p.features[k] ? <li key={k}>{t(key)}</li> : null))}
                      </ul>
                      <Link to="/register" className={`lp-btn lp-plan-cta ${p.priceNgn === 0 ? "lp-btn-outline" : "lp-btn-orange"}`}>
                        {p.priceNgn === 0 ? t("lp.price.cta.free") : t("lp.price.cta.paid", { name: p.name })}
                      </Link>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* ===== FAQ ===== */}
        <section className="lp-section" id="faq">
          <div className="lp-wrap lp-faq-layout">
            <div className="lp-reveal">
              <div className="lp-eyebrow">{t("lp.faq.eyebrow")}</div>
              <h2>{t("lp.faq.h1")}<br />{t("lp.faq.h2")}</h2>
            </div>
            <div className="lp-reveal">
              {[0, 1, 2, 3, 4].map((i) => {
                const open = openFaq.has(i);
                return (
                  <div className="lp-faqitem" key={i}>
                    <button type="button" className="lp-faqq" aria-expanded={open}
                      aria-controls={`lp-faqb-${i}`} onClick={() => toggleFaq(i)}>
                      {t(`lp.faq.q${i + 1}`)}
                      <span className="lp-faqx" aria-hidden="true">{open ? "−" : "+"}</span>
                    </button>
                    <div className={`lp-faqb${open ? " open" : ""}`} id={`lp-faqb-${i}`}>
                      <div className="lp-faqb-in"><p>{t(`lp.faq.a${i + 1}`)}</p></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ===== CTA ===== */}
        <div className="lp-wrap">
          <section className="lp-cta lp-reveal">
            <div>
              <h2>{t("lp.cta.h1")}<br />{t("lp.cta.h2")}</h2>
              <p>{t("lp.cta.p")}</p>
            </div>
            <Link to="/register" className="lp-btn lp-btn-white">{t("lp.cta.btn")} <span aria-hidden="true">↗</span></Link>
          </section>
        </div>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-foot-top">
            <div>
              <Link to="/" className="lp-brand"><BrandLockup size={32} decoding="async" /></Link>
              <p>{t("lp.foot.tag")}</p>
            </div>
            <div className="lp-foot-links">
              <a href="#products">{t("lp.foot.apps")}</a>
              <a href="#workflow">{t("lp.nav.why")}</a>
              <a href="#faq">{t("lp.nav.faq")}</a>
              <Link to="/download">{t("dl.title")}</Link>
              <Link to="/login">{t("lp.nav.signin")}</Link>
              <Link to="/register">{t("lp.nav.getStarted")} <span aria-hidden="true">↗</span></Link>
            </div>
          </div>
          <div className="lp-foot-bottom">
            <span>{t("lp.foot.rights", { year })}</span>
            <span>{t("lp.foot.motto")}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
