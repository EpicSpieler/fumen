/* actions.ts — things you can do with a set or difficulty, shared by every view. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { osuMapUrl, osuSetUrl } from "../lib/api";
import { go } from "../lib/router";
import { store } from "../lib/store";
import { player } from "../player";
import { openMenu, toast, type MenuEntry } from "../ui/controls";

export function openSet(setIdx: number, mapIdx?: number): void {
  const snap = store.snap;
  if (!snap) return;
  const set = snap.sets[setIdx];
  go({ name: "set", id: set.id, ...(mapIdx !== undefined ? { map: snap.maps[mapIdx].id } : {}) });
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, { kind: "success", timeout: 2000 });
  } catch {
    toast("Couldn't access the clipboard", { kind: "danger" });
  }
}

/** Context menu for a set (and optionally one of its difficulties). */
export function setMenu(
  at: Element | { x: number; y: number },
  setIdx: number,
  mapIdx?: number,
  opts: { onSearch?: (q: string) => void; inSetPage?: boolean; extra?: MenuEntry[] } = {},
): void {
  const snap = store.snap;
  if (!snap) return;
  const set = snap.sets[setIdx];
  const map = mapIdx !== undefined ? snap.maps[mapIdx] : undefined;
  const playing = player.isCurrent(setIdx) && player.playing;
  const entries: MenuEntry[] = [
    { label: playing ? "Pause" : "Play", icon: playing ? "pause" : "play", action: () => player.playSet(setIdx, mapIdx) },
  ];
  if (!opts.inSetPage) entries.push({ label: "Open beatmap set", icon: "library", action: () => openSet(setIdx, mapIdx) });
  if (opts.extra?.length) entries.push(...opts.extra);
  entries.push("sep");
  if (set.onlineId) {
    const url = map?.onlineId ? osuMapUrl(set.onlineId, map.onlineId, map.mode) : osuSetUrl(set.onlineId);
    entries.push(
      { label: "View on osu! website", icon: "external", action: () => void openUrl(url) },
      { label: "Copy link", icon: "link", action: () => void copy(url, "Link") },
    );
  } else {
    entries.push({ label: "Not submitted to osu!", icon: "external", disabled: true });
  }
  if (opts.onSearch) {
    const search = opts.onSearch;
    entries.push(
      "sep",
      { label: `More by ${set.artist || "this artist"}`, icon: "music", action: () => search(`artist=="${set.artist.toLowerCase()}"`) },
      { label: `More from ${set.creator || "this mapper"}`, icon: "user", action: () => search(`creator=="${set.creator.toLowerCase()}"`) },
    );
  }
  openMenu(at, entries, { minWidth: 220 });
}
