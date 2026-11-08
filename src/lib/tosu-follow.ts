/* tosu-follow.ts — Fumen plays along with osu!: the song osu! plays (from tosu, lib/tosu) plays in
 * Fumen's player without sound, at osu!'s place and rate, so the visualizer shows it live. Session
 * only: it runs while it's switched on. */
import { api } from "./api";
import { startAnalyser } from "./eq";
import { Emitter, store } from "./store";
import { readTosu, STATE, TosuClock, type TosuNow } from "./tosu";
import { player } from "../player";

const URL = "ws://127.0.0.1:24050/websocket/v2";
/** ms between tries while tosu isn't there */
const RETRY = 3000;
/** ms between checks of Fumen's place against osu!'s */
const TICK = 100;
/** Fumen's song is put back in place when it's this far off, ms */
const DRIFT = 90;
/** ms between new looks for a song that wasn't in the library (it may be imported meanwhile) */
const LOOK_AGAIN = 2000;

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
  readonly bus = new Emitter<{ status: FollowStatus }>();
  status: FollowStatus = { kind: "off" };
  private ws: WebSocket | null = null;
  private retry = 0;
  private tick = 0;
  private clock = new TosuClock();
  private now: TosuNow | null = null;
  /** the MD5 Fumen plays along to, and its library difficulty (null: not in the library) */
  private md5 = "";
  private mapIdx: number | null = null;
  private lookup = 0;
  private lookedAt = 0;
  private ids = new Map<string, string>();

  get on(): boolean {
    return this.status.kind !== "off";
  }

  start(): void {
    if (this.on) return;
    startAnalyser();
    player.setSilent(true);
    this.set({ kind: "connecting" });
    this.connect();
    this.tick = window.setInterval(() => this.sync(), TICK);
  }

  stop(): void {
    if (!this.on) return;
    clearTimeout(this.retry);
    clearInterval(this.tick);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.now = null;
    this.md5 = "";
    this.mapIdx = null;
    this.clock.reset();
    player.setSilent(false);
    this.set({ kind: "off" });
  }

  private set(s: FollowStatus): void {
    this.status = s;
    this.bus.emit("status", s);
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(URL);
    } catch {
      this.retry = window.setTimeout(() => this.connect(), RETRY);
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
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
      this.now = null;
      this.md5 = "";
      if (this.status.kind !== "off") this.set({ kind: "connecting" });
      this.retry = window.setTimeout(() => this.connect(), RETRY);
    };
  }

  private read(now: TosuNow): void {
    this.now = now;
    if (now.md5 !== this.md5) {
      this.md5 = now.md5;
      this.mapIdx = null;
      this.clock.reset();
      // osu!'s song isn't Fumen's any more: quiet until the new one is found
      if (player.playing) player.audio.pause();
      void this.find(now);
    } else if (this.mapIdx === null && now.md5 && performance.now() - this.lookedAt > LOOK_AGAIN) void this.find(now);
    this.clock.update(now.live, now.rate, performance.now());
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
    if (job !== this.lookup || !this.on) return;
    const idx = id ? (store.snap?.maps.findIndex((m) => m.id === id) ?? -1) : -1;
    if (idx < 0) {
      if (this.status.kind !== "missing" || this.status.title !== title) this.set({ kind: "missing", title });
      return;
    }
    this.mapIdx = idx;
    this.set({ kind: "following", title });
    const m = store.snap!.maps[idx];
    const at = Math.max(0, this.clock.at(performance.now()) / 1000 || 0);
    if (player.now?.set === m.set) player.selectMap(idx);
    else player.playSet(m.set, idx, [m.set], { at });
  }

  /** Keeps Fumen's song at osu!'s place, rate and pause. */
  private sync(): void {
    const now = this.now;
    if (!now || this.mapIdx === null || !player.now || player.now.map !== this.mapIdx) return;
    const t = performance.now();
    if (Math.abs(player.rate - now.rate) > 0.001) player.setRate(now.rate);
    if (player.pitch !== now.pitch) player.setPitch(now.pitch);
    const a = player.audio;
    // the results screen and paused play keep the song still in osu! too
    const moving = this.clock.running(t) && now.state !== STATE.resultScreen;
    if (!moving) {
      if (!player.playing) return;
      a.pause();
      // it ran on until the pause showed: back to where osu! stopped
      a.currentTime = now.live / 1000;
      return;
    }
    const at = this.clock.at(t);
    if (!Number.isFinite(at)) return;
    if (!player.playing) {
      a.currentTime = at / 1000;
      player.toggle();
      return;
    }
    if (Math.abs(a.currentTime * 1000 - at) > DRIFT && !a.seeking) a.currentTime = at / 1000;
  }
}

export const follow = new Follow();
