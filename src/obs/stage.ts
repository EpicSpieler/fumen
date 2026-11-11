/* stage.ts — the visualizer as an OBS source (/obs/stage): the window's visualizer (views/vis)
 * with a host of its own. The song is osu!'s (tosu's time, the play answered as in the window);
 * while osu! plays nothing and Fumen does (music in a BRB scene), Fumen's. The levels come from the
 * song decoded here (./spectrum), the beats from what the window sent with the map.
 *
 * Address options: `style` (one of the visualizer's styles), `bg=none` (see-through over gameplay:
 * the strip of light and the words only), `title=0`, `stats=0|1`, `react=0`. */
import { DEFAULT_PREFS } from "../lib/store";
import type { VisPrefs, VisStyle } from "../lib/types";
import { STYLES, Visualizer, type VisHost } from "../views/vis/visualizer";
import { artUrl, audioUrl, link, params, parts } from "./link";
import { inMap, live } from "./live";
import { Spectrum } from "./spectrum";

interface Track {
  key: string;
  kind: "osu" | "fumen";
  bg: string | null;
  audio: string | null;
  title: string;
  artist: string;
  version: string;
  beats: number[];
  kiai: number[];
}

/** The window's settings with this address' own on top (no video here). */
function prefs(): VisPrefs {
  const o: VisPrefs = { ...DEFAULT_PREFS.visualizer, ...(parts.config?.vis ?? {}) };
  const style = params.get("style");
  if (style && STYLES.some((s) => s.id === style)) o.style = style as VisStyle;
  for (const k of ["title", "stats", "react"] as const) {
    const v = params.get(k);
    if (v === "0") o[k] = false;
    else if (v === "1") o[k] = true;
  }
  o.video = false;
  return o;
}

/** What plays now: osu!'s song while it has one going (or nothing else plays), else Fumen's. */
function current(): Track | null {
  const now = live.now;
  const song = live.song();
  const p = parts.player;
  if (now?.md5 && (song?.playing || inMap(now.state) || !p?.playing)) {
    const m = parts.map?.md5 === now.md5 ? parts.map : null;
    return {
      key: `osu ${now.md5} ${m?.bg ?? ""} ${m?.audio ?? ""} ${m?.beats.length ?? 0}`,
      kind: "osu",
      bg: m?.bg ?? null,
      audio: m?.audio ?? null,
      title: m?.title ?? now.title,
      artist: m?.artist ?? now.artist,
      version: m ? `${m.version} · mapped by ${m.creator}` : now.version,
      beats: m?.beats ?? [],
      kiai: m?.kiai ?? [],
    };
  }
  if (p)
    return {
      key: `fumen ${p.audio ?? ""} ${p.bg ?? ""} ${p.title} ${p.version} ${p.beats.length}`,
      kind: "fumen",
      bg: p.bg,
      audio: p.audio,
      title: p.title,
      artist: p.artist,
      version: p.version,
      beats: p.beats,
      kiai: p.kiai,
    };
  return null;
}

export function start(): void {
  const canvas = document.createElement("canvas");
  canvas.className = "obs-canvas";
  document.getElementById("obs")!.append(canvas);
  const spectrum = new Spectrum();
  let track: Track | null = null;
  /** this frame's song */
  const at = { playing: false, rate: 1, pos: 0 };

  const host: VisHost = {
    clear: params.get("bg") === "none",
    prefs,
    playing: () => at.playing,
    rate: () => at.rate,
    position: () => at.pos,
    latency: () => 0,
    analysers: () => spectrum.at(at.pos),
    play: (dt, now) => (track?.kind === "osu" ? live.feel.frame(dt, now) : null),
    artUrl,
    timing: (id) => (track && track.key === id && track.beats.length ? Promise.resolve({ beats: track.beats, kiai: track.kiai }) : Promise.reject(new Error("no beats"))),
    video: () => Promise.resolve(null),
  };
  const vis = new Visualizer(canvas, () => {}, host);
  link.on("config", () => vis.sync());

  let last = performance.now();
  const frame = (t: number): void => {
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    const next = current();
    if ((next?.key ?? "") !== (track?.key ?? "")) {
      track = next;
      if (next) vis.setTrack({ bg: next.bg, mapId: next.key, title: next.title, artist: next.artist, version: next.version });
      spectrum.use(next?.audio ? audioUrl(next.audio) : null);
    }
    if (track?.kind === "osu") {
      const s = live.song();
      at.playing = !!s?.playing;
      at.pos = s?.pos ?? at.pos;
      at.rate = live.now?.rate ?? 1;
    } else if (track?.kind === "fumen" && parts.player) {
      const p = parts.player;
      at.playing = p.playing;
      at.rate = p.rate;
      at.pos = p.playing ? p.pos + ((Date.now() - p.at) / 1000) * p.rate : p.pos;
    } else at.playing = false;
    vis.frame(dt, { top: 0, bottom: 0, drop: 0 });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
