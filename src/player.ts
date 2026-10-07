/* player.ts — plays beatmap sets' songs + the player under the content.
 *
 * Plays the set's own audio file from lazer's store (no network), from the beginning of the song.
 * One player for the whole app; views subscribe to changes.
 * Whoever starts playback can hand over the list it came from (a library page, a carousel), so
 * next/previous and the end of a track continue through what the user was looking at.
 * The playback rate works like lazer's rate mods: it applies to whatever plays until it's reset,
 * and times shown in the bar are at that rate.
 */
import { fileUrl, thumbUrl } from "./lib/api";
import { displayArtist, displayTitle, duration, esc } from "./lib/format";
import { go } from "./lib/router";
import { Emitter, events, setPrefs, store } from "./lib/store";
import type { RepeatMode } from "./lib/types";
import { toast } from "./ui/controls";
import { icon } from "./ui/icons";
import { setContentArt } from "./ui/theme";
import { setMenu } from "./views/actions";

export interface NowPlaying {
  set: number;
  map: number;
  audio: string;
  bg?: string;
}

/** Going back within this many seconds of the start jumps to the previous track instead. */
const RESTART_GRACE = 3;

export const RATE_MIN = 0.5;
export const RATE_MAX = 2;
export const RATE_STEP = 0.05;

class Player {
  readonly bus = new Emitter<{ track: NowPlaying | null; state: boolean; queue: null; rate: number }>();
  readonly audio = new Audio();
  now: NowPlaying | null = null;
  /** playback speed, HT 0.75 / DT 1.5 or anything from 0.5 to 2 in steps of 0.05 (session only) */
  rate = 1;
  /** set indices in the order of the list playback started from */
  private queue: number[] = [];
  private qpos = -1;
  /** sets played before the current one (for "previous" in shuffle) */
  private history: number[] = [];
  private startAt = 0;
  private fadeRaf = 0;

  constructor() {
    this.audio.preload = "auto";
    this.audio.addEventListener("play", () => this.bus.emit("state", true));
    this.audio.addEventListener("pause", () => this.bus.emit("state", false));
    this.audio.addEventListener("ended", () => {
      this.bus.emit("state", false);
      if (this.hasNext) this.next();
    });
    this.audio.addEventListener("error", () => {
      if (!this.now) return;
      toast("This song's audio file couldn't be played.", { kind: "danger" });
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
    if (this.now && this.now.set === setIdx && this.now.audio === audio) {
      if (opts.at !== undefined) {
        this.audio.currentTime = Math.max(0, opts.at);
        if (!this.playing) this.fadeIn();
      } else this.toggle();
      this.bus.emit("queue", null);
      return;
    }
    if (!this.load(setIdx, mapIdx, opts.at)) toast("This set has no audio file.");
  }

  /** Starts a set's song from the beginning (or `at` seconds). False when the set has no audio. */
  private load(setIdx: number, mapIdx?: number, at?: number): boolean {
    const snap = store.snap;
    if (!snap) return false;
    const set = snap.sets[setIdx];
    const mi = mapIdx ?? set.maps[0];
    const map = snap.maps[mi];
    const audio = map?.audio ?? set.audio;
    if (!audio) return false;
    this.now = { set: setIdx, map: mi, audio, bg: map?.bg ?? set.bg };
    this.bus.emit("track", this.now);
    this.bus.emit("queue", null);

    const a = this.audio;
    a.pause();
    a.loop = store.prefs.repeat === "one";
    a.src = fileUrl(audio);
    const start = () => {
      a.removeEventListener("loadedmetadata", start);
      const d = a.duration;
      const t = Math.max(0, at ?? 0);
      this.startAt = Number.isFinite(d) ? Math.min(t, Math.max(0, d - 1)) : t;
      a.currentTime = this.startAt;
      a.playbackRate = this.rate;
      this.fadeIn();
    };
    a.addEventListener("loadedmetadata", start);
    a.load();
    return true;
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
    if (!this.playing) this.fadeIn();
  }

  /** Plays with a short fade-in, except from the very start, where a fade would swallow the first beat. */
  private fadeIn(): void {
    cancelAnimationFrame(this.fadeRaf);
    const target = this.targetVolume();
    if (this.audio.currentTime < 0.05) {
      this.audio.volume = target;
      this.audio.play().catch(() => {});
      return;
    }
    this.audio.volume = 0;
    this.audio.play().catch(() => {});
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 450);
      this.audio.volume = target * k;
      if (k < 1) this.fadeRaf = requestAnimationFrame(step);
    };
    this.fadeRaf = requestAnimationFrame(step);
  }

  /** Perceptual volume curve. */
  private targetVolume(): number {
    const v = store.prefs.volume;
    return Math.max(0, Math.min(1, v * v));
  }

  toggle(): void {
    if (!this.now) return;
    if (this.playing) return this.audio.pause();
    if (this.audio.ended) this.audio.currentTime = this.startAt;
    this.fadeIn();
  }

  stop(): void {
    cancelAnimationFrame(this.fadeRaf);
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
    cancelAnimationFrame(this.fadeRaf);
    this.audio.volume = this.targetVolume();
  }

  setRate(r: number): void {
    const v = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, r)) / RATE_STEP) * RATE_STEP;
    const rate = Math.round(v * 100) / 100;
    if (rate === this.rate) return;
    this.rate = rate;
    // pitch stays, like lazer's rate mods without "adjust pitch"
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    this.bus.emit("rate", rate);
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
  off: "Repeat: off",
  all: "Repeat: list",
  one: "Repeat: this song",
};

export function mountPlayerBar(host: HTMLElement): void {
  host.innerHTML = `
    <div class="pb-seek" role="slider" aria-label="Seek" tabindex="0">
      <div class="pb-seek-track"><div class="pb-seek-fill"></div></div>
      <div class="pb-seek-head"></div>
      <div class="pb-seek-tip num"></div>
    </div>
    <div class="pb-row">
      <div class="pb-left">
        <button class="pb-art" type="button" data-tip="Open beatmap set" aria-label="Open beatmap set"><img alt="" /></button>
        <div class="pb-meta">
          <button class="pb-title" type="button"></button>
          <div class="pb-artist"></div>
          <div class="pb-time num"><span class="pb-cur">0:00</span> / <span class="pb-dur">0:00</span><button class="pb-rate" type="button" data-tip="Back to normal speed" hidden></button></div>
        </div>
      </div>
      <div class="pb-center">
        <button class="pb-btn pb-shuffle" type="button" aria-label="Shuffle">${icon("shuffle")}</button>
        <button class="pb-btn pb-skip pb-prev" type="button" data-tip="Previous" aria-label="Previous">${icon("skip-back")}</button>
        <button class="pb-play" type="button" aria-label="Play"></button>
        <button class="pb-btn pb-skip pb-next" type="button" data-tip="Next" aria-label="Next">${icon("skip-forward")}</button>
        <button class="pb-btn pb-repeat" type="button" aria-label="Repeat"></button>
      </div>
      <div class="pb-right">
        <button class="pb-btn pb-mute" type="button" aria-label="Mute"></button>
        <div class="pb-vol" role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" tabindex="0"><div class="pb-vol-fill"></div></div>
        <button class="pb-btn pb-more" type="button" data-tip="More" aria-label="More">${icon("more-vert")}</button>
        <button class="pb-btn pb-close" type="button" data-tip="Close player" aria-label="Close player">${icon("x")}</button>
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
  const vol = $<HTMLDivElement>(".pb-vol");
  const mute = $<HTMLButtonElement>(".pb-mute");
  const shuffle = $<HTMLButtonElement>(".pb-shuffle");
  const repeat = $<HTMLButtonElement>(".pb-repeat");
  const prev = $<HTMLButtonElement>(".pb-prev");
  const next = $<HTMLButtonElement>(".pb-next");
  const rateBtn = $<HTMLButtonElement>(".pb-rate");
  const a = player.audio;

  // ── volume ──
  let lastVolume = store.prefs.volume || 0.6;
  const renderVolume = () => {
    const v = store.prefs.volume;
    vol.style.setProperty("--v", `${v * 100}%`);
    vol.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    mute.innerHTML = icon(v === 0 ? "volume-off" : v < 0.45 ? "volume-low" : "volume");
    mute.dataset.tip = v === 0 ? "Unmute" : "Mute";
  };
  const setVolume = (v: number) => {
    player.setVolume(v);
    if (store.prefs.volume > 0) lastVolume = store.prefs.volume;
    renderVolume();
  };
  renderVolume();
  dragSlider(vol, (f) => setVolume(f));
  vol.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.05 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.05 : 0;
    if (!step) return;
    e.preventDefault();
    setVolume(store.prefs.volume + step);
  });
  for (const el of [vol, mute]) {
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      setVolume(store.prefs.volume + ((e as WheelEvent).deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });
  }
  mute.addEventListener("click", () => setVolume(store.prefs.volume > 0 ? 0 : lastVolume));

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
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.now ? (playing ? "playing" : "paused") : "none";
  };

  const renderModes = () => {
    const p = store.prefs;
    shuffle.classList.toggle("on", p.shuffle);
    shuffle.dataset.tip = p.shuffle ? "Shuffle: on" : "Shuffle: off";
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
    rateBtn.textContent = `${rate.toFixed(2)}×`;
    rateBtn.setAttribute("aria-label", `Playing at ${rate.toFixed(2)}×, back to normal speed`);
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

/** Click or drag along a horizontal track; reports the fraction (0–1). */
function dragSlider(el: HTMLElement, onValue: (f: number, done: boolean) => void, enabled: () => boolean = () => true): void {
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

/** The set page owns the ambient while open; otherwise the playing track does. */
let pageArt: string | null | undefined;
let playerArt: string | null = null;
function setContentArtFromPlayer(url: string | null): void {
  playerArt = url;
  if (pageArt === undefined) setContentArt(playerArt);
}
export function claimContentArt(url: string | null | undefined): void {
  pageArt = url;
  setContentArt(url === undefined ? playerArt : url);
}
