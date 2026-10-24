/* changelog.ts — what each version changed, as written in changelog.json (English and German,
 * by hand). After an update Fumen shows the versions since the one it last ran; Settings ›
 * About shows all of them. The release script takes its notes from the same file. */
import data from "./changelog.json";
import { lang } from "./i18n";

export interface ChangelogEntry {
  version: string;
  date: string;
  en: string[];
  de: string[];
}

export const CHANGELOG: ChangelogEntry[] = data;

const SEEN_KEY = "fumen.seenVersion";

/** -1, 0 or 1 as `a` is older, the same or newer than `b` ("1.3.10" > "1.3.9") */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The entries newer than `seen` up to `current`, newest first. */
export function entriesSince(seen: string, current: string, list: ChangelogEntry[] = CHANGELOG): ChangelogEntry[] {
  return list.filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0);
}

/** An entry's lines in the current language. */
export const linesOf = (e: ChangelogEntry): string[] => (lang === "de" && e.de.length ? e.de : e.en);

function seenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(v: string): void {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* shown again next time, no harm */
  }
}

/**
 * What to show after this start: the entries since the version Fumen last ran. A fresh install
 * shows nothing; someone who used Fumen before the changelog existed (`known`) sees this
 * version's entry once.
 */
export function newSinceLastRun(current: string, known: boolean): ChangelogEntry[] {
  const seen = seenVersion();
  markSeen(current);
  if (!seen) return known ? CHANGELOG.filter((e) => e.version === current) : [];
  return entriesSince(seen, current);
}
