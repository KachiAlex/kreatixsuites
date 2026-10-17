// Recurrence + iCalendar (.ics) helpers for Kreatix Calendar.
// RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (weekly), BYMONTHDAY (monthly). Stored on calendar_events.rrule
// without the "RRULE:" prefix.

export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: Date;
  byDay?: string[];          // MO,TU,WE,TH,FR,SA,SU
  byMonthDay?: number;
}

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRRule(s: string | null | undefined): RRule | null {
  if (!s) return null;
  const parts: Record<string, string> = {};
  for (const kv of s.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) parts[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = parts.FREQ as RRule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const rr: RRule = { freq, interval: Math.max(1, parseInt(parts.INTERVAL ?? "1", 10) || 1) };
  if (parts.COUNT) rr.count = Math.min(400, parseInt(parts.COUNT, 10) || 0);
  if (parts.UNTIL) {
    const u = parseICalDate(parts.UNTIL);
    if (u) rr.until = u;
  }
  if (parts.BYDAY) rr.byDay = parts.BYDAY.split(",").filter((d) => d in DAYS);
  if (parts.BYMONTHDAY) rr.byMonthDay = parseInt(parts.BYMONTHDAY, 10) || undefined;
  return rr;
}

/** Expand occurrences of (start,duration,rrule) into [lo,hi]. Returns start Dates. */
export function expandOccurrences(start: Date, rrule: RRule, lo: Date, hi: Date, cap = 400): Date[] {
  const out: Date[] = [];
  const push = (d: Date) => {
    if (rrule.until && d > rrule.until) return false;
    if (d >= lo && d < hi) out.push(new Date(d));
    return d < hi;
  };

  let n = 0;
  const hitCap = () => ++n > (rrule.count ?? cap) || out.length >= cap;

  if (rrule.freq === "DAILY") {
    const step = rrule.interval * 864e5;
    for (let t = start.getTime(); t < hi.getTime() + 864e5; t += step) {
      if (hitCap() || !push(new Date(t))) break;
    }
  } else if (rrule.freq === "WEEKLY") {
    const weekMs = rrule.interval * 7 * 864e5;
    const days = (rrule.byDay?.length ? rrule.byDay : [Object.keys(DAYS).find((k) => DAYS[k] === start.getUTCDay())!])
      .map((d) => DAYS[d]);
    // anchor to the Monday of the start week (UTC)
    const anchor = start.getTime() - ((start.getUTCDay() + 6) % 7) * 864e5;
    for (let wk = anchor; wk < hi.getTime() + 7 * 864e5; wk += weekMs) {
      for (const dow of days) {
        const t = wk + ((dow + 6) % 7) * 864e5 + (start.getTime() % 864e5);
        if (t < start.getTime() - 1000) continue; // before series start
        if (hitCap() || !push(new Date(t))) return out;
      }
    }
  } else {
    const stepMonths = rrule.freq === "MONTHLY" ? rrule.interval : rrule.interval * 12;
    const dom = rrule.byMonthDay ?? start.getUTCDate();
    for (let i = 0; i < 500; i++) {
      const d = new Date(Date.UTC(
        start.getUTCFullYear(), start.getUTCMonth() + i * stepMonths, dom,
        start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
      if (d.getUTCDate() !== dom) { continue; } // skipped month (e.g. Feb 30)
      if (d < start) continue;
      if (hitCap() || !push(d)) break;
      if (d > hi) break;
    }
  }
  return out;
}

// ── iCalendar ──

export function parseICalDate(v: string): Date | null {
  const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  return isNaN(d.getTime()) ? null : d;
}

export function toICalDate(d: Date | string, allDay = false): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`;
  return allDay ? date : `${date}T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}Z`;
}

const escIcs = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const unescIcs = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

export interface IcsEvent {
  uid: string; summary: string; description?: string; location?: string;
  startsAt: Date; endsAt: Date; allDay: boolean; rrule?: string; sequence?: number;
  exdates?: Date[];        // cancelled occurrences of a recurring series
}

/** Parse the VEVENTs out of an .ics payload. Unfolds continuation lines first. */
export function parseIcs(ics: string): IcsEvent[] {
  const lines = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const events: IcsEvent[] = [];
  let cur: Record<string, string> | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT" && cur) {
      const st = parseICalDate(cur.DTSTART ?? "");
      if (st) {
        const en = parseICalDate(cur.DTEND ?? "") ?? new Date(st.getTime() + 3600e3);
        const allDay = !(cur.DTSTART ?? "").includes("T");
        events.push({
          uid: cur.UID ?? `imp-${st.getTime()}`,
          summary: unescIcs(cur.SUMMARY ?? "(no title)"),
          description: cur.DESCRIPTION ? unescIcs(cur.DESCRIPTION) : undefined,
          location: cur.LOCATION ? unescIcs(cur.LOCATION) : undefined,
          startsAt: st, endsAt: en > st ? en : new Date(st.getTime() + 3600e3),
          allDay, rrule: cur.RRULE || undefined,
        });
      }
      cur = null; continue;
    }
    if (cur) {
      const i = line.indexOf(":");
      if (i > 0) {
        const key = line.slice(0, i).split(";")[0].toUpperCase();
        cur[key] = line.slice(i + 1);
      }
    }
  }
  return events;
}

const buildVevent = (ev: IcsEvent, organizer?: string, method?: "REQUEST" | "CANCEL"): string => {
  const allDay = ev.allDay;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${toICalDate(new Date())}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    allDay ? `DTSTART;VALUE=DATE:${toICalDate(ev.startsAt, true)}` : `DTSTART:${toICalDate(ev.startsAt)}`,
    allDay
      ? `DTEND;VALUE=DATE:${toICalDate(new Date(ev.endsAt.getTime() + 864e5), true)}`
      : `DTEND:${toICalDate(ev.endsAt)}`,
    `SUMMARY:${escIcs(ev.summary)}`,
    ...(method === "CANCEL" ? ["STATUS:CANCELLED"] : []),
  ];
  if (ev.location) lines.push(`LOCATION:${escIcs(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escIcs(ev.description)}`);
  if (organizer) lines.push(`ORGANIZER:mailto:${organizer}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule.replace(/^RRULE:/i, "")}`);
  if (ev.exdates?.length)
    lines.push(`EXDATE:${ev.exdates.map((d) => toICalDate(d, allDay)).join(",")}`);
  lines.push("END:VEVENT");
  return lines.join("\r\n");
};

export function buildIcs(ev: IcsEvent, organizer?: string, method?: "REQUEST" | "CANCEL"): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kreatix//Calendar//EN", "CALSCALE:GREGORIAN",
    ...(method ? [`METHOD:${method}`] : []),
    buildVevent(ev, organizer, method),
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n";
}

/** Multi-event calendar feed (webcal subscription). Cancelled occurrences go
 *  out as EXDATE; moved exceptions fall back to series time (fidelity gap —
 *  RECURRENCE-ID instances are a future refinement). */
export function buildIcsFeed(events: IcsEvent[], organizer?: string, calName = "Kreatix Calendar"): string {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kreatix//Calendar//EN", "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escIcs(calName)}`,
    ...events.map((e) => buildVevent(e, organizer)),
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n";
}
