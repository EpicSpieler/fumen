/* link.ts — what Fumen's window tells the OBS pages (lib/obs-parts): the overlay server's event
 * stream (/obs/events, src-tauri/src/overlay.rs). A dev build's page comes from Vite and is told
 * the server's port (?fumen=<port>). The browser preview has no server: there the window's shim
 * hands the parts over a BroadcastChannel (?fumen=preview). */
import type { PartName, Parts } from "../lib/obs-parts";
import { Emitter } from "../lib/store";

export const params = new URLSearchParams(location.search);
const fumen = params.get("fumen");
/** the browser preview (tools/browser-preview) */
export const preview = fumen === "preview";
/** in Fumen's own window, being arranged (views/hud-editor.ts): told everything by the window, a made-up try */
export const editing = params.get("edit") === "1";
const base = fumen && /^\d+$/.test(fumen) ? `http://127.0.0.1:${fumen}` : location.origin;
/** Fumen's files as the window reads them (lib/api's fumen:// address) */
const files = (window as { __FUMEN_BASE__?: string }).__FUMEN_BASE__ ?? (navigator.userAgent.includes("Windows") ? "http://fumen.localhost/" : "fumen://localhost/");

const NAMES: PartName[] = ["config", "map", "tries", "player", "session", "cue", "keymap", "keys", "heart"];

export const parts: Parts = { config: null, map: null, tries: null, player: null, session: null, cue: null, keymap: null, keys: null, heart: null };
export const link = new Emitter<Parts & { open: boolean }>();

export function take<K extends PartName>(name: K, value: Parts[K]): void {
  parts[name] = value;
  link.emit(name, value as (Parts & { open: boolean })[K]);
}

export function connect(): void {
  if (preview) {
    const ch = new BroadcastChannel("fumen-obs");
    ch.onmessage = (e: MessageEvent<{ part?: PartName; value?: unknown }>) => {
      if (e.data.part && NAMES.includes(e.data.part)) take(e.data.part, e.data.value as never);
    };
    ch.postMessage({ hello: true });
    return;
  }
  const es = new EventSource(`${base}/obs/events`);
  for (const name of NAMES)
    es.addEventListener(name, (e) => {
      try {
        take(name, JSON.parse((e as MessageEvent<string>).data));
      } catch {
        // half a message: the next one comes
      }
    });
  es.onopen = () => link.emit("open", true);
  es.onerror = () => link.emit("open", false);
}

/** A background at about `width` (320, 640 or 1280). */
export function artUrl(key: string, width: number): string {
  const w = width <= 320 ? 320 : width <= 640 ? 640 : 1280;
  return preview || editing ? `${files}thumb/${w}/${key}` : `${base}/obs/art/${w}/${key}`;
}

/** A song by its file key. */
export function audioUrl(key: string): string {
  return preview || editing ? `${files}file/${key}` : `${base}/obs/audio/${key}`;
}
