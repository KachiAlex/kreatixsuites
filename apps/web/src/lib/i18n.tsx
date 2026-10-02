// Lightweight i18n — dictionary-keyed t() with {var} interpolation,
// locale from localStorage → navigator.language → "en". Missing keys fall
// back to English. Add locales by creating src/i18n/<tag>.ts exporting a
// partial map, then registering it in LOCALES below.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "../i18n/en";
import { de } from "../i18n/de";
import { fr } from "../i18n/fr";
import { es } from "../i18n/es";
import { pt } from "../i18n/pt";
import { ar } from "../i18n/ar";

export type Dict = Record<string, string>;

export const LOCALES: { tag: string; label: string; dir?: "rtl"; dict: Dict }[] = [
  { tag: "en", label: "English", dict: en },
  { tag: "de", label: "Deutsch", dict: de },
  { tag: "es", label: "Español", dict: es },
  { tag: "fr", label: "Français", dict: fr },
  { tag: "pt", label: "Português", dict: pt },
  { tag: "ar", label: "العربية", dir: "rtl", dict: ar },
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
  useEffect(() => {
    const entry = LOCALES.find((l) => l.tag === locale) ?? LOCALES[0];
    document.documentElement.dir = entry.dir ?? "ltr";
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18n>(() => {
    const entry = LOCALES.find((l) => l.tag === locale) ?? LOCALES[0];
    const dir = entry.dir ?? "ltr";
    const t = (key: string, vars?: Record<string, string | number>) => {
      let s = entry.dict[key] ?? en[key] ?? key;
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
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
