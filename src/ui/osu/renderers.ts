/* renderers.ts — the osu! renderer for a lazer skin (argon, argon pro, triangles, or a legacy skin
 * over lazer's classic textures), its textures loaded. */
import { builtinSkinUrl } from "../../lib/api";
import { FileSource, TextureChain, type LoadedSkin } from "../../lib/skin/skins";
import type { ChartData, SkinList } from "../../lib/types";
import { ArgonOsuRenderer } from "./argon";
import { OsuChart } from "./chart";
import { LegacyOsuRenderer } from "./legacy";
import type { OsuRenderer } from "./playfield";
import { loadDefaults, TrianglesOsuRenderer, type DefaultTextures } from "./triangles";

/** lazer's own textures (osu.Game.Resources Textures/Gameplay/osu, Cursor), extracted with triangles. */
function defaults(list: SkinList): Promise<DefaultTextures> {
  const files = new TextureChain([new FileSource(list.triangles.map((n): [string, string] => [n, builtinSkinUrl("triangles", n)]), null)]);
  return loadDefaults((name) => files.texture(name));
}

export async function createOsuRenderer(skin: LoadedSkin, list: SkinList, data: ChartData): Promise<OsuRenderer> {
  const t = await defaults(list);
  switch (skin.entry.kind) {
    case "argon":
      return new ArgonOsuRenderer(t);
    case "argon-pro":
      return new ArgonOsuRenderer(t, true);
    case "triangles":
      return new TrianglesOsuRenderer(t);
  }
  // legacy skins (classic, retro, yours): theirs first, then lazer's classic textures
  if (skin.chain.length) return LegacyOsuRenderer.create(skin, new OsuChart(data), t);
  return new TrianglesOsuRenderer(t);
}
