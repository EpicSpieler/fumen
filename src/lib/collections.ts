/* collections.ts — Fumen's own collections (lazer's come with the library snapshot and can't be
 * changed here). They hold difficulties; the backend keeps them by MD5 (src-tauri/src/collections.rs)
 * and hands back library ids, which this turns into snapshot indices. A smart collection holds a
 * saved search instead (the library's filters) and is whatever in the library matches it now. */
import { save } from "@tauri-apps/plugin-dialog";
import { api, asApiError } from "./api";
import { mapIndexOf } from "./history";
import { num } from "./format";
import { DEFAULT_FILTER, filterLibrary, type FilterState, type LibIndex } from "./search";
import { Emitter, events, reloadLibrary, store } from "./store";
import type { CollectionPick, CollectionRow, FumenCollection } from "./types";
import { toast, uiConfirm } from "../ui/controls";
import { t, tn } from "./i18n";

/** what a drag from the library carries: the difficulties' library ids, as JSON */
export const DRAG_TYPE = "application/x-fumen-maps";

export const collectionEvents = new Emitter<{ collections: FumenCollection[] }>();

let list: FumenCollection[] = [];
let started = false;

export const fumenCollections = (): FumenCollection[] => list;
export const fumenCollection = (id: string): FumenCollection | undefined => list.find((c) => c.id === id);
export const isFumenCollection = (id: string): boolean => list.some((c) => c.id === id);

export const isSmart = (c: FumenCollection | undefined): boolean => c?.query !== undefined;

/** A smart collection's filters (anything it doesn't say: the defaults). */
export function smartFilter(c: FumenCollection): FilterState {
  let saved: Partial<FilterState> & { srMax?: number | null } = {};
  try {
    saved = JSON.parse(c.query ?? "{}");
  } catch {
    // an unreadable search matches like an empty one
  }
  return { ...DEFAULT_FILTER, ...saved, srMax: saved.srMax ?? Infinity, keys: [...(saved.keys ?? [])], status: [...(saved.status ?? [])] };
}

/** what a smart collection keeps (Infinity goes into JSON as null, read back as Infinity) */
export const filterJson = (f: FilterState): string =>
  JSON.stringify({ text: f.text, mode: f.mode, keys: f.keys, srMin: f.srMin, srMax: f.srMax, status: f.status, played: f.played, showHidden: f.showHidden });

/** smart collections' members, per library index and search */
const smartCache = new WeakMap<LibIndex, Map<string, Set<number>>>();

/** A collection's difficulties as snapshot indices (the ones in the library). */
export function collectionMaps(c: FumenCollection): Set<number> {
  if (isSmart(c)) {
    const ix = store.index;
    if (!ix) return new Set();
    let byQuery = smartCache.get(ix);
    if (!byQuery) smartCache.set(ix, (byQuery = new Map()));
    let members = byQuery.get(c.query!);
    if (!members) {
      members = new Set(filterLibrary(ix, smartFilter(c)).sets.flatMap((r) => r.maps));
      byQuery.set(c.query!, members);
    }
    return members;
  }
  const out = new Set<number>();
  for (const id of c.maps) {
    const i = mapIndexOf(id);
    if (i !== undefined) out.add(i);
  }
  return out;
}

const idsOf = (mapIdxs: Iterable<number>): string[] => [...mapIdxs].map((i) => store.snap!.maps[i].id);
const diffs = (n: number) => tn(n, "{n} difficulty", "{n} difficulties");

export async function loadCollections(): Promise<void> {
  try {
    list = await api.getCollections();
    collectionEvents.emit("collections", list);
  } catch (e) {
    console.warn("[collections]", asApiError(e).message);
  }
}

/** Runs a change, then reloads; a failure is a toast (`fail`: "Couldn't …", translated). */
async function change<T>(fail: string, f: () => Promise<T>): Promise<T | null> {
  try {
    const r = await f();
    await loadCollections();
    return r;
  } catch (e) {
    toast(`${fail}: ${asApiError(e).message}`, { kind: "danger", timeout: 6000 });
    return null;
  }
}

/** Makes a collection (with difficulties in it if given); its id, or null if it didn't work. */
export async function createCollection(name: string, mapIdxs: number[] = []): Promise<string | null> {
  const id = await change(t("Couldn't make the collection"), () => api.createCollection(name, idsOf(mapIdxs)));
  if (id && mapIdxs.length) toast(t("Made “{name}” with {diffs}", { name, diffs: diffs(mapIdxs.length) }), { kind: "success" });
  return id;
}

/** Saves the library's filters as a smart collection; its id. */
export async function createSmartCollection(name: string, filter: FilterState): Promise<string | null> {
  return change(t("Couldn't save the search"), () => api.createSmartCollection(name, filterJson(filter)));
}

export async function updateSmartCollection(id: string, filter: FilterState): Promise<boolean> {
  const ok = await change(t("Couldn't save the search"), () => api.setCollectionQuery(id, filterJson(filter)).then(() => true));
  if (ok) toast(t("Saved “{name}”", { name: fumenCollection(id)?.name ?? t("the collection") }), { kind: "success" });
  return !!ok;
}

export async function copyLazerCollection(lazerId: string, name: string): Promise<string | null> {
  return change(t("Couldn't copy the collection"), () => api.copyLazerCollection(lazerId, name));
}

export async function addToCollection(id: string, mapIdxs: number[]): Promise<void> {
  const name = fumenCollection(id)?.name ?? t("the collection");
  const added = await change(t("Couldn't add to the collection"), () => api.addToCollection(id, idsOf(mapIdxs)));
  if (added === null) return;
  if (added === 0) toast(mapIdxs.length === 1 ? t("Already in “{name}”", { name }) : t("All already in “{name}”", { name }));
  else toast(t("Added {diffs} to “{name}”", { diffs: diffs(added), name }), { kind: "success" });
}

export async function removeFromCollection(id: string, mapIdxs: number[]): Promise<void> {
  const name = fumenCollection(id)?.name ?? t("the collection");
  const removed = await change(t("Couldn't take it out of the collection"), () => api.removeFromCollection(id, idsOf(mapIdxs)));
  if (removed) toast(t("Took {diffs} out of “{name}”", { diffs: diffs(removed), name }));
}

export async function renameCollection(id: string, name: string): Promise<void> {
  await change(t("Couldn't rename the collection"), () => api.renameCollection(id, name));
}

export async function deleteCollection(id: string): Promise<void> {
  await change(t("Couldn't delete the collection"), () => api.deleteCollection(id));
}

// ── out of Fumen ────────────────────────────────────────────────────────

/** What goes out: a smart collection with what it matches now. */
function pick(c: FumenCollection): CollectionPick {
  return isSmart(c) ? { id: c.id, maps: idsOf(collectionMaps(c)) } : { id: c.id };
}

/** How many difficulties a collection takes out of Fumen (a hand-made one's missing ones too). */
export const outgoingCount = (c: FumenCollection): number => (isSmart(c) ? collectionMaps(c).size : c.maps.length + c.missing);

/** The lazer collection one of Fumen's goes into: the one it went into before, else lazer's of
 * the same name (as the importer decides it), else none (a new one). */
export function lazerTarget(c: FumenCollection): CollectionRow | undefined {
  const lazer = (store.snap?.collections ?? []).filter((l) => !l.from);
  return lazer.find((l) => l.id === c.lazerId) ?? lazer.find((l) => l.name === c.name);
}

let writing = false;

/** Puts collections into osu!lazer's after asking; lazer has to be closed. */
export async function putIntoLazer(cols: FumenCollection[]): Promise<void> {
  if (writing || !cols.length) return;
  let st;
  try {
    st = await api.lazerImportStatus();
  } catch (e) {
    toast(asApiError(e).message, { kind: "danger", timeout: 6000 });
    return;
  }
  if (!st.ready) {
    const msg = st.reason === "running" ? t("Close osu!lazer first: Fumen only writes to it while it's closed.") : (st.message ?? t("osu!lazer can't be written to right now."));
    toast(msg, { kind: "danger", timeout: 6000 });
    return;
  }
  const safety = `\n\n${t("lazer's database is backed up first.")}`;
  let title: string;
  let message: string;
  if (cols.length === 1) {
    const [c] = cols;
    const target = lazerTarget(c);
    const now = isSmart(c) ? ` ${t("(what matches the search now; put it in again after changes)")}` : "";
    const count = diffs(outgoingCount(c));
    title = target ? t("Update “{name}” in osu!lazer?", { name: target.name }) : t("Put “{name}” into osu!lazer?", { name: c.name });
    message = target
      ? `${
          target.name !== c.name
            ? t("lazer's “{name}” will hold exactly this collection's {diffs}{now} and be renamed to “{to}”.", { name: target.name, diffs: count, now, to: c.name })
            : t("lazer's “{name}” will hold exactly this collection's {diffs}{now}.", { name: target.name, diffs: count, now })
        }`
      : t("It becomes one of lazer's collections, with {diffs}{now}.", { diffs: count, now });
  } else {
    const updating = cols.filter((c) => lazerTarget(c)).length;
    title = t("Put {n} collections into osu!lazer?", { n: num(cols.length) });
    message = updating
      ? t("{fresh} become new lazer collections; {updating} replace what's in lazer's of the same name (or the one they went into before).", { fresh: num(cols.length - updating), updating: num(updating) })
      : t("Each becomes one of lazer's collections.");
    if (cols.some(isSmart)) message += ` ${t("Smart ones go in with what they match now.")}`;
  }
  if (!(await uiConfirm(message + safety, { title, confirmLabel: t("Put into lazer") }))) return;

  writing = true;
  events.emit("importing", true);
  try {
    const r = await api.putCollectionsIntoLazer(cols.map(pick));
    const parts = [r.created && t("{n} new", { n: num(r.created) }), r.updated && t("{n} updated", { n: num(r.updated) })].filter(Boolean).join(", ");
    toast(cols.length === 1 ? t("“{name}” is in osu!lazer", { name: cols[0].name }) : t("Collections in osu!lazer: {counts}", { counts: parts }), { kind: "success" });
    await reloadLibrary().catch((e) => console.warn("[collections] reload failed", e));
    await loadCollections();
  } catch (e) {
    toast(t("Couldn't write lazer's collections: {error}", { error: asApiError(e).message }), { kind: "danger", timeout: 7000 });
  } finally {
    writing = false;
    events.emit("importing", false);
  }
}

/** Saves collections as a stable collection.db (for stable or Collection Manager). */
export async function saveCollectionDb(cols: FumenCollection[]): Promise<void> {
  if (!cols.length) return;
  let path: string | null;
  try {
    path = await save({ title: t("Save as collection.db"), defaultPath: "collection.db", filters: [{ name: t("osu! collections"), extensions: ["db"] }] });
  } catch (e) {
    toast(asApiError(e).message, { kind: "danger", timeout: 6000 });
    return;
  }
  if (!path) return;
  try {
    const n = await api.saveCollectionDb(path, cols.map(pick));
    toast(n === 1 ? t("Saved “{name}” as collection.db", { name: cols[0].name }) : t("Saved {n} collections as collection.db", { n: num(n) }), { kind: "success" });
  } catch (e) {
    toast(t("Couldn't save collection.db: {error}", { error: asApiError(e).message }), { kind: "danger", timeout: 6000 });
  }
}

export function initCollections(): void {
  if (started) return;
  started = true;
  void loadCollections();
  // a rescan can bring back (or take away) difficulties: the ids are looked up again
  events.on("library", () => void loadCollections());
}
