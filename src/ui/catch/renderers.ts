/* renderers.ts — the osu!catch renderer for a lazer skin (argon, argon pro, triangles, or a legacy
 * skin over lazer's classic textures), its textures loaded. */
import { builtinSkinUrl } from "../../lib/api";
import { FileSource, TextureChain, type LoadedSkin } from "../../lib/skin/skins";
import type { SkinList } from "../../lib/types";
import { ArgonCatchRenderer } from "./argon";
import { LegacyCatchRenderer } from "./legacy";
import type { CatchRenderer } from "./playfield";
import { loadCatcherDefaults, TrianglesCatchRenderer, type DefaultCatcherTextures } from "./triangles";

/** lazer's own catcher textures (osu.Game.Resources Textures/Gameplay/catch), extracted with triangles. */
function defaults(list: SkinList): Promise<DefaultCatcherTextures> {
  const files = new TextureChain([new FileSource(list.triangles.map((n): [string, string] => [n, builtinSkinUrl("triangles", n)]), null)]);
  return loadCatcherDefaults((name) => files.texture(name));
}

export async function createCatchRenderer(skin: LoadedSkin, list: SkinList): Promise<CatchRenderer> {
  switch (skin.entry.kind) {
    case "argon":
    case "argon-pro":
      return new ArgonCatchRenderer();
    case "triangles":
      return new TrianglesCatchRenderer(await defaults(list));
  }
  const t = await defaults(list);
  // legacy skins (classic, retro, yours): theirs first, then lazer's classic textures
  if (skin.chain.length) return LegacyCatchRenderer.create(skin, t);
  return new TrianglesCatchRenderer(t);
}
