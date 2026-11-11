/* session.ts — the session card (/obs/session): for a break or the end of a stream. How long it's
 * been and since when, the tries, passes, fails and clips, the best plays, the map that cost the
 * most, and every try on one line, its height how far it got, passes in the accent, a little room
 * where the map changed. When the scene with it goes live (or Settings' "Show now") it builds up:
 * the numbers roll up from nothing, the line draws from the left, the plays slide in.
 *
 * Address options: `bg=cover` (the best play's cover, blurred, behind it; default: nothing behind).
 * The source: the stream's size (1920 × 1080); the card sits in the middle. */
import { pct } from "../lib/format";
import { lang, t, tn } from "../lib/i18n";
import type { ObsSession, ObsSessionPlay } from "../lib/obs-parts";
import { reduceMotion } from "../ui/controls";
import { artUrl, link, params, parts } from "./link";
import { accentFrom } from "./look";
import { Odometer } from "./odometer";
import { rankOf } from "./ranks";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** "2 h 14 min", "14 min" */
export function sessionLength(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? t("{h} h {m} min", { h, m: min % 60 }) : t("{m} min", { m: min });
}

const STATS = ["tries", "passes", "fails", "left", "clips"] as const;
type Stat = (typeof STATS)[number];

export function start(): void {
  const behind = params.get("bg") === "cover";
  const root = document.getElementById("obs")!;
  root.innerHTML = `
    ${behind ? `<div class="ses-behind"></div>` : ""}
    <div class="ses" data-state="out">
      <header class="ses-head">
        <div>
          <div class="ses-label">${t("This session")}</div>
          <div class="ses-length"></div>
        </div>
        <div class="ses-since"></div>
      </header>
      <div class="ses-stats">
        ${STATS.map(
          (k, i) => `<div class="ses-stat" data-stat="${k}" style="--i:${i}"><b class="ses-num"></b><span>${
            { tries: t("Tries"), passes: t("Passes"), fails: t("Fails"), left: t("Left early"), clips: t("Clips") }[k]
          }</span></div>`,
        ).join("")}
      </div>
      <div class="ses-line-box"><div class="ses-line"></div></div>
      <div class="ses-cols">
        <section class="ses-top"><div class="ses-label">${t("Best plays")}</div><div class="ses-plays"></div></section>
        <section class="ses-costly"><div class="ses-label">${t("Cost the most")}</div><div class="ses-map"></div></section>
      </div>
      <div class="ses-empty">${t("Nothing played yet")}</div>
    </div>`;
  const card = root.querySelector<HTMLElement>(".ses")!;
  const $ = <T extends HTMLElement>(s: string) => card.querySelector<T>(s)!;
  const nums = {} as Record<Stat, Odometer>;
  for (const k of STATS) {
    nums[k] = new Odometer();
    card.querySelector(`[data-stat="${k}"] .ses-num`)!.append(nums[k].el);
  }
  let built = false;
  let lineKey = "";
  let listKey = "";

  const play = (p: ObsSessionPlay, i: number): string => {
    const r = rankOf(p.rank);
    return `<div class="ses-play" style="--i:${i}">
      <div class="ses-cover">${p.bg ? `<img alt="" src="${artUrl(p.bg, 320)}" />` : ""}</div>
      <div class="ses-play-words">
        <div class="ses-play-title">${esc(p.title)}</div>
        <div class="ses-play-sub">${esc(p.version)}</div>
      </div>
      <div class="ses-play-score">
        ${r ? `<b class="ses-rank" style="color:${r.color}">${r.label}</b>` : ""}
        <span>${esc(pct(p.accuracy))}</span>
        ${p.pp !== null ? `<span>${Math.round(p.pp)} pp</span>` : ""}
      </div>
      <div class="ses-badges">${p.best ? `<span class="ses-badge accent">${t("New best")}</span>` : ""}${p.fc ? `<span class="ses-badge">FC</span>` : ""}</div>
    </div>`;
  };

  /** what the session is now; `fresh`: the numbers come up from nothing */
  const fill = (s: ObsSession | null, fresh: boolean): void => {
    const empty = !s || !s.tries;
    card.classList.toggle("empty", empty);
    const now = Date.now();
    $(".ses-length").textContent = s ? sessionLength(now - s.start) : "";
    $(".ses-since").textContent = s ? t("since {time}", { time: new Date(s.start).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }) : "";
    const values: Record<Stat, number> = { tries: s?.tries ?? 0, passes: s?.passes ?? 0, fails: s?.fails ?? 0, left: s?.left ?? 0, clips: s?.clips ?? 0 };
    for (const k of STATS) {
      if (fresh && !reduceMotion()) nums[k].set(0, true);
      // after the card is in, one after another
      const delay = fresh && !reduceMotion() ? 450 + STATS.indexOf(k) * 90 : 0;
      window.setTimeout(() => nums[k].set(values[k]), delay);
    }
    card.querySelector<HTMLElement>('[data-stat="clips"]')!.hidden = !values.clips;
    // every try on one line
    const line = s?.line ?? [];
    const key = line.map((x) => `${x.at}${x.outcome[0]}`).join(",");
    if (key !== lineKey) {
      lineKey = key;
      $(".ses-line").innerHTML = line
        .map((x, i) => {
          const kind = x.outcome === "pass" ? "pass" : x.outcome === "fail" ? "fail" : "left";
          const moved = i > 0 && line[i - 1].md5 !== x.md5 ? " moved" : "";
          return `<i class="${kind}${moved}" style="--h:${Math.max(0.06, Math.min(1, x.got)).toFixed(3)}"></i>`;
        })
        .join("");
    }
    // the plays and the costly map
    const lk = JSON.stringify([s?.top, s?.costly]);
    if (lk !== listKey) {
      listKey = lk;
      $(".ses-plays").innerHTML = s?.top.length ? s.top.map(play).join("") : `<p class="ses-none">${t("No pass yet")}</p>`;
      $(".ses-top").hidden = !s?.top.length && !s?.costly;
      const c = s?.costly;
      $(".ses-costly").hidden = !c;
      $(".ses-map").innerHTML = c
        ? `<div class="ses-play" style="--i:0">
            <div class="ses-cover">${c.bg ? `<img alt="" src="${artUrl(c.bg, 320)}" />` : ""}</div>
            <div class="ses-play-words">
              <div class="ses-play-title">${esc(c.title)}</div>
              <div class="ses-play-sub">${esc(c.version)}</div>
            </div>
          </div>
          <div class="ses-cost">
            <span>${tn(c.tries, "{n} try", "{n} tries")}</span>
            <span>${tn(c.fails, "{n} fail", "{n} fails")}</span>
            <span>${sessionLength(c.minutes * 60_000)}</span>
            <b class="${c.passed ? "accent" : ""}">${c.passed ? t("Passed in the end") : t("Not passed yet")}</b>
          </div>`
        : "";
      const cover = s?.top[0]?.bg ?? c?.bg ?? null;
      accentFrom(cover ? artUrl(cover, 320) : null);
      const back = root.querySelector<HTMLElement>(".ses-behind");
      if (back) back.style.backgroundImage = cover ? `url("${artUrl(cover, 640)}")` : "";
    }
  };

  /** it builds up again (the scene went live, "Show now") */
  const build = (): void => {
    card.dataset.state = "out";
    void card.offsetWidth;
    card.dataset.state = "in";
    built = true;
    fill(parts.session, true);
  };

  link.on("session", (s) => fill(s, !built));
  link.on("cue", (c) => {
    if (c?.kind === "session") build();
  });
  // OBS tells a browser source when its scene goes live
  window.addEventListener("obsSourceActiveChanged", (e) => {
    if ((e as CustomEvent<{ active: boolean }>).detail?.active) build();
  });
  // the length grows while it's up
  window.setInterval(() => {
    if (parts.session) $(".ses-length").textContent = sessionLength(Date.now() - parts.session.start);
  }, 30_000);
  window.setTimeout(build, 300);
}
