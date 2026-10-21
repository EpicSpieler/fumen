/* overlay.ts — the stream overlay from the window's side: which match is on stream, switching
 * the overlay server on and off (src-tauri/src/overlay.rs, 127.0.0.1 only), and what it shows:
 * the names and points, the map being played (or picked next, or played last), and every slot's
 * ban, pick or win. Sent again whenever the match, its pool or the library changes; while a match
 * is on stream its room is asked about every few seconds (lib/matches.ts' watch). */
import { invoke } from "@tauri-apps/api/core";
import { asApiError, osuCoverUrl } from "../lib/api";
import { bpm, duration, esc, fixed, srColor, srInk } from "../lib/format";
import { t } from "../lib/i18n";
import { matchById, matchEvents, matchState, slotOfBeatmap, watchMatch, type Match, type MatchState, type Side } from "../lib/matches";
import { kindInfo, kindOfSlot, modText, poolById, poolEvents, poolSlot, rateOf, slotChart, slotCodes, type Pool } from "../lib/pools";
import { Emitter, events } from "../lib/store";
import { closeAnimated, toast } from "../ui/controls";
import { icon } from "../ui/icons";
import { chartStars } from "./pool-picker";

const STREAM_KEY = "fumen.onStream";

export const overlayEvents = new Emitter<{ change: void }>();

let streamId: string | null = (() => {
  try {
    return localStorage.getItem(STREAM_KEY);
  } catch {
    return null;
  }
})();
let port: number | null = null;
let unwatch: (() => void) | null = null;
let started = false;

/** the match on stream */
export const onStream = (): string | null => streamId;
/** the overlay server's port, while it's on */
export const overlayPort = (): number | null => port;

export function setOnStream(id: string | null): void {
  streamId = id;
  try {
    if (id) localStorage.setItem(STREAM_KEY, id);
    else localStorage.removeItem(STREAM_KEY);
  } catch {
    // a remembered choice, nothing more
  }
  rewatch();
  void push();
  overlayEvents.emit("change", undefined);
}

function rewatch(): void {
  unwatch?.();
  unwatch = streamId && port ? watchMatch(streamId) : null;
}

export function initOverlay(): void {
  if (started) return;
  started = true;
  void invoke<number | null>("overlay_port").then((p) => {
    port = p ?? null;
    rewatch();
    void push();
  });
  const again = () => void push();
  matchEvents.on("matches", again);
  poolEvents.on("pools", again);
  events.on("library", again);
}

export async function startOverlay(): Promise<void> {
  try {
    port = await invoke<number>("overlay_start");
    rewatch();
    await push();
  } catch (e) {
    toast(`${t("Couldn't start the overlay.")} ${asApiError(e).message}`, { kind: "danger" });
  }
  overlayEvents.emit("change", undefined);
}

export async function stopOverlay(): Promise<void> {
  await invoke("overlay_stop").catch(() => {});
  port = null;
  rewatch();
  overlayEvents.emit("change", undefined);
}

// ── what it shows ───────────────────────────────────────────────────────


function sideName(m: Match, side: Side): string {
  return (side === "red" ? m.red : m.blue) || (side === "red" ? t("Red") : t("Blue"));
}

/** The map to show: the one being played, else the last pick not played yet, else the last one played. */
function currentSlot(m: Match, pool: Pool, s: MatchState): { slot: string; state: "playing" | "picked" | "played"; label: string } | null {
  const playing = s.live ? slotOfBeatmap(pool, s.live.beatmapId) : null;
  if (playing) return { slot: playing, state: "playing", label: t("Playing now") };
  const played = new Set(s.games.map((g) => g.slot));
  const next = [...m.picks].reverse().find((p) => !played.has(p.slot));
  if (next) return { slot: next.slot, state: "picked", label: t("{side}'s pick", { side: sideName(m, next.side) }) };
  const last = [...s.games].reverse().find((g) => g.slot);
  if (last?.slot) return { slot: last.slot, state: "played", label: t("Last map") };
  return null;
}

export function overlayState(): { state: Record<string, unknown>; art: string[] } {
  const m = streamId ? matchById(streamId) : undefined;
  const pool = m && poolById(m.poolId);
  if (!m || !pool) return { state: { on: false }, art: [] };
  const s = matchState(m, (b) => slotOfBeatmap(pool, b));
  const art: string[] = [];

  let current: Record<string, unknown> | null = null;
  const cur = currentSlot(m, pool, s);
  const c = cur && slotChart(poolSlot(pool, cur.slot));
  const k = cur && kindOfSlot(pool, cur.slot);
  if (cur && c && k) {
    if (c.bg) art.push(c.bg);
    const r = rateOf(k.mods);
    const stars = chartStars(c, k.mods);
    current = {
      slot: cur.slot,
      state: cur.state,
      label: cur.label,
      color: kindInfo(k.code).color,
      title: c.title,
      sub: `${c.artist} · ${c.version} · ${c.creator}`,
      art: c.bg ? `/art/${c.bg}` : c.setId && c.online ? osuCoverUrl(c.setId) : null,
      starsText: `${fixed(stars, 2)}★`,
      starsBg: srColor(stars),
      starsInk: srInk(stars),
      facts: [duration(c.length / r), `${bpm(c.bpm * r)} BPM`, modText(k.mods)].filter(Boolean),
    };
  }

  const slots = slotCodes(pool.categories).map((code) => {
    const color = kindInfo(kindOfSlot(pool, code)!.code).color;
    const ban = m.bans.find((b) => b.slot === code);
    if (ban) return { slot: code, color, state: "banned", side: ban.side };
    const game = [...s.games].reverse().find((g) => g.slot === code);
    if (game) return { slot: code, color, state: game.winner ? "won" : "picked", side: game.winner ?? game.pickedBy };
    if (s.live && slotOfBeatmap(pool, s.live.beatmapId) === code) return { slot: code, color, state: "playing", side: null };
    const pick = m.picks.find((p) => p.slot === code);
    if (pick) return { slot: code, color, state: "picked", side: pick.side };
    return { slot: code, color, state: "open", side: null };
  });

  const side = (sd: Side) => {
    const own = sd === "red" ? m.red : m.blue;
    const players = s.players[sd].map((p) => p.name).join(", ");
    return { name: sideName(m, sd), players: players && players.toLowerCase() !== own.toLowerCase() ? players : "", points: s.points[sd], won: s.winner === sd };
  };
  return {
    state: {
      on: true,
      title: pool.name,
      firstTo: s.firstTo,
      red: side("red"),
      blue: side("blue"),
      current,
      slots,
      labels: { bestOf: t("Best of {n}", { n: m.bestOf }) },
    },
    art,
  };
}

let last = "";
async function push(): Promise<void> {
  if (!port) return;
  const { state, art } = overlayState();
  const text = JSON.stringify(state);
  if (text === last) return;
  last = text;
  await invoke("overlay_state", { state, art }).catch((e) => console.warn("[overlay]", asApiError(e).message));
}

// ── the dialog ──────────────────────────────────────────────────────────

/** The overlay's switch, its address for OBS, and the match on stream. */
export function openOverlayDialog(): void {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop dialog-backdrop";
  const render = () => {
    const m = streamId ? matchById(streamId) : undefined;
    const base = port ? `http://127.0.0.1:${port}/` : "";
    const row = (label: string, url: string) => `<div class="ov-url"><span class="ov-url-label">${label}</span><code>${esc(url)}</code><button class="icon-btn sm" type="button" data-copy="${esc(url)}" aria-label="${t("Copy")}" data-tip="${t("Copy")}">${icon("copy")}</button></div>`;
    bd.innerHTML = `
      <div class="modal-panel dialog overlay-dialog" role="dialog" aria-modal="true" aria-labelledby="ov-title">
        <div class="dialog-title" id="ov-title">${t("Stream overlay")}</div>
        <p class="dialog-text">${t("A page for OBS: add a Browser source at 1920 × 1080 with this address. It shows the match on stream and follows it as the games come in. Only this computer can open it.")}</p>
        <div class="ov-switch">
          <span><b>${port ? t("The overlay is on") : t("The overlay is off")}</b><small>${m ? t("On stream: {red} vs {blue}", { red: esc(sideName(m, "red")), blue: esc(sideName(m, "blue")) }) : t("No match on stream yet: pick one on its page.")}</small></span>
          <button class="btn ${port ? "" : "btn-primary"}" type="button" data-act="toggle">${port ? t("Switch off") : t("Switch on")}</button>
        </div>
        ${
          port
            ? `<div class="ov-urls">
                ${row(t("Everything"), base)}
                ${row(t("Score only"), `${base}?only=bar`)}
                ${row(t("Map only"), `${base}?only=map`)}
                ${row(t("Slots only"), `${base}?only=slots`)}
              </div>`
            : ""
        }
        <div class="dialog-actions"><button class="btn btn-ghost" type="button" data-act="close">${t("Close")}</button></div>
      </div>`;
  };
  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    off();
    closeAnimated(bd);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    }
  };
  const off = overlayEvents.on("change", render);
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) finish();
  });
  bd.addEventListener("click", (e) => {
    const el = e.target as Element;
    if (el.closest('[data-act="close"]')) return finish();
    if (el.closest('[data-act="toggle"]')) return void (port ? stopOverlay() : startOverlay());
    const copy = el.closest<HTMLElement>("[data-copy]");
    if (copy)
      void navigator.clipboard.writeText(copy.dataset.copy!).then(
        () => toast(t("Copied"), { kind: "success", timeout: 1600 }),
        () => toast(t("Couldn't access the clipboard"), { kind: "danger" }),
      );
  });
  render();
  document.body.appendChild(bd);
}

