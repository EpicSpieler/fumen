/* tosu-follow.ts — Fumen plays along with osu!: the song osu! plays (from tosu, lib/tosu) plays in
 * Fumen's player without sound, at osu!'s place and rate, so the visualizer shows it live. It runs
 * in the background while prefs `followOsu` is on; Fumen is only quiet while tosu is there.
 * main.ts opens the visualizer when a map starts (`play`), closes it when you leave the map or osu!
 * (`leave`), and opens the score page after a pass. */
import { api, isTauri } from "./api";
import { startAnalyser } from "./eq";
import { Emitter, store } from "./store";
import { AttemptTracker, type Attempt } from "./attempts";
import { heart } from "./heart";
import { averageIn } from "./heart-stats";
import { chartMods } from "./mods";
import { hardest } from "./practice";
import { Feel } from "./vis/feel";
import { readTosu, StartHold, STATE, TosuClock, type TosuNow } from "./tosu";
import { player } from "../player";

/** tosu's address; the browser preview can point it at tools/browser-preview/fake-tosu.mjs */
export const TOSU_URL = (() => {
  const own = isTauri ? null : safeGet("fumen-preview-tosu");
  return own ?? "ws://127.0.0.1:24050/websocket/v2";
})();

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
/** ms between tries while tosu isn't there */
const RETRY = 3000;
/** ms between checks of Fumen's place against osu!'s */
const TICK = 100;
/** Fumen's song is put back in place when it's this far off, ms */
const DRIFT = 90;
/** ms between new looks for a song that wasn't in the library (it may be imported meanwhile) */
const LOOK_AGAIN = 2000;
/** ms between checks that osu! still runs (tosu may keep its last state when it's closed) */
const OSU_CHECK = 2000;
/** ms between tries to start the song when it wouldn't (no click in Fumen yet, say) */
const PLAY_AGAIN = 1000;

export type FollowStatus =
  | { kind: "off" }
  /** no tosu (yet) */
  | { kind: "connecting" }
  /** tosu is there, osu! shows no song */
  | { kind: "waiting" }
  | { kind: "following"; title: string }
  /** osu!'s song isn't in Fumen's library */
  | { kind: "missing"; title: string };

class Follow {
  /** `play`: a map started in osu! and Fumen plays along (its index in the library); `leave`:
   * out of the map again (to song select or a menu), or osu! / tosu went (the MD5 of the map left);
   * `map`: osu! is on another difficulty (its MD5, "" for none); `tosu`: every message */
  readonly bus = new Emitter<{ status: FollowStatus; play: number; leave: string; attempt: Attempt; map: string; tosu: TosuNow }>();
  /** every try at a map (lib/attempts), kept as it ends */
  private tries = new AttemptTracker();
  /** how the play goes, for the visualizer to answer (lib/vis/feel) */
  readonly feel = new Feel();
  status: FollowStatus = { kind: "off" };
  private ws: WebSocket | null = null;
  private retry = 0;
  private tick = 0;
  private osuTimer = 0;
  /** osu! was closed: what tosu still says is left alone until it runs again */
  private osuGone = false;
  /** Fumen saw osu! run (a check that never finds it can't tell that it closed) */
  private osuSeen = false;
  /** tosu was started for this run of osu! (prefs tosuAutostart) */
  private tosuTried = false;
  private clock = new TosuClock();
  /** a map just started: Fumen waits at the beginning until osu!'s time really starts there */
  private hold = new StartHold();
  private now: TosuNow | null = null;
  /** the MD5 Fumen plays along to, and its library difficulty (null: not in the library) */
  private md5 = "";
  private mapIdx: number | null = null;
  private lookup = 0;
  private lookedAt = 0;
  private playTried = 0;
  /** a map started in osu!: `play` goes out once Fumen plays it too */
  private started = false;
  private ids = new Map<string, string>();
  /** Fumen plays something of your own (another song, a replay, practice): hands off until
   * osu! moves on to another map or starts one */
  private yielded = false;
  /** listening to the player (from the first start: player.ts and this import each other) */
  private hooked = false;

  get on(): boolean {
    return this.status.kind !== "off";
  }

  /** tosu answers (Fumen is quiet then) */
  get connected(): boolean {
    return this.now !== null;
  }

  /** the difficulty osu! is on (MD5), "" without tosu */
  get current(): string {
    return this.now?.md5 ?? "";
  }

  /** what tosu said last, null without tosu (or osu! closed) */
  get latest(): TosuNow | null {
    return this.now;
  }

  /** Fumen's player has osu!'s map on (not something of your own) */
  get alongside(): boolean {
    return this.connected && !this.yielded && this.mapIdx !== null && player.now?.map === this.mapIdx;
  }

  start(): void {
    if (this.on) return;
    if (!this.hooked) {
      this.hooked = true;
      // another song picked in Fumen: yours
      player.bus.on("track", (np) => {
        if (this.connected && this.mapIdx !== null && np && np.map !== this.mapIdx) this.yieldPlayer();
      });
    }
    this.set({ kind: "connecting" });
    this.connect();
    this.tick = window.setInterval(() => this.sync(), TICK);
    if (isTauri) this.osuTimer = window.setInterval(() => void this.checkOsu(), OSU_CHECK);
  }

  stop(): void {
    if (!this.on) return;
    clearTimeout(this.retry);
    clearInterval(this.tick);
    clearInterval(this.osuTimer);
    this.osuGone = false;
    this.osuSeen = false;
    this.tosuTried = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.lost();
    this.set({ kind: "off" });
  }

  /** Leaves Fumen's player to you (with its sound) until osu! moves on. */
  yieldPlayer(): void {
    if (!this.connected || this.yielded) return;
    this.yielded = true;
    player.setSilent(false);
  }

  private takeBack(): void {
    if (!this.yielded) return;
    this.yielded = false;
    player.setSilent(true);
  }

  private set(s: FollowStatus): void {
    this.status = s;
    this.bus.emit("status", s);
  }

  /** Keeps tries that ended and tells about them (`attempt`). */
  private keep(done: Attempt[]): void {
    for (const a of done) {
      void withFastPart(a)
        .then((x) => api.saveAttempt(x).then((id) => this.bus.emit("attempt", { ...x, id })))
        .catch((e) => console.warn("[attempts] keep", e));
    }
  }

  /** A reading from the heart rate monitor (lib/heart): kept with the try under way. */
  pulse(bpm: number, contact: boolean | null): void {
    this.tries.pulse(bpm, contact);
  }

  /** tosu is gone (or following stopped): Fumen's song stops and Fumen has its sound again. */
  private lost(): void {
    this.keep(this.tries.end(Date.now()));
    this.feel.stop();
    if (this.now && this.mapIdx !== null && player.now?.map === this.mapIdx && player.playing) player.audio.pause();
    if (this.now) this.bus.emit("leave", this.now.md5);
    this.hold.clear();
    const had = !!this.now?.md5;
    this.now = null;
    this.md5 = "";
    if (had) this.bus.emit("map", "");
    this.mapIdx = null;
    this.started = false;
    this.yielded = false;
    this.clock.reset();
    player.setSilent(false);
  }

  /** osu! closed: like tosu going (the visualizer closes, Fumen has its sound back). */
  private async checkOsu(): Promise<void> {
    const r = await api.osuRunning().catch(() => null);
    if (!r || !this.on) return;
    const gone = !r.lazer && !r.stable;
    if (!gone) {
      this.osuSeen = true;
      this.osuGone = false;
      // osu! runs without tosu: start it (once per run of osu!)
      if (!this.now && store.prefs.tosuAutostart && !this.tosuTried) {
        this.tosuTried = true;
        void api.startTosu().catch((e) => console.warn("[tosu] start", e));
      }
    } else if (this.osuSeen && !this.osuGone) {
      this.osuGone = true;
      this.osuSeen = false;
      this.tosuTried = false;
      const was = this.connected;
      this.lost();
      if (was) this.set({ kind: "waiting" });
    }
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(TOSU_URL);
    } catch {
      this.retry = window.setTimeout(() => this.connect(), RETRY);
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const now = readTosu(msg);
      if (now) this.read(now);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost();
      if (this.status.kind !== "off") this.set({ kind: "connecting" });
      this.retry = window.setTimeout(() => this.connect(), RETRY);
    };
  }

  private read(now: TosuNow): void {
    if (this.osuGone) return;
    const before = this.now;
    if (!before) {
      // osu! plays the music now; the analysers still hear Fumen's copy
      startAnalyser();
      player.setSilent(true);
    }
    this.now = now;
    const t = performance.now();
    if (now.state === STATE.play && before?.state !== STATE.play) {
      this.started = true;
      this.takeBack();
      this.hold.begin(now.live, before && before.md5 === now.md5 ? before.live : null, t);
    } else if (now.state !== STATE.play) {
      this.started = false;
      this.hold.clear();
    } else this.hold.update(now.live, t);
    // (osu! may have picked another map on the way out already: it's the one left that counts)
    if (before && inMap(before.state) && !inMap(now.state)) this.bus.emit("leave", before.md5);
    if (now.md5 !== this.md5) {
      this.takeBack();
      this.md5 = now.md5;
      this.bus.emit("map", now.md5);
      this.mapIdx = null;
      this.clock.reset();
      // osu!'s song isn't Fumen's any more: quiet until the new one is found
      if (player.playing) player.audio.pause();
      void this.find(now);
    } else if (this.mapIdx === null && now.md5 && performance.now() - this.lookedAt > LOOK_AGAIN) void this.find(now);
    this.clock.update(now.live, now.rate, performance.now());
    this.keep(this.tries.feed(now, Date.now()));
    this.feel.feed(now, performance.now() / 1000);
    this.bus.emit("tosu", now);
    if (!now.md5 && this.status.kind !== "waiting") this.set({ kind: "waiting" });
  }

  /** Looks the difficulty up in the library and starts its song where osu! is. */
  private async find(now: TosuNow): Promise<void> {
    const job = ++this.lookup;
    this.lookedAt = performance.now();
    if (!now.md5) return;
    const title = `${now.artist} - ${now.title} [${now.version}]`;
    let id = this.ids.get(now.md5) ?? null;
    if (!id) {
      id = await api.mapByMd5(now.md5).catch(() => null);
      if (id) this.ids.set(now.md5, id);
    }
    if (job !== this.lookup || !this.connected || this.yielded) return;
    const idx = id ? (store.snap?.maps.findIndex((m) => m.id === id) ?? -1) : -1;
    if (idx < 0) {
      if (this.status.kind !== "missing" || this.status.title !== title) this.set({ kind: "missing", title });
      return;
    }
    this.mapIdx = idx;
    this.set({ kind: "following", title });
    const m = store.snap!.maps[idx];
    const at = this.hold.on ? 0 : Math.max(0, this.clock.at(performance.now()) / 1000 || 0);
    if (player.now?.set === m.set) player.selectMap(idx);
    else player.playSet(m.set, idx, [m.set], { at });
  }

  /** Keeps Fumen's song at osu!'s place, rate and pause. */
  private sync(): void {
    const now = this.now;
    if (!now || this.yielded || this.mapIdx === null || !player.now || player.now.map !== this.mapIdx) return;
    if (this.started) {
      this.started = false;
      this.bus.emit("play", this.mapIdx);
    }
    const t = performance.now();
    if (Math.abs(player.rate - now.rate) > 0.001) player.setRate(now.rate);
    if (player.pitch !== now.pitch) player.setPitch(now.pitch);
    const a = player.audio;
    // a map starting: at the beginning, still, whatever the menu's music does
    if (this.hold.on) {
      if (player.playing) a.pause();
      if (a.currentTime > 0.05 && !a.seeking) a.currentTime = 0;
      return;
    }
    // the results screen and paused play keep the song still in osu! too
    // osu! says when it's paused (pause menu, fail screen); the time standing still catches the rest
    const moving = this.clock.running(t) && !now.paused && now.state !== STATE.resultScreen;
    if (!moving) {
      if (!player.playing) return;
      a.pause();
      // it ran on until the pause showed: back to where osu! stopped
      a.currentTime = now.live / 1000;
      return;
    }
    const at = this.clock.at(t);
    if (!Number.isFinite(at)) return;
    // lazer's lead-in: the map runs, the song hasn't begun
    if (at < 0) {
      if (player.playing) a.pause();
      if (a.currentTime > 0.05 && !a.seeking) a.currentTime = 0;
      return;
    }
    if (!player.playing) {
      if (t - this.playTried < PLAY_AGAIN) return;
      this.playTried = t;
      a.currentTime = at / 1000;
      player.toggle();
      return;
    }
    if (Math.abs(a.currentTime * 1000 - at) > DRIFT && !a.seeking) a.currentTime = at / 1000;
  }
}

/** in a map: playing it or on its results */
const inMap = (state: number): boolean => state === STATE.play || state === STATE.resultScreen;

/** A try with a pulse: the average in the map's fastest part too, when its chart is there. */
async function withFastPart(a: Attempt): Promise<Attempt> {
  if (!a.heart) return a;
  try {
    const id = await api.mapByMd5(a.md5);
    if (!id) return a;
    const part = hardest(await api.getChart(id, chartMods([], a.mode)));
    const fast = averageIn(a.heart.samples, part.a, part.b);
    return fast === null ? a : { ...a, heart: { ...a.heart, fast: Math.round(fast * 10) / 10 } };
  } catch {
    return a;
  }
}

export const follow = new Follow();
heart.bus.on("reading", (r) => follow.pulse(r.bpm, r.contact));
