/* skins.ts — lazer's skins for the playfield: the list, which one is used, and texture and sound
 * lookups the way lazer's skins do them (MIT, ppy Pty Ltd):
 *
 *  - a texture is looked up as itself, then with .png and .jpg, case-insensitively;
 *  - "@2x" versions win and count as half size;
 *  - animations are name-0, name-1, … from the first skin that has frame 0 or the plain name;
 *  - a legacy skin falls back to lazer's "classic" textures for anything it doesn't have;
 *  - a hit sound ("soft-hitclap") is looked up as itself, then without its bank ("hitclap"), as
 *    .wav / .mp3 / .ogg, in each skin of the chain in turn: a legacy skin, then classic, then
 *    triangles (lazer's last resort); argon pro, then argon, then triangles.
 */
import { api, builtinSkinUrl, fileUrl, type BuiltinSkin } from "../api";
import { store } from "../store";
import type { SkinEntry, SkinList } from "../types";
import { LATEST_VERSION, parseSkinIni, type SkinIni } from "./ini";

/** lazer's built-in skins */
export const ARGON_ID = "cffa69de-b3e3-4dee-8563-3c4f425c05d0";
const ARGON: SkinEntry = { id: ARGON_ID, name: 'osu! "argon" (2022)', creator: "team osu!", kind: "argon", protected: true };

let list: Promise<SkinList> | null = null;

export function loadSkinList(refresh = false): Promise<SkinList> {
  if (!list || refresh) {
    list = api.getSkins();
    list.catch(() => (list = null));
  }
  return list;
}

/** The skin the playfield uses: Fumen's own pick, else lazer's, else argon (lazer's default). */
export function currentSkin(l: SkinList | null): SkinEntry {
  const skins = l?.skins ?? [];
  const want = store.prefs.playfieldSkin ?? l?.selected ?? null;
  return skins.find((s) => s.id === want) ?? skins.find((s) => s.id === l?.selected) ?? skins.find((s) => s.id === ARGON_ID) ?? ARGON;
}

// ── files and textures ────────────────────────────────────────────────────

export interface TexRef {
  url: string;
  /** 2 for "@2x" textures */
  ratio: number;
}

export interface Anim {
  frames: TexRef[];
  /** ms per frame */
  frameLength: number;
  loop: boolean;
}

/** lazer's ResourceStore lookup key: forward slashes, lowercase */
const key = (name: string): string => name.replace(/\\/g, "/").toLowerCase();

/** One skin's files plus its skin.ini. */
export class FileSource {
  private readonly files = new Map<string, string>();

  constructor(
    entries: Iterable<[string, string]>,
    /** null when the skin has no skin.ini */
    readonly ini: SkinIni | null,
    /** lazer's classic skin is always the latest version */
    private readonly forcedVersion?: number,
  ) {
    for (const [name, url] of entries) this.files.set(key(name), url);
  }

  get version(): number {
    return this.forcedVersion ?? this.ini?.version ?? LATEST_VERSION;
  }

  /** TextureStore.Get: the name, then name.png, name.jpg */
  find(name: string): string | undefined {
    const k = key(name);
    return this.files.get(k) ?? this.files.get(`${k}.png`) ?? this.files.get(`${k}.jpg`);
  }

  /** SampleStore.Get: the name, then name.wav, name.mp3, name.ogg */
  sound(name: string): string | undefined {
    const k = key(name);
    return this.files.get(k) ?? this.files.get(`${k}.wav`) ?? this.files.get(`${k}.mp3`) ?? this.files.get(`${k}.ogg`);
  }

  /** LegacySkin.GetTexture: "@2x" first */
  texture(name: string): TexRef | null {
    name = name.replaceAll("@2x", "");
    const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
    const dot = name.lastIndexOf(".");
    const hasExt = dot > slash && dot < name.length - 1;
    const twoX = hasExt ? `${name.slice(0, dot)}@2x${name.slice(dot)}` : `${name.replace(/\.$/, "")}@2x`;
    const hi = this.find(twoX);
    if (hi) return { url: hi, ratio: 2 };
    const lo = this.find(name);
    return lo ? { url: lo, ratio: 1 } : null;
  }

  /** skin.ini's AnimationFramerate, if positive */
  get animationFramerate(): number | null {
    const v = Number.parseInt(this.ini?.config.get("AnimationFramerate") ?? "", 10);
    return v > 0 ? v : null;
  }
}

const SIXTY_FRAME_TIME = 1000 / 60;

/** A chain of skins to look textures up in (lazer's ISkinSource). */
export class TextureChain {
  constructor(readonly sources: FileSource[]) {}

  texture(name: string): TexRef | null {
    for (const s of this.sources) {
      const t = s.texture(name);
      if (t) return t;
    }
    return null;
  }

  /** LegacySkinExtensions.GetAnimation */
  animation(name: string, animatable: boolean, looping: boolean, opts: { applyConfigFrameRate?: boolean; frameLength?: number } = {}): Anim | null {
    const source = this.sources.find((s) => (animatable && s.texture(`${name}-0`)) || s.texture(name));
    if (!source) return null;
    const frames: TexRef[] = [];
    if (animatable) {
      for (let i = 0; ; i++) {
        const t = source.texture(`${name}-${i}`);
        if (!t) break;
        frames.push(t);
      }
    }
    if (!frames.length) {
      const t = source.texture(name);
      if (!t) return null;
      return { frames: [t], frameLength: SIXTY_FRAME_TIME, loop: looping };
    }
    let frameLength = opts.frameLength;
    if (frameLength === undefined) {
      if (opts.applyConfigFrameRate) {
        const rate = source.animationFramerate;
        frameLength = rate ? 1000 / rate : 1000 / frames.length;
      } else frameLength = SIXTY_FRAME_TIME;
    }
    return { frames, frameLength, loop: looping };
  }
}

/** The frame of an animation `elapsed` ms after it started. */
export function frameAt(a: Anim, elapsed: number): TexRef {
  const n = a.frames.length;
  if (n === 1 || !(elapsed > 0)) return a.frames[0];
  const i = Math.floor(elapsed / a.frameLength);
  return a.frames[a.loop ? i % n : Math.min(i, n - 1)];
}

// ── images ────────────────────────────────────────────────────────────────

const images = new Map<string, Promise<HTMLImageElement | null>>();
const ready = new Map<string, HTMLImageElement>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        ready.set(url, img);
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    images.set(url, p);
  }
  return p;
}

/** Loads every texture of the animations / textures given. */
export async function preload(refs: (TexRef | Anim | null | undefined)[]): Promise<void> {
  const urls = new Set<string>();
  for (const r of refs) {
    if (!r) continue;
    if ("frames" in r) r.frames.forEach((f) => urls.add(f.url));
    else urls.add(r.url);
  }
  await Promise.all([...urls].map(loadImage));
}

/** A loaded texture's image and its size in skin units (pixels / ratio), or null. */
export function tex(ref: TexRef | null | undefined): { img: HTMLImageElement; w: number; h: number } | null {
  if (!ref) return null;
  const img = ready.get(ref.url);
  if (!img || !img.naturalWidth) return null;
  return { img, w: img.naturalWidth / ref.ratio, h: img.naturalHeight / ref.ratio };
}

// ── skins ─────────────────────────────────────────────────────────────────

export interface LoadedSkin {
  entry: SkinEntry;
  /** legacy skins: the skin, then lazer's classic textures (empty for argon / triangles) */
  chain: FileSource[];
  /** the skin itself (null for argon / triangles; classic for the classic skin) */
  own: FileSource | null;
}

const loaded = new Map<string, Promise<LoadedSkin>>();

async function fetchIni(url: string | undefined): Promise<SkinIni | null> {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseSkinIni(new TextDecoder().decode(await res.arrayBuffer()));
}

/** A built-in skin's extracted files (no skin.ini). */
function builtinFiles(l: SkinList, skin: BuiltinSkin): FileSource | null {
  const names = { classic: l.classic, retro: l.retro, triangles: l.triangles, argon: l.argon, "argon-pro": l.argonPro }[skin] ?? [];
  return names.length ? new FileSource(names.map((n): [string, string] => [n, builtinSkinUrl(skin, n)]), null) : null;
}

async function builtinSource(l: SkinList, skin: "classic" | "retro"): Promise<FileSource | null> {
  const names = skin === "classic" ? l.classic : l.retro;
  if (!names.length) return null;
  const entries = names.map((n): [string, string] => [n, builtinSkinUrl(skin, n)]);
  if (skin === "classic") return new FileSource(entries, null, 2.7);
  const ini = await fetchIni(entries.find(([n]) => n.toLowerCase() === "skin.ini")?.[1]).catch(() => null);
  return new FileSource(entries, ini);
}

export function loadSkin(entry: SkinEntry, l: SkinList): Promise<LoadedSkin> {
  let p = loaded.get(entry.id);
  if (!p) {
    p = (async (): Promise<LoadedSkin> => {
      if (entry.kind === "argon" || entry.kind === "argon-pro" || entry.kind === "triangles") return { entry, chain: [], own: null };
      const classic = await builtinSource(l, "classic");
      let own: FileSource | null;
      if (entry.kind === "classic") own = classic;
      else if (entry.kind === "retro") own = await builtinSource(l, "retro");
      else {
        const files = await api.getSkinFiles(entry.id);
        const entries = files.map(([name, hash]): [string, string] => [name, fileUrl(hash)]);
        const ini = await fetchIni(entries.find(([n]) => n.toLowerCase() === "skin.ini")?.[1]).catch(() => null);
        own = new FileSource(entries, ini);
      }
      const chain = [own, own === classic ? null : classic].filter((s): s is FileSource => !!s);
      return { entry, chain, own };
    })();
    p.catch(() => loaded.delete(entry.id));
    loaded.set(entry.id, p);
  }
  return p;
}

// ── sounds ────────────────────────────────────────────────────────────────

/** The skins a skin's hit sounds come from, in lookup order (lazer's ISkinSource for samples). */
export class SoundChain {
  constructor(readonly sources: FileSource[]) {}

  /** A skin sample ("soft-hitclap"): each skin in turn, with the bank, then without it. */
  find(name: string): string | undefined {
    const bare = name.slice(name.indexOf("-") + 1);
    for (const s of this.sources) {
      const url = s.sound(name) ?? s.sound(bare);
      if (url) return url;
    }
    return undefined;
  }
}

export async function loadSkinSounds(entry: SkinEntry, l: SkinList): Promise<SoundChain> {
  const triangles = builtinFiles(l, "triangles");
  let chain: (FileSource | null)[];
  if (entry.kind === "triangles") chain = [];
  else if (entry.kind === "argon") chain = [builtinFiles(l, "argon")];
  else if (entry.kind === "argon-pro") chain = [builtinFiles(l, "argon-pro"), builtinFiles(l, "argon")];
  // legacy, classic, retro: the skin, then classic (as for textures)
  else chain = (await loadSkin(entry, l)).chain;
  return new SoundChain([...chain, triangles].filter((s): s is FileSource => !!s));
}

/** Forget loaded skins (after a re-import, files may have changed). */
export function clearSkins(): void {
  loaded.clear();
  list = null;
}
