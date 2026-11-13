/* heart.ts — the heart rate monitor (src-tauri/src/heart.rs): which one, how the connection goes,
 * the pulse right now. Settings picks it; lib/tosu-follow keeps the pulse with each try; the OBS
 * pages get it from Rust directly. */
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "./api";
import { Emitter } from "./emitter";
import { setPrefs, store } from "./store";

export interface HeartDevice {
  id: string;
  name: string;
  /** signal strength, dBm */
  rssi: number | null;
}

export interface HeartReading {
  bpm: number;
  /** the strap touches skin (when it says) */
  contact: boolean | null;
}

export interface HeartStatus {
  state: "off" | "connecting" | "on" | "lost";
  name: string | null;
  battery: number | null;
  message: string | null;
}

/** a reading older than this (ms) isn't the pulse now */
const FRESH = 6000;

class Heart {
  status: HeartStatus = { state: "off", name: null, battery: null, message: null };
  /** the latest reading and when it came (performance ms) */
  last: HeartReading | null = null;
  lastAt = 0;
  readonly bus = new Emitter<{ reading: HeartReading; status: HeartStatus }>();
  private started = false;

  /** The pulse now, or null (none for a while, or no skin contact). */
  get bpm(): number | null {
    if (!this.last || performance.now() - this.lastAt > FRESH || this.last.contact === false || this.last.bpm <= 0) return null;
    return this.last.bpm;
  }

  /** Listens to Rust and connects to the strap picked before. */
  init(): void {
    if (this.started) return;
    this.started = true;
    void listen<HeartReading>("heart", (e) => {
      this.last = e.payload;
      this.lastAt = performance.now();
      this.bus.emit("reading", e.payload);
    });
    void listen<HeartStatus>("heart-status", (e) => {
      this.status = e.payload;
      if (e.payload.state !== "on") this.last = null;
      this.bus.emit("status", e.payload);
    });
    const p = store.prefs.heart;
    if (p?.id && isTauri) void api.heartConnect(p.id, p.name ?? "").catch(() => {});
  }

  /** Uses this strap from now on (and on every start). */
  use(d: HeartDevice): Promise<void> {
    setPrefs({ heart: { id: d.id, name: d.name } });
    this.status = { state: "connecting", name: d.name, battery: null, message: null };
    this.bus.emit("status", this.status);
    return api.heartConnect(d.id, d.name);
  }

  /** No strap any more. */
  forget(): Promise<void> {
    setPrefs({ heart: { id: null, name: null } });
    this.last = null;
    this.status = { state: "off", name: null, battery: null, message: null };
    this.bus.emit("status", this.status);
    return api.heartDisconnect();
  }
}

export const heart = new Heart();
