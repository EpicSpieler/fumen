/* collections.ts — Fumen's own collections (lazer's come with the library snapshot and can't be
 * changed here). They hold difficulties; the backend keeps them by MD5 (src-tauri/src/collections.rs)
 * and hands back library ids, which this turns into snapshot indices. */
import { api, asApiError } from "./api";
import { mapIndexOf } from "./history";
import { num } from "./format";
import { Emitter, events, store } from "./store";
import type { FumenCollection } from "./types";
import { toast } from "../ui/controls";

/** what a drag from the library carries: the difficulties' library ids, as JSON */
export const DRAG_TYPE = "application/x-fumen-maps";

export const collectionEvents = new Emitter<{ collections: FumenCollection[] }>();

let list: FumenCollection[] = [];
let started = false;

export const fumenCollections = (): FumenCollection[] => list;
export const fumenCollection = (id: string): FumenCollection | undefined => list.find((c) => c.id === id);
export const isFumenCollection = (id: string): boolean => list.some((c) => c.id === id);

/** A collection's difficulties as snapshot indices (the ones in the library). */
export function collectionMaps(c: FumenCollection): Set<number> {
  const out = new Set<number>();
  for (const id of c.maps) {
    const i = mapIndexOf(id);
    if (i !== undefined) out.add(i);
  }
  return out;
}

const idsOf = (mapIdxs: Iterable<number>): string[] => [...mapIdxs].map((i) => store.snap!.maps[i].id);
const diffs = (n: number) => `${num(n)} ${n === 1 ? "difficulty" : "difficulties"}`;

export async function loadCollections(): Promise<void> {
  try {
    list = await api.getCollections();
    collectionEvents.emit("collections", list);
  } catch (e) {
    console.warn("[collections]", asApiError(e).message);
  }
}

/** Runs a change, then reloads; a failure is a toast. */
async function change<T>(what: string, f: () => Promise<T>): Promise<T | null> {
  try {
    const r = await f();
    await loadCollections();
    return r;
  } catch (e) {
    toast(`Couldn't ${what}: ${asApiError(e).message}`, { kind: "danger", timeout: 6000 });
    return null;
  }
}

/** Makes a collection (with difficulties in it if given); its id, or null if it didn't work. */
export async function createCollection(name: string, mapIdxs: number[] = []): Promise<string | null> {
  const id = await change("make the collection", () => api.createCollection(name, idsOf(mapIdxs)));
  if (id && mapIdxs.length) toast(`Made "${name}" with ${diffs(mapIdxs.length)}`, { kind: "success" });
  return id;
}

export async function copyLazerCollection(lazerId: string, name: string): Promise<string | null> {
  return change("copy the collection", () => api.copyLazerCollection(lazerId, name));
}

export async function addToCollection(id: string, mapIdxs: number[]): Promise<void> {
  const name = fumenCollection(id)?.name ?? "the collection";
  const added = await change("add to the collection", () => api.addToCollection(id, idsOf(mapIdxs)));
  if (added === null) return;
  if (added === 0) toast(mapIdxs.length === 1 ? `Already in "${name}"` : `All already in "${name}"`);
  else toast(`Added ${diffs(added)} to "${name}"`, { kind: "success" });
}

export async function removeFromCollection(id: string, mapIdxs: number[]): Promise<void> {
  const name = fumenCollection(id)?.name ?? "the collection";
  const removed = await change("take it out of the collection", () => api.removeFromCollection(id, idsOf(mapIdxs)));
  if (removed) toast(`Took ${diffs(removed)} out of "${name}"`);
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await change("rename the collection", () => api.renameCollection(id, name));
}

export async function deleteCollection(id: string): Promise<void> {
  await change("delete the collection", () => api.deleteCollection(id));
}

export function initCollections(): void {
  if (started) return;
  started = true;
  void loadCollections();
  // a rescan can bring back (or take away) difficulties: the ids are looked up again
  events.on("library", () => void loadCollections());
}
