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
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── timezone math (Intl-backed; no tz lib dependency) ──
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const tzFmt = (tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
};

/** Wall-clock fields of an instant in tz. */
const wallFields = (tz: string, d: Date) => {
  const p = tzFmt(tz).formatToParts(d);
  const num = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const h = num("hour") === 24 ? 0 : num("hour");
  return {
    y: num("year"), m: num("month"), d: num("day"), h, min: num("minute"), s: num("second"),
    dow: DOW_SHORT.indexOf(p.find((x) => x.type === "weekday")!.value),
  };
};

/** ms offset of tz at a UTC instant. */
const tzOffsetMs = (tz: string, utcMs: number) => {
  const w = wallFields(tz, new Date(utcMs));
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(utcMs / 1000) * 1000;
};

/** Wall-clock (y,m,d,h,min,s) in tz → UTC instant. Two-pass offset correction
 *  covers transitions that flip mid-conversion; ambiguous times take the
 *  first occurrence, nonexistent times slide forward (RFC 5545 behavior). */
export function wallToUtc(tz: string, y: number, m: number, d: number, h: number, min: number, s: number): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, s);
  return new Date(guess - tzOffsetMs(tz, guess - tzOffsetMs(tz, guess)));
}

const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export { validTz };

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

/** Expand occurrences of (start,duration,rrule) into [lo,hi]. Returns start
 *  Dates. Stepping is wall-clock in `tz` — a daily 9:00 meeting stays 9:00
 *  across DST transitions (the UTC instant shifts, the local time doesn't). */
export function expandOccurrences(start: Date, rrule: RRule, lo: Date, hi: Date, cap = 400, tz = "UTC"): Date[] {
  const out: Date[] = [];
  const push = (d: Date) => {
    if (rrule.until && d > rrule.until) return false;
    if (d >= lo && d < hi) out.push(new Date(d));
    return d < hi;
  };

  let n = 0;
  const hitCap = () => ++n > (rrule.count ?? cap) || out.length >= cap;

  const ws = wallFields(tz, start);   // wall-clock anchor (time + weekday)
  const mk = (y: number, m: number, d: number) => wallToUtc(tz, y, m, d, ws.h, ws.min, ws.s);

  if (rrule.freq === "DAILY") {
    // calendar-day stepping — NOT fixed-ms (that drifts ±1h across DST)
    for (let i = 0; ; i += rrule.interval) {
      const cand = new Date(Date.UTC(ws.y, ws.m - 1, ws.d + i));
      const t = mk(cand.getUTCFullYear(), cand.getUTCMonth() + 1, cand.getUTCDate());
      if (hitCap() || !push(t) || t > hi) break;
    }
  } else if (rrule.freq === "WEEKLY") {
    const days = (rrule.byDay?.length ? rrule.byDay : [Object.keys(DAYS).find((k) => DAYS[k] === ws.dow)!])
      .map((d) => DAYS[d])
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));   // Mon..Sun — chronological within each week
    // anchor to the Monday of the start week in wall-clock days
    const anchor = Date.UTC(ws.y, ws.m - 1, ws.d) - ((ws.dow + 6) % 7) * 864e5;
    for (let wk = anchor; wk < hi.getTime() + 31 * 864e5; wk += rrule.interval * 7 * 864e5) {
      for (const dow of days) {
        const cand = new Date(wk + ((dow + 6) % 7) * 864e5);
        const t = mk(cand.getUTCFullYear(), cand.getUTCMonth() + 1, cand.getUTCDate());
        if (t < start) continue;              // before series start
        if (hitCap() || !push(t) || t > hi) return out;
      }
    }
  } else {
    const stepMonths = rrule.freq === "MONTHLY" ? rrule.interval : rrule.interval * 12;
    const dom = rrule.byMonthDay ?? ws.d;
    for (let i = 0; i < 500; i++) {
      const probe = new Date(Date.UTC(ws.y, ws.m - 1 + i * stepMonths, dom));
      if (probe.getUTCDate() !== dom) continue;   // skipped month (e.g. Feb 30)
      const t = mk(probe.getUTCFullYear(), probe.getUTCMonth() + 1, dom);
      if (t < start) continue;
      if (hitCap() || !push(t) || t > hi) break;
    }
  }
  return out;
}

// ── iCalendar ──

export function parseICalDate(v: string, tz?: string): Date | null {
  const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, s] = m;
  if (tz && !m[7] && validTz(tz))
    return wallToUtc(tz, +y, +mo, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0));
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(s ?? 0)));
  return isNaN(dt.getTime()) ? null : dt;
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
  tz?: string;             // IANA zone — emitted as TZID on DT*/EXDATE for wall-clock recurrence
  recurrenceId?: Date;     // set on exception-override instances
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
      const stz = cur["DTSTART@TZID"];
      const st = parseICalDate(cur.DTSTART ?? "", stz);
      if (st) {
        const en = parseICalDate(cur.DTEND ?? "", cur["DTEND@TZID"] ?? stz) ?? new Date(st.getTime() + 3600e3);
        const allDay = !(cur.DTSTART ?? "").includes("T");
        events.push({
          uid: cur.UID ?? `imp-${st.getTime()}`,
          summary: unescIcs(cur.SUMMARY ?? "(no title)"),
          description: cur.DESCRIPTION ? unescIcs(cur.DESCRIPTION) : undefined,
          location: cur.LOCATION ? unescIcs(cur.LOCATION) : undefined,
          startsAt: st, endsAt: en > st ? en : new Date(st.getTime() + 3600e3),
          allDay, rrule: cur.RRULE || undefined,
          tz: !allDay && stz && validTz(stz) ? stz : undefined,
        });
      }
      cur = null; continue;
    }
    if (cur) {
      const i = line.indexOf(":");
      if (i > 0) {
        // keep params as KEY@PARAM entries (TZID, VALUE, ...) — DTSTART;TZID=X:...
        const lhs = line.slice(0, i);
        const [key, ...params] = lhs.split(";");
        const k = key.toUpperCase();
        cur[k] = line.slice(i + 1);
        for (const p of params) {
          const eq = p.indexOf("=");
          if (eq > 0) cur[`${k}@${p.slice(0, eq).toUpperCase()}`] = p.slice(eq + 1);
        }
      }
    }
  }
  return events;
}

/** Wall-clock ical datetime of an instant as seen in tz (no trailing Z —
 *  paired with ;TZID=). */
const toICalWall = (d: Date, tz: string) => {
  const w = wallFields(tz, d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.y}${p(w.m)}${p(w.d)}T${p(w.h)}${p(w.min)}${p(w.s)}`;
};

const buildVevent = (ev: IcsEvent, organizer?: string, method?: "REQUEST" | "CANCEL"): string => {
  const allDay = ev.allDay;
  // recurring series carry TZID so subscribers expand in wall-clock;
  // instants without a rule are absolute UTC either way
  const tzid = ev.tz && !allDay ? ev.tz : null;
  const dtv = (d: Date) => tzid ? toICalWall(d, tzid) : toICalDate(d, allDay);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${toICalDate(new Date())}`,
    `SEQUENCE:${ev.sequence ?? 0}`,
    allDay ? `DTSTART;VALUE=DATE:${toICalDate(ev.startsAt, true)}`
      : `DTSTART${tzid ? `;TZID=${tzid}` : ""}:${dtv(ev.startsAt)}`,
    allDay
      ? `DTEND;VALUE=DATE:${toICalDate(new Date(ev.endsAt.getTime() + 864e5), true)}`
      : `DTEND${tzid ? `;TZID=${tzid}` : ""}:${dtv(ev.endsAt)}`,
    `SUMMARY:${escIcs(ev.summary)}`,
    ...(method === "CANCEL" ? ["STATUS:CANCELLED"] : []),
  ];
  if (ev.recurrenceId)
    lines.push(`RECURRENCE-ID${tzid ? `;TZID=${tzid}` : ""}:${dtv(ev.recurrenceId)}`);
  if (ev.location) lines.push(`LOCATION:${escIcs(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escIcs(ev.description)}`);
  if (organizer) lines.push(`ORGANIZER:mailto:${organizer}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule.replace(/^RRULE:/i, "")}`);
  if (ev.exdates?.length)
    lines.push(`EXDATE${tzid ? `;TZID=${tzid}` : ""}:${ev.exdates.map((d) => dtv(d)).join(",")}`);
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
