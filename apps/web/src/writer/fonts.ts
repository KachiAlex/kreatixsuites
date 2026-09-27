/** Font registry — bundled @fontsource families (lazy-imported on first use)
 *  plus a Google Fonts tail for anything else. KBS-WRITER typography. */

export interface FontDef {
  /** Display label in the picker */
  label: string;
  /** CSS font-family value applied to the editor */
  family: string;
  /** @fontsource package name (bundled, lazy `import()`) — omit for system fonts */
  fs?: string;
  /** Google Fonts family name — loaded via dynamic <link> on demand */
  gf?: string;
  category: "sans" | "serif" | "mono" | "display" | "system";
}

export const FONTS: FontDef[] = [
  // system fonts — always available
  { label: "Arial", family: "Arial, sans-serif", category: "system" },
  { label: "Times New Roman", family: "'Times New Roman', serif", category: "system" },
  { label: "Georgia", family: "Georgia, serif", category: "system" },
  { label: "Courier New", family: "'Courier New', monospace", category: "system" },
  { label: "Verdana", family: "Verdana, sans-serif", category: "system" },
  // bundled sans
  { label: "Inter", family: "'Inter', sans-serif", fs: "inter", category: "sans" },
  { label: "Roboto", family: "'Roboto', sans-serif", fs: "roboto", category: "sans" },
  { label: "Open Sans", family: "'Open Sans', sans-serif", fs: "open-sans", category: "sans" },
  { label: "Lato", family: "'Lato', sans-serif", fs: "lato", category: "sans" },
  { label: "Montserrat", family: "'Montserrat', sans-serif", fs: "montserrat", category: "sans" },
  { label: "Poppins", family: "'Poppins', sans-serif", fs: "poppins", category: "sans" },
  { label: "Source Sans 3", family: "'Source Sans 3', sans-serif", fs: "source-sans-3", category: "sans" },
  { label: "Raleway", family: "'Raleway', sans-serif", fs: "raleway", category: "sans" },
  { label: "Nunito", family: "'Nunito', sans-serif", fs: "nunito", category: "sans" },
  { label: "Oswald", family: "'Oswald', sans-serif", fs: "oswald", category: "sans" },
  // bundled serif
  { label: "Merriweather", family: "'Merriweather', serif", fs: "merriweather", category: "serif" },
  { label: "Playfair Display", family: "'Playfair Display', serif", fs: "playfair-display", category: "display" },
  { label: "Lora", family: "'Lora', serif", fs: "lora", category: "serif" },
  { label: "PT Serif", family: "'PT Serif', serif", fs: "pt-serif", category: "serif" },
  { label: "Crimson Text", family: "'Crimson Text', serif", fs: "crimson-text", category: "serif" },
  { label: "Source Serif 4", family: "'Source Serif 4', serif", fs: "source-serif-4", category: "serif" },
  // bundled mono
  { label: "JetBrains Mono", family: "'JetBrains Mono', monospace", fs: "jetbrains-mono", category: "mono" },
  { label: "Fira Code", family: "'Fira Code', monospace", fs: "fira-code", category: "mono" },
  { label: "Source Code Pro", family: "'Source Code Pro', monospace", fs: "source-code-pro", category: "mono" },
  { label: "Roboto Mono", family: "'Roboto Mono', monospace", fs: "roboto-mono", category: "mono" },
  // bundled display
  { label: "Dancing Script", family: "'Dancing Script', cursive", fs: "dancing-script", category: "display" },
  { label: "Pacifico", family: "'Pacifico', cursive", fs: "pacifico", category: "display" },
];

const loaded = new Set<string>();
const FONT_SOURCE_LOADERS: Record<string, () => Promise<unknown>> = {
  "inter": () => import("@fontsource/inter"),
  "roboto": () => import("@fontsource/roboto"),
  "open-sans": () => import("@fontsource/open-sans"),
  "lato": () => import("@fontsource/lato"),
  "montserrat": () => import("@fontsource/montserrat"),
  "poppins": () => import("@fontsource/poppins"),
  "source-sans-3": () => import("@fontsource/source-sans-3"),
  "raleway": () => import("@fontsource/raleway"),
  "nunito": () => import("@fontsource/nunito"),
  "oswald": () => import("@fontsource/oswald"),
  "merriweather": () => import("@fontsource/merriweather"),
  "playfair-display": () => import("@fontsource/playfair-display"),
  "lora": () => import("@fontsource/lora"),
  "pt-serif": () => import("@fontsource/pt-serif"),
  "crimson-text": () => import("@fontsource/crimson-text"),
  "source-serif-4": () => import("@fontsource/source-serif-4"),
  "jetbrains-mono": () => import("@fontsource/jetbrains-mono"),
  "fira-code": () => import("@fontsource/fira-code"),
  "source-code-pro": () => import("@fontsource/source-code-pro"),
  "roboto-mono": () => import("@fontsource/roboto-mono"),
  "dancing-script": () => import("@fontsource/dancing-script"),
  "pacifico": () => import("@fontsource/pacifico"),
};

/** Load a font's stylesheet on demand — bundled fonts via dynamic import,
 *  Google fonts via a <link> injected once. Safe to call repeatedly. */
export function ensureFont(family: string): void {
  const def = FONTS.find((f) => f.family === family || f.label === family);
  if (def?.fs && !loaded.has(def.fs)) {
    loaded.add(def.fs);
    void FONT_SOURCE_LOADERS[def.fs]?.();
    return;
  }
  if (!def) {
    // Google Fonts tail — inject <link> for arbitrary family names
    const name = family.replace(/['"]/g, "").split(",")[0].trim();
    if (!name || loaded.has(`gf:${name}`)) return;
    loaded.add(`gf:${name}`);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;700&display=swap`;
    document.head.appendChild(link);
  }
}

/** Load every font that actually appears in a loaded document. */
export function ensureDocFonts(doc: unknown): void {
  const text = JSON.stringify(doc);
  const seen = new Set<string>();
  for (const f of FONTS) {
    if (text.includes(f.family) && !seen.has(f.family)) { seen.add(f.family); ensureFont(f.family); }
  }
}
