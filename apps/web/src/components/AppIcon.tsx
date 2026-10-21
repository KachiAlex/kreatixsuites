import type { CSSProperties } from "react";

export type AppKind = "suites" | "writer" | "sheets" | "present" | "pdf" | "board" | "mail" | "meet" | "chat" | "calendar" | "tasks" | "forms" | "notes" | "sites" | "file" | "folder";

const TILE: Record<AppKind, string> = {
  suites: "#F2782E",
  writer: "#3578E5",
  sheets: "#1F9D66",
  present: "#7C5CD6",
  pdf: "#D84B57",
  board: "#0E7C61",
  mail: "#0FA3A3",
  meet: "#6264A7",
  chat: "#0E7C61",
  calendar: "#C2470E",
  tasks: "#7B61A3",
  forms: "#0F7B6C",
  notes: "#7C3A8C",
  sites: "#2C6E9B",
  file: "#727272",
  folder: "#B8AFA6",
};

function Glyph({ kind, color }: { kind: AppKind; color: string }) {
  switch (kind) {
    case "suites":
      // The official mark: vertical bar + left-pointing triangle (the K's arms)
      return (
        <g fill="#fff">
          <rect x="15" y="12" width="10" height="40" rx="5" />
          <path d="M51 13 30 32 51 51Z" />
        </g>
      );
    case "writer":
      // Fountain-pen nib
      return (
        <g>
          <path d="M32 11 47 31 32 55 17 31Z" fill="#fff" />
          <path d="M32 33v14" stroke={color} strokeWidth="4" strokeLinecap="round" />
          <circle cx="32" cy="26.5" r="3.4" fill={color} />
        </g>
      );
    case "sheets":
      // Spreadsheet grid
      return (
        <g fill="none" stroke="#fff" strokeWidth="3.5">
          <rect x="15" y="13" width="34" height="38" rx="3" />
          <path d="M15 25.5h34M15 38h34M26.3 25.5V51M37.7 25.5V51" />
        </g>
      );
    case "present":
      // Projection screen on stand
      return (
        <g fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round">
          <rect x="13" y="13" width="38" height="27" rx="3" />
          <path d="M20 21.5h14M20 28.5h20" />
          <path d="M32 40v7M23 50h18" />
        </g>
      );
    case "pdf":
      return (
        <text x="32" y="39" textAnchor="middle" fill="#fff"
          fontFamily="'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="19" letterSpacing="1">
          PDF
        </text>
      );
    case "board":
      // Whiteboard — canvas with a drawn squiggle
      return (
        <g>
          <rect x="12" y="14" width="40" height="36" rx="5" fill="none" stroke="#fff" strokeWidth="3.5" />
          <path d="M20 40c4-10 8-12 12-6s8 4 12-4" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="44" cy="22" r="2.5" fill="#fff" />
        </g>
      );
    case "mail":
      // Envelope
      return (
        <g fill="none" stroke="#fff" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round">
          <rect x="13" y="17" width="38" height="30" rx="4" />
          <path d="M15 21l17 14 17-14" />
        </g>
      );
    case "meet":
      // Video camera — Teams-style
      return (
        <g fill="#fff">
          <rect x="11" y="20" width="26" height="24" rx="4" />
          <path d="M40 27l13-7v24l-13-7z" />
        </g>
      );
    case "chat":
      // Speech bubble
      return (
        <g fill="#fff">
          <path d="M32 12c-11.6 0-21 7.5-21 16.8 0 5.3 2.8 10 7.2 13.1L16 52l11.4-4.3c1.5.3 3 .5 4.6.5 11.6 0 21-7.5 21-16.8S43.6 12 32 12Z" />
          <circle cx="24" cy="29" r="2.4" fill={color} />
          <circle cx="32" cy="29" r="2.4" fill={color} />
          <circle cx="40" cy="29" r="2.4" fill={color} />
        </g>
      );
    case "calendar":
      // Calendar page — binder rings + date mark
      return (
        <g>
          <rect x="12" y="14" width="40" height="38" rx="5" fill="#fff" />
          <rect x="12" y="14" width="40" height="11" rx="5" fill={color} opacity="0.85" />
          <path d="M22 10v8M42 10v8" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
          <circle cx="25" cy="35" r="3" fill={color} />
          <rect x="32" y="32" width="12" height="3.5" rx="1.75" fill={color} opacity="0.55" />
          <rect x="23" y="42" width="21" height="3.5" rx="1.75" fill={color} opacity="0.3" />
        </g>
      );
    case "tasks":
      // Checklist — clipboard with tick
      return (
        <g>
          <rect x="16" y="12" width="32" height="42" rx="5" fill="none" stroke="#fff" strokeWidth="3.5" />
          <rect x="24" y="9" width="16" height="7" rx="3" fill="#fff" />
          <path d="M22 28l5 5 9-10" stroke="#fff" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M23 43h18" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" opacity="0.6" />
        </g>
      );
    case "forms":
      // Form card — fields + radio rows
      return (
        <g>
          <rect x="14" y="10" width="36" height="44" rx="5" fill="none" stroke="#fff" strokeWidth="3.5" />
          <path d="M21 20h22" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="24" cy="31" r="3.2" fill="none" stroke="#fff" strokeWidth="3" />
          <path d="M32 31h11" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
          <circle cx="24" cy="42" r="3.2" fill="#fff" />
          <path d="M32 42h11" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />
        </g>
      );
    case "notes":
      // Sticky note with folded corner
      return (
        <g>
          <path d="M16 10h32v32l-10 12H16z" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinejoin="round" />
          <path d="M48 42l-10 12v-12z" fill="#fff" />
          <path d="M22 22h18M22 30h14" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        </g>
      );
    case "sites":
      // Intranet globe — SharePoint-style hub
      return (
        <g fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round">
          <circle cx="32" cy="32" r="20" />
          <path d="M12 32h40" />
          <path d="M32 12c-8 6-8 34 0 40M32 12c8 6 8 34 0 40" />
          <path d="M17.5 21.5h29M17.5 42.5h29" opacity="0.55" />
        </g>
      );
    case "folder":
      return <path d="M12 18h16l5 7h19v23a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3Z" fill="#fff" />;
    default:
      // Generic document
      return (
        <g fill="none" stroke="#fff" strokeWidth="3.5" strokeLinejoin="round">
          <path d="M21 12h15l9 9v31H21Z" />
          <path d="M36 12v9h9" />
        </g>
      );
  }
}

/** Kreatix Suites logo lockup — the official artwork (public/brand PNGs,
 *  background cut to alpha). `light` = white-wordmark variant for dark
 *  surfaces; default = ink-wordmark variant for light surfaces. */
export function BrandLockup({ light, size = 40, style, fetchPriority, decoding }: {
  light?: boolean;
  size?: number;
  style?: CSSProperties;
  fetchPriority?: "high" | "low" | "auto";
  decoding?: "async" | "sync" | "auto";
}) {
  return (
    <img src={light ? "/brand/kreatix-suites-dark.png" : "/brand/kreatix-suites-light.png"}
      alt="Kreatix Suites" draggable={false} fetchPriority={fetchPriority} decoding={decoding}
      style={{ height: size, width: "auto", display: "block", ...style }} />
  );
}

/** Brand app tile (per Kreatix brand board) — rounded square + white glyph.
 *  Renders inline SVG; pass `size` for a fixed tile or omit to fill the parent. */
export function AppIcon({ kind, size, style, className }: {
  kind: AppKind | string;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  const k = (kind in TILE ? kind : "file") as AppKind;
  return (
    <svg viewBox="0 0 64 64" role="img" aria-hidden="true" className={className}
      width={size ?? "100%"} height={size ?? "100%"} style={{ display: "block", ...style }}>
      <rect width="64" height="64" rx="15" fill={TILE[k]} />
      <Glyph kind={k} color={TILE[k]} />
    </svg>
  );
}
