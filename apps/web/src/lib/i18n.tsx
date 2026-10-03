// Lightweight i18n — dictionary-keyed t() with {var} interpolation,
// locale from localStorage → navigator.language → "en". Missing keys fall
// back to English. Add locales by creating src/i18n/<tag>.ts exporting a
// partial map, then registering it in LOCALES below.
// Only English ships in the entry chunk — other dictionaries load on demand.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "../i18n/en";

export type Dict = Record<string, string>;

export const LOCALES: { tag: string; label: string; dir?: "rtl"; dict?: Dict; load?: () => Promise<Dict> }[] = [
  { tag: "en", label: "English", dict: en },
  { tag: "de", label: "Deutsch", load: () => import("../i18n/de").then((m) => m.de) },
  { tag: "es", label: "Español", load: () => import("../i18n/es").then((m) => m.es) },
  { tag: "fr", label: "Français", load: () => import("../i18n/fr").then((m) => m.fr) },
  { tag: "pt", label: "Português", load: () => import("../i18n/pt").then((m) => m.pt) },
  { tag: "ar", label: "العربية", dir: "rtl", load: () => import("../i18n/ar").then((m) => m.ar) },
];

const STORAGE = "kx-locale";

function detect(): string {
  const saved = localStorage.getItem(STORAGE);
  if (saved && LOCALES.some((l) => l.tag === saved)) return saved;
  const nav = (navigator.language || "en").toLowerCase();
  const exact = LOCALES.find((l) => l.tag === nav);
  if (exact) return exact.tag;
  const base = nav.split("-")[0];
  return LOCALES.find((l) => l.tag === base)?.tag ?? "en";
}

interface I18n {
  locale: string;
  dir: "ltr" | "rtl";
  setLocale: (tag: string) => void;
  /** t("home.newDoc") → translated string; {vars} interpolate; falls back to en then key. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18n>({
  locale: "en", dir: "ltr", setLocale: () => {},
  t: (k) => en[k] ?? k,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(detect);
  const [dicts, setDicts] = useState<Record<string, Dict>>({ en });
  const entry = LOCALES.find((l) => l.tag === locale) ?? LOCALES[0];
  useEffect(() => {
    document.documentElement.dir = entry.dir ?? "ltr";
    document.documentElement.lang = locale;
    if (!entry.dict && entry.load && !dicts[locale]) {
      let live = true;
      void entry.load().then((d) => {
        if (live) setDicts((prev) => ({ ...prev, [locale]: d }));
      });
      return () => { live = false; };
    }
  }, [locale, entry, dicts]);
  const value = useMemo<I18n>(() => {
    const dir = entry.dir ?? "ltr";
    const dict = entry.dict ?? dicts[locale] ?? en;
    const t = (key: string, vars?: Record<string, string | number>) => {
      let s = dict[key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    return {
      locale, dir, t,
      setLocale: (tag: string) => {
        if (!LOCALES.some((l) => l.tag === tag)) return;
        localStorage.setItem(STORAGE, tag);
        setLocaleState(tag);
      },
    };
  }, [locale, dicts, entry]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
