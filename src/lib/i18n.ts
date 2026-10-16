/* i18n.ts — Fumen in English and German.
 *
 * - The English text is the key: `t("Library")`, with `{name}` placeholders filled from `vars`
 *   (`t("Logged in as {name}", { name })`). Keys are plain string literals, so
 *   `i18n.test.ts` can find them all and check that German has each one.
 * - Counts: `tn(n, "{n} set", "{n} sets")`; `{n}` is the number as the language writes it.
 * - The language is the system's (German or else English) until one is picked in Settings. It's
 *   known before anything renders (the first lines of every view run at import): kept in
 *   localStorage too, next to the preference in Fumen's settings. Changing it reloads the window.
 * - Numbers, dates and relative times follow the language (`locale`).
 * - What the Rust side says (errors, lazer's state, import rows) goes through `fromRust()`. */
import { de, rust } from "../locales/de";

export type Lang = "en" | "de";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
];

const KEY = "fumen.lang";

const isLang = (v: unknown): v is Lang => v === "en" || v === "de";

function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** The system's language, as far as Fumen speaks it. */
export function systemLang(): Lang {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export const lang: Lang = storedLang() ?? systemLang();
export const locale = lang === "de" ? "de-DE" : "en-GB";
if (typeof document !== "undefined") document.documentElement.lang = lang;

const dict: Record<string, string> | null = lang === "de" ? de : null;

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** `s` in the current language. */
export function t(s: string, vars?: Record<string, string | number>): string {
  return fill(dict?.[s] ?? s, vars);
}

/** Rust's texts with something filled in ("Beatmap {beatmap} wasn't found…"), as patterns. */
let rustPatterns: { re: RegExp; to: string }[] | null = null;

/**
 * A text from Fumen's Rust side (an error, lazer's state, an import row) in the current
 * language: as it is, else by its pattern, the filled-in parts looked up too. Anything else
 * (lazer's own messages, the system's) stays as it came.
 */
export function fromRust(s: string): string {
  if (!dict) return s;
  const exact = rust[s] ?? dict[s];
  if (exact) return exact;
  rustPatterns ??= Object.entries(rust)
    .filter(([k]) => k.includes("{"))
    .map(([k, to]) => ({
      re: new RegExp(`^${k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, "(?<$1>[\\s\\S]*?)").replace(/[{}]/g, "\\$&")}$`),
      to,
    }));
  for (const { re, to } of rustPatterns) {
    const m = re.exec(s);
    if (!m) continue;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) vars[k] = fromRust(v);
    return fill(to, vars);
  }
  return s;
}

/** A label inside a sentence: lowercase in English ("long notes"), German nouns keep their capital. */
export const lower = (s: string): string => (lang === "de" ? s : s.toLowerCase());

const nf = new Intl.NumberFormat(locale);

/** `one` or `other` by `n`, in the current language; `{n}` is `n` formatted (German: 1.234). */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const tr = dict?.[`${one}|${other}`];
  const [o, m] = tr ? (tr.split("|") as [string, string]) : [one, other];
  return fill(n === 1 ? o : m, { n: nf.format(n), ...vars });
}

/**
 * Another language: kept for the next start, then the window starts again in it. `persist`
 * stores it in Fumen's settings too.
 */
export function switchLang(next: Lang, persist: (l: Lang) => Promise<void>): void {
  if (next === lang) return;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the setting still has it */
  }
  // the settings written first, or the old language would win again on the next start
  void persist(next)
    .catch(() => {})
    .finally(() => location.reload());
}

/**
 * After Fumen's settings are read: their language wins (localStorage may have been cleared);
 * returns true when the window restarts for it.
 */
export function adoptLang(saved: unknown): boolean {
  if (!isLang(saved) || saved === lang) return false;
  try {
    localStorage.setItem(KEY, saved);
  } catch {
    return false;
  }
  location.reload();
  return true;
}
