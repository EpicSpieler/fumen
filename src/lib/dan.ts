/* dan.ts — the dan rating and pattern report from Fumen's port of ManiaMapAnalyser
 * (src-tauri/src/mma): how dan labels read and compare, and the report's clusters merged per
 * core pattern the way the analyser shows them. Dans at other rates: `danAt` in charts.ts. */
import type { CorePattern, DanRating, PatternReport } from "./types";
import { t } from "./i18n";

/** "< Intro 1 low" → "below Intro 1"; "> CloverWisp Theta high" → "above CloverWisp Theta". */
export function danText(label: string): string {
  const m = /^([<>])\s*(.+?)(?:\s+(?:low|mid\/low|mid|mid\/high|high))?$/.exec(label.trim());
  if (!m) return label;
  return `${m[1] === "<" ? "below" : "above"} ${m[2]}`;
}

/** The readings of a dan, the one that fits the chart first: LN for long-note charts. */
export function danReadings(d: DanRating, report?: PatternReport): { main: string; other?: string; otherKind?: "rice" | "LN" } {
  const lnFirst = !!d.ln && !!report && (report.mode === "LN" || report.lnRatio >= 0.5);
  if (!d.ln) return { main: danText(d.rc) };
  return lnFirst ? { main: danText(d.ln), other: danText(d.rc), otherKind: "rice" } : { main: danText(d.rc), other: danText(d.ln), otherKind: "LN" };
}

/** A library dan label ("Gamma mid || LN 9 low") as one reading: LN when long notes make up
 * at least half the chart (`lnShare`, 0–1), rice otherwise — as the chart panel leads. */
export function shortDan(label: string, lnShare: number): string {
  const [rc, ln] = label.split("||").map((s) => s.trim());
  return danText(ln && lnShare >= 0.5 ? ln : rc);
}

const GREEK: Record<string, number> = { alpha: 11, beta: 12, gamma: 13, delta: 14, epsilon: 15, zeta: 16, eta: 17, theta: 18, iota: 19, kappa: 20 };

/**
 * A dan label as a number on the rice scale (ManiaMapAnalyser's rcLabelToNumeric): Intro 1–3 =
 * −2…0, Reform / Regular N = N, Alpha = 11 … Kappa = 20, with low −0.4 … high +0.4. Also reads
 * bare names ("gamma", "reform 7"), for search. `null` for anything else (and for "< …" / "> …").
 */
export function danNumber(label: string): number | null {
  const text = label.split("||")[0].replace(/\s+/g, " ").trim().toLowerCase();
  if (!text || /[<>]/.test(text)) return null;
  let base: number | null = null;
  const intro = /\bintro\s*([123])\b/.exec(text);
  if (intro) base = +intro[1] - 3;
  const numbered = base === null ? /\b(?:reform|rework|regular)\s*(-?\d+(?:\.\d+)?)\b/.exec(text) : null;
  if (numbered) base = +numbered[1];
  if (base === null) {
    for (const [word, v] of Object.entries(GREEK)) {
      if (new RegExp(`\\b${word}\\b`).test(text)) {
        base = v;
        break;
      }
    }
  }
  if (base === null) {
    const plain = /(^|\s)(-?\d+(?:\.\d+)?)(\s|$)/.exec(text);
    if (plain) base = +plain[2];
  }
  if (base === null || !Number.isFinite(base)) return null;
  const tier = /\bmid\s*[/-]\s*high\b/.test(text)
    ? 0.2
    : /\bmid\s*[/-]\s*low\b/.test(text)
      ? -0.2
      : /\blow\b/.test(text)
        ? -0.4
        : /\bhigh\b/.test(text)
          ? 0.4
          : 0;
  return base + tier;
}

export const CORE_PATTERNS: Record<CorePattern, { label: string; hint: string }> = {
  Stream: { label: "Stream", hint: t("Single notes in quick succession, no column twice in a row") },
  Chordstream: { label: "Chordstream", hint: t("Streams of chords: jumpstream, handstream, trills of chords") },
  Jacks: { label: "Jacks", hint: t("Columns hit again right after: minijacks, chordjacks, longjacks") },
  Coordination: { label: t("Coordination"), hint: t("Long notes held while other columns move: column lock, shields, releases") },
  Density: { label: t("LN density"), hint: t("Long notes started in quick succession, or inverse") },
  Wildcard: { label: "LN wildcard", hint: t("Long notes mixed with speed or jacks") },
};

export const MODE_LABEL: Record<PatternReport["mode"], string> = { RC: "Rice", LN: t("Long notes"), HB: t("Hybrid"), Mix: t("Mixed") };

/** Scroll speed changes over this many ms make an SV chart. */
export const SV_AMOUNT = 2000;

export interface PatternGroup {
  pattern: CorePattern;
  /** chart ms it covers (summed over its speeds) */
  amount: number;
  /** speed of its biggest cluster */
  bpm: number;
  mixed: boolean;
  /** specific patterns, share by time, biggest first */
  specific: [string, number][];
}

/** The report's clusters merged per core pattern, most important first (at most five). */
export function patternGroups(report: PatternReport): PatternGroup[] {
  const groups = new Map<CorePattern, { amount: number; best: PatternReport["clusters"][number]; spec: Map<string, number> }>();
  for (const c of report.clusters) {
    let g = groups.get(c.pattern);
    if (!g) groups.set(c.pattern, (g = { amount: 0, best: c, spec: new Map() }));
    g.amount += c.amount;
    if (c.amount > g.best.amount) g.best = c;
    for (const [name, share] of c.specific) g.spec.set(name, (g.spec.get(name) ?? 0) + share * c.amount);
  }
  return [...groups.entries()].slice(0, 5).map(([pattern, g]) => ({
    pattern,
    amount: g.amount,
    bpm: g.best.bpm,
    mixed: g.best.mixed,
    specific: [...g.spec.entries()].map(([n, w]): [string, number] => [n, g.amount > 0 ? w / g.amount : 0]).sort((a, b) => b[1] - a[1]),
  }));
}
