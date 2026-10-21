/* match.ts — one match: red against blue with the points, the pool as a board (each slot open,
 * banned, picked, being played or won, with the scores), and the room's games in order. Bans and
 * picks go on from a slot's menu; the games come from osu!'s multiplayer room, asked for again
 * every few seconds while the match is on and the page is open (lib/matches.ts: watchMatch, and
 * what it all comes to).
 * The match on stream feeds the OBS overlay (overlay.ts). */
import { openUrl } from "@tauri-apps/plugin-opener";
import { osuCoverUrl, thumbUrl } from "../lib/api";
import { esc, num, pct, relativeTime, srChip } from "../lib/format";
import { locale, t } from "../lib/i18n";
import {
  deleteMatch, matchById, matchEvents, matchProblem, matchState, refreshMatch, watchMatch, setMatchRoom, slotOfBeatmap, updateMatch, type Choice, type Match, type MatchState,
  type PlayedGame, type Side,
} from "../lib/matches";
import { kindInfo, kindOfSlot, poolById, poolEvents, poolSlot, slotChart, slotCodes, type Pool } from "../lib/pools";
import { go } from "../lib/router";
import { events } from "../lib/store";
import { openMenu, toast, uiConfirm, uiPrompt, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openMatchDialog } from "./match-dialog";
import { onStream, setOnStream } from "./overlay";
import { chartStars } from "./pool-picker";

const SIDE_COLOR: Record<Side, string> = { red: "#ff6b7a", blue: "#6ea8fe" };

const whenFormat = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const matchWhen = (ms: number): string => whenFormat.format(new Date(ms));

/** "Red" / the player's name */
export const sideName = (m: Match, side: Side): string => (side === "red" ? m.red : m.blue) || (side === "red" ? t("Red") : t("Blue"));

/** What a match is at, in a few words: "Sat 1 Aug, 18:00 · in 2 hours", "3 – 2", "Live · 1 – 1". */
export function matchLine(m: Match, s: MatchState): string {
  if (s.status === "done") return s.winner ? t("{side} won", { side: sideName(m, s.winner) }) : t("Over");
  if (s.status === "live") return t("Live");
  return m.at ? `${matchWhen(m.at)} · ${relativeTime(m.at)}` : t("No time yet");
}

export class MatchView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];

  constructor(private id: string) {
    this.el = document.createElement("section");
    this.el.className = "view match-view";
    this.offs.push(
      matchEvents.on("matches", () => this.render()),
      poolEvents.on("pools", () => this.render()),
      events.on("library", () => this.render()),
    );
    this.bind();
    this.render();
    this.offs.push(watchMatch(id));
  }

  private match(): Match | undefined {
    return matchById(this.id);
  }

  private state(m: Match): MatchState | null {
    const pool = poolById(m.poolId);
    return pool ? matchState(m, (b) => slotOfBeatmap(pool, b)) : null;
  }

  private async ask(): Promise<void> {
    this.el.querySelector(".mh-refresh")?.classList.add("spinning");
    await refreshMatch(this.id);
  }

  private render(): void {
    const m = this.match();
    const pool = m && poolById(m.poolId);
    if (!m || !pool) {
      this.el.innerHTML = `<div class="empty-state">${icon("flag")}<div class="empty-title">${t("That match doesn't exist any more.")}</div></div>`;
      return;
    }
    const s = this.state(m)!;
    const name = (side: Side) => {
      const own = side === "red" ? m.red : m.blue;
      const osu = s.players[side].map((p) => p.name).join(", ");
      return `<b>${esc(sideName(m, side))}</b>${osu && osu.toLowerCase() !== own.toLowerCase() ? `<small>${esc(osu)}</small>` : ""}`;
    };
    const facts = [
      matchLine(m, s),
      t("best of {n}", { n: m.bestOf }),
      m.firstPick ? t("{side} picks first", { side: sideName(m, m.firstPick) }) : "",
      s.nextPick ? t("{side} picks next", { side: sideName(m, s.nextPick) }) : "",
    ].filter(Boolean);
    const stream = onStream() === m.id;
    const fetched = m.fetched ? t("osu! asked {when}", { when: relativeTime(m.fetched) }) : "";
    this.el.innerHTML = `
      <header class="view-head match-head">
        <div class="match-head-text">
          <button class="pool-back" type="button">${icon("chevron-left")}<span>${esc(pool.name)}</span></button>
          <div class="mh-score">
            <span class="mh-side red${s.winner === "red" ? " won" : ""}">${name("red")}</span>
            <span class="mh-points num"><b class="red">${s.points.red}</b><i>–</i><b class="blue">${s.points.blue}</b></span>
            <span class="mh-side blue${s.winner === "blue" ? " won" : ""}">${name("blue")}</span>
          </div>
          <div class="view-sub mh-facts">${facts.map(esc).join(" · ")}</div>
        </div>
        <div class="pool-head-tools">
          <button class="btn btn-sm mh-stream${stream ? " active" : ""}" type="button" aria-pressed="${stream}" data-tip="${t("Shows this match in the OBS overlay")}">${icon(stream ? "check" : "play")}<span>${stream ? t("On stream") : t("Put on stream")}</span></button>
          ${
            m.mpId
              ? `<button class="icon-btn mh-refresh" type="button" aria-label="${t("Ask osu! again")}" data-tip="${esc(fetched || t("Ask osu! again"))}">${icon("refresh")}</button>`
              : `<button class="btn btn-sm mh-room" type="button">${icon("link")}<span>${t("Link the osu! room…")}</span></button>`
          }
          <button class="icon-btn" type="button" data-act="match-menu" aria-label="${t("More")}" data-tip="${t("More")}">${icon("more-vert")}</button>
        </div>
      </header>
      ${matchProblem(m.id) ? `<div class="mh-problem">${icon("alert")}<span>${t("Couldn't ask osu!:")} ${esc(matchProblem(m.id))}</span></div>` : ""}
      ${s.live ? this.liveHtml(pool, s) : ""}
      <div class="match-board">${slotCodes(pool.categories).map((c) => this.tileHtml(m, pool, s, c)).join("")}</div>
      ${this.gamesHtml(m, pool, s)}
      ${m.note ? `<div class="match-note">${esc(m.note)}</div>` : ""}`;
  }

  /** the game being played right now */
  private liveHtml(pool: Pool, s: MatchState): string {
    const g = s.live!;
    const slot = slotOfBeatmap(pool, g.beatmapId);
    const c = slot ? slotChart(poolSlot(pool, slot)) : undefined;
    return `<div class="match-live">
      <span class="ml-tag">${t("Playing now")}</span>
      ${slot ? `<span class="slot-code" style="--k:${kindInfo(kindOfSlot(pool, slot)!.code).color}">${esc(slot)}</span>` : ""}
      <span class="ml-title">${esc(c ? `${c.artist} - ${c.title} [${c.version}]` : g.title || t("osu! beatmap {id}", { id: g.beatmapId }))}</span>
    </div>`;
  }

  private tileHtml(m: Match, pool: Pool, s: MatchState, code: string): string {
    const k = kindOfSlot(pool, code)!;
    const c = slotChart(poolSlot(pool, code));
    const art = c?.bg ? thumbUrl(c.bg, 320) : c?.setId && c.online ? osuCoverUrl(c.setId) : null;
    const ban = m.bans.find((b) => b.slot === code);
    const played = s.games.filter((g) => g.slot === code);
    const pick = m.picks.find((p) => p.slot === code);
    const live = s.live && slotOfBeatmap(pool, s.live.beatmapId) === code;
    let state = "";
    let cls = "";
    if (ban) {
      cls = " banned";
      state = `<span class="mt-state" style="--s:${SIDE_COLOR[ban.side]}">${t("Banned by {side}", { side: esc(sideName(m, ban.side)) })}</span>`;
    } else if (played.length) {
      const g = played[played.length - 1];
      cls = ` played${g.winner ? ` won-${g.winner}` : ""}`;
      const by = g.tiebreaker ? t("Tiebreaker") : g.pickedBy ? t("{side}'s pick", { side: esc(sideName(m, g.pickedBy)) }) : "";
      state = `<span class="mt-state" style="--s:${g.winner ? SIDE_COLOR[g.winner] : "var(--t3)"}">${[by, g.winner ? t("{side} won", { side: esc(sideName(m, g.winner)) }) : t("Draw")].filter(Boolean).join(" · ")}</span>`;
    } else if (live) {
      cls = " live";
      state = `<span class="mt-state">${t("Playing now")}</span>`;
    } else if (pick) {
      cls = " picked";
      state = `<span class="mt-state" style="--s:${SIDE_COLOR[pick.side]}">${t("{side}'s pick", { side: esc(sideName(m, pick.side)) })}</span>`;
    }
    const stars = c ? chartStars(c, k.mods) : null;
    return `<button class="match-tile${cls}" type="button" data-slot="${esc(code)}">
      <span class="mt-art${art ? "" : " img-missing"}">${art ? `<img src="${art}" alt="" loading="lazy" decoding="async">` : ""}</span>
      <span class="mt-top"><span class="slot-code" style="--k:${kindInfo(k.code).color}">${esc(code)}</span>${stars !== null ? srChip(stars) : ""}</span>
      <span class="mt-title">${c ? esc(c.title) : `<i>${t("empty")}</i>`}</span>
      ${state}
    </button>`;
  }

  private gamesHtml(m: Match, pool: Pool, s: MatchState): string {
    const warm = (m.result?.games ?? []).filter((g) => g.end !== undefined && g.scores.length > 0).slice(0, m.warmups).length;
    if (!s.games.length) {
      const why = !m.mpId ? t("Link the multiplayer room and the games come in from osu! as they're played.") : warm ? t("Only warm-ups so far.") : t("No game played yet.");
      return `<div class="match-games-empty">${why}</div>`;
    }
    const score = (g: PlayedGame, side: Side) => {
      const v = g[side];
      if (v === null) return "–";
      const acc = side === "red" ? g.redAcc : g.blueAcc;
      const main = g.game.scoring === "accuracy" ? pct(v) : num(Math.round(v));
      return `<b>${main}</b>${acc !== null && g.game.scoring !== "accuracy" ? `<small>${pct(acc)}</small>` : ""}`;
    };
    const rows = s.games
      .map((g) => {
        const k = g.slot ? kindOfSlot(pool, g.slot) : undefined;
        const c = g.slot ? slotChart(poolSlot(pool, g.slot)) : undefined;
        const title = c ? `${c.title} [${c.version}]` : g.game.title || t("osu! beatmap {id}", { id: g.game.beatmapId });
        const by = g.tiebreaker ? t("Tiebreaker") : g.pickedBy ? t("{side}'s pick", { side: esc(sideName(m, g.pickedBy)) }) : "";
        return `<div class="mg-row${g.winner ? ` won-${g.winner}` : ""}">
          <span class="mg-n num">${g.n}</span>
          ${g.slot && k ? `<span class="slot-code" style="--k:${kindInfo(k.code).color}">${esc(g.slot)}</span>` : `<span class="slot-code mg-off" data-tip="${t("Not in the pool")}">?</span>`}
          <span class="mg-title"><span>${esc(title)}</span><small>${[by, g.game.mods.join("")].filter(Boolean).join(" · ")}</small></span>
          <span class="mg-score red num">${score(g, "red")}</span>
          <span class="mg-score blue num">${score(g, "blue")}</span>
        </div>`;
      })
      .join("");
    return `<section class="match-games">
      <div class="mg-head label-caps"><span>${t("Games")}</span>${warm ? `<small>${t("{n} warm-ups left out", { n: warm })}</small>` : ""}<span class="mg-side red">${esc(sideName(m, "red"))}</span><span class="mg-side blue">${esc(sideName(m, "blue"))}</span></div>
      ${rows}
    </section>`;
  }

  // ── doing things ──────────────────────────────────────────────────────

  private tileMenu(at: Element, m: Match, code: string): void {
    const ban = m.bans.find((b) => b.slot === code);
    const pick = m.picks.find((p) => p.slot === code);
    const set = (bans: Choice[], picks: Choice[]) => void updateMatch(m.id, { bans, picks });
    const without = (list: Choice[]) => list.filter((x) => x.slot !== code);
    const entries: MenuEntry[] = [{ group: code }];
    // the tiebreaker is nobody's to ban or pick
    if (kindOfSlot(poolById(m.poolId)!, code)?.code === "TB") {
      entries.push({ label: t("The tiebreaker isn't banned or picked"), icon: "info", disabled: true, action: () => {} });
      if (ban || pick) entries.push("sep", { label: t("Clear"), icon: "x", action: () => set(without(m.bans), without(m.picks)) });
      openMenu(at, entries, { minWidth: 220 });
      return;
    }
    for (const side of ["red", "blue"] as const) {
      entries.push({
        label: t("Ban for {side}", { side: sideName(m, side) }),
        icon: "x",
        checked: ban?.side === side,
        action: () => set([...without(m.bans), { side, slot: code }], without(m.picks)),
      });
    }
    for (const side of ["red", "blue"] as const) {
      entries.push({
        label: t("{side} picks it", { side: sideName(m, side) }),
        icon: "flag",
        checked: pick?.side === side,
        action: () => set(without(m.bans), [...without(m.picks), { side, slot: code }]),
      });
    }
    if (ban || pick) entries.push("sep", { label: t("Clear"), icon: "x", action: () => set(without(m.bans), without(m.picks)) });
    openMenu(at, entries, { minWidth: 220 });
  }

  private matchMenu(at: Element, m: Match): void {
    const entries: MenuEntry[] = [
      { label: t("Change the match…"), icon: "sliders", action: () => void openMatchDialog(m.poolId, m) },
      { label: m.mpId ? t("Change the osu! room…") : t("Link the osu! room…"), icon: "link", action: () => void this.linkRoom(m) },
    ];
    if (m.mpId) entries.push({ label: t("Open the room on osu!"), icon: "external", action: () => void openUrl(`https://osu.ppy.sh/community/matches/${m.mpId}`) });
    entries.push(
      { label: m.note ? t("Change the note…") : t("Add a note…"), icon: "tag", action: () => void this.editNote(m) },
      "sep",
      { label: t("Delete match…"), icon: "trash", danger: true, action: () => void this.remove(m) },
    );
    openMenu(at, entries, { minWidth: 230 });
  }

  private async linkRoom(m: Match): Promise<void> {
    const link = await uiPrompt("", {
      title: t("The match's osu! room"),
      value: m.mpId ? `https://osu.ppy.sh/community/matches/${m.mpId}` : "",
      placeholder: "https://osu.ppy.sh/community/matches/…",
      confirmLabel: t("Save"),
      maxLength: 200,
    });
    if (link === null) return;
    try {
      await setMatchRoom(m.id, link);
      if (link.trim()) void this.ask();
    } catch (e) {
      toast((e as { message?: string }).message ?? String(e), { kind: "danger" });
    }
  }

  private async editNote(m: Match): Promise<void> {
    const note = await uiPrompt("", { title: t("Note"), value: m.note, confirmLabel: t("Save"), maxLength: 2000 });
    if (note !== null) void updateMatch(m.id, { note });
  }

  private async remove(m: Match): Promise<void> {
    const ok = await uiConfirm(t("Its bans, picks and games go with it."), {
      title: t("Delete {red} vs {blue}?", { red: sideName(m, "red"), blue: sideName(m, "blue") }),
      confirmLabel: t("Delete"),
      danger: true,
    });
    if (!ok) return;
    if (onStream() === m.id) setOnStream(null);
    await deleteMatch(m.id);
    go({ name: "pools", id: m.poolId, tab: "matches" }, { replace: true });
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const el = e.target as Element;
      const m = this.match();
      if (!m) return;
      if (el.closest(".pool-back")) return go({ name: "pools", id: m.poolId, tab: "matches" });
      if (el.closest(".mh-refresh")) return void this.ask();
      if (el.closest(".mh-room")) return void this.linkRoom(m);
      if (el.closest(".mh-stream")) {
        setOnStream(onStream() === m.id ? null : m.id);
        return this.render();
      }
      const menu = el.closest<HTMLElement>('[data-act="match-menu"]');
      if (menu) return this.matchMenu(menu, m);
      const tile = el.closest<HTMLElement>(".match-tile");
      if (tile) return this.tileMenu(tile, m, tile.dataset.slot!);
    });
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}

/** for a match's line in lists: its points, when it's on or over */
export function pointsText(s: MatchState): string {
  return s.status === "upcoming" ? "" : `${s.points.red} – ${s.points.blue}`;
}

