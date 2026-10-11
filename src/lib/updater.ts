/* updater.ts — Fumen's own updates. Releases are signed; the update itself (download, signature
 * check, Windows installer) is Tauri's updater plugin, which asks fumen.dertesti.dev for the
 * latest version. Fumen looks a little after it starts and then every few hours, never in a
 * development build unless asked; installing is always the player's call. */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { asApiError } from "./api";
import { Emitter, events } from "./store";

/** the first look after start, and how often after that */
const FIRST_CHECK = 8_000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current"; at: number }
  | { phase: "available"; version: string; notes?: string }
  | { phase: "downloading"; version: string; done: number; total?: number }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string; version?: string };

export const updateEvents = new Emitter<{ change: UpdateState }>();

let state: UpdateState = { phase: "idle" };
let pending: Update | null = null;
// the installer closes Fumen: not while beatmaps are going into lazer
let importing = false;
events.on("importing", (v) => (importing = v));

export const updateState = (): UpdateState => state;

function set(next: UpdateState): void {
  state = next;
  updateEvents.emit("change", state);
}

const busy = () => state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";

/** Asks whether there's a newer Fumen. Quiet about failures unless `manual`. */
export async function checkForUpdate(manual = false): Promise<void> {
  if (busy()) return;
  const before = state;
  set({ phase: "checking" });
  try {
    const update = await check({ timeout: 20_000 });
    pending = update;
    set(update ? { phase: "available", version: update.version, notes: update.body } : { phase: "current", at: Date.now() });
  } catch (e) {
    console.warn("[update]", e);
    // an automatic look that failed (offline, say) leaves things as they were
    set(manual ? { phase: "error", message: updateError(e) } : before.phase === "checking" ? { phase: "idle" } : before);
  }
}

/** Downloads the pending update and runs its installer; Fumen closes for it and opens again. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || busy()) return;
  if (importing) {
    set({ phase: "error", message: "Wait for the beatmaps being added to lazer, then update.", version: update.version });
    return;
  }
  const version = update.version;
  let done = 0;
  let total: number | undefined;
  set({ phase: "downloading", version, done });
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength;
      else if (e.event === "Progress") {
        done += e.data.chunkLength;
        set({ phase: "downloading", version, done, total });
      } else set({ phase: "installing", version });
    });
    // Windows closes Fumen for the installer before this; elsewhere it's installed now
    set({ phase: "installing", version });
  } catch (e) {
    console.warn("[update] install", e);
    set({ phase: "error", message: updateError(e), version });
  }
}

function updateError(e: unknown): string {
  const raw = typeof e === "string" ? e : asApiError(e).message;
  if (/signature/i.test(raw)) return "The update's signature didn't match, so it wasn't installed.";
  if (/network|connect|dns|timed? ?out|request/i.test(raw)) return "Couldn't reach Fumen's update server. Check your connection.";
  return raw || "The update didn't work.";
}

/** "42%" of a download, or how much so far when the size isn't known. */
export function downloadText(s: Extract<UpdateState, { phase: "downloading" }>): string {
  return s.total ? `${Math.min(100, Math.floor((s.done / s.total) * 100))}%` : `${(s.done / 1048576).toFixed(1)} MB`;
}

/** Looks for updates now and then (not in a development build). */
export function initUpdater(): void {
  if (import.meta.env.DEV) return;
  setTimeout(() => void checkForUpdate(), FIRST_CHECK);
  setInterval(() => {
    if (state.phase === "idle" || state.phase === "current") void checkForUpdate();
  }, CHECK_EVERY);
}
