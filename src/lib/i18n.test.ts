// Every text the UI shows through t() / tn() has its German, and German has nothing left over;
// the same for what Fumen's Rust side says (src/locales/de/rust.ts, read by fromRust()).
import { describe, expect, it } from "vitest";
import { de, rust } from "../locales/de";

/** the app's source, but not tests, translations or i18n.ts itself */
const SOURCES = Object.entries(
  import.meta.glob<string>(["../**/*.ts", "!../**/*.test.ts", "!../locales/**", "!./i18n.ts"], { query: "?raw", import: "default", eager: true }),
);

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const T = new RegExp(String.raw`(?<![\w.$])t\(\s*` + STR, "g");
const TN = new RegExp(String.raw`(?<![\w.$])tn\([^,]+,\s*` + STR + String.raw`,\s*` + STR, "g");
/** a t( / tn( whose text isn't a plain "string" (the check above couldn't see it) */
const LOOSE = /(?<![\w.$])t\(\s*(?!")|(?<![\w.$])tn\((?![^,]+,\s*"(?:[^"\\]|\\.)*",\s*")/g;

const unescape = (s: string): string => JSON.parse(`"${s}"`);

function keys(): { keys: Map<string, string>; loose: string[] } {
  const found = new Map<string, string>();
  const loose: string[] = [];
  for (const [path, text] of SOURCES) {
    const rel = path.replace(/^\.\.?\//, "");
    for (const m of text.matchAll(T)) found.set(unescape(m[1]), rel);
    for (const m of text.matchAll(TN)) found.set(`${unescape(m[1])}|${unescape(m[2])}`, rel);
    for (const m of text.matchAll(LOOSE)) loose.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
  }
  return { keys: found, loose };
}

const placeholders = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

describe("German", () => {
  const { keys: used, loose } = keys();

  it("finds the source", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  it("only plain strings go through t() and tn()", () => {
    expect(loose).toEqual([]);
  });

  it("has every text", () => {
    const missing = [...used].filter(([k]) => !(k in de)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("has nothing that isn't used", () => {
    expect(Object.keys(de).filter((k) => !used.has(k))).toEqual([]);
  });

  it("keeps the placeholders and both forms of a count", () => {
    const wrong: string[] = [];
    for (const [k, v] of Object.entries(de)) {
      const forms = k.includes("|") ? k.split("|") : [k];
      const tr = k.includes("|") ? v.split("|") : [v];
      if (tr.length !== forms.length) wrong.push(`${k}: ${tr.length} forms`);
      else forms.forEach((f, i) => placeholders(f) !== placeholders(tr[i]) && wrong.push(`${k} → ${v}`));
      if (!v.trim()) wrong.push(`${k}: empty`);
    }
    expect(wrong).toEqual([]);
  });
});

/** src-tauri's source, without its tests */
const RUST = Object.entries(import.meta.glob<string>("../../src-tauri/src/**/*.rs", { query: "?raw", import: "default", eager: true })).map(([path, text]) => {
  const tests = text.search(/#\[cfg\(test\)\]\s*mod (tests|real) \{/);
  return [path, tests >= 0 ? text.slice(0, tests) : text] as const;
});

const RS = STR;
/** where Rust hands the UI a text: an error, an import row's or lazer's message, a fallback */
const SAYS = [
  new RegExp(String.raw`Error::known\(\s*"[a-z-]+",\s*(?:format!\(\s*)?` + RS, "g"),
  new RegExp(String.raw`Some\(\s*(?:format!\(\s*)?` + RS, "g"),
  new RegExp(String.raw`unwrap_or_else\(\|\|\s*(?:format!\(\s*)?` + RS, "g"),
  new RegExp(String.raw`importer_error\([^,]+,[^,]+,\s*` + RS, "g"),
];
/** `{}`, `{e}`, `{name}`, `{x:?}` all stand for something filled in */
const shape = (s: string): string => s.replace(/\{[^{}\n"]*\}/g, "{}");

describe("German for Rust", () => {
  // as plain text: a Rust char literal like '"' would throw a scan for strings off
  const source = shape(RUST.map(([, text]) => text).join("\n"));
  const said = new Map<string, string>();
  for (const [path, text] of RUST) for (const re of SAYS) for (const m of text.matchAll(re)) if (/[A-Z]/.test(m[1]) && / /.test(m[1])) said.set(m[1], path.replace(/^.*src-tauri\/src\//, ""));

  it("finds the source", () => {
    expect(RUST.length).toBeGreaterThan(20);
    expect(said.size).toBeGreaterThan(40);
  });

  it("has every text", () => {
    const known = new Set([...Object.keys(rust), ...Object.keys(de)].map(shape));
    expect([...said].filter(([s]) => !known.has(shape(s))).map(([s, f]) => `${f}: ${s}`)).toEqual([]);
  });

  it("has nothing Rust doesn't say", () => {
    expect(Object.keys(rust).filter((k) => !source.includes(`"${shape(k)}`))).toEqual([]);
  });

  it("keeps the placeholders", () => {
    expect(Object.entries(rust).filter(([k, v]) => placeholders(k) !== placeholders(v) || !v.trim())).toEqual([]);
  });
});
