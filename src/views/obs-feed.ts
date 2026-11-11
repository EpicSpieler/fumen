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
import { hudPrefs } from "../lib/hud-layout";
import { lang } from "../lib/i18n";
import { better, sessionStartOf, triesPart, type ObsBest, type ObsConfig, type ObsCue, type ObsMap, type ObsPlayer, type ObsSession, type ObsSessionPlay, type ObsTries, type PartName } from "../lib/obs-parts";
import { DEMO_LAST, DEMO_MD5 } from "../obs/demo";
import { progress } from "../lib/attempts";
import { DEFAULT_ACCENT, events, setPrefs, store } from "../lib/store";
import { follow, TOSU_URL } from "../lib/tosu-follow";
import type { MapRow, SetRow } from "../lib/types";
import { player } from "../player";
import { overlayEvents, overlayPort } from "./overlay";
import { visPrefs } from "./vis/visualizer";

/** how far back a session may reach */
const SESSION_MAX = 24 * 60 * 60 * 1000;
/** ms between looks at the session while nothing happens (its length grows) */
const SESSION_EVERY = 60_000;

const sent = new Map<PartName, string>();
const ids = new Map<string, string | null>();
/** what osu! called the maps it was on while Fumen ran, for tries at maps the library doesn't
 * have (played in stable, downloaded since the last look at lazer) */
const named = new Map<string, { title: string; version: string }>();
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

/** A map's title and difficulty: the library's, else osu!'s; null when neither knows it. */
function wordsOf(md5: string, row: { m: MapRow; s: SetRow } | null): { title: string; version: string } | null {
  if (row) return { title: row.s.title, version: row.m.version };
  return named.get(md5) ?? null;
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

/** What the pages follow: the language, tosu's address, the looks, where the overlay's parts sit. */
export function obsConfig(): ObsConfig {
  const p = store.prefs;
  return { tosu: TOSU_URL, lang, accent: p.accent || DEFAULT_ACCENT, vis: visPrefs(), reduceMotion: !!p.reduceMotion, hud: hudPrefs(p.obs?.hud) };
}

function sendConfig(): void {
  send("config", obsConfig());
}

/** What the pages are told about a difficulty: the library's, or what tosu says when it isn't there. */
function toObsMap(
  md5: string,
  id: string | null,
  row: { m: MapRow; s: SetRow } | null,
  now: { title: string; artist: string; version: string; mode: number } | null,
  beats: number[],
  kiai: number[],
  best: ObsBest | null,
): ObsMap {
  const m = row?.m;
  const s = row?.s;
  return {
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
    best: m ? bestOf(m, best) : best,
  };
}

/** For arranging the overlay (views/hud-editor.ts): a difficulty from the library standing in
 * for the map osu! plays (the one that plays now, else one with a background), with made-up
 * tries at it: some ended early, most around one part, a best to beat. */
export async function demoParts(): Promise<{ map: ObsMap | null; tries: ObsTries }> {
  const snap = store.snap;
  let row: { m: MapRow; s: SetRow } | null = null;
  const np = player.now;
  if (np && snap?.maps[np.map]) row = { m: snap.maps[np.map], s: snap.sets[np.set] };
  if (!row && follow.latest?.md5) row = rowOf(await idOf(follow.latest.md5));
  if (!row && snap) {
    const pick = snap.maps.find((m) => m.mode === 3 && (m.bg || snap.sets[m.set]?.bg)) ?? snap.maps.find((m) => m.bg || snap.sets[m.set]?.bg) ?? snap.maps[0];
    if (pick) row = { m: pick, s: snap.sets[pick.set] };
  }
  const chart = row ? await loadChart(row.m.id).catch(() => null) : null;
  const map = row ? toObsMap(DEMO_MD5, row.m.id, row, null, chart?.beats ?? [], chart?.kiai ?? [], null) : null;
  if (map) map.best = { accuracy: 0.9621, rank: "A", pp: 196, score: 610_000 };
  const tries: ObsTries = {
    md5: DEMO_MD5,
    count: 11,
    passes: 0,
    fails: 9,
    left: 2,
    ends: [0.12, 0.3, 0.33, 0.34, 0.36, 0.37, 0.5, 0.55, 0.58],
    furthest: 0.58,
    spot: { a: DEMO_LAST * 0.31, b: DEMO_LAST * 0.37, stops: 4 },
    sincePass: 11,
    best: null,
  };
  return { map, tries };
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
  // the map at once (the song card waits for it), its beats when the chart is read
  const map = toObsMap(md5, id, row, now, [], [], tp.best);
  send("map", map, [map.bg], [map.audio]);
  if (!row) return;
  const chart = await loadChart(row.m.id).catch(() => null);
  if (job !== mapJob || !chart) return;
  send("map", { ...map, beats: chart.beats ?? [], kiai: chart.kiai ?? [] }, [map.bg], [map.audio]);
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
    if (job !== sessionJob) return;
    // a map nothing here has a name for stays out
    const words = wordsOf(a.md5, row);
    if (!words) continue;
    const before = (await api.attemptsForMap(a.md5, 500).catch(() => [] as Attempt[])).filter((b) => b.outcome === "pass" && b.started < a.started);
    if (job !== sessionJob) return;
    const bg = row?.m.bg ?? row?.s.bg ?? null;
    if (bg) art.push(bg);
    top.push({
      ...words,
      bg,
      rank: a.rank,
      accuracy: a.accuracy,
      pp: a.pp,
      best: before.every((b) => better(a, b)),
      fc: a.misses === 0,
    });
  }
  // the map that took the most tries (then the most fails), of the ones with a name
  const by = new Map<string, Attempt[]>();
  for (const a of tries) by.set(a.md5, [...(by.get(a.md5) ?? []), a]);
  const fails = (l: Attempt[]) => l.filter((a) => a.outcome === "fail").length;
  let costly: ObsSession["costly"] = null;
  for (const most of [...by.entries()].sort((x, y) => y[1].length - x[1].length || fails(y[1]) - fails(x[1]))) {
    if (most[1].length < 2) break;
    const row = rowOf(await idOf(most[0]));
    if (job !== sessionJob) return;
    const words = wordsOf(most[0], row);
    if (!words) continue;
    const bg = row?.m.bg ?? row?.s.bg ?? null;
    if (bg) art.push(bg);
    costly = {
      ...words,
      bg,
      tries: most[1].length,
      fails: fails(most[1]),
      minutes: Math.round(most[1].reduce((n, a) => n + Math.max(0, a.ended - a.started), 0) / 60_000),
      passed: most[1].some((a) => a.outcome === "pass"),
    };
    break;
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

/** Shows something on the pages right now (a button in Settings); the session card with the
 * session as it is this moment. */
export function cue(kind: ObsCue["kind"]): void {
  const go = (): void => send("cue", { n: ++cueN, kind } satisfies ObsCue);
  if (kind === "session") void sendSession().then(go, go);
  else go();
}

/** A clip was saved: the session card counts it. */
export function clipSaved(): void {
  clips++;
  void sendSession();
}

/** Starts a new session now (Settings). */
export function newSession(): void {
  setPrefs({ obs: { ...store.prefs.obs, sessionFrom: Date.now() } });
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
  follow.bus.on("map", (md5) => {
    const now = follow.latest;
    if (md5 && now?.md5 === md5 && now.title) named.set(md5, { title: now.title, version: now.version });
    void sendMap();
  });
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
