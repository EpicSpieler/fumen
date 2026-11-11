/* main.ts — the OBS pages (docs/OBS.md): one page, the address says which (/obs/stage, /obs/hud,
 * /obs/card, /obs/session; from a dev build's Vite ?view=…). Fumen's window tells the language,
 * tosu's address and the settings (the `config` part); a page that speaks another language than
 * Fumen loads again in Fumen's.
 *
 * `?edit=1`: the page inside Fumen's own window, being arranged (views/hud-editor.ts). The window
 * hands it the parts itself (`window.fumenObs.take`) and a made-up try plays instead of osu!'s
 * (./demo). */
import "../styles/tokens.css";
import "../styles/obs.css";
import { lang } from "../lib/i18n";
import { Demo, DEMO_MD5, type Moment } from "./demo";
import { connect, editing, link, params, parts, take } from "./link";
import { live } from "./live";

const view = params.get("view") ?? location.pathname.split("/").filter(Boolean)[1] ?? "";
document.body.dataset.view = view;
document.body.classList.toggle("clear", params.get("bg") === "none");
document.body.classList.toggle("edit", editing);

link.on("config", (c) => {
  if (!c) return;
  if (!editing && c.lang !== lang) {
    try {
      localStorage.setItem("fumen.lang", c.lang);
      location.reload();
      return;
    } catch {
      // no storage here: the page stays in its language
    }
  }
  if (!editing) live.use(c.tosu);
  document.documentElement.classList.toggle("reduce-motion", c.reduceMotion);
});

const pages: Record<string, () => Promise<{ start(): void }>> = {
  stage: () => import("./stage"),
  hud: () => import("./hud"),
  card: () => import("./card"),
  session: () => import("./session"),
};

/** Being arranged: the window's handle on the page. */
function arranged(): void {
  const demo = new Demo(
    () => ({ title: parts.map?.title ?? "", artist: parts.map?.artist ?? "", version: parts.map?.version ?? "", mode: parts.map?.mode ?? 3 }),
    (now) => live.take(now),
  );
  demo.start();
  (window as unknown as { fumenObs: unknown }).fumenObs = {
    md5: DEMO_MD5,
    take,
    play: () => demo.play(),
    pause: () => demo.pause(),
    moment: (m: Moment) => demo.moment(m),
    running: () => demo.running,
  };
  window.dispatchEvent(new Event("fumen-obs-ready"));
}

const page = pages[view];
if (page)
  void page().then((m) => {
    m.start();
    if (editing) arranged();
    else connect();
  });
