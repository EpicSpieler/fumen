/* hitsounds.ts — the playing chart's hitsounds in the fullscreen playfield, as lazer plays them
 * under autoplay: every note's sounds at its time, the set's custom samples and storyboard
 * samples included (which sounds: src-tauri/src/hitsounds.rs), the rest from the skin. osu!'s
 * slider slides and spinner spins loop for as long as they last (a spin rising in pitch); a
 * banana shower's bananas sound higher one by one.
 *
 * Sounds are scheduled a little ahead on the Web Audio clock the song itself plays through
 * (eq.ts), mapped from the song's position; a jump in the song (seek, loop) or a pause stops
 * what's playing and starts over from there. Rate mods change their pitch, as lazer's do. The
 * volume is the player's volume times the hitsound slider, both on the player's perceptual curve.
 */
import { player } from "../player";
import { api, fileUrl } from "./api";
import { lowerBound } from "./charts";
import { audioContext } from "./eq";
import type { SoundChain } from "./skin/skins";
import { events as storeEvents, store } from "./store";
import type { ChartSounds } from "./types";
import { wavFallback } from "./wav";

/** how far ahead sounds are scheduled, s */
const LOOKAHEAD = 0.12;
/** scheduling interval, ms */
const TICK = 25;
/** a sound this late (ms of song) is dropped rather than played late */
const LATE = 40;
/** numbers per looping sound in `ChartSounds.loops` */
const LOOP = 7;
/** the song's clock and the mapping onto Web Audio's may part by this much (ms of song) before
 * it counts as a jump */
const JUMP = 40;

const buffers = new Map<string, Promise<AudioBuffer | null>>();

function decode(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bytes = await res.arrayBuffer();
      try {
        // decoding takes the buffer; keep the original for the fallback
        return await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        // WAVs the webview can't read (Ogg inside, ADPCM): wav.ts
        const alt = wavFallback(bytes);
        if (!alt) return null;
        if ("encoded" in alt) return await ctx.decodeAudioData(alt.encoded);
        const out = ctx.createBuffer(alt.channels.length, alt.channels[0].length, alt.rate);
        alt.channels.forEach((c, i) => out.copyToChannel(c as Float32Array<ArrayBuffer>, i));
        return out;
      }
    })().catch(() => null);
    buffers.set(url, p);
  }
  return p;
}

interface Voice {
  src: AudioBufferSourceNode;
  /** context time it ends */
  end: number;
}

class Hitsounds {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private chart: { id: string; sounds: Promise<ChartSounds> } | null = null;
  private sounds: ChartSounds | null = null;
  /** decoded sound per sample (null while loading, or missing) */
  private bufs: (AudioBuffer | null)[] = [];
  /** playback rate per sample (bananas) */
  private pitches: number[] = [];
  private loaded = "";
  private job = 0;
  private active = false;
  private timer = 0;
  /** next event (index into `sounds.events`) */
  private next = 0;
  /** next looping sound (index of its start in `sounds.loops`) */
  private nextLoop = 0;
  /** song ms at context time `at`, at `rate` */
  private anchor: { song: number; at: number; rate: number } | null = null;
  private voices: Voice[] = [];
  private offs: (() => void)[] = [];

  constructor() {
    storeEvents.on("prefs", (p) => {
      if ("volume" in p || "hitsoundVolume" in p) this.applyVolume();
    });
  }

  /** The chart's hitsounds with a skin's samples; replaces what was loaded. */
  async load(mapId: string, skin: SoundChain, skinId: string): Promise<void> {
    const key = `${mapId}|${skinId}`;
    if (key === this.loaded) return;
    this.loaded = key;
    const job = ++this.job;
    this.halt();
    this.sounds = null;
    this.bufs = [];
    this.pitches = [];
    const ctx = this.context();
    if (!ctx) return;
    if (this.chart?.id !== mapId) {
      const sounds = api.getHitsounds(mapId);
      this.chart = { id: mapId, sounds };
      sounds.catch(() => this.chart?.id === mapId && (this.chart = null));
    }
    let sounds: ChartSounds;
    try {
      sounds = await this.chart!.sounds;
    } catch (e) {
      console.warn("[hitsounds]", e);
      return;
    }
    if (job !== this.job) return;
    const urls = sounds.samples.map((s) => ("file" in s ? fileUrl(s.file) : skin.find(s.skin)));
    // only this chart's sounds stay decoded (keysounded charts would pile up)
    const keep = new Set(urls);
    for (const url of [...buffers.keys()]) if (!keep.has(url)) buffers.delete(url);
    this.sounds = sounds;
    this.bufs = urls.map(() => null);
    this.pitches = sounds.samples.map(Hitsounds.pitch);
    // sounds join as they're decoded (keysounded charts have hundreds)
    urls.forEach((url, i) => {
      if (!url) return;
      void decode(ctx, url).then((b) => {
        if (job === this.job) this.bufs[i] = b;
      });
    });
    this.tick();
  }

  /** Forgets the chart (a difficulty the playfield doesn't show). */
  clear(): void {
    this.job++;
    this.loaded = "";
    this.halt();
    this.sounds = null;
    this.bufs = [];
  }

  /** How many of the chart's samples are the set's own, or null before it's loaded. */
  get custom(): number | null {
    return this.sounds ? this.sounds.samples.filter((s) => "file" in s).length : null;
  }

  /** Plays while on: the fullscreen playfield is showing a chart. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      const a = player.audio;
      const kick = () => this.tick();
      for (const ev of ["play", "pause", "seeking", "seeked", "ratechange"]) {
        a.addEventListener(ev, kick);
        this.offs.push(() => a.removeEventListener(ev, kick));
      }
      this.timer = window.setInterval(kick, TICK);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.offs.forEach((f) => f());
      this.offs = [];
      this.halt();
    }
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = audioContext();
    if (!ctx) return null;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.applyVolume();
    return ctx;
  }

  private applyVolume(): void {
    if (!this.out || !this.ctx) return;
    const v = store.prefs.volume;
    const h = store.prefs.hitsoundVolume;
    this.out.gain.setTargetAtTime(v * v * h * h, this.ctx.currentTime, 0.015);
  }

  private tick(): void {
    const ctx = this.ctx;
    const s = this.sounds;
    const a = player.audio;
    if (!this.active || !ctx || !s || a.paused || a.seeking || ctx.state !== "running") return this.halt();
    const now = ctx.currentTime;
    const song = a.currentTime * 1000;
    const rate = player.rate;
    let an = this.anchor;
    if (an && an.rate === rate) {
      const drift = song - (an.song + (now - an.at) * 1000 * rate);
      if (Math.abs(drift) > JUMP) an = null;
      // follow the element's clock, gently: it moves in steps
      else an.song += drift * 0.1;
    } else an = null;
    if (!an) {
      this.halt();
      an = this.anchor = { song, at: now, rate };
      this.next = lowerBound(s.events, song - LATE);
      // loops under way carry on from here
      const loops = s.loops ?? [];
      this.nextLoop = 0;
      while (this.nextLoop < loops.length && loops[this.nextLoop] < song) {
        if (loops[this.nextLoop + 1] > song) this.loop(ctx, an, this.nextLoop, song);
        this.nextLoop += LOOP;
      }
    }
    const horizon = an.song + (now + LOOKAHEAD - an.at) * 1000 * rate;
    const ev = s.events;
    while (this.next < ev.length && ev[this.next] <= horizon) {
      const t = ev[this.next];
      const buf = this.bufs[ev[this.next + 1]];
      const vol = ev[this.next + 2];
      this.next += 3;
      if (!buf || vol <= 0) continue;
      const at = an.at + (t - an.song) / 1000 / rate;
      if (at < now - LATE / 1000) continue;
      this.play(ctx, buf, Math.max(at, now), vol / 100, rate * this.pitches[ev[this.next - 2]]);
    }
    const loops = s.loops ?? [];
    while (this.nextLoop < loops.length && loops[this.nextLoop] <= horizon) {
      this.loop(ctx, an, this.nextLoop, loops[this.nextLoop]);
      this.nextLoop += LOOP;
    }
    this.voices = this.voices.filter((v) => v.end > now);
  }

  /** Starts the looping sound at `i` (into `sounds.loops`) from song time `from`. */
  private loop(ctx: AudioContext, an: { song: number; at: number; rate: number }, i: number, from: number): void {
    const l = this.sounds!.loops!;
    const [start, end, sample, volume, rate0, rate1, rampEnd] = l.slice(i, i + LOOP);
    const buf = this.bufs[sample];
    if (!buf || volume <= 0 || end <= from) return;
    const now = ctx.currentTime;
    const when = (song: number) => an.at + (song - an.song) / 1000 / an.rate;
    const at = Math.max(now, when(from));
    const stop = when(end);
    if (stop <= at) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // the pitch: from rate0 at the start to rate1 at the ramp's end (and the song's rate on top)
    const rateAt = (song: number) => (rampEnd > start ? rate0 + (rate1 - rate0) * Math.min(1, Math.max(0, (song - start) / (rampEnd - start))) : rate1);
    src.playbackRate.setValueAtTime(rateAt(from) * an.rate, at);
    if (rampEnd > from) src.playbackRate.linearRampToValueAtTime(rate1 * an.rate, Math.max(at, when(rampEnd)));
    const g = ctx.createGain();
    g.gain.value = volume / 100;
    src.connect(g).connect(this.out!);
    src.start(at);
    src.stop(stop);
    this.voices.push({ src, end: stop });
  }

  /** DrawableBanana: a shower's bananas sound higher one by one ("catch:banana:<number>") */
  private static pitch(s: ChartSounds["samples"][number]): number {
    const m = "skin" in s ? /^catch:banana:(\d+)$/.exec(s.skin) : null;
    return m ? 0.77 + Number(m[1]) * 0.006 : 1;
  }

  private play(ctx: AudioContext, buf: AudioBuffer, at: number, gain: number, rate: number): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (gain < 1) {
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.out!);
    } else src.connect(this.out!);
    src.start(at);
    this.voices.push({ src, end: at + buf.duration / rate });
  }

  /** Stops every sound playing or scheduled. */
  private halt(): void {
    this.anchor = null;
    for (const v of this.voices) {
      try {
        v.src.stop();
      } catch {
        // never started
      }
    }
    this.voices = [];
  }
}

export const hitsounds = new Hitsounds();
