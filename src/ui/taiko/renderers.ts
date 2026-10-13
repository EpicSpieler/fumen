/* renderers.ts — the osu!taiko renderer for a lazer skin (argon, argon pro, triangles, or a legacy
 * skin over lazer's classic textures), its textures loaded. */
import { builtinSkinUrl } from "../../lib/api";
import { FileSource, preload, TextureChain, type LoadedSkin } from "../../lib/skin/skins";
import type { SkinList } from "../../lib/types";
import { ArgonTaikoRenderer } from "./argon";
import { LegacyTaikoRenderer } from "./legacy";
import type { TaikoRenderer } from "./playfield";
import { TrianglesRenderer, type DrumTextures } from "./triangles";

/** lazer's default drum (osu.Game.Resources Textures/Gameplay/taiko), extracted with triangles. */
async function defaultDrum(list: SkinList): Promise<DrumTextures> {
  const files = new TextureChain([new FileSource(list.triangles.map((n): [string, string] => [n, builtinSkinUrl("triangles", n)]), null)]);
  const drum: DrumTextures = {
    outer: files.texture("taiko-drum-outer"),
    outerHit: files.texture("taiko-drum-outer-hit"),
    inner: files.texture("taiko-drum-inner"),
    innerHit: files.texture("taiko-drum-inner-hit"),
  };
  await preload(Object.values(drum));
  return drum;
}

export async function createTaikoRenderer(skin: LoadedSkin, list: SkinList): Promise<TaikoRenderer> {
  switch (skin.entry.kind) {
    case "argon":
      return new ArgonTaikoRenderer();
    case "argon-pro":
      return new ArgonTaikoRenderer(true);
    case "triangles":
      return new TrianglesRenderer(await defaultDrum(list));
  }
  // legacy skins (classic, retro, yours): theirs first, then lazer's classic textures
  if (skin.chain.length) return LegacyTaikoRenderer.create(skin);
  return new TrianglesRenderer(await defaultDrum(list));
}
