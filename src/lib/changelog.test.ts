import { describe, expect, it } from "vitest";
import { CHANGELOG, compareVersions, entriesSince } from "./changelog";

describe("changelog", () => {
  it("compares versions by number, not text", () => {
    expect(compareVersions("1.3.10", "1.3.9")).toBe(1);
    expect(compareVersions("1.3.9", "1.3.10")).toBe(-1);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("picks the versions after the last one seen, up to this one", () => {
    const list = ["1.3.10", "1.3.9", "1.3.8", "1.3.7"].map((version) => ({ version, date: "", en: ["x"], de: ["y"] }));
    expect(entriesSince("1.3.7", "1.3.9", list).map((e) => e.version)).toEqual(["1.3.9", "1.3.8"]);
    expect(entriesSince("1.3.10", "1.3.10", list)).toEqual([]);
  });

  it("is newest first, with every version in both languages", () => {
    for (let i = 1; i < CHANGELOG.length; i++) expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBe(1);
    for (const e of CHANGELOG) {
      expect(e.en.length, e.version).toBeGreaterThan(0);
      expect(e.de.length, e.version).toBeGreaterThan(0);
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("reads like a person wrote it: no dashes standing in for punctuation", () => {
    for (const e of CHANGELOG) for (const line of [...e.en, ...e.de]) expect(line, e.version).not.toMatch(/—|–|--/);
  });
});
