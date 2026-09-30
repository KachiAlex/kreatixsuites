import type { CSSProperties } from "react";

export type AppKind = "suites" | "writer" | "sheets" | "present" | "pdf" | "file" | "folder";

const TILE: Record<AppKind, string> = {
  suites: "#F2782E",
  writer: "#3578E5",
  sheets: "#1F9D66",
  present: "#7C5CD6",
  pdf: "#D84B57",
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
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif" fontWeight="800" fontSize="19" letterSpacing="1">
          PDF
        </text>
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

/** Kreatix Suites logo lockup per the brand board.
 *  `light` = the official on-dark artwork (public/brand PNG); otherwise a
 *  type-rendered equivalent for light surfaces (Kreatix ink / Suites orange
 *  italic / divider / PRODUCTIVITY SUITE). */
export function BrandLockup({ light, size = 40, tagline = true, style }: {
  light?: boolean;
  size?: number;
  tagline?: boolean;
  style?: CSSProperties;
}) {
  if (light) {
    return (
      <img src="/brand/kreatix-suites-dark.png" alt="Kreatix Suites" draggable={false}
        style={{ height: size, width: "auto", display: "block", ...style }} />
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.28, ...style }}>
      <AppIcon kind="suites" size={size} />
      <div style={{ lineHeight: 1.08, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
        <div style={{ fontSize: size * 0.4, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--ink)" }}>
          Kreatix
        </div>
        <div style={{ fontSize: size * 0.27, fontWeight: 800, fontStyle: "italic", color: "var(--k-orange)" }}>
          Suites
        </div>
        {tagline && (
          <div style={{
            fontSize: size * 0.14, fontWeight: 700, letterSpacing: ".15em", color: "#9A918B",
            borderTop: "1px solid var(--line)", marginTop: size * 0.08, paddingTop: size * 0.06,
          }}>
            PRODUCTIVITY SUITE
          </div>
        )}
      </div>
    </div>
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
