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
  /** Workspace name when the mail is about a workspace — replaces the Kreatix sender label. */
  senderName?: string;
  subject: string;
  html: string;
  text?: string;
  attachment?: { name: string; content: string /* base64 */ }[];
}

export async function sendMail(m: Mail): Promise<{ ok: boolean; messageId?: string }> {
  const res = await fetch(`${BREVO}/smtp/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": process.env.KREATIX_BREVO_API_KEY!,
    },
    body: JSON.stringify({
      sender: { ...sender(), ...(m.senderName ? { name: m.senderName } : {}) },
      to: [{ email: m.to, ...(m.toName ? { name: m.toName } : {}) }],
      subject: m.subject,
      htmlContent: m.html,
      ...(m.text ? { textContent: m.text } : {}),
      ...(m.attachment?.length ? { attachment: m.attachment } : {}),
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

function shell(title: string, body: string, brand = "Kreatix Suites"): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f7;font-family:Inter,Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8e8ea">
<tr><td style="background:#1c1c1e;padding:20px 28px">
  <span style="display:inline-block;background:#F2782E;color:#fff;font-weight:700;font-size:13px;border-radius:6px;padding:4px 8px;margin-right:8px">${esc(brand.charAt(0).toUpperCase())}</span>
  <span style="color:#fff;font-weight:600;font-size:15px;letter-spacing:.2px">${esc(brand)}</span>
</td></tr>
<tr><td style="padding:28px;color:#1c1c1e;font-size:14px;line-height:1.6">
<h1 style="margin:0 0 14px;font-size:18px;font-weight:700">${title}</h1>
${body}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;color:#8a8a90;font-size:12px">
${brand === "Kreatix Suites" ? `${esc(brand)} · <a href="${publicUrl()}" style="color:#F2782E;text-decoration:none">${publicUrl().replace(/^https?:\/\//, "")}</a>` : esc(brand)}
</td></tr>
</table></td></tr></table></body></html>`;
}

const btn = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#F2782E;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;padding:11px 22px;margin:14px 0 4px">${label}</a>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const tpl = {
  systemAlert(lines: string[]): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      subject: `[Kreatix] Health alert — ${lines.length} check${lines.length > 1 ? "s" : ""} degraded`,
      html: shell("System health alert", `
<p>The hourly health sweep found issues on your Kreatix Suites instance:</p>
<ul>${lines.map((l) => `<li style="font-family:monospace;font-size:13px;margin:4px 0">${esc(l)}</li>`).join("")}</ul>
${btn(`${publicUrl()}/admin`, "Open Admin → Health")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Repeated alerts for the same check are throttled to once every 6 hours.</p>`),
    };
  },

  welcome(name: string, workspace: string, kind = "business"): Pick<Mail, "subject" | "html" | "senderName"> {
    const space = kind === "family" ? "family space" : kind === "personal" ? "account" : "workspace";
    const brand = kind === "business" ? workspace : undefined;
    return {
      ...(brand ? { senderName: brand } : {}),
      subject: brand ? `Welcome to ${brand}` : "Welcome to Kreatix Suites",
      html: shell("Welcome aboard", `
<p>Hi ${esc(name)},</p>
<p>Your ${space} <b>${esc(workspace)}</b> is ready — documents, spreadsheets, presentations, files, mail and AI, all in one place. Your <b>3-month free trial</b> starts now.</p>
${btn(publicUrl(), brand ? `Open ${esc(brand)}` : "Open Kreatix Suites")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">${kind === "family" ? "Invite your family anytime from Admin → Members." : "Invite your team anytime from Admin → Members."}</p>`, brand),
    };
  },

  joinedWorkspace(name: string, workspace: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `You've joined ${workspace}`,
      html: shell(`Welcome to ${esc(workspace)}`, `
<p>Hi ${esc(name)},</p>
<p>You've joined <b>${esc(workspace)}</b> — open it to start working with your team.</p>
${btn(publicUrl(), `Open ${esc(workspace)}`)}`, workspace),
    };
  },

  invite(workspace: string, inviter: string, token: string): Pick<Mail, "subject" | "html" | "senderName"> {
    const link = `${publicUrl()}/register?invite=${encodeURIComponent(token)}`;
    return {
      senderName: workspace,
      subject: `${inviter} invited you to ${workspace}`,
      html: shell(`Join ${esc(workspace)}`, `
<p><b>${esc(inviter)}</b> invited you to collaborate in <b>${esc(workspace)}</b>.</p>
${btn(link, "Accept invitation")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Or paste this link: ${link}<br>This invite expires — contact your workspace admin if it lapses.</p>`, workspace),
    };
  },

  /** Ownership proof before a join request is queued — the requester has
   *  no account, so a 6-digit code stands in for password verification. */
  joinRequestCode(requesterName: string, workspace: string, code: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `${code} — your code to request joining ${workspace}`,
      html: shell("Your join-request code", `
<p>Hi ${esc(requesterName)},</p>
<p>You asked to join <b>${esc(workspace)}</b>. Enter this code to send the request:</p>
<p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:18px 0">${esc(code)}</p>
<p style="color:#8a8a90;font-size:12px">It expires in 15 minutes. If you didn't request this, ignore it — no request was sent.</p>`, workspace),
    };
  },

  /** A public "request to join" landed — sent to the org's owners/admins. */
  joinRequestAdmin(workspace: string, requesterName: string, requesterEmail: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `Join request — ${requesterName} wants to join ${workspace}`,
      html: shell("Join request", `
<p><b>${esc(requesterName)}</b> (${esc(requesterEmail)}) asked to join <b>${esc(workspace)}</b>.</p>
${btn(`${publicUrl()}/admin`, "Review in Admin → Members")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Approve to send them an invite link, or decline to dismiss the request.</p>`, workspace),
    };
  },

  /** Join request approved — fresh accounts get a one-time invite link. */
  joinApprovedInvite(workspace: string, token: string): Pick<Mail, "subject" | "html" | "senderName"> {
    const link = `${publicUrl()}/register?invite=${encodeURIComponent(token)}`;
    return {
      senderName: workspace,
      subject: `You're in — create your ${workspace} account`,
      html: shell(`Welcome to ${esc(workspace)}`, `
<p>Your request to join <b>${esc(workspace)}</b> was approved.</p>
${btn(link, "Create your account")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Or paste this link: ${link}<br>This is a one-time link — create your account to join ${esc(workspace)}.</p>`, workspace),
    };
  },

  /** Approved, but the requester's existing account has files — a silent org
   *  move would strand them, so we ask the admin to coordinate. */
  joinRequestNeedsTransfer(workspace: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `Your request to join ${workspace} was approved`,
      html: shell(`Welcome to ${esc(workspace)}`, `
<p>Your request to join <b>${esc(workspace)}</b> was approved.</p>
<p>You already have an account with files in another space, so your admin will arrange the transfer — keep an eye out for their invite.</p>
${btn(publicUrl(), `Open ${esc(workspace)}`)}`, workspace),
    };
  },

  /** Join request approved and the existing account was moved in directly. */
  joinApprovedMember(workspace: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `You're now a member of ${workspace}`,
      html: shell(`Welcome to ${esc(workspace)}`, `
<p>Your request to join <b>${esc(workspace)}</b> was approved and your account is now part of the workspace.</p>
${btn(publicUrl(), `Open ${esc(workspace)}`)}`, workspace),
    };
  },

  paymentReceipt(workspace: string, amountNgn: number, seats: number, months: number, periodEnd: string): Pick<Mail, "subject" | "html" | "senderName"> {
    const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return {
      senderName: workspace,
      subject: `Payment confirmed — ${workspace}`,
      html: shell("Payment confirmed", `
<p>Your subscription payment for <b>${esc(workspace)}</b> is confirmed.</p>
<table style="font-size:14px;border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Amount</td><td><b>${ngn(amountNgn)}</b></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Seats</td><td>${seats}</td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Period</td><td>${months} month${months > 1 ? "s" : ""} — until ${new Date(periodEnd).toDateString()}</td></tr>
</table>
${btn(`${publicUrl()}/admin`, "View billing")}`, workspace),
    };
  },

  trialEnding(workspace: string, daysLeft: number, amountNgn: number): Pick<Mail, "subject" | "html" | "senderName"> {
    const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;
    return {
      senderName: workspace,
      subject: `Your ${workspace} trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      html: shell("Trial ending soon", `
<p>The free trial for <b>${esc(workspace)}</b> ends in <b>${daysLeft} day${daysLeft === 1 ? "" : "s"}</b>.</p>
<p>To keep full access, subscribe at <b>${ngn(amountNgn)}/month</b> — after a 7-day grace period the workspace becomes read-only.</p>
${btn(`${publicUrl()}/admin`, "Subscribe now")}`, workspace),
    };
  },

  aiBudgetWarning(workspace: string, pct: number): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      senderName: workspace,
      subject: `${workspace} is nearing its AI usage budget`,
      html: shell("AI budget almost reached", `
<p><b>${esc(workspace)}</b> has used <b>${pct}%</b> of its monthly AI credit budget.</p>
<p>AI features pause at 100% and reset on the 1st of next month — files are never affected.</p>
${btn(`${publicUrl()}/admin`, "View usage")}`, workspace),
    };
  },

  feedbackReply(name: string, message: string, reply: string): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      subject: "Re: your feedback — Kreatix Suites",
      html: shell("We replied to your feedback", `
<p>Hi ${esc(name)},</p>
<p>Thanks for telling us:</p>
<blockquote style="border-left:3px solid #F2782E;margin:10px 0;padding:6px 14px;color:#555;background:#fafafa">${esc(message)}</blockquote>
<p>${esc(reply)}</p>
${btn(publicUrl(), "Open Kreatix Suites")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Reply anytime from the feedback bubble in the app — this thread stays open.</p>`),
    };
  },

  /** Calendar invite/cancel — accompanies a text/calendar .ics attachment.
   *  `rsvp` adds one-click Accept/Maybe/Decline links (signed per-recipient). */
  meetingInvite(organizer: string, title: string, when: string, location: string | null, meet: boolean, cancelled: boolean,
    rsvp?: { accept: string; maybe: string; decline: string }): Pick<Mail, "subject" | "html" | "senderName"> {
    return {
      subject: `${cancelled ? "Cancelled: " : "Invitation: "}${title}`,
      html: shell(cancelled ? "Meeting cancelled" : "You're invited", `
<p><b>${esc(organizer)}</b> ${cancelled ? "cancelled" : "invited you to"} <b>${esc(title)}</b>.</p>
<table style="font-size:14px;border-collapse:collapse;margin:8px 0">
<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">When</td><td><b>${esc(when)}</b></td></tr>
${location ? `<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Where</td><td><b>${esc(location)}</b></td></tr>` : ""}
${meet ? `<tr><td style="padding:4px 16px 4px 0;color:#8a8a90">Call</td><td><b>Meet</b> — join from the event</td></tr>` : ""}
</table>
${cancelled ? `<p>This event has been removed from your calendar. Open the attached file to clear it in external calendars.</p>` : `<p>The attached <code>.ics</code> file adds this to Outlook/Apple/Google calendars — your Kreatix calendar already has it.</p>`}
${!cancelled && rsvp ? `<p style="margin:18px 0 4px">Respond:
  <a href="${rsvp.accept}" style="color:#16a34a;font-weight:600">Accept</a> ·
  <a href="${rsvp.maybe}" style="color:#d97706;font-weight:600">Maybe</a> ·
  <a href="${rsvp.decline}" style="color:#dc2626;font-weight:600">Decline</a></p>` : ""}
${btn(`${publicUrl()}/calendar`, "Open Calendar")}`),
    };
  },

  passwordReset(name: string, token: string): Pick<Mail, "subject" | "html" | "senderName"> {
    const link = `${publicUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    return {
      subject: "Reset your Kreatix Suites password",
      html: shell("Password reset", `
<p>Hi ${esc(name)},</p>
<p>We got a request to reset your password. This link works for <b>1 hour</b>:</p>
${btn(link, "Reset password")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">If you didn't ask for this, ignore this email — your password stays unchanged.</p>`),
    };
  },

  verifyEmail(name: string, token: string): Pick<Mail, "subject" | "html" | "senderName"> {
    const link = `${publicUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    return {
      subject: "Verify your email — Kreatix Suites",
      html: shell("Verify your email", `
<p>Hi ${esc(name)},</p>
<p>Confirm this email address belongs to you — it unlocks email notifications and account recovery:</p>
${btn(link, "Verify email")}
<p style="color:#8a8a90;font-size:12px;margin-top:22px">This link expires in 24 hours.</p>`),
    };
  },

  workspaceLocked(workspace: string, amountNgn: number): Pick<Mail, "subject" | "html" | "senderName"> {
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
