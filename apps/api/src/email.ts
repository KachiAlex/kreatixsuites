// Transactional email via Brevo (https://api.brevo.com/v3/smtp/email).
// Enabled when KREATIX_BREVO_API_KEY is set; every call site is fire-and-forget
// so a mail outage can never break auth, billing, or registration.
import { q } from "./db.js";

const BREVO = "https://api.brevo.com/v3";

export const mailEnabled = () => !!process.env.KREATIX_BREVO_API_KEY;

const sender = () => ({
  email: process.env.KREATIX_MAIL_FROM || "hello@kreatixtech.com",
  name: process.env.KREATIX_MAIL_FROM_NAME || "Kreatix Suites",
});

export const publicUrl = () =>
  (process.env.KREATIX_PUBLIC_URL || "https://suites.kreatixtech.com").replace(/\/$/, "");

interface Mail {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendMail(m: Mail): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch(`${BREVO}/smtp/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": process.env.KREATIX_BREVO_API_KEY!,
    },
    body: JSON.stringify({
      sender: sender(),
      to: [{ email: m.to, ...(m.toName ? { name: m.toName } : {}) }],
      subject: m.subject,
      htmlContent: m.html,
      ...(m.text ? { textContent: m.text } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true, messageId: (await res.json() as { messageId?: string }).messageId };
}

/** Fire-and-forget — logs failures, never throws into request paths. */
export function sendMailSafe(log: { warn: (obj: unknown, msg: string) => void }, m: Mail) {
  if (!mailEnabled()) return;
  sendMail(m).catch((e) => log.warn({ err: String(e), to: m.to }, "email send failed"));
}

/** Emails of a workspace's owner + admins — billing/lock notices go here. */
export async function orgAdminRecipients(orgId: string): Promise<{ email: string; name: string }[]> {
  const rows = await q<{ email: string; display_name: string }>(
    "SELECT email, display_name FROM users WHERE org_id = $1 AND role IN ('owner','admin') AND NOT disabled",
    [orgId]);
  return rows.map((r) => ({ email: r.email, name: r.display_name }));
}

// ---- templates — minimal branded wrapper, Kreatix orange ----

function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f7;font-family:Inter,Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8e8ea">
<tr><td style="background:#1c1c1e;padding:20px 28px">
  <span style="display:inline-block;background:#F2782E;color:#fff;font-weight:700;font-size:13px;border-radius:6px;padding:4px 8px;margin-right:8px">K</span>
  <span style="color:#fff;font-weight:600;font-size:15px;letter-spacing:.2px">Kreatix Suites</span>
</td></tr>
<tr><td style="padding:28px;color:#1c1c1e;font-size:14px;line-height:1.6">
<h1 style="margin:0 0 14px;font-size:18px;font-weight:700">${title}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;color:#8a8a90;font-size:12px">
Kreatix Suites · <a href="${publicUrl()}" style="color:#F2782E;text-decoration:none">${publicUrl().replace(/^https?:\/\//, "")}</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#F2782E;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;padding:11px 22px;margin:14px 0 4px">${label}</a>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const tpl = {
  welcome(name: string, workspace: string): Pick<Mail, "subject" | "html"> {
    return {
      subject: "Welcome to Kreatix Suites",
      html: shell("Welcome aboard", `
<p>Hi ${esc(name)},</p>
<p>Your workspace <b>${esc(workspace)}</b> is ready — Writer, Sheets, Present, PDF, Drive and Kreatix AI, all in one place. Your <b>3-month free trial</b> starts now.</p>
${btn(publicUrl(), "Open your workspace")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Invite your team anytime from Admin → Members.</p>`),
    };
  },

  joinedWorkspace(name: string, workspace: string): Pick<Mail, "subject" | "html"> {
    return {
      subject: `You've joined ${workspace} on Kreatix Suites`,
      html: shell(`Welcome to ${esc(workspace)}`, `
<p>Hi ${esc(name)},</p>
<p>You've joined <b>${esc(workspace)}</b> — open Kreatix Suites to start working with your team.</p>
${btn(publicUrl(), "Open Kreatix Suites")}`),
    };
  },

  invite(workspace: string, inviter: string, token: string): Pick<Mail, "subject" | "html"> {
    const link = `${publicUrl()}/register?invite=${encodeURIComponent(token)}`;
    return {
      subject: `${inviter} invited you to ${workspace} on Kreatix Suites`,
      html: shell(`Join ${esc(workspace)}`, `
<p><b>${esc(inviter)}</b> invited you to collaborate in <b>${esc(workspace)}</b> on Kreatix Suites.</p>
${btn(link, "Accept invitation")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Or paste this link: ${link}<br>This invite expires — contact your workspace admin if it lapses.</p>`),
    };
  },

  paymentReceipt(workspace: string, amountNgn: number, seats: number, months: number, periodEnd: string): Pick<Mail, "subject" | "html"> {
    const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return {
      subject: `Payment confirmed — ${workspace}`,
      html: shell("Payment confirmed", `
<p>Your subscription payment for <b>${esc(workspace)}</b> is confirmed.</p>
<table style="font-size:14px;border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Amount</td><td><b>${ngn(amountNgn)}</b></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Seats</td><td>${seats}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Period</td><td>${months} month${months > 1 ? "s" : ""} — until ${new Date(periodEnd).toDateString()}</td></tr>
</table>
${btn(`${publicUrl()}/admin`, "View billing")}`),
    };
  },

  trialEnding(workspace: string, daysLeft: number, amountNgn: number): Pick<Mail, "subject" | "html"> {
    const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return {
      subject: `Your ${workspace} trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      html: shell("Trial ending soon", `
<p>The free trial for <b>${esc(workspace)}</b> ends in <b>${daysLeft} day${daysLeft === 1 ? "" : "s"}</b>.</p>
<p>To keep full access, subscribe at <b>${ngn(amountNgn)}/month</b> — after a 7-day grace period the workspace becomes read-only.</p>
${btn(`${publicUrl()}/admin`, "Subscribe now")}`),
    };
  },

  workspaceLocked(workspace: string, amountNgn: number): Pick<Mail, "subject" | "html"> {
    const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return {
      subject: `${workspace} is now read-only`,
      html: shell("Workspace locked", `
<p>The subscription for <b>${esc(workspace)}</b> has expired and the workspace is now <b>read-only</b>. Your files are safe — nothing is deleted.</p>
<p>Renew at <b>${ngn(amountNgn)}/month</b> to restore full access for your team.</p>
${btn(`${publicUrl()}/admin`, "Renew subscription")}`),
    };
  },
};
