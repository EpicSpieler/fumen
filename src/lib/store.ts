/* store.ts — app-wide state and a tiny typed event bus. */
import { api } from "./api";
import { buildIndex, type LibIndex } from "./search";
import type { LibraryStatus, ScanProgress, Settings, Snapshot, UiPrefs } from "./types";

type Handler<T> = (payload: T) => void;

export class Emitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Set<Handler<E[K]>> } = {};

  on<K extends keyof E>(evt: K, fn: Handler<E[K]>): () => void {
    (this.handlers[evt] ??= new Set()).add(fn);
    return () => this.handlers[evt]?.delete(fn);
  }

  emit<K extends keyof E>(evt: K, payload: E[K]): void {
    this.handlers[evt]?.forEach((fn) => fn(payload));
  }
}

export const DEFAULT_ACCENT = "#8b7cff";

export const DEFAULT_PREFS: UiPrefs = {
  accentMode: "dynamic",
  accent: DEFAULT_ACCENT,
  ambient: true,
  reduceMotion: false,
  unicode: false,
  theme: "dark",
  volume: 0.6,
  layout: "grid",
  sort: "added",
  sortDesc: true,
  mode: -1,
  keys: [],
  sidebarCollapsed: false,
  collapsedGroups: [],
  shuffle: true,
  repeat: "off",
  scrollSpeed: null,
  playfieldSkin: null,
  hitsoundVolume: 0.6,
  fullscreenMode: "visual",
  defaultsApplied: false,
};

export const store = {
  snap: null as Snapshot | null,
  index: null as LibIndex | null,
  settings: null as Settings | null,
  prefs: { ...DEFAULT_PREFS } as UiPrefs,
  status: null as LibraryStatus | null,
  scan: null as ScanProgress | null,
};

export const events = new Emitter<{
  library: Snapshot;
  prefs: Partial<UiPrefs>;
  scan: ScanProgress | null;
  status: LibraryStatus;
  /** "search the library for this" from anywhere (tags, mapper links) */
  search: string;
}>();

export function setSnapshot(snap: Snapshot): void {
  store.snap = snap;
  store.index = buildIndex(snap);
  events.emit("library", snap);
}

export async function reloadLibrary(): Promise<void> {
  setSnapshot(await api.getLibrary());
}

export async function refreshStatus(): Promise<LibraryStatus> {
  const status = await api.libraryStatus();
  store.status = status;
  events.emit("status", status);
  return status;
}

export function loadPrefs(settings: Settings): void {
  store.settings = settings;
  store.prefs = { ...DEFAULT_PREFS, ...(settings.ui as Partial<UiPrefs>) };
  // the difficulty table became the set list (0.2)
  if ((store.prefs.layout as string) === "table") store.prefs.layout = "list";
}

// Preference writes are applied immediately and persisted in one debounced batch.
let pending: Partial<UiPrefs> = {};
let saveTimer: number | undefined;

export function setPrefs(patch: Partial<UiPrefs>): void {
  Object.assign(store.prefs, patch);
  Object.assign(pending, patch);
  events.emit("prefs", patch);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const ui = pending;
    pending = {};
    api.updateSettings({ ui }).then((s) => (store.settings = s)).catch((e) => console.warn("[prefs] save failed", e));
  }, 400);
}
