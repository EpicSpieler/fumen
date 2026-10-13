import { describe, expect, it, vi } from "vitest";

// skins.ts reaches the Tauri API, which looks at the window when loaded
vi.mock("../api", () => ({ api: {}, builtinSkinUrl: () => "", fileUrl: () => "" }));

const { FileSource, SoundChain } = await import("./skins");

const source = (...names: string[]) => new FileSource(names.map((n): [string, string] => [n, `url:${n}`]), null);

describe("skin samples for osu!taiko's drum", () => {
  const triangles = source("normal-hitnormal.wav", "soft-hitclap.wav", "normal-hitfinish.wav", "hitwhistle.wav");

  it("legacy skins: taiko- first in the legacy skins, then lazer's defaults without it", () => {
    // a skin with mania sounds only: those don't stand in for the drum
    const skin = source("taiko-soft-hitclap.wav", "normal-hitnormal.ogg");
    const classic = source("taiko-normal-hitnormal.wav", "taiko-normal-hitfinish.wav");
    const chain = new SoundChain([skin, classic, triangles], 2);
    expect(chain.find("taiko:b:soft-hitclap:soft")).toBe("url:taiko-soft-hitclap.wav");
    expect(chain.find("taiko:b:normal-hitnormal:drum")).toBe("url:taiko-normal-hitnormal.wav");
    expect(chain.find("taiko:s:normal-hitfinish:normal")).toBe("url:taiko-normal-hitfinish.wav");
    // nowhere with the prefix: the defaults, bank then bare name
    expect(chain.find("taiko:s:drum-hitwhistle:normal")).toBe("url:hitwhistle.wav");
    // no flourish outside argon
    expect(chain.find("taiko:f:normal-hitflourish:strong")).toBeUndefined();
    // other rulesets' samples as before
    expect(chain.find("soft-hitclap")).toBe("url:soft-hitclap.wav");
  });

  it("argon: its own drums by volume bank, no second strong sound, flourishes", () => {
    const argon = source("taiko-drum-hitnormal.wav", "taiko-strong-hitclap.wav", "taiko-strong-hitflourish.wav", "normal-hitfinish.wav");
    const chain = new SoundChain([argon, triangles], 0, true);
    expect(chain.find("taiko:b:soft-hitnormal:drum")).toBe("url:taiko-drum-hitnormal.wav");
    expect(chain.find("taiko:b:soft-hitclap:strong")).toBe("url:taiko-strong-hitclap.wav");
    expect(chain.find("taiko:s:soft-hitfinish:normal")).toBeUndefined();
    expect(chain.find("taiko:f:soft-hitflourish:strong")).toBe("url:taiko-strong-hitflourish.wav");
    // after the beatmap's own sound: the usual lookup
    expect(chain.find("taiko:S:normal-hitfinish:normal")).toBe("url:normal-hitfinish.wav");
  });
});
