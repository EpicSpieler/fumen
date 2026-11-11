/* obs-settings.ts — Settings' part for OBS itself (views/obs-control.ts): the connection with its
 * port and password and how it's going, scenes for what osu! shows, and clips of the good moments. */
import { esc } from "../lib/format";
import { t } from "../lib/i18n";
import { OSU_SCENES, type OsuScene } from "../lib/obs-rules";
import type { ObsLinkState } from "../lib/obs-ws";
import { setPrefs, store } from "../lib/store";
import type { ObsPrefs } from "../lib/types";
import { createSelect, toast } from "../ui/controls";
import { icon } from "../ui/icons";
import { obs, obsEvents, obsScenes, replayBufferOn, setObsPassword, testClip } from "./obs-control";

const SCENE_NAMES: Record<OsuScene, () => string> = {
  select: () => t("Song select"),
  play: () => t("Playing"),
  results: () => t("Results"),
  closed: () => t("osu! closed"),
};

function said(s: ObsLinkState, port: number): { text: string; tone: "" | "ok" | "bad" } {
  switch (s.kind) {
    case "on":
      return { text: s.version ? t("Connected to OBS {v}.", { v: s.version }) : t("Connected to OBS."), tone: "ok" };
    case "connecting":
      return { text: t("Looking for OBS…"), tone: "" };
    case "password":
      return { text: t("OBS wants a password, or this one isn't right."), tone: "bad" };
    case "away":
      return { text: t("Nothing answers on port {port}. Is OBS open, with its websocket server on (Tools, WebSocket Server Settings)?", { port }), tone: "bad" };
    default:
      return { text: t("Fumen switches scenes and keeps clips through OBS's websocket server (OBS 28 or newer)."), tone: "" };
  }
}

/** Renders into `el` and keeps it up to date; the returned function stops that. */
export function mountObsSettings(el: HTMLElement): () => void {
  const prefs = (): ObsPrefs => store.prefs.obs;
  const patch = (p: Partial<ObsPrefs>): void => setPrefs({ obs: { ...prefs(), ...p } });

  const render = (): void => {
    const p = prefs();
    const s = obs.state;
    const st = said(s, p.port || 4455);
    const on = s.kind === "on";
    const scenes = p.scenes ?? { on: false, select: "", play: "", results: "", closed: "" };
    const clips = p.clips ?? { on: false, fc: true, best: true, close: true, marker: false, rename: true };
    const chip = (key: keyof typeof clips, label: string) => `<button type="button" class="chip-toggle${clips[key] ? " active" : ""}" data-clip="${key}" aria-pressed="${!!clips[key]}">${label}</button>`;
    el.innerHTML = `
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">${t("Connect to OBS")}</div>
          <div class="setting-desc obs-said ${st.tone}">${esc(st.text)}</div>
        </div>
        <input type="checkbox" role="switch" data-link="connect" aria-label="${t("Connect to OBS")}" ${p.connect ? "checked" : ""} />
      </div>
      ${
        p.connect
          ? `<div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">${t("Port and password")}</div>
          <div class="setting-desc">${t("As OBS shows them under Tools, WebSocket Server Settings. The password stays sealed on this PC.")}</div>
        </div>
        <form class="setting-actions obs-login" autocomplete="off">
          <input type="number" class="obs-port" min="1" max="65535" value="${p.port || 4455}" aria-label="${t("Port")}" />
          <input type="password" class="obs-pw" placeholder="${t("Password")}" aria-label="${t("Password")}" />
          <button class="btn btn-sm" type="submit">${t("Save")}</button>
        </form>
      </div>`
          : ""
      }
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">${t("Scenes follow osu!")}</div>
          <div class="setting-desc">${t("With Follow osu! on, OBS shows the scene set for what osu! shows. A scene you picked yourself that isn't one of these stays on.")}</div>
        </div>
        <input type="checkbox" role="switch" data-link="scenes" aria-label="${t("Scenes follow osu!")}" ${scenes.on ? "checked" : ""} ${on ? "" : "disabled"} />
      </div>
      ${scenes.on && on ? `<div class="setting-row obs-scenes">${OSU_SCENES.map((k) => `<label class="obs-scene"><span>${SCENE_NAMES[k]()}</span><span data-scene="${k}"></span></label>`).join("")}</div>` : ""}
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">${t("Clips of the good moments")}</div>
          <div class="setting-desc">${t("OBS's replay buffer saved a few seconds after a full combo, a new best or a close pass (under 10 % health, or the first pass after 3 fails).")}${on && clips.on && !replayBufferOn() ? ` <span class="obs-warn">${t("The replay buffer is off in OBS.")}</span>` : ""}</div>
        </div>
        <input type="checkbox" role="switch" data-link="clips" aria-label="${t("Clips of the good moments")}" ${clips.on ? "checked" : ""} ${on ? "" : "disabled"} />
      </div>
      ${
        clips.on && on
          ? `<div class="setting-row obs-clips">
        <div class="obs-chips">
          ${chip("fc", t("Full combo"))}${chip("best", t("New best"))}${chip("close", t("Close pass"))}
          <span class="obs-chip-gap"></span>
          ${chip("rename", t("Named after the map"))}${chip("marker", t("Chapter marker"))}
        </div>
        <button class="btn btn-sm" type="button" data-link-act="test">${icon("play")}${t("Test clip")}</button>
      </div>`
          : ""
      }`;
    // the scene for each state: OBS's own, or none
    for (const k of OSU_SCENES) {
      const slot = el.querySelector<HTMLElement>(`[data-scene="${k}"]`);
      if (!slot) continue;
      const list = obsScenes();
      const value = scenes[k] && !list.includes(scenes[k]) ? [scenes[k], ...list] : list;
      const sel = createSelect<string>(
        [{ value: "", label: t("Don't switch") }, ...value.map((v) => ({ value: v, label: v }))],
        scenes[k] ?? "",
        (v) => patch({ scenes: { ...prefs().scenes, [k]: v } }),
        { className: "obs-scene-pick" },
      );
      slot.append(sel.el);
    }
  };

  el.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const k = input.dataset.link;
    if (k === "connect") patch({ connect: input.checked });
    else if (k === "scenes") patch({ scenes: { ...prefs().scenes, on: input.checked } });
    else if (k === "clips") patch({ clips: { ...prefs().clips, on: input.checked } });
    else return;
    render();
  });
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const port = Math.round(Number(form.querySelector<HTMLInputElement>(".obs-port")!.value));
    const pw = form.querySelector<HTMLInputElement>(".obs-pw")!.value;
    if (port >= 1 && port <= 65535) patch({ port });
    void setObsPassword(pw).then(
      () => toast(pw ? t("Saved. Fumen asks OBS again.") : t("No password kept. Fumen asks OBS again."), { kind: "success", timeout: 2200 }),
      (err) => toast(String(err), { kind: "danger" }),
    );
  });
  el.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const c = target.closest<HTMLElement>("[data-clip]");
    if (c) {
      const key = c.dataset.clip as keyof ObsPrefs["clips"];
      patch({ clips: { ...prefs().clips, [key]: !prefs().clips[key] } });
      return render();
    }
    if (target.closest('[data-link-act="test"]')) testClip();
  });

  const offs = [obs.bus.on("state", render), obsEvents.on("scenes", render), obsEvents.on("replay", render)];
  render();
  return () => offs.forEach((f) => f());
}
