/* player.ts — plays beatmap sets' songs + the player under the content.
 *
 * Plays the set's own audio file from lazer's store (no network), from the beginning of the song.
 * One player for the whole app; views subscribe to changes.
 * Whoever starts playback can hand over the list it came from (a library page, a carousel), so
 * next/previous and the end of a track continue through what the user was looking at.
 * The playback rate works like lazer's rate mods: it applies to whatever plays until it's reset,
 * and times shown in the bar are at that rate. The other mods (lib/mods) work the same way: picked
 * once, they stay on for whatever plays.
 */
import { fileUrl, thumbUrl } from "./lib/api";
import { displayArtist, displayTitle, duration, esc, fixed } from "./lib/format";
import { go } from "./lib/router";
import { Emitter, events, setPrefs, store } from "./lib/store";
import type { Mod } from "./lib/mods";
import type { RepeatMode } from "./lib/types";
import { toast } from "./ui/controls";
import { icon } from "./ui/icons";
import { leadingSilence } from "./lib/silence";
import { setContentArt } from "./ui/theme";
import { setMenu } from "./views/actions";
import { t } from "./lib/i18n";

export interface NowPlaying {
  set: number;
  map: number;
  audio: string;
  bg?: string;
}

/** Going back within this many seconds of the start jumps to the previous track instead. */
const RESTART_GRACE = 3;
/** ms a song fades in when it's resumed or starts somewhere in the middle */
const RESUME_FADE = 450;
/** ms a new song waits at most for its silence to be found */
const SILENCE_WAIT = 400;

export const RATE_MIN = 0.5;
export const RATE_MAX = 2;
export const RATE_STEP = 0.05;

class Player {
  readonly bus = new Emitter<{ track: NowPlaying | null; state: boolean; queue: null; rate: number; pitch: boolean; mods: readonly Mod[] }>();
  readonly audio = new Audio();
  now: NowPlaying | null = null;
  /** playback speed, HT 0.75 / DT 1.5 or anything from 0.5 to 2 in steps of 0.05 (session only) */
  rate = 1;
  /** the other mods the playfield plays with, in lazer's order (session only) */
  mods: readonly Mod[] = [];
  /** set indices in the order of the list playback started from */
  private queue: number[] = [];
  private qpos = -1;
  /** sets played before the current one (for "previous" in shuffle) */
  private history: number[] = [];
  private startAt = 0;
  /** the running fade's timer */
  private fadeTimer = 0;
  /** the volume, once it lives in Web Audio */
  private gain: GainNode | null = null;
  /** the song is fading out towards its end (prefs fadeOut) */
  private endFade = false;
  /** bumped per track change, so a fade-out finishing late doesn't swap in an older pick */
  private swapJob = 0;
  private swapping = false;
  /** the track change waiting for the fade-out */
  private pending: (() => void) | null = null;
  /** the next track loads without starting (paused during the fade-out) */
  private holdPaused = false;
  /** the waiting "loadedmetadata" handler of the track being loaded */
  private onMeta: (() => void) | null = null;
  /** the pitch follows the rate, like Nightcore / Daycore (session only) */
  pitch = false;

  constructor() {
    this.audio.preload = "auto";
    // CORS mode, so the fullscreen visualizer can read the audio (fumen:// allows any origin)
    this.audio.crossOrigin = "anonymous";
    this.audio.preservesPitch = true;
    this.audio.addEventListener("play", () => this.bus.emit("state", true));
    this.audio.addEventListener("pause", () => this.bus.emit("state", false));
    this.audio.addEventListener("ended", () => {
      this.bus.emit("state", false);
      if (this.hasNext) this.next();
    });
    this.audio.addEventListener("timeupdate", () => this.fadeAtEnd());
    this.audio.addEventListener("seeked", () => this.fadeAtEnd());
    this.audio.addEventListener("error", () => {
      if (!this.now) return;
      toast(t("This song's audio file couldn't be played."), { kind: "danger" });
      this.stop();
    });
    events.on("prefs", (p) => {
      if ("repeat" in p) this.audio.loop = p.repeat === "one";
      if ("shuffle" in p || "repeat" in p) this.bus.emit("queue", null);
    });
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get hasNext(): boolean {
    if (!this.now) return false;
    if (store.prefs.repeat === "all") return this.queue.length > 0;
    return (store.prefs.shuffle && this.queue.length > 1) || this.qpos < this.queue.length - 1;
  }

  isCurrent(set: number): boolean {
    return this.now?.set === set;
  }

  /**
   * Plays a set's song; toggles if it's already the current track.
   * `queue` is the list the set was picked from (set indices, display order); `at` (seconds)
   * starts somewhere other than the beginning.
   */
  playSet(setIdx: number, mapIdx?: number, queue?: number[], opts: { at?: number } = {}): void {
    const snap = store.snap;
    if (!snap) return;
    const set = snap.sets[setIdx];
    const audio = (mapIdx !== undefined ? snap.maps[mapIdx]?.audio : undefined) ?? set.audio;
    if (queue) {
      this.queue = [...new Set(queue)];
      this.history = [];
    } else if (!this.queue.includes(setIdx)) {
      this.queue = [setIdx];
      this.history = [];
    }
    this.qpos = this.queue.indexOf(setIdx);
    if (this.now && this.now.set === setIdx && this.now.audio === audio && !this.swapping) {
      if (opts.at !== undefined) {
        this.audio.currentTime = Math.max(0, opts.at);
        if (!this.playing) this.fadeIn(RESUME_FADE);
      } else this.toggle();
      this.bus.emit("queue", null);
      return;
    }
    if (!this.load(setIdx, mapIdx, opts.at)) toast(t("This set has no audio file."));
  }

  /** Switches the playing difficulty within the set; keeps playing when it's the same song. */
  selectMap(mi: number): void {
    const snap = store.snap;
    const np = this.now;
    if (!snap || !np) return;
    const m = snap.maps[mi];
    if (!m || m.set !== np.set) return;
    const set = snap.sets[m.set];
    if ((m.audio ?? set.audio) === np.audio) {
      this.now = { ...np, map: mi, bg: m.bg ?? set.bg };
      this.bus.emit("track", this.now);
    } else this.playSet(m.set, mi);
  }

  /**
   * Starts a set's song from the beginning (past its silence, prefs skipSilence) or `at` seconds,
   * once the one playing has faded out (prefs fadeOut). False when the set has no audio.
   */
  private load(setIdx: number, mapIdx?: number, at?: number): boolean {
    const snap = store.snap;
    if (!snap) return false;
    const set = snap.sets[setIdx];
    const mi = mapIdx ?? set.maps[0];
    const map = snap.maps[mi];
    const audio = map?.audio ?? set.audio;
    if (!audio) return false;
    const url = fileUrl(audio);
    // looked for while the old song fades out and the new one loads
    const lead = at === undefined && store.prefs.skipSilence ? leadingSilence(url) : null;
    const after = !!this.now;
    this.swap(() => {
      this.now = { set: setIdx, map: mi, audio, bg: map?.bg ?? set.bg };
      this.bus.emit("track", this.now);
      this.bus.emit("queue", null);

      const a = this.audio;
      a.pause();
      if (this.onMeta) a.removeEventListener("loadedmetadata", this.onMeta);
      a.loop = store.prefs.repeat === "one";
      a.src = url;
      const job = this.swapJob;
      const start = async () => {
        a.removeEventListener("loadedmetadata", start);
        this.onMeta = null;
        // the silence, if it's found in time; the song doesn't wait long for it
        const skip = lead ? await Promise.race([lead, new Promise<number>((r) => setTimeout(() => r(0), SILENCE_WAIT))]) : 0;
        if (job !== this.swapJob) return;
        const d = a.duration;
        const t = Math.max(0, at ?? skip);
        this.startAt = Number.isFinite(d) ? Math.min(t, Math.max(0, d - 1)) : t;
        a.currentTime = this.startAt;
        a.playbackRate = this.rate;
        if (this.holdPaused) {
          this.holdPaused = false;
          this.setOut(this.targetVolume());
          return;
        }
        // from the start (or where the sound starts) a fade would swallow the first beat, unless asked for
        const fade = after ? store.prefs.fadeIn * 1000 : 0;
        this.fadeIn(at === undefined ? fade : Math.max(fade, RESUME_FADE));
      };
      this.onMeta = start;
      a.addEventListener("loadedmetadata", start);
      a.load();
    });
    return true;
  }

  /** Runs `change` once the song playing has faded out (prefs fadeOut); at once when nothing plays,
   * or when another change comes while it fades. */
  private swap(change: () => void): void {
    const job = ++this.swapJob;
    const ms = store.prefs.fadeOut * 1000;
    this.endFade = false;
    this.holdPaused = false;
    if (!ms || !this.playing || this.swapping) {
      this.swapping = false;
      this.pending = null;
      return change();
    }
    this.swapping = true;
    this.pending = change;
    this.ramp(0, ms, () => {
      if (job !== this.swapJob) return;
      this.swapping = false;
      this.pending = null;
      change();
    });
  }

  /** Fades the song out over its last seconds (prefs fadeOut), and back in when it's moved away from the end. */
  private fadeAtEnd(): void {
    const a = this.audio;
    const ms = store.prefs.fadeOut * 1000;
    if (!ms || a.loop || this.swapping || !Number.isFinite(a.duration)) return;
    const left = ((a.duration - a.currentTime) / (a.playbackRate || 1)) * 1000;
    if (!this.endFade && this.playing && left > 0 && left <= ms) {
      this.endFade = true;
      this.ramp(0, left);
    } else if (this.endFade && left > ms + 250) {
      this.endFade = false;
      this.ramp(this.targetVolume(), RESUME_FADE);
    }
  }

  next(): void {
    if (!this.now || !this.queue.length) return;
    const cur = this.now.set;
    const shuffle = store.prefs.shuffle && this.queue.length > 1;
    // a few attempts: sets without audio are skipped
    for (let tries = 0, pos = this.qpos; tries < Math.min(this.queue.length, 25); tries++) {
      if (shuffle) {
        do pos = Math.floor(Math.random() * this.queue.length);
        while (this.queue[pos] === cur);
      } else {
        pos++;
        if (pos >= this.queue.length) {
          if (store.prefs.repeat !== "all") return;
          pos = 0;
        }
      }
      const target = this.queue[pos];
      if (target === cur) return this.restart();
      if (this.load(target)) {
        this.history.push(cur);
        if (this.history.length > 100) this.history.shift();
        this.qpos = pos;
        return;
      }
    }
  }

  prev(): void {
    if (!this.now) return;
    if (this.audio.currentTime - this.startAt > RESTART_GRACE) return this.restart();
    const back = this.history.pop() ?? (!store.prefs.shuffle && this.qpos > 0 ? this.queue[this.qpos - 1] : undefined);
    if (back === undefined || !this.load(back)) return this.restart();
    this.qpos = this.queue.indexOf(back);
  }

  restart(): void {
    if (!this.now) return;
    this.audio.currentTime = this.startAt;
    if (!this.playing) this.fadeIn(this.startAt > 0 ? 0 : RESUME_FADE);
  }

  /** Plays, fading in over `ms` (none: at once). */
  private fadeIn(ms: number): void {
    this.endFade = false;
    if (ms > 0) this.setOut(0);
    else this.setOut(this.targetVolume());
    this.audio.play().catch((e) => console.warn("[player] play", e));
    if (ms > 0) this.ramp(this.targetVolume(), ms);
  }

  /**
   * Takes the output to `to` over `ms`, then runs `done`. On the audio clock once the song plays
   * through Web Audio, else on a timer: either keeps going while the window is hidden, where
   * animation frames stop (and a fade-in waiting on them would stay silent).
   */
  private ramp(to: number, ms: number, done?: () => void): void {
    this.stopFade();
    const ctx = this.gain?.context as AudioContext | undefined;
    if (ctx?.state === "suspended") void ctx.resume();
    if (ms <= 0 || (ctx && ctx.state !== "running")) {
      this.setOut(to);
      done?.();
      return;
    }
    if (this.gain && ctx) {
      const g = this.gain.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, now + ms / 1000);
      if (done) this.fadeTimer = window.setTimeout(done, ms);
      return;
    }
    const a = this.audio;
    const from = a.volume;
    const t0 = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      a.volume = from + (to - from) * k;
      if (k < 1) return;
      this.stopFade();
      done?.();
    }, 16);
  }

  private stopFade(): void {
    clearTimeout(this.fadeTimer);
    clearInterval(this.fadeTimer);
    this.fadeTimer = 0;
  }

  /** Routes the volume through a gain in Web Audio (lib/eq, once the song plays through it), so the
   * visualizer's analysers before it hear the song at full level. */
  useGain(gain: GainNode): void {
    const v = this.audio.volume;
    this.stopFade();
    this.gain = gain;
    this.audio.volume = 1;
    this.setOut(this.swapping || this.endFade ? v : this.targetVolume());
  }

  private setOut(v: number): void {
    if (this.gain) {
      const g = this.gain.gain;
      g.cancelScheduledValues(this.gain.context.currentTime);
      g.value = v;
    } else this.audio.volume = v;
  }

  /** Perceptual volume curve. */
  private targetVolume(): number {
    const v = store.prefs.volume;
    return Math.max(0, Math.min(1, v * v));
  }

  toggle(): void {
    if (!this.now) return;
    if (this.swapping && this.pending) {
      // paused while the old song fades out: the new one comes in paused
      const change = this.pending;
      this.swapJob++;
      this.swapping = false;
      this.pending = null;
      this.stopFade();
      this.holdPaused = true;
      change();
      return;
    }
    if (this.playing) return this.audio.pause();
    if (this.audio.ended) this.audio.currentTime = this.startAt;
    this.fadeIn(this.audio.currentTime < 0.05 ? 0 : RESUME_FADE);
  }

  stop(): void {
    this.stopFade();
    this.swapJob++;
    this.swapping = false;
    this.pending = null;
    this.holdPaused = false;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.now = null;
    this.queue = [];
    this.qpos = -1;
    this.history = [];
    this.bus.emit("track", null);
    this.bus.emit("state", false);
    this.bus.emit("queue", null);
  }

  seek(fraction: number): void {
    const d = this.audio.duration;
    if (Number.isFinite(d)) this.audio.currentTime = Math.max(0, Math.min(d, fraction * d));
  }

  setVolume(v: number): void {
    setPrefs({ volume: Math.max(0, Math.min(1, v)) });
    // a fade-out under way goes on from the new volume
    if (this.swapping || this.endFade) return;
    this.stopFade();
    this.setOut(this.targetVolume());
  }

  setRate(r: number): void {
    const v = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, r)) / RATE_STEP) * RATE_STEP;
    const rate = Math.round(v * 100) / 100;
    if (rate === this.rate) return;
    this.rate = rate;
    // pitch stays, like lazer's rate mods without "adjust pitch" (unless `pitch`)
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.bus.emit("rate", rate);
  }

  /** The pitch goes up and down with the rate (Nightcore / Daycore), or stays. */
  setPitch(on: boolean): void {
    if (on === this.pitch) return;
    this.pitch = on;
    this.audio.preservesPitch = !on;
    this.bus.emit("pitch", on);
    // what shows the rate shows the pitch with it
    this.bus.emit("rate", this.rate);
  }

  setMods(mods: readonly Mod[]): void {
    if (mods.length === this.mods.length && mods.every((m, i) => m === this.mods[i])) return;
    this.mods = mods;
    this.bus.emit("mods", mods);
  }

  toggleShuffle(): void {
    setPrefs({ shuffle: !store.prefs.shuffle });
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ["off", "all", "one"];
    setPrefs({ repeat: order[(order.indexOf(store.prefs.repeat) + 1) % order.length] });
  }
}

export const player = new Player();

// ── bar ────────────────────────────────────────────────────────────────────

const REPEAT_TIP: Record<RepeatMode, string> = {
  off: t("Repeat: off"),
  all: t("Repeat: list"),
  one: t("Repeat: this song"),
};

export function mountPlayerBar(host: HTMLElement, opts: { onFullscreen: () => void }): void {
  host.innerHTML = `
    <div class="pb-seek" role="slider" aria-label="${t("Seek")}" tabindex="0">
      <div class="pb-seek-track"><div class="pb-seek-fill"></div></div>
      <div class="pb-seek-head"></div>
      <div class="pb-seek-tip num"></div>
    </div>
    <div class="pb-row">
      <div class="pb-left">
        <button class="pb-art" type="button" data-tip="${t("Open beatmap set")}" aria-label="${t("Open beatmap set")}"><img alt="" /></button>
        <div class="pb-meta">
          <button class="pb-title" type="button"></button>
          <div class="pb-artist"></div>
          <div class="pb-time num"><span class="pb-cur">0:00</span> / <span class="pb-dur">0:00</span><button class="pb-rate" type="button" data-tip="${t("Back to normal speed")}" hidden></button></div>
        </div>
      </div>
      <div class="pb-center">
        <button class="pb-btn pb-shuffle" type="button" aria-label="${t("Shuffle")}">${icon("shuffle")}</button>
        <button class="pb-btn pb-skip pb-prev" type="button" data-tip="${t("Previous")}" aria-label="${t("Previous")}">${icon("skip-back")}</button>
        <button class="pb-play" type="button" aria-label="${t("Play")}"></button>
        <button class="pb-btn pb-skip pb-next" type="button" data-tip="${t("Next")}" aria-label="${t("Next")}">${icon("skip-forward")}</button>
        <button class="pb-btn pb-repeat" type="button" aria-label="${t("Repeat")}"></button>
      </div>
      <div class="pb-right">
        ${volumeHtml()}
        <button class="pb-btn pb-full" type="button" data-tip="${t("Fullscreen")}" aria-label="${t("Fullscreen")}">${icon("fullscreen")}</button>
        <button class="pb-btn pb-more" type="button" data-tip="${t("More")}" aria-label="${t("More")}">${icon("more-vert")}</button>
        <button class="pb-btn pb-close" type="button" data-tip="${t("Close player")}" aria-label="${t("Close player")}">${icon("x")}</button>
      </div>
    </div>`;

  const $ = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;
  const img = $<HTMLImageElement>(".pb-art img");
  const title = $<HTMLButtonElement>(".pb-title");
  const artist = $<HTMLDivElement>(".pb-artist");
  const playBtn = $<HTMLButtonElement>(".pb-play");
  const cur = $<HTMLSpanElement>(".pb-cur");
  const dur = $<HTMLSpanElement>(".pb-dur");
  const seek = $<HTMLDivElement>(".pb-seek");
  const seekTip = $<HTMLDivElement>(".pb-seek-tip");
  const shuffle = $<HTMLButtonElement>(".pb-shuffle");
  const repeat = $<HTMLButtonElement>(".pb-repeat");
  const prev = $<HTMLButtonElement>(".pb-prev");
  const next = $<HTMLButtonElement>(".pb-next");
  const rateBtn = $<HTMLButtonElement>(".pb-rate");
  const a = player.audio;

  bindVolume($<HTMLButtonElement>(".pb-mute"), $<HTMLDivElement>(".pb-vol"));

  // ── track ──
  const renderTrack = (np: NowPlaying | null) => {
    document.body.classList.toggle("has-player", !!np);
    if (!np || !store.snap) {
      setContentArtFromPlayer(null);
      updateMediaSession(null);
      return;
    }
    const set = store.snap.sets[np.set];
    const map = store.snap.maps[np.map];
    const unicode = store.prefs.unicode;
    title.textContent = displayTitle(set, unicode);
    title.dataset.tip = title.textContent;
    artist.innerHTML = `${esc(displayArtist(set, unicode))}${map ? `<span class="pb-diff">${esc(map.version)}</span>` : ""}`;
    img.classList.remove("img-missing");
    if (np.bg) {
      img.src = thumbUrl(np.bg, 160);
      img.onerror = () => img.classList.add("img-missing");
    } else {
      img.removeAttribute("src");
      img.classList.add("img-missing");
    }
    host.classList.remove("pop");
    void host.offsetWidth;
    host.classList.add("pop");
    setContentArtFromPlayer(np.bg ? thumbUrl(np.bg, 360) : null);
    updateMediaSession(np);
  };

  const renderState = (playing: boolean) => {
    host.classList.toggle("playing", playing);
    playBtn.setAttribute("aria-label", playing ? t("Pause") : t("Play"));
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.now ? (playing ? "playing" : "paused") : "none";
  };

  const renderModes = () => {
    const p = store.prefs;
    shuffle.classList.toggle("on", p.shuffle);
    shuffle.dataset.tip = p.shuffle ? t("Shuffle: on") : t("Shuffle: off");
    shuffle.setAttribute("aria-pressed", String(p.shuffle));
    repeat.classList.toggle("on", p.repeat !== "off");
    repeat.innerHTML = icon(p.repeat === "one" ? "repeat-one" : "repeat");
    repeat.dataset.tip = REPEAT_TIP[p.repeat];
    next.disabled = !player.hasNext;
  };

  const renderTime = () => {
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    const t = a.currentTime || 0;
    cur.textContent = duration((t * 1000) / player.rate);
    dur.textContent = duration((d * 1000) / player.rate);
    seek.style.setProperty("--p", d > 0 ? `${(t / d) * 100}%` : "0%");
    seek.setAttribute("aria-valuenow", String(Math.round(t)));
  };

  const renderRate = (rate: number) => {
    rateBtn.hidden = rate === 1;
    rateBtn.textContent = player.pitch ? `${rate > 1 ? "NC" : "DC"} ${fixed(rate, 2)}×` : `${fixed(rate, 2)}×`;
    rateBtn.setAttribute("aria-label", t("Playing at {rate}×, back to normal speed", { rate: fixed(rate, 2) }));
    renderTime();
  };

  player.bus.on("track", renderTrack);
  player.bus.on("state", renderState);
  player.bus.on("queue", renderModes);
  player.bus.on("rate", renderRate);
  rateBtn.addEventListener("click", () => player.setRate(1));
  a.addEventListener("timeupdate", () => {
    if (!seeking) renderTime();
  });
  a.addEventListener("durationchange", renderTime);
  events.on("prefs", (p) => {
    if ("unicode" in p && player.now) renderTrack(player.now);
  });

  playBtn.addEventListener("click", () => player.toggle());
  prev.addEventListener("click", () => player.prev());
  next.addEventListener("click", () => player.next());
  shuffle.addEventListener("click", () => player.toggleShuffle());
  repeat.addEventListener("click", () => player.cycleRepeat());
  title.addEventListener("click", () => openCurrent());
  $<HTMLButtonElement>(".pb-art").addEventListener("click", () => openCurrent());
  $<HTMLButtonElement>(".pb-close").addEventListener("click", () => player.stop());
  $<HTMLButtonElement>(".pb-full").addEventListener("click", () => opts.onFullscreen());
  $<HTMLButtonElement>(".pb-more").addEventListener("click", (e) => {
    const np = player.now;
    if (np) setMenu(e.currentTarget as HTMLElement, np.set, np.map, { onSearch: (q) => events.emit("search", q) });
  });

  // ── seeking ──
  let seeking = false;
  const timeAt = (f: number) => duration((f * (Number.isFinite(a.duration) ? a.duration : 0) * 1000) / player.rate);
  dragSlider(
    seek,
    (f, done) => {
      seeking = !done;
      seek.style.setProperty("--p", `${f * 100}%`);
      cur.textContent = timeAt(f);
      if (done) player.seek(f);
    },
    () => !!player.now,
  );
  seek.addEventListener("pointermove", (e) => {
    const r = seek.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seekTip.textContent = timeAt(f);
    seekTip.style.setProperty("--x", `${e.clientX - r.left}px`);
  });
  seek.addEventListener("keydown", (e) => {
    const d = a.duration;
    if (!Number.isFinite(d)) return;
    if (e.key === "ArrowRight") a.currentTime = Math.min(d, a.currentTime + 5);
    else if (e.key === "ArrowLeft") a.currentTime = Math.max(0, a.currentTime - 5);
  });

  // space toggles playback unless typing
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat || e.defaultPrevented || !player.now) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable], button, [role='slider']")) return;
    e.preventDefault();
    player.toggle();
  });

  // media keys / the Windows media flyout
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, () => void][] = [
      ["play", () => player.toggle()],
      ["pause", () => player.toggle()],
      ["nexttrack", () => player.next()],
      ["previoustrack", () => player.prev()],
      ["stop", () => player.stop()],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    }
  }

  renderState(false);
  renderModes();
}

/** the volume before muting, for unmuting */
let lastVolume = 0;

/** The markup of a volume control (a mute button and a slider), for `bindVolume`. */
export function volumeHtml(cls = ""): string {
  return `<button class="pb-btn pb-mute${cls ? ` ${cls}-mute` : ""}" type="button" aria-label="${t("Mute")}"></button>
    <div class="pb-vol${cls ? ` ${cls}-vol` : ""}" role="slider" aria-label="${t("Volume")}" aria-valuemin="0" aria-valuemax="100" tabindex="0"><div class="pb-vol-fill"></div></div>`;
}

/** Wires a mute button and a volume slider to the player's volume; every one of them shows it. */
export function bindVolume(mute: HTMLButtonElement, vol: HTMLElement): void {
  lastVolume ||= store.prefs.volume || 0.6;
  const render = () => {
    const v = store.prefs.volume;
    vol.style.setProperty("--v", `${v * 100}%`);
    vol.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    mute.innerHTML = icon(v === 0 ? "volume-off" : v < 0.45 ? "volume-low" : "volume");
    mute.dataset.tip = v === 0 ? t("Unmute") : t("Mute");
  };
  const set = (v: number) => {
    player.setVolume(v);
    if (store.prefs.volume > 0) lastVolume = store.prefs.volume;
  };
  render();
  events.on("prefs", (p) => {
    if ("volume" in p) render();
  });
  dragSlider(vol, (f) => set(f));
  vol.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.05 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.05 : 0;
    if (!step) return;
    e.preventDefault();
    set(store.prefs.volume + step);
  });
  for (const el of [vol, mute]) {
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      set(store.prefs.volume + ((e as WheelEvent).deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
  }
  mute.addEventListener("click", () => set(store.prefs.volume > 0 ? 0 : lastVolume));
}

/** Click or drag along a horizontal track; reports the fraction (0–1). */
export function dragSlider(el: HTMLElement, onValue: (f: number, done: boolean) => void, enabled: () => boolean = () => true): void {
  let active = false;
  const at = (x: number) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width));
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !enabled()) return;
    active = true;
    el.classList.add("dragging");
    el.setPointerCapture(e.pointerId);
    onValue(at(e.clientX), false);
  });
  el.addEventListener("pointermove", (e) => {
    if (active) onValue(at(e.clientX), false);
  });
  const end = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    el.classList.remove("dragging");
    onValue(at(e.clientX), true);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

function updateMediaSession(np: NowPlaying | null): void {
  if (!("mediaSession" in navigator)) return;
  const snap = store.snap;
  if (!np || !snap) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const set = snap.sets[np.set];
  const unicode = store.prefs.unicode;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: displayTitle(set, unicode),
      artist: displayArtist(set, unicode),
      album: snap.maps[np.map]?.version ?? "",
      artwork: np.bg ? [{ src: new URL(thumbUrl(np.bg, 360), location.href).href, sizes: "360x360", type: "image/jpeg" }] : [],
    });
  } catch {
    /* metadata is a nicety */
  }
}

function openCurrent(): void {
  const np = player.now;
  if (!np || !store.snap) return;
  go({ name: "set", id: store.snap.sets[np.set].id });
}

/** The set page owns the ambient while open; otherwise the playing track does, and with nothing
 * playing the set home shows first (so "from artwork" has artwork from the start). */
let pageArt: string | null | undefined;
let playerArt: string | null = null;
let restingArt: string | null = null;
const applyArt = () => setContentArt(pageArt !== undefined ? pageArt : (playerArt ?? restingArt));
function setContentArtFromPlayer(url: string | null): void {
  playerArt = url;
  applyArt();
}
export function claimContentArt(url: string | null | undefined): void {
  pageArt = url;
  applyArt();
}
/** The art for when nothing plays and no page claims it (home's "where you left off"). */
export function setRestingArt(url: string | null): void {
  if (url === restingArt) return;
  restingArt = url;
  applyArt();
}
