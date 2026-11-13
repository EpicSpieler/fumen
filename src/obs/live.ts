/* live.ts — an OBS page's own line to tosu: what osu! shows, where its song is between tosu's
 * messages, and how the play goes (lib/vis/feel). Straight from tosu rather than through Fumen's
 * window, which a browser slows down while it's in the background; OBS's sources it doesn't. */
import { Emitter } from "../lib/emitter";
import { backToStart, readTosu, STATE, StartHold, TosuClock, type TosuNow } from "../lib/tosu";
import { Feel } from "../lib/vis/feel";

/** ms between tries while tosu isn't there */
const RETRY = 2000;
/** ms osu!'s time has to move on in a message for a map joined in the middle to count as running */
const BEGIN_STEP = 30;

/**
 * Whether the map being played begins with `now` (osu! is playing it; `before` is the message
 * earlier). lazer's gameplay screen comes in when its time jumps back to the map's start: until
 * then the loading screen runs on with the menu's music, from then the lead-in runs with the song
 * held at the start, up to 2 s before a first note at 0:00. So the map begins at that jump, not
 * when the song moves, which would be the first note (docs/tosu.md). `fromStart`: the start of
 * this map was seen (osu! went from another screen to playing it while the page was open).
 */
export function mapBegins(now: TosuNow, before: TosuNow | null, fromStart: boolean): boolean {
  if (!before || before.md5 !== now.md5) return false;
  if (backToStart(now.live, before.live)) return true;
  if (before.state !== STATE.play) return false;
  // no jump seen (osu!'s time was near the start already): the first note judged
  if (now.play.hits > before.play.hits) return true;
  // joined in the middle of a map: once the song moves
  return !fromStart && !now.paused && now.live - before.live >= BEGIN_STEP;
}

/** in a map: playing it or on its results */
export const inMap = (state: number): boolean => state === STATE.play || state === STATE.resultScreen;

class Live {
  now: TosuNow | null = null;
  readonly feel = new Feel();
  readonly clock = new TosuClock();
  private hold = new StartHold();
  /** `msg`: every message; `map`: osu! is on another difficulty (its MD5); `start`: a map began;
   * `begin`: the map really runs (its gameplay screen came in, past the loading screen); `leave`:
   * out of a map (the MD5 left); `gone`: tosu went */
  readonly bus = new Emitter<{ msg: TosuNow; map: string; start: TosuNow; begin: TosuNow; leave: string; gone: void }>();
  /** the map being played really runs: its gameplay screen is in (until it's left) */
  begun = false;
  /** the start of the map being played was seen (see mapBegins) */
  private fromStart = false;
  private url = "";
  private ws: WebSocket | null = null;
  private retry = 0;

  /** Talks to tosu at `url` (again, when it moved). */
  use(url: string): void {
    if (!url || url === this.url) return;
    this.url = url;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.open();
  }

  get connected(): boolean {
    return this.now !== null;
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry = window.setTimeout(() => this.open(), RETRY);
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      try {
        const now = readTosu(JSON.parse(String(e.data)));
        if (now) this.read(now);
      } catch {
        // not tosu's
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.drop();
      this.retry = window.setTimeout(() => this.open(), RETRY);
    };
  }

  /** tosu went: nothing is known any more */
  private drop(): void {
    if (!this.now) return;
    if (inMap(this.now.state)) this.bus.emit("leave", this.now.md5);
    this.now = null;
    this.begun = false;
    this.fromStart = false;
    this.feel.stop();
    this.clock.reset();
    this.hold.clear();
    this.bus.emit("gone", undefined);
  }

  /** What tosu would say, made up (the editor's demo, ./demo); null: as if tosu went. */
  take(now: TosuNow | null): void {
    if (now) this.read(now);
    else this.drop();
  }

  private read(now: TosuNow): void {
    const before = this.now;
    this.now = now;
    const t = performance.now();
    if (now.md5 !== before?.md5) {
      this.clock.reset();
      this.bus.emit("map", now.md5);
    }
    if (now.state === STATE.play && before?.state !== STATE.play) {
      // joined in the middle of a map (the page just opened): it runs already
      if (before) this.hold.begin(now.live, before.md5 === now.md5 ? before.live : null, t);
      this.bus.emit("start", now);
    } else if (now.state !== STATE.play) this.hold.clear();
    else this.hold.update(now.live, t);
    if (before && inMap(before.state) && !inMap(now.state)) this.bus.emit("leave", before.md5);
    // the map begins when its gameplay screen comes in, not on the loading screen
    if (now.state !== STATE.play) {
      this.begun = false;
      this.fromStart = false;
    } else if (!this.begun) {
      if (before && before.state !== STATE.play) this.fromStart = true;
      if (mapBegins(now, before, this.fromStart)) {
        this.begun = true;
        this.bus.emit("begin", now);
      }
    }
    this.clock.update(now.live, now.rate, t);
    this.feel.feed(now, t / 1000);
    this.bus.emit("msg", now);
  }

  /** Where osu!'s song is (seconds) and whether it moves; null without one. */
  song(): { pos: number; playing: boolean } | null {
    const now = this.now;
    if (!now || !now.md5) return null;
    const t = performance.now();
    // a map starting: at the beginning, still, whatever the menu's music still does
    if (this.hold.on) return { pos: 0, playing: false };
    const at = this.clock.at(t);
    if (!Number.isFinite(at)) return null;
    const moving = this.clock.running(t) && !now.paused && now.state !== STATE.resultScreen;
    // lazer's lead-in: the map runs, the song hasn't begun
    if (at < 0) return { pos: 0, playing: false };
    return { pos: at / 1000, playing: moving };
  }

  /** How far into the map the play is, 0–1 (null outside one or without its objects). */
  progress(): number | null {
    const now = this.now;
    if (!now || !inMap(now.state) || now.lastObject === null) return null;
    const start = now.firstObject ?? 0;
    const span = now.lastObject - start;
    if (span <= 0) return null;
    const at = this.clock.at(performance.now());
    return Math.min(1, Math.max(0, ((Number.isFinite(at) ? at : now.live) - start) / span));
  }
}

export const live = new Live();
