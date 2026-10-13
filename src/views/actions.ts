/* actions.ts — things you can do with a set or difficulty, shared by every view. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { osuMapUrl, osuSetUrl } from "../lib/api";
import {
  addToCollection, collectionMaps, copyLazerCollection, createCollection, deleteCollection, fumenCollection, fumenCollections,
  isSmart, lazerTarget, putIntoLazer, removeFromCollection, renameCollection, saveCollectionDb,
} from "../lib/collections";
import { num } from "../lib/format";
import { go } from "../lib/router";
import { store } from "../lib/store";
import { player } from "../player";
import { openMenu, toast, uiConfirm, uiPrompt, type MenuEntry } from "../ui/controls";

export function openSet(setIdx: number, mapIdx?: number, opts: { similar?: boolean } = {}): void {
  const snap = store.snap;
  if (!snap) return;
  const set = snap.sets[setIdx];
  go({ name: "set", id: set.id, ...(mapIdx !== undefined ? { map: snap.maps[mapIdx].id, ...(opts.similar ? { similar: true } : {}) } : {}) });
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
  opts: { onSearch?: (q: string) => void; inSetPage?: boolean; extra?: MenuEntry[]; collection?: string; onSimilar?: () => void } = {},
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
  if (mapIdx !== undefined) {
    const similar = opts.onSimilar ?? (() => openSet(setIdx, mapIdx, { similar: true }));
    entries.push({ label: "Similar maps", icon: "similar", action: similar });
  }
  if (opts.extra?.length) entries.push(...opts.extra);
  // a set: all its difficulties
  const picked = mapIdx !== undefined ? [mapIdx] : [...set.maps];
  entries.push("sep", { label: "Add to collection…", icon: "collection", action: () => collectionPicker(at, picked) });
  if (opts.collection && fumenCollection(opts.collection) && !isSmart(fumenCollection(opts.collection))) {
    const id = opts.collection;
    entries.push({ label: map ? "Remove from collection" : "Remove set from collection", icon: "x", action: () => void removeFromCollection(id, picked) });
  }
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

/** Which collection to put difficulties in: Fumen's, each marked when they're all in it already,
 * or a new one. */
export function collectionPicker(at: Element | { x: number; y: number }, mapIdxs: number[]): void {
  const cols = fumenCollections().filter((c) => !isSmart(c));
  const entries: MenuEntry[] = [];
  if (cols.length) entries.push({ group: "Add to" });
  for (const c of cols) {
    const has = collectionMaps(c);
    entries.push({
      label: c.name,
      icon: "collection",
      hint: num(c.maps.length),
      checked: mapIdxs.every((i) => has.has(i)),
      action: () => void addToCollection(c.id, mapIdxs),
    });
  }
  if (cols.length) entries.push("sep");
  entries.push({ label: "New collection…", icon: "plus", action: () => void newCollection(mapIdxs) });
  // after the menu that asked has closed
  setTimeout(() => openMenu(at, entries, { minWidth: 220 }), 0);
}

/** Asks for a name and makes a collection, with these difficulties in it. */
export async function newCollection(mapIdxs: number[] = []): Promise<string | null> {
  const name = await uiPrompt(mapIdxs.length ? `With ${num(mapIdxs.length)} ${mapIdxs.length === 1 ? "difficulty" : "difficulties"} in it.` : "", {
    title: "New collection",
    placeholder: "Name",
    confirmLabel: "Make",
  });
  return name ? createCollection(name, mapIdxs) : null;
}

/** The menu of a collection (sidebar, collection page): Fumen's can be renamed and deleted; one of
 * lazer's can be copied into Fumen to change it. */
export function collectionMenu(
  at: Element | { x: number; y: number },
  id: string,
  after?: { deleted?: () => void; copied?: (id: string) => void; editSearch?: (id: string) => void },
): void {
  const mine = fumenCollection(id);
  if (mine) {
    openMenu(at, [
      ...(isSmart(mine) && after?.editSearch ? [{ label: "Edit search", icon: "sliders" as const, hint: "in the library", action: () => after.editSearch!(id) }] : []),
      {
        label: "Rename…",
        icon: "tag",
        action: () => void (async () => {
          const name = await uiPrompt("", { title: "Rename collection", value: mine.name, confirmLabel: "Rename" });
          if (name && name !== mine.name) await renameCollection(id, name);
        })(),
      },
      "sep",
      {
        label: lazerTarget(mine) ? "Update in osu!lazer" : "Put into osu!lazer",
        icon: "arrow-right",
        hint: "lazer closed",
        action: () => void putIntoLazer([mine]),
      },
      { label: "Save as collection.db…", icon: "download", hint: "stable", action: () => void saveCollectionDb([mine]) },
      "sep",
      {
        label: "Delete collection",
        icon: "trash",
        danger: true,
        action: () => void (async () => {
          const ok = await uiConfirm(`"${mine.name}" goes, the beatmaps stay.`, { title: "Delete this collection?", confirmLabel: "Delete", danger: true });
          if (!ok) return;
          await deleteCollection(id);
          after?.deleted?.();
        })(),
      },
    ], { minWidth: 200 });
    return;
  }
  const lazer = store.snap?.collections.find((c) => c.id === id);
  if (!lazer) return;
  openMenu(at, [
    {
      label: "Copy into Fumen",
      icon: "copy",
      hint: "to change it",
      action: () => void (async () => {
        const name = await uiPrompt(`A Fumen collection you can add to and take from. ${lazer.from === "stable" ? "stable's" : "lazer's"} stays as it is.`, {
          title: "Copy into Fumen",
          value: lazer.name,
          confirmLabel: "Copy",
        });
        if (!name) return;
        const copy = await copyLazerCollection(id, name);
        if (copy) after?.copied?.(copy);
      })(),
    },
  ], { minWidth: 210 });
}
