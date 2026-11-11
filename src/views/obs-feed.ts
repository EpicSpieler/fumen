/* obs-feed.ts — the window's side of the OBS pages (docs/OBS.md, lib/obs-parts): while the overlay
 * server runs, it's told the map osu! is on with what Fumen knows of it (the cover, the song, the
 * beats, stars, dan, patterns, your best), your tries at that map, Fumen's own player, the session,
 * and the settings the pages follow. Each part goes again only when it changed. */
import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import type { Attempt } from "../lib/attempts";
import { loadChart } from "../lib/charts";
import { shortDan } from "../lib/dan";
import { holdRatio, patternWords, rankInfo } from "../lib/format";
import { lang } from "../lib/i18n";
import { better, triesPart, type ObsBest, type ObsCue, type ObsMap, type ObsPlayer, type ObsSession, type ObsSessionPlay, type PartName } from "../lib/obs-parts";
import { progress } from "../lib/attempts";
import { DEFAULT_ACCENT, events, store } from "../lib/store";
import { follow, TOSU_URL } from "../lib/tosu-follow";
import type { MapRow, SetRow } from "../lib/types";
import { player } from "../player";
import { overlayEvents, overlayPort } from "./overlay";
import { visPrefs } from "./vis/visualizer";

/** a session ends after this long without a try (as on Home) */
const SESSION_GAP = 60 * 60 * 1000;
/** how far back a session may reach */
const SESSION_MAX = 24 * 60 * 60 * 1000;
/** ms between looks at the session while nothing happens (its length grows) */
const SESSION_EVERY = 60_000;

const sent = new Map<PartName, string>();
const ids = new Map<string, string | null>();
let started = false;
let cueN = 0;
let clips = 0;
let mapJob = 0;
let playerJob = 0;
let sessionJob = 0;

/** The pages' part `name` is `value` now (with the backgrounds and songs it names). */
function send(name: PartName, value: unknown, art: (string | null | undefined)[] = [], audio: (string | null | undefined)[] = []): void {
  if (!overlayPort()) return;
  const text = JSON.stringify([value, art, audio]);
  if (sent.get(name) === text) return;
  sent.set(name, text);
  const keep = (l: (string | null | undefined)[]) => l.filter((k): k is string => !!k);
  void invoke("obs_part", { part: name, value, art: keep(art), audio: keep(audio) }).catch((e) => {
    sent.delete(name);
    console.warn("[obs]", e);
  });
}

async function idOf(md5: string): Promise<string | null> {
  if (ids.has(md5)) return ids.get(md5)!;
  const id = await api.mapByMd5(md5).catch(() => null);
  if (id) ids.set(md5, id);
  return id;
}

function rowOf(id: string | null): { m: MapRow; s: SetRow } | null {
  const snap = store.snap;
  if (!id || !snap) return null;
  const m = snap.maps.find((x) => x.id === id);
  return m ? { m, s: snap.sets[m.set] } : null;
}

function patternsOf(m: MapRow): string[] {
  if (m.category) return [m.category];
  return m.patterns ? patternWords(m.patterns).split(", ").filter(Boolean).slice(0, 3) : [];
}

function bestOf(m: MapRow, tries: ObsBest | null): ObsBest | null {
  const own = m.best && m.best.rank >= 0 ? { accuracy: m.best.acc, rank: rankInfo(m.best.rank).label, pp: null, score: m.best.score } : null;
  if (!own) return tries;
  if (!tries) return own;
  return tries.score >= own.score ? tries : own;
}

// ── the parts ──

function sendConfig(): void {
  const p = store.prefs;
  send("config", { tosu: TOSU_URL, lang, accent: p.accent || DEFAULT_ACCENT, vis: visPrefs(), reduceMotion: !!p.reduceMotion });
}

/** The map osu! is on, and your tries at it. */
async function sendMap(): Promise<void> {
  const job = ++mapJob;
  const now = follow.latest;
  const md5 = now?.md5 ?? "";
  if (!md5) {
    send("map", null);
    send("tries", null);
    return;
  }
  const id = await idOf(md5);
  const tries = await api.attemptsForMap(md5, 500).catch(() => [] as Attempt[]);
  if (job !== mapJob) return;
  const tp = triesPart(md5, tries);
  send("tries", tp);
  const row = rowOf(id);
  let beats: number[] = [];
  let kiai: number[] = [];
  if (row) {
    const chart = await loadChart(row.m.id).catch(() => null);
    if (job !== mapJob) return;
    beats = chart?.beats ?? [];
    kiai = chart?.kiai ?? [];
  }
  const m = row?.m;
  const s = row?.s;
  const map: ObsMap = {
    md5,
    id,
    title: s?.title ?? now?.title ?? "",
    artist: s?.artist ?? now?.artist ?? "",
    version: m?.version ?? now?.version ?? "",
    creator: s?.creator ?? "",
    mode: m?.mode ?? now?.mode ?? 0,
    keys: m && m.mode === 3 ? Math.round(m.cs) : null,
    bg: m?.bg ?? s?.bg ?? null,
    audio: m?.audio ?? s?.audio ?? null,
    beats,
    kiai,
    sr: m?.sr ?? null,
    srDt: m?.srDt ?? null,
    srHt: m?.srHt ?? null,
    bpm: m?.bpm ?? 0,
    length: m?.length ?? 0,
    dan: m?.dan ? shortDan(m.dan, holdRatio(m)) : null,
    patterns: m ? patternsOf(m) : [],
    best: m ? bestOf(m, tp.best) : tp.best,
  };
  send("map", map, [map.bg], [map.audio]);
}

/** Fumen's own player. */
async function sendPlayer(): Promise<void> {
  const job = ++playerJob;
  const np = player.now;
  const snap = store.snap;
  if (!np || !snap) return send("player", null);
  const m = snap.maps[np.map];
  const s = snap.sets[np.set];
  if (!m || !s) return send("player", null);
  const chart = await loadChart(m.id).catch(() => null);
  if (job !== playerJob) return;
  const part: ObsPlayer = {
    playing: player.playing && !follow.alongside,
    at: Date.now(),
    pos: player.audio.currentTime,
    rate: player.rate,
    title: s.title,
    artist: s.artist,
    version: `${m.version} · mapped by ${s.creator}`,
    bg: np.bg ?? null,
    audio: np.audio,
    beats: chart?.beats ?? [],
    kiai: chart?.kiai ?? [],
  };
  send("player", part, [part.bg], [part.audio]);
}

/** Where the session began: the first try after the last hour without one (or "New session"). */
export function sessionStartOf(tries: readonly Pick<Attempt, "started" | "ended">[], now: number, from = 0): number {
  const list = [...tries].sort((a, b) => b.started - a.started);
  if (!list.length || now - list[0].ended >= SESSION_GAP) return Math.max(now, from);
  let start = list[0].started;
  for (let i = 1; i < list.length; i++) {
    if (start - list[i].ended >= SESSION_GAP) break;
    start = list[i].started;
  }
  return Math.max(start, from);
}

async function sendSession(): Promise<void> {
  const job = ++sessionJob;
  const now = Date.now();
  const all = await api.attemptsSince(now - SESSION_MAX).catch(() => [] as Attempt[]);
  if (job !== sessionJob) return;
  const start = sessionStartOf(all, now, store.prefs.obs?.sessionFrom ?? 0);
  const tries = all.filter((a) => a.started >= start).sort((a, b) => a.started - b.started);
  const line = tries.slice(-400).map((a) => ({ md5: a.md5, at: a.started, outcome: a.outcome, got: a.outcome === "pass" ? 1 : (progress(a) ?? 0) }));
  const art: string[] = [];
  // the best three passes, each against everything before it on its map
  const passes = tries.filter((a) => a.outcome === "pass").sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  const top: ObsSessionPlay[] = [];
  const seen = new Set<string>();
  for (const a of passes) {
    if (top.length >= 3 || seen.has(a.md5)) continue;
    seen.add(a.md5);
    const row = rowOf(await idOf(a.md5));
    const before = (await api.attemptsForMap(a.md5, 500).catch(() => [] as Attempt[])).filter((b) => b.outcome === "pass" && b.started < a.started);
    if (job !== sessionJob) return;
    const bg = row?.m.bg ?? row?.s.bg ?? null;
    if (bg) art.push(bg);
    top.push({
      title: row?.s.title ?? a.md5.slice(0, 8),
      version: row?.m.version ?? "",
      bg,
      rank: a.rank,
      accuracy: a.accuracy,
      pp: a.pp,
      best: before.every((b) => better(a, b)),
      fc: a.misses === 0,
    });
  }
  // the map that took the most tries (then the most fails)
  const by = new Map<string, Attempt[]>();
  for (const a of tries) by.set(a.md5, [...(by.get(a.md5) ?? []), a]);
  const fails = (l: Attempt[]) => l.filter((a) => a.outcome === "fail").length;
  const most = [...by.entries()].sort((x, y) => y[1].length - x[1].length || fails(y[1]) - fails(x[1]))[0];
  let costly: ObsSession["costly"] = null;
  if (most && most[1].length >= 2) {
    const row = rowOf(await idOf(most[0]));
    if (job !== sessionJob) return;
    const bg = row?.m.bg ?? row?.s.bg ?? null;
    if (bg) art.push(bg);
    costly = {
      title: row?.s.title ?? most[0].slice(0, 8),
      version: row?.m.version ?? "",
      bg,
      tries: most[1].length,
      fails: fails(most[1]),
      minutes: Math.round(most[1].reduce((n, a) => n + Math.max(0, a.ended - a.started), 0) / 60_000),
      passed: most[1].some((a) => a.outcome === "pass"),
    };
  }
  const count = (o: Attempt["outcome"]) => tries.filter((a) => a.outcome === o).length;
  const session: ObsSession = {
    start,
    tries: tries.length,
    passes: count("pass"),
    fails: count("fail"),
    left: count("quit") + count("retry"),
    line,
    top,
    costly,
    clips,
  };
  send("session", session, art);
}

/** Shows something on the pages right now (a button in Settings). */
export function cue(kind: ObsCue["kind"]): void {
  send("cue", { n: ++cueN, kind } satisfies ObsCue);
}

/** A clip was saved: the session card counts it. */
export function clipSaved(): void {
  clips++;
  void sendSession();
}

/** Starts a new session now (Settings). */
export function newSession(): void {
  void sendSession();
}

function sendAll(): void {
  sent.clear();
  sendConfig();
  void sendMap();
  void sendPlayer();
  void sendSession();
}

export function initObsFeed(): void {
  if (started) return;
  started = true;
  overlayEvents.on("change", () => {
    if (overlayPort()) sendAll();
    else sent.clear();
  });
  events.on("prefs", () => sendConfig());
  events.on("library", () => {
    void sendMap();
    void sendPlayer();
  });
  follow.bus.on("map", () => void sendMap());
  follow.bus.on("attempt", () => {
    void sendMap();
    void sendSession();
  });
  const again = () => void sendPlayer();
  player.bus.on("track", again);
  player.bus.on("state", again);
  player.bus.on("rate", again);
  player.audio.addEventListener("seeked", again);
  // the player's place now and then, so a page's guess doesn't drift; the session's length
  window.setInterval(() => {
    if (player.playing) void sendPlayer();
  }, 5000);
  window.setInterval(() => void sendSession(), SESSION_EVERY);
  if (overlayPort()) sendAll();
}
