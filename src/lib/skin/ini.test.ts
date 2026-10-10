import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMN_SIZE, DEFAULT_HIT_POSITION, LATEST_VERSION, parseSkinIni } from "./ini";

describe("skin.ini (lazer's decoder)", () => {
  it("reads the version, 1.0 when missing", () => {
    expect(parseSkinIni("[General]\nName: x\n").version).toBe(1);
    expect(parseSkinIni("[General]\nVersion: 2.5\n").version).toBe(2.5);
    expect(parseSkinIni("[General]\nVersion: latest\n").version).toBe(LATEST_VERSION);
    // not a decimal: ignored
    expect(parseSkinIni("[General]\nVersion: 2,5\n").version).toBe(1);
    // comments after values, BOM, CRLF
    expect(parseSkinIni("﻿[General]\r\nVersion: 2.4 // old\r\n").version).toBe(2.4);
  });

  it("holds [Mania] lines until Keys and scales by 1.6", () => {
    const ini = parseSkinIni(`[Mania]
ColumnWidth: 40,50,50,40
HitPosition: 402
Keys: 4
ColumnSpacing: 10,0,10
ColumnLineWidth: 1,1,1,1,1
Colour1: 10,20,30,128
NoteImage0: Notes\\note1
JudgementLine: 0`);
    const c = ini.mania.get(4)!;
    expect(c.columnWidth).toEqual([64, 80, 80, 64]);
    expect(c.hitPosition).toBeCloseTo(DEFAULT_HIT_POSITION);
    expect(c.columnSpacing).toEqual([16, 0, 16]);
    expect(c.columnLineWidth).toEqual([1, 1, 1, 1, 1]);
    expect(c.colours.get("Colour1")).toEqual([10, 20, 30, 128]);
    expect(c.images.get("NoteImage0")).toBe("Notes\\note1");
    expect(c.showJudgementLine).toBe(false);
  });

  it("clamps the hit position and reads bad array entries as zero", () => {
    const c = parseSkinIni("[Mania]\nKeys: 2\nHitPosition: 100\nColumnWidth: 30,abc,99\n").mania.get(2)!;
    expect(c.hitPosition).toBeCloseTo(240 * 1.6);
    expect(c.columnWidth).toEqual([48, 0]);
  });

  it("ignores duplicate key counts and forgets lines across sections", () => {
    const ini = parseSkinIni(`[Mania]
Keys: 4
ColumnWidth: 20
[Mania]
Keys: 4
ColumnWidth: 40
[Mania]
ColumnWidth: 25
[Colours]
[Mania]
Keys: 7`);
    expect(ini.mania.get(4)!.columnWidth[0]).toBe(32);
    expect(ini.mania.get(7)!.columnWidth[0]).toBe(DEFAULT_COLUMN_SIZE);
  });

  it("stops applying a section's lines after a bad value, like lazer", () => {
    const c = parseSkinIni(`[Mania]
Keys: 4
BarlineHeight: 2
HitPosition: nope
ColumnWidth: 20
JudgementLine: 0`).mania.get(4)!;
    expect(c.barLineHeight).toBe(2);
    expect(c.columnWidth[0]).toBe(DEFAULT_COLUMN_SIZE);
    expect(c.showJudgementLine).toBe(true);
  });

  it("skips bad colours and keys only", () => {
    const ini = parseSkinIni(`[Mania]
Keys: x
Keys: 5
Colour1: 300,0,0
ColourLight1: 1,2`);
    // the colour line fails and stays held, so the next line fails with it
    expect(ini.mania.get(5)!.colours.size).toBe(0);
    expect(ini.mania.has(0)).toBe(false);
  });

  it("keeps general settings from every section but colours", () => {
    const ini = parseSkinIni("[General]\nAnimationFramerate: 30\n[Colours]\nCombo1: 1,2,3\n[Mania]\nKeys: 4\nNoteBodyStyle: 0\n");
    expect(ini.config.get("AnimationFramerate")).toBe("30");
    expect(ini.config.has("Combo1")).toBe(false);
    expect(ini.mania.get(4)!.noteBodyStyle).toBe(0);
  });
});
