/* obs-control.ts — Fumen and OBS itself (docs/OBS.md): the connection (lib/obs-ws) as Settings
 * sets it, scenes that follow what osu! shows (lib/obs-rules' SceneRules), and the replay buffer
 * saved a few seconds after the good moments of a play (a full combo, a new best, a close pass),
 * named after the map, with a chapter marker in the recording if wanted. Needs "Follow osu!"
 * (tosu) for what osu! does. */
import { invoke } from "@tauri-apps/api/core";
import { api, asApiError } from "../lib/api";
import type { Attempt } from "../lib/attempts";
import { t } from "../lib/i18n";
import { better } from "../lib/obs-parts";
import { clipName, clipReason, SceneRules, sceneOf, type ClipReason } from "../lib/obs-rules";
import { ObsSocket } from "../lib/obs-ws";
import { Emitter, events, store } from "../lib/store";
import { STATE } from "../lib/tosu";
import { follow } from "../lib/tosu-follow";
import { toast } from "../ui/controls";
import { clipSaved } from "./obs-feed";

/** ms after a play's end before the replay buffer is saved, so the moment is in it */
const CLIP_AFTER = 3000;

export const obs = new ObsSocket(() => invoke<string | null>("obs_password_get").catch(() => null));
/** `scenes`: OBS's scenes, top first; `scene`: the one on air; `replay`: the replay buffer runs */
export const obsEvents = new Emitter<{ scenes: string[]; scene: string | null; replay: boolean }>();

let scenes: string[] = [];
let current: string | null = null;
let replayOn = false;
let recording = false;
const rules = new SceneRules();
let started = false;
let linkedTo: string | null = null;
let scenesKey = "";

/** OBS's scenes, top of its list first */
export const obsScenes = (): string[] => scenes;
export const replayBufferOn = (): boolean => replayOn;

const prefs = () => store.prefs.obs;
/** OBS on this computer (the window may only reach 127.0.0.1) */
const address = (): string | null => (prefs()?.connect ? `ws://127.0.0.1:${prefs().port || 4455}` : null);

/** What OBS has now: its scenes, the one on air, the replay buffer, the recording. */
async function look(): Promise<void> {
  try {
    const list = await obs.request<{ currentProgramSceneName?: string; scenes?: { sceneName: string; sceneIndex: number }[] }>("GetSceneList");
    scenes = [...(list.scenes ?? [])].sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
    current = list.currentProgramSceneName ?? null;
    obsEvents.emit("scenes", scenes);
    obsEvents.emit("scene", current);
  } catch {
    // gone again
  }
  replayOn = await obs.request<{ outputActive?: boolean }>("GetReplayBufferStatus").then(
    (r) => !!r.outputActive,
    () => false,
  );
  obsEvents.emit("replay", replayOn);
  recording = await obs.request<{ outputActive?: boolean }>("GetRecordStatus").then(
    (r) => !!r.outputActive,
    () => false,
  );
}

// ── scenes ──

function step(): void {
  const p = prefs();
  if (!p?.scenes?.on || !obs.on || !store.prefs.followOsu) return;
  const target = rules.decide(sceneOf(follow.latest), performance.now(), current, p.scenes);
  if (target)
    void obs.request("SetCurrentProgramScene", { sceneName: target }).catch((e) => console.warn("[obs] scene", asApiError(e).message));
}

// ── clips ──

/** the least health of the try going on, 0–1 ("close pass") */
let least: { md5: string; hits: number; health: number } | null = null;
/** tries a clip was kept for (when they started) */
const clipped = new Set<number>();
/** what the next clip OBS saves is to be called */
let naming: string | null = null;

function watchHealth(): void {
  const n = follow.latest;
  if (!n || n.state !== STATE.play || n.play.health === null) return;
  // a new try: another map, or the judgements counted from nothing again
  if (!least || least.md5 !== n.md5 || n.play.hits < least.hits) least = { md5: n.md5, hits: n.play.hits, health: 1 };
  least.hits = n.play.hits;
  if (n.play.hits > 0 && !n.play.failed) least.health = Math.min(least.health, n.play.health / 100);
}

async function onAttempt(a: Attempt): Promise<void> {
  const p = prefs()?.clips;
  if (!p?.on || !obs.on || a.outcome !== "pass" || clipped.has(a.started)) return;
  const before = (await api.attemptsForMap(a.md5, 500).catch(() => [] as Attempt[])).filter((b) => b.started < a.started);
  const passes = before.filter((b) => b.outcome === "pass");
  const lastPass = passes.reduce((m, b) => Math.max(m, b.started), -Infinity);
  const reason = clipReason(
    {
      pass: true,
      misses: a.misses,
      newBest: passes.length > 0 && passes.every((b) => better(a, b)),
      leastHealth: least?.md5 === a.md5 ? least.health : null,
      failsBefore: before.filter((b) => b.outcome === "fail" && b.started > lastPass).length,
    },
    p,
  );
  if (!reason || clipped.has(a.started)) return;
  clipped.add(a.started);
  await keep(a.md5, reason);
}

/** The map's title and difficulty, for a clip's name. */
async function mapWords(md5: string): Promise<{ title: string; version: string }> {
  const now = follow.latest;
  const id = md5 ? await api.mapByMd5(md5).catch(() => null) : null;
  const m = id ? store.snap?.maps.find((x) => x.id === id) : undefined;
  if (m) return { title: store.snap!.sets[m.set]?.title ?? "", version: m.version };
  if (now && now.md5 === md5) return { title: now.title, version: now.version };
  return { title: "Fumen", version: "" };
}

const WORDS: Record<ClipReason | "test", () => string> = {
  fc: () => t("Full combo"),
  best: () => t("New best"),
  close: () => t("Close pass"),
  test: () => t("Test"),
};

/** Saves the replay buffer for this play (after a moment, so its end is in it). */
async function keep(md5: string, reason: ClipReason | "test"): Promise<void> {
  if (!replayOn)
    replayOn = await obs.request<{ outputActive?: boolean }>("GetReplayBufferStatus").then(
      (r) => !!r.outputActive,
      () => false,
    );
  if (!replayOn) {
    toast(reason === "test" ? t("The replay buffer is off in OBS.") : t("That was worth a clip, but the replay buffer is off in OBS."), {
      kind: "danger",
      timeout: 9000,
      action: { label: t("Start it"), run: () => void obs.request("StartReplayBuffer").catch((e) => toast(asApiError(e).message, { kind: "danger" })) },
    });
    return;
  }
  const { title, version } = await mapWords(md5);
  const word = WORDS[reason]();
  const p = prefs().clips;
  // the chapter at the moment itself, the clip a little after it
  if (p.marker && recording && reason !== "test") void obs.request("CreateRecordChapter", { chapterName: `${word}: ${title}${version ? ` [${version}]` : ""}` }).catch(() => {});
  window.setTimeout(
    () => {
      naming = p.rename ? clipName(title, version, word, new Date()) : null;
      void obs.request("SaveReplayBuffer").catch((e) => {
        naming = null;
        toast(`${t("The clip wasn't saved.")} ${asApiError(e).message}`, { kind: "danger" });
      });
    },
    reason === "test" ? 0 : CLIP_AFTER,
  );
}

/** OBS wrote the clip: named after the map if wanted, counted, shown. */
async function saved(path: string): Promise<void> {
  const name = naming;
  naming = null;
  let at = path;
  if (name && path) at = await invoke<string>("rename_clip", { path, name }).catch(() => path);
  clipSaved();
  toast(t("Clip saved"), {
    kind: "success",
    timeout: 7000,
    action: at ? { label: t("Show in folder"), run: () => void invoke("reveal_clip", { path: at }).catch((e) => toast(asApiError(e).message, { kind: "danger" })) } : undefined,
  });
}

/** Settings' "Test clip": the replay buffer saved now. */
export function testClip(): void {
  if (!obs.on) return void toast(t("Fumen isn't connected to OBS."), { kind: "danger" });
  void keep(follow.latest?.md5 ?? "", "test");
}

/** A new password for OBS (empty: none), kept sealed; then OBS is asked again. */
export async function setObsPassword(password: string): Promise<void> {
  await invoke("obs_password_set", { password: password || null });
  obs.use(address());
}

export function initObsControl(): void {
  if (started) return;
  started = true;
  const relink = (): void => {
    const a = address();
    if (a !== linkedTo) {
      linkedTo = a;
      obs.use(a);
    }
    const key = JSON.stringify(prefs()?.scenes ?? null);
    if (key !== scenesKey) {
      scenesKey = key;
      rules.reset();
    }
  };
  relink();
  events.on("prefs", (p) => {
    if ("obs" in p || "followOsu" in p) relink();
  });
  obs.bus.on("state", (s) => {
    if (s.kind === "on") {
      rules.reset();
      void look();
    } else {
      scenes = [];
      current = null;
      replayOn = false;
      obsEvents.emit("scenes", scenes);
    }
  });
  obs.bus.on("event", (e) => {
    switch (e.type) {
      case "CurrentProgramSceneChanged":
        current = String(e.data.sceneName ?? "") || null;
        obsEvents.emit("scene", current);
        break;
      case "SceneListChanged":
      case "SceneCreated":
      case "SceneRemoved":
      case "SceneNameChanged":
        void look();
        break;
      case "ReplayBufferStateChanged":
        replayOn = !!e.data.outputActive;
        obsEvents.emit("replay", replayOn);
        break;
      case "RecordStateChanged":
        recording = !!e.data.outputActive;
        break;
      case "ReplayBufferSaved":
        void saved(String(e.data.savedReplayPath ?? ""));
        break;
    }
  });
  follow.bus.on("tosu", () => {
    watchHealth();
    step();
  });
  follow.bus.on("attempt", (a) => void onAttempt(a));
  // states that settle while nothing comes from tosu (osu! closed)
  window.setInterval(step, 500);
}
