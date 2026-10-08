// Platform superadmin console — KPIs, payment queue, feedback, workspaces,
// AI spend, pricing and email tools. The account is portal-only: every call
// here is /api/superadmin/*, enforced server-side by the confinement guard.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/hooks";

/* ---- inline SVG icon set (stroke icons, no emoji in chrome) ---- */
const PATHS: Record<string, string> = {
  layout: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  building: "M4 21V5h10v16 M14 10h6v11 M2 21h20 M7 8h1 M10 8h1 M7 12h1 M10 12h1 M7 16h1 M10 16h1 M17 13h1 M17 17h1",
  wallet: "M3 7V5a2 2 0 0 1 2-2h14v4 M3 7h17v14H5a2 2 0 0 1-2-2z M20 11h-6v6h6 M16 14h.01",
  chat: "M21 11a8 8 0 0 1-8 8H6l-4 3 1-6a8 8 0 0 1-1-5 8 8 0 0 1 8-8h3a8 8 0 0 1 8 8z M7 10h9 M7 14h5",
  settings: "M9 3h6l1 3 3 1 2 4-2 2 1 3-3 3-3-1-2 3-4-1-1-3-3-1-1-4 2-2-1-3 3-3z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
  refresh: "M20 7a9 9 0 0 0-15-2L2 8 M2 3v5h5 M4 17a9 9 0 0 0 15 2l3-3 M22 21v-5h-5",
  trend: "M3 17l6-6 4 4 8-10 M15 5h6v6",
  spark: "M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  alert: "M12 3l10 18H2z M12 9v5 M12 17h.01",
  arrow: "M5 12h14 M15 8l4 4-4 4",
  check: "M5 12l4 4L19 6",
  mail: "M3 5h18v14H3z M3 5l9 7 9-7",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
  download: "M12 3v12 M7 10l5 5 5-5 M3 17v4h18v-4",
  close: "M6 6l12 12 M18 6L6 18",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 6v6l4 2",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  file: "M6 2h8l6 6v14H6z M14 2v6h6",
};
const I = ({ n, s = 18 }: { n: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" className="sap-ico">
    <path d={PATHS[n] ?? PATHS.layout} />
  </svg>
);

interface SaOrg {
  id: string; name: string; created_at: string; seats: number;
  state: string; monthlyAmountNgn: number; status: string | null;
  trial_ends_at: string | null; period_end: string | null; override_until: string | null;
  ai_token_budget?: number | null; plan?: string | null; has_super?: boolean;
}
interface SaOverview {
  orgs: number; users: number; activeSubs: number; trialing: number;
  locked: number; granted: number; freeTier: number; pendingPayments: number; mrrNgn: number;
}
interface PlanRow {
  slug: string; name: string; price_ngn: number; member_price_ngn: number;
  features: Record<string, boolean>; limits: Record<string, number>;
  active: boolean; sort: number;
}
interface SaPayment {
  id: string; org_id: string; org_name: string; amount_ngn: number;
  method: string; reference: string | null; plan?: string; status: string; created_at: string;
}
interface BillingCfg {
  base_price_ngn: number; member_price_ngn: number; trial_months: number;
  business_multiplier: number; currency: string;
}
interface SaAiUsage {
  month: string; requests: number; tokens: number; costUsd: number; budgetUsd: number;
  topOrgs: { orgId: string; name: string; requests: number; tokens: number; costUsd: number }[];
}
interface SaFeedback {
  id: string; sentiment: "good" | "ok" | "bad"; message: string; page: string | null;
  reply: string | null; replied_at: string | null;
  created_at: string; org_name: string; display_name: string; email: string;
}
interface SaAudit {
  id: string; actor_email: string; action: string; target: string | null;
  detail: string | null; created_at: string;
}
interface SaMember {
  id: string; display_name: string; email: string; initials: string | null;
  role: string; is_super: boolean; disabled: boolean;
  created_at: string; last_active: string | null;
}
interface OrgDetail {
  org: { id: string; name: string; createdAt: string; seats: number;
    subscription: { status: string | null; trial_ends_at: string | null; period_end: string | null;
      override_until: string | null; plan: string | null; amount_ngn: number | null };
    state: string; monthlyAmountNgn: number };
  members: SaMember[];
  usage: { files: number; bytes: number; versions: number; comments: number };
  ai: { requests: number; tokens: number; costUsd: number };
  payments: SaPayment[];
  feedbackCount: number;
}
interface Review {
  title: string; body: ReactNode; label: string; danger?: boolean;
  run: () => Promise<void>;
}

const nf = new Intl.NumberFormat("en-NG");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const ngn = (n: number) => `₦${nf.format(n)}`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const title = (s: string) => (s === "none" ? "None" : s.charAt(0).toUpperCase() + s.slice(1));
const initials = (name: string) =>
  name.split(/\s+/).filter((w) => w !== "&").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const dateOf = (v: string | null) =>
  v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
const dayOf = (v: string) =>
  new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const monthLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtBytes = (n: number) =>
  n >= (1 << 30) ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n >= (1 << 20) ? `${(n / (1 << 20)).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

/** Resolve a plan slug (with legacy 'standard' → 'pro' alias) from the catalog. */
const planRow = (plans: PlanRow[], slug?: string | null) =>
  plans.find((p) => p.slug === (slug === "standard" ? "pro" : slug))
  ?? plans.find((p) => p.slug === "free");
const allowance = (plans: PlanRow[], o: { seats: number; plan?: string | null }) => {
  const p = planRow(plans, o.plan);
  return (p?.limits?.ai_tokens_base ?? 0) + Math.max(0, o.seats - 1) * (p?.limits?.ai_tokens_per_seat ?? 0);
};

function When({ v }: { v: string }) {
  const d = new Date(v);
  const today = d.toDateString() === new Date().toDateString();
  return (
    <div className="sap-when">
      <b>{today ? "Today" : dayOf(v)}</b>
      {d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
    </div>
  );
}
const OrgIcon = ({ name }: { name: string }) => <span className="sap-orgicon">{initials(name)}</span>;
const StateBadge = ({ s }: { s: string }) => <span className={`sap-state ${s}`}>{title(s)}</span>;

/** Small key/value block used inside the review dialog. */
function ReviewBox({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="sap-reviewbox">
      {rows.map(([k, v]) => (
        <div className="sap-reviewrow" key={k}><span>{k}</span><b>{v}</b></div>
      ))}
    </div>
  );
}

export function SuperPortal() {
  const { user } = useAuth();
  const { msg, toast } = useToast();
  const [ov, setOv] = useState<SaOverview | null>(null);
  const [orgs, setOrgs] = useState<SaOrg[]>([]);
  const [payments, setPayments] = useState<SaPayment[]>([]);
  const [cfg, setCfg] = useState<BillingCfg | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [newPlan, setNewPlan] = useState({ slug: "", name: "", price: "", member: "" });
  const [planFormOpen, setPlanFormOpen] = useState(false);
  const [ai, setAi] = useState<SaAiUsage | null>(null);
  const [feedback, setFeedback] = useState<SaFeedback[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [mood, setMood] = useState<"all" | "good" | "ok" | "bad">("all");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [selOrgId, setSelOrgId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<Review | null>(null);
  const [acting, setActing] = useState(false);
  const [cfgSaved, setCfgSaved] = useState<"ok" | "err">("ok");
  const [emailTo, setEmailTo] = useState("");
  const [payStatus, setPayStatus] = useState<"pending" | "confirmed" | "rejected" | "all">("pending");
  const [payFrom, setPayFrom] = useState("");
  const [payTo, setPayTo] = useState("");
  const [ledger, setLedger] = useState<SaPayment[] | null>(null); // null = pending queue
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [memberTick, setMemberTick] = useState(0);
  const [audit, setAudit] = useState<SaAudit[] | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditAction, setAuditAction] = useState("all");
  const SECTIONS = ["payments", "feedback", "workspaces", "ai-usage", "pricing", "email", "history"] as const;
  type Section = (typeof SECTIONS)[number];
  const [activeSec, setActiveSec] = useState<Section>(() => {
    const h = window.location.hash.slice(1);
    return (SECTIONS as readonly string[]).includes(h) ? (h as Section) : "payments";
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    setLoadErr(null);
    try {
      const [o, og, pay, c, a, fb, pl] = await Promise.all([
        api.get<SaOverview>("/api/superadmin/overview"),
        api.get<{ orgs: SaOrg[] }>("/api/superadmin/orgs"),
        api.get<{ payments: SaPayment[] }>("/api/superadmin/payments?status=pending"),
        api.get<{ config: BillingCfg }>("/api/superadmin/billing-config"),
        api.get<SaAiUsage>("/api/superadmin/ai-usage"),
        api.get<{ feedback: SaFeedback[]; stats: Record<string, number> }>("/api/superadmin/feedback"),
        api.get<{ plans: PlanRow[] }>("/api/superadmin/plans"),
      ]);
      setOv(o); setOrgs(og.orgs); setPayments(pay.payments); setCfg(c.config); setPlans(pl.plans);
      setAi(a); setFeedback(fb.feedback); setStats(fb.stats);
      setRefreshedAt(new Date());
    } catch (e) {
      const m = e instanceof Error ? e.message : "Load failed";
      setLoadErr(m);
      toast(m);
    } finally {
      setRefreshing(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  // tabs are hash-synced — deep links (/admin#feedback) and back/forward work
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.slice(1);
      if ((SECTIONS as readonly string[]).includes(h)) setActiveSec(h as Section);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // payments ledger — non-pending views fetched on filter change
  const fetchLedger = useCallback(async () => {
    const qs = new URLSearchParams({ status: payStatus });
    if (payFrom) qs.set("from", new Date(`${payFrom}T00:00:00`).toISOString());
    if (payTo) qs.set("to", new Date(`${payTo}T23:59:59`).toISOString());
    const r = await api.get<{ payments: SaPayment[] }>(`/api/superadmin/payments?${qs}`);
    setLedger(r.payments);
  }, [payStatus, payFrom, payTo]);

  useEffect(() => {
    if (payStatus === "pending" && !payFrom && !payTo) { setLedger(null); return; }
    let dead = false;
    setLedgerLoading(true);
    fetchLedger()
      .catch((e) => { if (!dead) toast(e instanceof Error ? e.message : "Payments load failed"); })
      .finally(() => { if (!dead) setLedgerLoading(false); });
    return () => { dead = true; };
  }, [fetchLedger, toast]);

  // audit trail — lazily fetched on first visit to the History tab
  useEffect(() => {
    if (activeSec !== "history" || audit !== null) return;
    let dead = false;
    api.get<{ audit: SaAudit[] }>("/api/superadmin/audit")
      .then((r) => { if (!dead) setAudit(r.audit); })
      .catch((e) => { if (!dead) toast(e instanceof Error ? e.message : "Audit log failed to load"); });
    return () => { dead = true; };
  }, [activeSec, audit, toast]);

  const refreshAudit = useCallback(() => {
    api.get<{ audit: SaAudit[] }>("/api/superadmin/audit")
      .then((r) => setAudit(r.audit))
      .catch((e) => toast(e instanceof Error ? e.message : "Audit log failed to load"));
  }, [toast]);

  // Escape closes the review dialog / workspace drawer (unless a request runs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !acting) { setReview(null); setSelOrgId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [acting]);

  const ask = (r: Review) => setReview(r);
  const commit = async () => {
    if (!review || acting) return;
    setActing(true);
    try {
      await review.run();
      setReview(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(false);
    }
  };

  /* ---------- mutations (all behind the review dialog) ---------- */

  const reviewPayment = (p: SaPayment, ok: boolean) => ask({
    title: ok ? "Confirm payment" : "Reject payment",
    label: ok ? "Confirm & activate" : "Reject payment",
    danger: !ok,
    body: (<>
      <p>{ok
        ? "Activate or extend this workspace's subscription. Confirmation also emails a receipt."
        : "Remove this payment from the pending queue. The subscription stays unchanged."}</p>
      <ReviewBox rows={[
        ["Workspace", p.org_name], ["Amount", ngn(p.amount_ngn)],
        ["Reference", <code key="r">{p.reference ?? "—"}</code>], ["Plan", planRow(plans, p.plan)?.name ?? title(p.plan ?? "pro")],
      ]} />
    </>),
    run: async () => {
      await api.post(`/api/superadmin/payments/${p.id}/${ok ? "confirm" : "reject"}`, {});
      toast(ok ? "Payment confirmed — workspace activated" : "Payment rejected");
      await load();
      if (payStatus !== "pending" || payFrom || payTo) await fetchLedger();
    },
  });

  const compOrg = (o: SaOrg) => {
    const until = new Date(Date.now() + 30 * 86400000);
    ask({
      title: "Grant 30 days of access",
      label: "Grant access",
      body: (<>
        <p>Give <strong>{o.name}</strong> free access until <strong>{dateOf(until.toISOString())}</strong>.
          This sets the comped override; it does not change the paid subscription period.</p>
      </>),
      run: async () => {
        await api.patch(`/api/superadmin/orgs/${o.id}/subscription`, { overrideUntil: until.toISOString() });
        toast(`Granted 30 days of access to ${o.name}`);
        await load();
      },
    });
  };

  const replyTo = (f: SaFeedback, message: string) => ask({
    title: `Reply to ${f.display_name}`,
    label: "Send reply",
    body: (<>
      <p>This reply appears in the user's feedback widget and is emailed to <strong>{f.email}</strong>.</p>
      <div className="sap-reviewbox" style={{ whiteSpace: "pre-wrap", color: "var(--ink)" }}>{message}</div>
    </>),
    run: async () => {
      await api.post(`/api/superadmin/feedback/${f.id}/reply`, { message });
      setFeedback((rows) => rows.map((r) => r.id === f.id
        ? { ...r, reply: message, replied_at: new Date().toISOString() } : r));
      toast("Reply sent — shown in the user's widget and emailed");
    },
  });

  const saveOrgSettings = (o: SaOrg, plan: string, budget: number | null) => ask({
    title: "Update workspace settings",
    label: "Save settings",
    body: (<>
      <p>Review the new plan and AI allowance for <strong>{o.name}</strong>.</p>
      <ReviewBox rows={[
        ["Plan", title(plan)],
        ["Monthly AI budget", budget === null
          ? `Plan default: ${compact.format(allowance(plans, { ...o, plan }))} tokens`
          : `${nf.format(budget)} tokens`],
      ]} />
    </>),
    run: async () => {
      await api.patch(`/api/superadmin/orgs/${o.id}/subscription`, { plan, aiTokenBudget: budget });
      toast(`Workspace settings updated for ${o.name}`);
      await load();
    },
  });

  const extendTrial = (o: SaOrg, days: number) => {
    const end = o.trial_ends_at ? new Date(new Date(o.trial_ends_at).getTime() + days * 86400000) : null;
    ask({
      title: "Extend trial",
      label: "Extend trial",
      body: (<>
        <p>Add <strong>{days} days</strong> to {o.name}'s trial.
          {end ? <> The trial will end on <strong>{dateOf(end.toISOString())}</strong>.</> : null}</p>
      </>),
      run: async () => {
        await api.patch(`/api/superadmin/orgs/${o.id}/subscription`, { extendTrialDays: days });
        toast("Trial extended");
        await load();
      },
    });
  };

  const cancelSub = (o: SaOrg) => ask({
    title: "Cancel this subscription?",
    label: "Cancel subscription",
    danger: true,
    body: (<>
      <p><strong>{o.name}</strong> will lose subscription access. Cancellation is terminal and
        cannot be restored from this console.</p>
      <p className="sap-dim">This does not delete tenant data or disable individual users.</p>
    </>),
    run: async () => {
      await api.patch(`/api/superadmin/orgs/${o.id}/subscription`, { status: "canceled" });
      toast("Subscription canceled");
      setSelOrgId(null);
      await load();
    },
  });

  const saveCfg = async (key: keyof BillingCfg, value: number | string, input: HTMLInputElement) => {
    if (!cfg) return;
    const num = key === "currency" ? String(value).toUpperCase() : Number(value);
    let valid = key === "currency" ? /^[A-Z]{3}$/.test(String(num))
      : Number.isFinite(num) && Number(num) >= 0;
    if (key !== "currency" && key !== "business_multiplier") valid = valid && Number.isSafeInteger(num);
    if (key === "business_multiplier") valid = Number.isFinite(num) && Number(num) >= 1 && Number(num) <= 10;
    if (key === "trial_months") valid = Number.isInteger(num) && Number(num) >= 0 && Number(num) <= 24;
    if (!valid) {
      input.value = String(cfg[key]);
      setCfgSaved("err");
      toast("Invalid value — previous value restored");
      return;
    }
    if (cfg[key] === num) return;
    try {
      const r = await api.put<{ config: BillingCfg }>("/api/superadmin/billing-config", { [key]: num });
      setCfg(r.config);
      setCfgSaved("ok");
      toast("Pricing updated");
    } catch (e) {
      input.value = String(cfg[key]);
      setCfgSaved("err");
      toast(e instanceof Error ? e.message : "Save failed — value restored");
    }
  };

  /** Save an edited plan — pricing/feature changes hit every workspace on it. */
  const savePlan = (draft: PlanRow) => ask({
    title: `Save ${draft.name} plan`,
    label: "Save plan",
    danger: !draft.active || draft.price_ngn === 0 && draft.slug !== "free",
    body: (<>
      <p>Applies to every workspace on <strong>{draft.name}</strong> — price changes
        affect the next billing period; feature changes apply immediately.</p>
      <ReviewBox rows={[
        ["Base price", `${ngn(draft.price_ngn)} / mo`],
        ["Extra member", draft.member_price_ngn > 0 ? `${ngn(draft.member_price_ngn)} / mo` : "Included"],
        ["AI requests", `${draft.limits?.ai_daily ?? "—"} / user / day`],
        ["Features on", Object.entries(draft.features).filter(([, v]) => v).map(([k]) => k).join(", ") || "—"],
        ["Status", draft.active ? "Buyable" : "Hidden from checkout"],
      ].map(([k, v]) => [k, v]) as [string, ReactNode][]} />
    </>),
    run: async () => {
      const r = await api.put<{ plan: PlanRow }>(`/api/superadmin/plans/${draft.slug}`, {
        name: draft.name, price_ngn: draft.price_ngn, member_price_ngn: draft.member_price_ngn,
        features: draft.features, limits: draft.limits, active: draft.active,
      });
      setPlans((ps) => ps.map((p) => (p.slug === r.plan.slug ? r.plan : p)));
      toast(`${r.plan.name} plan saved`);
      await load();
    },
  });

  const createPlan = () => {
    const slug = newPlan.slug.trim().toLowerCase();
    const name = newPlan.name.trim();
    const price = Number(newPlan.price), member = Number(newPlan.member || "0");
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(slug) || !name || !Number.isInteger(price) || price < 0 || !Number.isInteger(member) || member < 0) {
      toast("Check the plan fields — slug is lowercase letters/digits, prices are whole naira");
      return;
    }
    ask({
      title: `Create ${name} plan`,
      label: "Create plan",
      body: <p>New plans start with no features enabled — toggle them in the editor after creation.</p>,
      run: async () => {
        await api.post("/api/superadmin/plans", { slug, name, price_ngn: price, member_price_ngn: member });
        setNewPlan({ slug: "", name: "", price: "", member: "" });
        setPlanFormOpen(false);
        toast(`${name} plan created`);
        await load();
      },
    });
  };

  const deleteOrgs = (targets: SaOrg[]) => ask({
    title: targets.length === 1 ? `Delete ${targets[0].name}?` : `Delete ${targets.length} workspaces?`,
    label: targets.length === 1 ? "Delete workspace" : `Delete ${targets.length} workspaces`,
    danger: true,
    body: (<>
      <p>This permanently removes {targets.length === 1 ? "this workspace" : "these workspaces"} — every member
        account, file, version, share link, payment and AI record. <strong>This cannot be undone.</strong></p>
      <ReviewBox rows={targets.slice(0, 6).map((o) => [o.name, `${o.seats} seat${o.seats === 1 ? "" : "s"}`])} />
      {targets.length > 6 && <p className="sap-dim">…and {targets.length - 6} more.</p>}
    </>),
    run: async () => {
      if (targets.length === 1) {
        await api.del(`/api/superadmin/orgs/${targets[0].id}`);
        toast(`Deleted ${targets[0].name}`);
      } else {
        const r = await api.post<{ deleted: number }>(
          "/api/superadmin/orgs/delete", { ids: targets.map((o) => o.id) });
        const skipped = targets.length - r.deleted;
        toast(`Deleted ${r.deleted} workspace${r.deleted === 1 ? "" : "s"}${skipped ? ` — ${skipped} skipped` : ""}`);
      }
      setSelected(new Set());
      setSelOrgId(null);
      await load();
    },
  });

  const toggleOrg = (id: string, on: boolean) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAllVisible = () => {
    const ids = visibleOrgs.filter((o) => !o.has_super).map((o) => o.id);
    setSelected((s) => ids.every((id) => s.has(id)) ? new Set() : new Set([...s, ...ids]));
  };
  const selectedOrgs = orgs.filter((o) => selected.has(o.id));

  const toggleMember = (orgId: string, orgName: string, m: SaMember) => {
    const disable = !m.disabled;
    ask({
      title: disable ? "Disable member account" : "Enable member account",
      label: disable ? "Disable account" : "Enable account",
      danger: disable,
      body: (<>
        <p>{disable
          ? <>Blocking sign-in for <strong>{m.email}</strong> in <strong>{orgName}</strong>. Their files and data stay intact; they can't log in until re-enabled.</>
          : <>Restore sign-in for <strong>{m.email}</strong> in <strong>{orgName}</strong>.</>}</p>
        <ReviewBox rows={[["Member", <b key="m">{m.display_name}</b>], ["Email", m.email], ["Role", title(m.role)]]} />
      </>),
      run: async () => {
        await api.post(`/api/superadmin/orgs/${orgId}/members/${m.id}`, { disabled: disable });
        toast(disable ? `${m.display_name} disabled` : `${m.display_name} enabled`);
        setMemberTick((t) => t + 1);
        await load();
      },
    });
  };

  const exportPayments = () => {
    const cell = (v: unknown) => {
      let s = String(v ?? "");
      if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["Payment ID", "Workspace", "Amount NGN", "Method", "Reference", "Plan", "Status", "Received"],
      ...shownPayments.map((p) => [p.id, p.org_name, p.amount_ngn, p.method, p.reference ?? "", p.plan ?? "free", p.status, p.created_at]),
    ];
    const url = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "Kreatix_Payments.csv";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${shownPayments.length} payment${shownPayments.length === 1 ? "" : "s"}`);
  };

  const testEmail = () => {
    const to = emailTo.trim();
    if (!to) return;
    ask({
      title: "Test transactional email",
      label: "Send test",
      body: <p>Request a test email to <strong>{to}</strong>. A successful response verifies request
        acceptance — check the inbox to confirm delivery.</p>,
      run: async () => {
        try {
          const r = await api.post<{ ok: boolean; messageId?: string }>("/api/superadmin/test-email", { to });
          toast(r.ok ? `Test email accepted${r.messageId ? ` (${r.messageId})` : ""}` : "Send request was not accepted");
        } catch (e) {
          const m = e instanceof Error ? e.message : "Test email failed";
          toast(m.includes("disabled") || m.includes("BREVO") || m.includes("503")
            ? "Email is not configured — set KREATIX_BREVO_API_KEY" : m);
        }
      },
    });
  };

  /* ---------- derived views ---------- */

  const pendingCount = ov?.pendingPayments ?? 0;
  const queueTotal = payments.reduce((n, p) => n + p.amount_ngn, 0);
  const shownPayments = ledger ?? payments; // null ledger = pending queue view
  const ledgerTotal = shownPayments.reduce((n, p) => n + p.amount_ngn, 0);
  const aiPct = ai ? Math.min(100, (ai.costUsd / Math.max(1, ai.budgetUsd)) * 100) : 0;
  const fbFiltered = useMemo(
    () => feedback.filter((f) => mood === "all" || f.sentiment === mood), [feedback, mood]);
  const unrepliedBad = feedback.filter((f) => f.sentiment === "bad" && !f.reply).length;
  const auditFiltered = useMemo(() => {
    const s = auditSearch.trim().toLowerCase();
    return (audit ?? []).filter((a) =>
      (auditAction === "all" || a.action === auditAction) &&
      (!s || `${a.actor_email} ${a.target ?? ""} ${a.action}`.toLowerCase().includes(s)));
  }, [audit, auditAction, auditSearch]);
  const auditActions = useMemo(() => [...new Set((audit ?? []).map((a) => a.action))], [audit]);
  const visibleOrgs = useMemo(() => {
    const rows = orgs.filter((o) =>
      o.name.toLowerCase().includes(search.toLowerCase()) &&
      (stateFilter === "all" || o.state === stateFilter) &&
      (planFilter === "all" || (planRow(plans, o.plan)?.slug ?? "free") === planFilter));
    if (sortDir) rows.sort((a, b) => a.name.localeCompare(b.name) * (sortDir === "asc" ? 1 : -1));
    return rows;
  }, [orgs, search, stateFilter, planFilter, sortDir]);
  const selOrg = orgs.find((o) => o.id === selOrgId) ?? null;
  const needsAttention = pendingCount > 0 || aiPct >= 80 || unrepliedBad > 0;

  const exportCsv = () => {
    const cell = (v: unknown) => {
      let s = String(v ?? "");
      if (/^[=+@\-\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["Workspace ID", "Workspace", "Seats", "State", "Plan", "Monthly amount NGN", "Created", "AI token budget override"],
      ...visibleOrgs.map((o) => [o.id, o.name, o.seats, o.state, planRow(plans, o.plan)?.name ?? "Free", o.monthlyAmountNgn, o.created_at, o.ai_token_budget ?? "Plan default"]),
    ];
    const url = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "Kreatix_Workspaces.csv";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Workspace view exported");
  };

  const nav = (id: Section) => {
    setActiveSec(id);
    if (window.location.hash !== `#${id}`) window.location.hash = id;
    document.querySelector(".sap-body")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const gotoBadFeedback = () => { setMood("bad"); nav("feedback"); };

  /* ---------- render ---------- */

  return (
    <div className="sap-page">
      <div className="sap-head">
        <div>
          <div className="sap-eyebrow">Platform operations</div>
          <div className="sap-titleline">
            <h1>Platform</h1>
            <span className="sap-tag"><I n="shield" s={12} /> Superadmin</span>
          </div>
          <p>Every workspace. One clear view of your platform.</p>
        </div>
        <div className="sap-head-actions">
          <span className="sap-refresh-cap">
            Last refreshed
            <b>{refreshedAt ? refreshedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"}</b>
          </span>
          <button className={`btn-secondary sap-btn${refreshing ? " spin" : ""}`} disabled={refreshing}
            onClick={() => void load()}>
            <I n="refresh" s={14} /> Refresh
          </button>
        </div>
      </div>

      {loadErr && (
        <div className="sap-error">
          <I n="alert" s={16} /> {loadErr}
          <button className="btn-secondary sap-btn" onClick={() => void load()}>Retry</button>
        </div>
      )}

      {ov && (
        <div className="sap-kpis">
          <article className="sap-kpi">
            <div className="k-label">Workspaces <I n="building" s={14} /></div>
            <div className="k-value">{ov.orgs}</div>
            <div className="k-sub">{nf.format(ov.users)} total users across tenants</div>
          </article>
          <article className="sap-kpi">
            <div className="k-label">Monthly recurring revenue <I n="trend" s={14} /></div>
            <div className="k-value">{ngn(ov.mrrNgn)}</div>
            <div className="k-sub">{ov.activeSubs} active · {ov.trialing} trialing · {ov.freeTier} free{ov.locked ? ` · ${ov.locked} suspended` : ""}</div>
          </article>
          <article className={`sap-kpi${ov.pendingPayments ? " alert" : ""}`}>
            <div className="k-label">Pending payments <I n="wallet" s={14} /></div>
            <div className="k-value" style={{ color: ov.pendingPayments ? "var(--sap-amber)" : "var(--sap-green)" }}>
              {ov.pendingPayments}
            </div>
            <div className="k-sub">{ov.pendingPayments ? `${ngn(queueTotal)} awaiting review` : "All clear · nothing to review"}</div>
          </article>
          <article className={`sap-kpi${aiPct >= 80 ? " alert" : ""}`}>
            <div className="k-label">AI spend this month <I n="spark" s={14} /></div>
            <div className="k-value">{usd(ai?.costUsd ?? 0)}</div>
            <div className="sap-track" role="progressbar" aria-label="AI budget used"
              aria-valuenow={Math.round(aiPct)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${aiPct}%` }} />
            </div>
            <div className="k-sub">{compact.format(ai?.requests ?? 0)} requests · {compact.format(ai?.tokens ?? 0)} tokens</div>
          </article>
          <article className="sap-kpi">
            <div className="k-label">Feedback · last 30 days <I n="chat" s={14} /></div>
            <div className="k-value">{(stats.good ?? 0) + (stats.ok ?? 0) + (stats.bad ?? 0)}</div>
            <div className="sap-sentiment">
              <span className="g">😊 <b>{stats.good ?? 0}</b></span>
              <span className="o">🙂 <b>{stats.ok ?? 0}</b></span>
              <span className="b">😞 <b>{stats.bad ?? 0}</b></span>
            </div>
          </article>
        </div>
      )}

      <div className="sap-attention">
        <div className="a-left">
          <div className="a-bubble"><I n={needsAttention ? "alert" : "check"} s={16} /></div>
          <div>
            <strong>{needsAttention ? "A few things need your attention" : "You're up to date"}</strong>
            <span> Keep the platform moving.</span>
          </div>
        </div>
        <div className="a-links">
          {pendingCount > 0 && <a href="#payments" onClick={(e) => { e.preventDefault(); nav("payments"); }}>{pendingCount} payment{pendingCount > 1 ? "s" : ""} <I n="arrow" s={12} /></a>}
          {aiPct >= 80 && <a href="#ai-usage" onClick={(e) => { e.preventDefault(); nav("ai-usage"); }}>{aiPct.toFixed(0)}% AI budget used <I n="arrow" s={12} /></a>}
          {unrepliedBad > 0 && <a href="#feedback" onClick={(e) => { e.preventDefault(); gotoBadFeedback(); }}>{unrepliedBad} poor review{unrepliedBad > 1 ? "s" : ""} to reply <I n="arrow" s={12} /></a>}
        </div>
      </div>

      <div className="sap-body">
      <aside className="sap-side">
        <nav className="sap-sidenav" aria-label="Portal sections" role="tablist">
          <span className="sap-sidecap">Console</span>
          {(
            [
              ["payments", "wallet", <>Payments {pendingCount > 0 && <span className="sap-count warn">{pendingCount}</span>}</>],
              ["feedback", "chat", <>Feedback <span className="sap-count">{feedback.length}</span></>],
              ["workspaces", "building", "Workspaces"],
              ["ai-usage", "spark", "AI usage"],
              ["pricing", "settings", <>Plan &amp; pricing</>],
              ["email", "mail", "Email tools"],
              ["history", "clock", "History"],
            ] as [Section, string, ReactNode][]
          ).map(([id, ico, label]) => (
            <a key={id} href={`#${id}`} role="tab" aria-selected={activeSec === id}
              className={activeSec === id ? "active" : ""}
              onClick={(e) => { e.preventDefault(); nav(id); }}>
              <I n={ico} s={15} /><span className="sap-sidelabel">{label}</span>
            </a>
          ))}
        </nav>
      </aside>
      <div className="sap-pane">

      {/* ---------- payments ledger ---------- */}
      <section className="sap-card" id="payments" hidden={activeSec !== "payments"}>
        <div className="sap-cardhead">
          <div>
            <div className="sap-cardtitle"><I n="wallet" s={17} /><h2>Payments</h2><span className="sap-count warn">{pendingCount} pending</span></div>
            <p>Review receipts, activate subscriptions, reconcile the full ledger.</p>
          </div>
          <div className="sap-rowact">
            <span className="sap-tag">{ngn(ledgerTotal)} in view</span>
            <button className="btn-secondary sap-btn sm" onClick={exportPayments} disabled={shownPayments.length === 0}><I n="download" s={13} />Export CSV</button>
          </div>
        </div>
        <div className="sap-filters">
          <div className="sap-tabs" role="group" aria-label="Filter payment status">
            {(["pending", "confirmed", "rejected", "all"] as const).map((s) => (
              <button key={s} className={`sap-pill ${s === payStatus ? "on" : ""}`} aria-pressed={s === payStatus}
                onClick={() => setPayStatus(s)}>
                {title(s)}{" "}<b>{s === "pending" ? pendingCount : s === "all" ? "—" : ""}</b>
              </button>
            ))}
          </div>
          <label className="sap-datefield">From
            <input type="date" value={payFrom} onChange={(e) => setPayFrom(e.target.value)} aria-label="Payments from date" />
          </label>
          <label className="sap-datefield">To
            <input type="date" value={payTo} onChange={(e) => setPayTo(e.target.value)} aria-label="Payments to date" />
          </label>
          {(payFrom || payTo) && (
            <button className="btn-secondary sap-btn sm" onClick={() => { setPayFrom(""); setPayTo(""); }}>Clear dates</button>
          )}
        </div>
        {shownPayments.length === 0 && !ledgerLoading ? (
          <div className="sap-empty"><I n="check" s={18} /><strong>{ledger === null ? "All clear" : "Nothing here"}</strong>
            {ledger === null ? "No payments awaiting review." : "No payments match this filter."}</div>
        ) : (
        <div className="sap-tablewrap"><table className="sap-table">
          <thead><tr><th>Received</th><th>Workspace</th><th className="num">Amount</th><th>Method / reference</th><th>Status</th><th className="num">Review</th></tr></thead>
          <tbody>
            {shownPayments.map((p) => (
              <tr key={p.id}>
                <td><When v={p.created_at} /></td>
                <td><div className="sap-orgcell"><OrgIcon name={p.org_name} /><span><b>{p.org_name}</b><small>{planRow(plans, p.plan)?.name ?? title(p.plan ?? "pro")} plan</small></span></div></td>
                <td className="num" style={{ fontWeight: 600 }}>{ngn(p.amount_ngn)}</td>
                <td className="sap-method"><b>{p.method}</b><span className="mono">{p.reference}</span></td>
                <td><span className={`sap-paystate ${p.status}`}>{title(p.status)}</span></td>
                <td>{p.status === "pending" ? (
                  <div className="sap-rowact">
                    <button className="btn-primary sap-btn sm" disabled={acting} onClick={() => reviewPayment(p, true)}><I n="check" s={13} />Confirm</button>
                    <button className="btn-secondary sap-btn sm" disabled={acting} onClick={() => reviewPayment(p, false)}>Reject</button>
                  </div>
                ) : <span className="sap-dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        )}
        <div className="sap-cardfoot">
          <span><I n="shield" s={13} /> Confirmation activates access and emails a receipt.</span>
          <span>{ledgerLoading ? "Loading…" : `${shownPayments.length} record${shownPayments.length === 1 ? "" : "s"} in view`}</span>
        </div>
      </section>

      {/* ---------- feedback ---------- */}
      <section className="sap-card" id="feedback" hidden={activeSec !== "feedback"}>
        <div className="sap-cardhead">
          <div>
            <div className="sap-cardtitle"><I n="chat" s={17} /><h2>User feedback</h2><span className="sap-count">30 days</span></div>
            <p>Listen across tenants. Reply directly to the people behind the feedback.</p>
          </div>
          <div className="sap-tabs" role="group" aria-label="Filter feedback sentiment">
            {(["all", "good", "ok", "bad"] as const).map((m) => (
              <button key={m} className={`sap-pill ${m}${mood === m ? " on" : ""}`} aria-pressed={mood === m}
                onClick={() => setMood(m)}>
                {m === "all" ? "All" : m === "good" ? "😊 Good" : m === "ok" ? "🙂 Okay" : "😞 Poor"}{" "}
                <b>{m === "all" ? feedback.length : stats[m] ?? 0}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="sap-tablewrap"><table className="sap-table">
          <thead><tr><th>When</th><th>Mood</th><th>From</th><th>Workspace / page</th><th>Message &amp; reply</th></tr></thead>
          <tbody>
            {fbFiltered.length === 0 && (
              <tr><td colSpan={5}><div className="sap-empty"><I n="chat" s={18} /><strong>No feedback in this view</strong>Try another sentiment filter.</div></td></tr>
            )}
            {fbFiltered.map((f) => (
              <tr key={f.id}>
                <td><When v={f.created_at} /></td>
                <td><span className={`sap-mood ${f.sentiment}`}>{f.sentiment === "good" ? "😊 Good" : f.sentiment === "bad" ? "😞 Poor" : "🙂 Okay"}</span></td>
                <td className="sap-from"><b>{f.display_name}</b><small>{f.email}</small></td>
                <td><span className="sap-wsname">{f.org_name}</span><span className="sap-pagepath">{f.page ?? "—"}</span></td>
                <td><div className="sap-msg">
                  {f.message}
                  {f.reply ? (
                    <div className="sap-replied">
                      <b><I n="check" s={12} /> Replied{f.replied_at ? ` · ${dayOf(f.replied_at)}` : ""}</b>
                      {f.reply}
                    </div>
                  ) : (
                    <ReplyForm onSend={(message) => replyTo(f, message)} />
                  )}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="sap-cardfoot">
          <span>Showing {fbFiltered.length} of {feedback.length} submissions</span>
          <span><I n="mail" s={13} /> Replies appear in-app and are emailed</span>
        </div>
      </section>

      {/* ---------- workspaces ---------- */}
      <section className="sap-card" id="workspaces" hidden={activeSec !== "workspaces"}>
        <div className="sap-cardhead">
          <div>
            <div className="sap-cardtitle"><I n="building" s={17} /><h2>Workspaces</h2><span className="sap-count">{orgs.length}</span></div>
            <p>Manage tenant access, subscription tiers and AI allowances.</p>
          </div>
          <button className="btn-secondary sap-btn sm" onClick={exportCsv}><I n="download" s={13} />Export view</button>
        </div>
        <div className="sap-filters">
          <label className="sap-search"><I n="search" s={14} />
            <input type="search" placeholder="Search workspaces…" value={search} aria-label="Search workspace name"
              onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select value={stateFilter} aria-label="Filter workspace state" onChange={(e) => setStateFilter(e.target.value)}>
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="free">Free tier</option>
            <option value="trialing">Trialing</option>
            <option value="locked">Suspended</option>
            <option value="granted">Granted</option>
            <option value="none">No subscription</option>
            <option value="canceled">Canceled</option>
          </select>
          <select value={planFilter} aria-label="Filter plan" onChange={(e) => setPlanFilter(e.target.value)}>
            <option value="all">All plans</option>
            {plans.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
          <span className="sap-hint">Select a workspace to manage access</span>
        </div>
        {selected.size > 0 && (
          <div className="sap-selbar" role="status">
            <b>{selected.size}</b> workspace{selected.size === 1 ? "" : "s"} selected
            <button className="sap-danger sap-btn sm" disabled={acting}
              onClick={() => deleteOrgs(selectedOrgs)}>
              Delete {selected.size > 1 ? `${selected.size} workspaces` : "workspace"}
            </button>
            <button className="sap-link" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        <div className="sap-tablewrap"><table className="sap-table">
          <thead><tr>
            <th className="sap-checkcol"><input type="checkbox" aria-label="Select all visible workspaces"
              checked={visibleOrgs.length > 0 && visibleOrgs.every((o) => o.has_super || selected.has(o.id))}
              ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !visibleOrgs.every((o) => o.has_super || selected.has(o.id)); }}
              onChange={toggleAllVisible} /></th>
            <th>Workspace <button className="sap-sort" aria-label="Toggle workspace name sort"
              onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}>
              {sortDir === "asc" ? "↑" : sortDir === "desc" ? "↓" : "↕"}</button></th>
            <th className="num">Seats</th><th>Access</th><th>Plan</th>
            <th className="num">Monthly price</th><th>Created</th><th className="num">Actions</th>
          </tr></thead>
          <tbody>
            {visibleOrgs.length === 0 && (
              <tr><td colSpan={8}><div className="sap-empty"><I n="search" s={18} /><strong>No workspaces match</strong>Clear the search or change the filters.</div></td></tr>
            )}
            {visibleOrgs.map((o) => (
              <tr key={o.id}>
                <td className="sap-checkcol"><input type="checkbox" aria-label={`Select ${o.name}`}
                  checked={selected.has(o.id)} disabled={!!o.has_super}
                  title={o.has_super ? "Hosts a platform superadmin — cannot be deleted" : undefined}
                  onChange={(e) => toggleOrg(o.id, e.target.checked)} /></td>
                <td>
                  <button className="sap-orglink" onClick={() => setSelOrgId(o.id)} aria-label={`Manage ${o.name}`}>
                    <OrgIcon name={o.name} />
                    <span><b>{o.name}</b><small>{o.id}</small></span>
                  </button>
                </td>
                <td className="num">{o.seats}</td>
                <td><StateBadge s={o.state} /></td>
                <td><span className={`sap-plan ${(planRow(plans, o.plan)?.price_ngn ?? 0) > 0 ? "business" : ""}`}>{planRow(plans, o.plan)?.name ?? "Free"}</span></td>
                <td className="num" style={{ fontWeight: 500 }}>{ngn(o.monthlyAmountNgn)}</td>
                <td className="sap-age">{dayOf(o.created_at)}<small>{Math.max(0, Math.floor((Date.now() - new Date(o.created_at).getTime()) / 86400000))} days ago</small></td>
                <td><div className="sap-rowact">
                  <button className="btn-secondary sap-btn sm" disabled={o.state === "canceled" || acting}
                    onClick={() => compOrg(o)}>+30d comp</button>
                  <button className="sap-iconbtn" aria-label={`Workspace controls for ${o.name}`}
                    onClick={() => setSelOrgId(o.id)}><I n="settings" s={15} /></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="sap-cardfoot">
          <span>Showing {visibleOrgs.length} of {orgs.length} workspaces · prices in {cfg?.currency ?? "NGN"}</span>
          <span>Locked = read-only after the 7-day grace period</span>
        </div>
      </section>

      {/* ---------- AI usage ---------- */}
      <section className="sap-card" id="ai-usage" hidden={activeSec !== "ai-usage"}>
          <div className="sap-cardhead">
            <div>
              <div className="sap-cardtitle"><I n="spark" s={17} /><h2>AI usage by workspace</h2></div>
              <p>{ai ? monthLabel(ai.month) : ""} · ranked by estimated cost</p>
            </div>
            <span className="sap-tag" style={{ color: aiPct >= 80 ? "var(--sap-amber)" : undefined }}>
              {aiPct.toFixed(0)}% of budget
            </span>
          </div>
          <div className="sap-aisum">
            <div>
              <div className="sap-bignum">{usd(ai?.costUsd ?? 0)} <small>/ {usd(ai?.budgetUsd ?? 0)}</small></div>
              <div className="sap-dim" style={{ fontSize: 10 }}>Platform spend this month</div>
            </div>
            <div className="sap-budgetmeter">
              <span>{ai && ai.costUsd > ai.budgetUsd
                ? `${usd(ai.costUsd - ai.budgetUsd)} over budget`
                : `${usd((ai?.budgetUsd ?? 0) - (ai?.costUsd ?? 0))} remaining`}</span>
              <div className="sap-track" role="progressbar" aria-label="Monthly AI budget used"
                aria-valuenow={Math.round(aiPct)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${aiPct}%` }} />
              </div>
              <span>Monthly budget: {usd(ai?.budgetUsd ?? 0)}</span>
            </div>
          </div>
          <div className="sap-tablewrap"><table className="sap-table ai">
            <thead><tr><th>Workspace</th><th className="num">Requests</th><th className="num">Tokens</th><th className="num">Est. USD</th></tr></thead>
            <tbody>
              {(ai?.topOrgs ?? []).slice(0, aiExpanded ? 20 : 5).map((o, i) => (
                <tr key={o.orgId}>
                  <td><div className="sap-orgcell"><span className="sap-rank">{String(i + 1).padStart(2, "0")}</span><b>{o.name}</b></div></td>
                  <td className="num">{nf.format(o.requests)}</td>
                  <td className="num">{compact.format(o.tokens)}</td>
                  <td className="num" style={{ fontWeight: 550 }}>{usd(o.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="sap-cardfoot">
            <span>Showing {Math.min(aiExpanded ? 20 : 5, ai?.topOrgs.length ?? 0)} of {ai?.topOrgs.length ?? 0} workspaces</span>
            {(ai?.topOrgs.length ?? 0) > 5 && (
              <button className="sap-link" onClick={() => setAiExpanded((v) => !v)}>
                {aiExpanded ? "Show top 5" : `Show all ${ai?.topOrgs.length}`}
              </button>
            )}
          </div>
        </section>

      {/* ---------- plans & pricing ---------- */}
      <section className="sap-card" id="pricing" hidden={activeSec !== "pricing"}>
          <div className="sap-cardhead">
            <div>
              <div className="sap-cardtitle"><I n="settings" s={17} /><h2>Plans &amp; pricing</h2><span className="sap-count">{plans.length}</span></div>
              <p>Price, feature gates and usage limits per tier. Feature changes apply immediately — price changes hit the next billing period.</p>
            </div>
            <div className="sap-rowact">
              <span className={`sap-save ${cfgSaved === "err" ? "err" : ""}`} role="status">
                <I n={cfgSaved === "err" ? "alert" : "check"} s={13} /> {cfgSaved === "err" ? "Check value" : "Saved"}
              </span>
              <button className="btn-secondary sap-btn sm" onClick={() => setPlanFormOpen((v) => !v)}>+ New plan</button>
            </div>
          </div>
          {planFormOpen && (
            <div className="sap-newplan">
              <input placeholder="slug (e.g. starter)" value={newPlan.slug} maxLength={40}
                onChange={(e) => setNewPlan({ ...newPlan, slug: e.target.value })} aria-label="Plan slug" />
              <input placeholder="Display name" value={newPlan.name} maxLength={60}
                onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} aria-label="Plan name" />
              <input placeholder="Base ₦/mo" type="number" min={0} value={newPlan.price}
                onChange={(e) => setNewPlan({ ...newPlan, price: e.target.value })} aria-label="Base price" />
              <input placeholder="Extra member ₦/mo" type="number" min={0} value={newPlan.member}
                onChange={(e) => setNewPlan({ ...newPlan, member: e.target.value })} aria-label="Member price" />
              <button className="btn-primary sap-btn sm" onClick={createPlan}>Create</button>
            </div>
          )}
          <div className="sap-plans">
            {plans.map((p) => (
              <PlanEditor key={`${p.slug}-${p.price_ngn}-${p.member_price_ngn}-${JSON.stringify(p.features)}-${JSON.stringify(p.limits)}-${p.active}`}
                plan={p} onSave={savePlan} />
            ))}
          </div>
          {cfg && (
            <div className="sap-settings" style={{ marginTop: 14 }}>
              <CfgField label="Billing currency" hint="ISO currency label; price inputs remain in NGN. No FX conversion.">
                <input type="text" maxLength={3} defaultValue={cfg.currency} key={`cy${cfg.currency}`}
                  onBlur={(e) => void saveCfg("currency", e.target.value, e.target)} />
              </CfgField>
            </div>
          )}
      </section>

      {/* ---------- email tools ---------- */}
      <section className="sap-card sap-email" id="email" hidden={activeSec !== "email"}>
        <div className="sap-emailflex">
          <div>
            <h2>Test transactional email</h2>
            <p>Check the delivery path used by receipts and feedback replies.</p>
          </div>
          <form className="sap-emailform" onSubmit={(e) => { e.preventDefault(); testEmail(); }}>
            <label className="sap-vis-hidden" htmlFor="test-email">Recipient email address</label>
            <input id="test-email" type="email" required maxLength={180} placeholder="you@yourcompany.com"
              autoComplete="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
            <button className="btn-primary sap-btn" type="submit" disabled={acting}><I n="mail" s={13} />Test email</button>
          </form>
        </div>
        <div className="sap-cardfoot">
          <span>Sends via the platform's configured provider (Brevo).</span>
          <span>Acceptance does not confirm delivery — check the inbox.</span>
        </div>
      </section>

      {/* ---------- audit history ---------- */}
      <section className="sap-card" id="history" hidden={activeSec !== "history"}>
        <div className="sap-cardhead">
          <div>
            <div className="sap-cardtitle"><I n="clock" s={17} /><h2>Audit history</h2><span className="sap-count">{audit?.length ?? "—"}</span></div>
            <p>Append-only record of every operator action — who did what, to which workspace, and when.</p>
          </div>
          <button className="btn-secondary sap-btn sm" onClick={refreshAudit}><I n="refresh" s={13} />Refresh</button>
        </div>
        <div className="sap-filters">
          <label className="sap-search"><I n="search" s={14} />
            <input type="search" placeholder="Search actor, workspace, action…" value={auditSearch}
              aria-label="Search audit log" onChange={(e) => setAuditSearch(e.target.value)} />
          </label>
          <select value={auditAction} aria-label="Filter by action" onChange={(e) => setAuditAction(e.target.value)}>
            <option value="all">All actions</option>
            {auditActions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="sap-tablewrap"><table className="sap-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>
            {audit === null && <tr><td colSpan={5}><div className="sap-empty"><strong>Loading…</strong></div></td></tr>}
            {audit !== null && auditFiltered.length === 0 && (
              <tr><td colSpan={5}><div className="sap-empty"><I n="clock" s={18} /><strong>No entries yet</strong>Operator actions are recorded here as they happen.</div></td></tr>
            )}
            {auditFiltered.map((a) => (
              <tr key={a.id}>
                <td><When v={a.created_at} /></td>
                <td className="sap-from"><b>{a.actor_email}</b></td>
                <td><span className={`sap-act ${a.action.split(".")[0]}`}>{a.action}</span></td>
                <td className="sap-wsname">{a.target ?? "—"}</td>
                <td className="sap-detail"><code>{a.detail ?? "—"}</code></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="sap-cardfoot">
          <span><I n="shield" s={13} /> Append-only — entries are never edited or removed.</span>
          <span>Newest 300 entries · shown {auditFiltered.length}</span>
        </div>
      </section>
      </div>{/* .sap-pane */}
      </div>{/* .sap-body */}

      <footer className="sap-bottom">
        <span><I n="shield" s={13} /> Superadmin only · tenant data restricted to this console</span>
        <span>{user?.email}</span>
      </footer>

      {/* ---------- review dialog ---------- */}
      {review && (
        <div className="sap-overlay" onClick={(e) => { if (e.target === e.currentTarget && !acting) setReview(null); }}>
          <div className="sap-dialog" role="dialog" aria-modal="true" aria-labelledby="sap-review-title">
            <div className="sap-modalhead">
              <h2 id="sap-review-title">{review.title}</h2>
              <button className="sap-iconbtn" aria-label="Close review" disabled={acting} onClick={() => setReview(null)}><I n="close" s={15} /></button>
            </div>
            <div className="sap-modalbody">{review.body}</div>
            <div className="sap-modalfoot">
              <button className="btn-secondary sap-btn" disabled={acting} onClick={() => setReview(null)}>Go back</button>
              <button className={`${review.danger ? "sap-danger" : "btn-primary"} sap-btn`} disabled={acting}
                onClick={() => void commit()}>{acting ? "Working…" : review.label}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- workspace drawer ---------- */}
      {selOrg && (
        <div className="sap-overlay right" onClick={(e) => { if (e.target === e.currentTarget && !acting) setSelOrgId(null); }}>
          <div className="sap-drawer" role="dialog" aria-modal="true" aria-labelledby="sap-drawer-title">
            <div className="sap-modalhead">
              <div>
                <div className="sap-eyebrow" style={{ marginBottom: 4 }}>Workspace controls</div>
                <h2 id="sap-drawer-title">Manage workspace</h2>
              </div>
              <button className="sap-iconbtn" aria-label="Close workspace controls" onClick={() => setSelOrgId(null)}><I n="close" s={15} /></button>
            </div>
            <OrgDrawer key={selOrg.id} org={selOrg} tick={memberTick} plans={plans}
              onSave={(plan, budget) => saveOrgSettings(selOrg, plan, budget)}
              onComp={() => compOrg(selOrg)}
              onExtend={(d) => extendTrial(selOrg, d)}
              onCancel={() => cancelSub(selOrg)}
              onDelete={() => deleteOrgs([selOrg])}
              onToggleMember={(m) => toggleMember(selOrg.id, selOrg.name, m)} />
          </div>
        </div>
      )}

      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}

/** Inline reply composer inside a feedback row — reviews before sending. */
function ReplyForm({ onSend }: { onSend: (message: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form className="sap-replyline" onSubmit={(e) => { e.preventDefault(); const m = v.trim(); if (m) onSend(m); }}>
      <textarea placeholder="Write a helpful reply…" required maxLength={2000} rows={2}
        value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn-secondary sap-btn sm" type="submit" disabled={!v.trim()}>
        Reply <I n="arrow" s={12} />
      </button>
    </form>
  );
}

/** Pricing field with a currency/unit prefix. */
function CfgField({ label, hint, unit, unitAfter, full, children }: {
  label: string; hint: string; unit?: string; unitAfter?: boolean; full?: boolean; children: ReactNode;
}) {
  return (
    <div className={`sap-setting${full ? " full" : ""}`}>
      <label>{label}</label>
      <div className="sap-inputunit">
        {!unitAfter && unit && <span>{unit}</span>}
        {children}
        {unitAfter && unit && <span>{unit}</span>}
      </div>
      <small>{hint}</small>
    </div>
  );
}

/** Workspace management drawer — plan tier, AI budget override, trial extension, cancel. */
const FEATURE_KEYS: [string, string][] = [
  ["ai", "Kreatix AI"],
  ["export", "All export formats"],
  ["pdf_sign", "PDF signature"],
  ["pdf_edit", "PDF text/object editing"],
  ["share_protect", "Protected share links"],
  ["sso", "SSO (SAML/OIDC)"],
  ["scim", "SCIM provisioning"],
  ["priority_support", "Priority support"],
];
const LIMIT_KEYS: [string, string][] = [
  ["ai_daily", "AI requests / user / day"],
  ["ai_per_min", "AI requests / user / min"],
  ["ai_tokens_base", "AI tokens / mo (base)"],
  ["ai_tokens_per_seat", "AI tokens / mo (extra seat)"],
  ["storage_mb", "Storage (MB)"],
  ["max_members", "Max members (0 = ∞)"],
  ["version_days", "Version history days (0 = ∞)"],
];

/** Plan card editor — price, member price, feature toggles, numeric limits. */
function PlanEditor({ plan, onSave }: { plan: PlanRow; onSave: (draft: PlanRow) => void }) {
  const [price, setPrice] = useState(String(plan.price_ngn));
  const [member, setMember] = useState(String(plan.member_price_ngn));
  const [name, setName] = useState(plan.name);
  const [feats, setFeats] = useState<Record<string, boolean>>({ ...plan.features });
  const [lims, setLims] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(plan.limits ?? {}).map(([k, v]) => [k, String(v)])));
  const [active, setActive] = useState(plan.active);
  const isFree = plan.slug === "free";
  const p = Number(price), m = Number(member);
  const valid = name.trim().length > 0 && Number.isInteger(p) && p >= 0 && Number.isInteger(m) && m >= 0
    && (!isFree || (p === 0 && m === 0));
  const dirty = name !== plan.name || p !== plan.price_ngn || m !== plan.member_price_ngn
    || active !== plan.active || JSON.stringify(feats) !== JSON.stringify(plan.features)
    || Object.entries(lims).some(([k, v]) => Number(v) !== (plan.limits?.[k] ?? NaN));

  return (
    <div className={`sap-plancard${active ? "" : " off"}`}>
      <div className="sap-planhead">
        <input className="sap-planname" value={name} maxLength={60} aria-label="Plan name"
          onChange={(e) => setName(e.target.value)} />
        <code className="sap-planslug">{plan.slug}</code>
        {isFree && <span className="sap-tag">Default tier</span>}
      </div>
      <div className="sap-planpricing">
        <label>Base ₦ / month
          <input type="number" min={0} step={1} value={price} disabled={isFree}
            onChange={(e) => setPrice(e.target.value)} aria-label="Base price per month" />
        </label>
        <label>+ per member ₦ / month
          <input type="number" min={0} step={1} value={member} disabled={isFree}
            onChange={(e) => setMember(e.target.value)} aria-label="Price per additional member" />
        </label>
      </div>
      <div className="sap-planexample">
        {p === 0 && m === 0 ? "Free forever" :
          `3-seat workspace pays ${ngn(p + m * 2)} / mo`}
      </div>
      <div className="sap-planfeats">
        {FEATURE_KEYS.map(([k, label]) => (
          <label key={k} className="sap-feat">
            <input type="checkbox" checked={!!feats[k]}
              onChange={(e) => setFeats({ ...feats, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </div>
      <details className="sap-planlimits">
        <summary>Usage limits</summary>
        <div className="sap-limgrid">
          {LIMIT_KEYS.map(([k, label]) => (
            <label key={k}>
              <span>{label}</span>
              <input type="number" min={0} step={1} value={lims[k] ?? ""} placeholder="—"
                onChange={(e) => setLims({ ...lims, [k]: e.target.value })} aria-label={label} />
            </label>
          ))}
        </div>
      </details>
      <div className="sap-planfoot">
        <label className="sap-feat">
          <input type="checkbox" checked={active} disabled={isFree}
            onChange={(e) => setActive(e.target.checked)} />
          Buyable
        </label>
        <button className="btn-primary sap-btn sm" disabled={!dirty || !valid}
          onClick={() => onSave({
            ...plan, name: name.trim(), price_ngn: p, member_price_ngn: m, active,
            features: feats,
            limits: Object.fromEntries(Object.entries(lims).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)])),
          })}>
          Save plan
        </button>
      </div>
    </div>
  );
}

function OrgDrawer({ org, tick, plans, onSave, onComp, onExtend, onCancel, onDelete, onToggleMember }: {
  org: SaOrg;
  tick: number;
  plans: PlanRow[];
  onSave: (plan: string, budget: number | null) => void;
  onComp: () => void;
  onExtend: (days: number) => void;
  onCancel: () => void;
  onDelete: () => void;
  onToggleMember: (m: SaMember) => void;
}) {
  const [plan, setPlan] = useState(org.plan === "standard" ? "pro" : org.plan ?? "free");
  const [tokens, setTokens] = useState(org.ai_token_budget == null ? "" : String(org.ai_token_budget));
  const [days, setDays] = useState("30");
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const preview = { ...org, plan };
  const pa = planRow(plans, plan);

  useEffect(() => {
    let dead = false;
    setDetailErr(null);
    api.get<OrgDetail>(`/api/superadmin/orgs/${org.id}/detail`)
      .then((d) => { if (!dead) setDetail(d); })
      .catch((e) => { if (!dead) setDetailErr(e instanceof Error ? e.message : "Detail load failed"); });
    return () => { dead = true; };
  }, [org.id, tick]);

  return (
    <div className="sap-drawerbody">
      <div className="sap-drawertitle">
        <OrgIcon name={org.name} />
        <div><h3>{org.name}</h3><small>{org.id} · Created {dateOf(org.created_at)}</small></div>
      </div>
      <div className="sap-details">
        <div><label>Access state</label><StateBadge s={org.state} /></div>
        <div><label>Enabled seats</label><strong>{org.seats}</strong></div>
        <div><label>Monthly price</label><strong>{ngn(org.monthlyAmountNgn)}</strong></div>
        <div><label>Paid period ends</label><strong>{dateOf(org.period_end)}</strong></div>
        <div><label>Trial ends</label><strong>{dateOf(org.trial_ends_at)}</strong></div>
        <div><label>Comped until</label><strong>{dateOf(org.override_until)}</strong></div>
      </div>

      <div className="sap-dsection">
        <h4>Plan &amp; AI allowance</h4>
        <form onSubmit={(e) => {
          e.preventDefault();
          const raw = tokens.trim();
          const budget = raw === "" ? null : Number(raw);
          if (budget !== null && (!Number.isSafeInteger(budget) || budget < 0)) return;
          onSave(plan, budget);
        }}>
          <div className="sap-field">
            <label htmlFor="sap-org-plan">Subscription tier</label>
            <select id="sap-org-plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {plans.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
            <small>Tier determines price and AI allowance on the next billing period.</small>
          </div>
          <div className="sap-allowance">
            Plan default: <b>{compact.format(allowance(plans, preview))} tokens / month</b><br />
            {(pa?.limits?.ai_daily ?? 0).toLocaleString()} requests / day / user
          </div>
          <div className="sap-field">
            <label htmlFor="sap-org-budget">Monthly AI token budget override</label>
            <input id="sap-org-budget" type="number" min={0} step={1} placeholder="Use plan default"
              value={tokens} onChange={(e) => setTokens(e.target.value)} />
            <small>Blank = plan default. 0 = zero token allowance.</small>
          </div>
          <button className="btn-primary sap-btn" type="submit">Save workspace settings</button>
        </form>
      </div>

      <div className="sap-dsection">
        <h4>Access controls</h4>
        <p className="sap-dim">Comped access uses an override. Trial extensions apply to the trial's end date.</p>
        <button className="btn-secondary sap-btn" disabled={org.state === "canceled"} onClick={onComp}>
          +30 days complimentary access
        </button>
        {org.trial_ends_at && (
          <form className="sap-trialext" onSubmit={(e) => {
            e.preventDefault();
            const d = Number(days);
            if (Number.isInteger(d) && d >= 1 && d <= 730) onExtend(d);
          }}>
            <input type="number" min={1} max={730} value={days} aria-label="Days to extend"
              onChange={(e) => setDays(e.target.value)} />
            <button className="btn-secondary sap-btn" type="submit">Extend trial</button>
          </form>
        )}
      </div>

      {detailErr ? (
        <div className="sap-dsection"><p className="sap-dim">Workspace details failed to load: {detailErr}</p></div>
      ) : !detail ? (
        <div className="sap-dsection"><p className="sap-dim">Loading workspace details…</p></div>
      ) : (<>
        <div className="sap-dsection">
          <h4>Workspace activity</h4>
          <div className="sap-details">
            <div><label>Files</label><strong>{nf.format(detail.usage.files)}</strong></div>
            <div><label>Storage</label><strong>{fmtBytes(detail.usage.bytes)}</strong></div>
            <div><label>Versions</label><strong>{nf.format(detail.usage.versions)}</strong></div>
            <div><label>Comments</label><strong>{nf.format(detail.usage.comments)}</strong></div>
            <div><label>AI this month</label><strong>{compact.format(detail.ai.tokens)} tok</strong></div>
            <div><label>AI cost</label><strong>{usd(detail.ai.costUsd)}</strong></div>
            <div><label>Feedback sent</label><strong>{detail.feedbackCount}</strong></div>
            <div><label>AI requests</label><strong>{nf.format(detail.ai.requests)}</strong></div>
          </div>
        </div>

        <div className="sap-dsection">
          <h4>Members <span className="sap-count">{detail.members.length}</span></h4>
          <div className="sap-members">
            {detail.members.map((m) => (
              <div key={m.id} className={`sap-member${m.disabled ? " off" : ""}`}>
                <span className="sap-orgicon sm">{m.initials ?? initials(m.display_name)}</span>
                <div className="sap-memberinfo">
                  <b>{m.display_name}{m.is_super && <span className="sap-tag warn" style={{ marginLeft: 6 }}>super</span>}</b>
                  <small>{m.email}</small>
                </div>
                <div className="sap-membermeta">
                  <span className="sap-dim">{title(m.role)}</span>
                  <span className="sap-dim">{m.last_active ? <When v={m.last_active} /> : "never active"}</span>
                </div>
                {!m.is_super && (
                  <button className={`${m.disabled ? "btn-secondary" : "sap-danger"} sap-btn sm`}
                    onClick={() => onToggleMember(m)}>
                    {m.disabled ? "Enable" : "Disable"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {detail.payments.length > 0 && (
          <div className="sap-dsection">
            <h4>Payment history</h4>
            <div className="sap-members">
              {detail.payments.map((p) => (
                <div key={p.id} className="sap-member">
                  <div className="sap-memberinfo">
                    <b>{ngn(p.amount_ngn)}</b>
                    <small>{p.method}{p.reference ? ` · ${p.reference}` : ""}</small>
                  </div>
                  <div className="sap-membermeta">
                    <span className={`sap-paystate ${p.status}`}>{title(p.status)}</span>
                    <span className="sap-dim"><When v={p.created_at} /></span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </>)}

      <div className="sap-dsection sap-dangerzone">
        <h4>Danger zone</h4>
        <p className="sap-dim">Canceling ends subscription access for the whole workspace.</p>
        <button className="sap-danger sap-btn" disabled={org.state === "canceled"} onClick={onCancel}>
          Cancel subscription
        </button>
        {org.has_super ? (
          <p className="sap-dim"><I n="shield" s={12} /> This workspace hosts a platform superadmin
            account and cannot be deleted.</p>
        ) : (
          <button className="sap-danger sap-btn" onClick={onDelete}>Delete workspace permanently</button>
        )}
      </div>
    </div>
  );
}
