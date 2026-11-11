/* main.ts — the OBS pages (docs/OBS.md): one page, the address says which (/obs/stage, /obs/hud,
 * /obs/card, /obs/session; from a dev build's Vite ?view=…). Fumen's window tells the language,
 * tosu's address and the settings (the `config` part); a page that speaks another language than
 * Fumen loads again in Fumen's. */
import "../styles/tokens.css";
import "../styles/obs.css";
import { lang } from "../lib/i18n";
import { connect, link, params } from "./link";
import { live } from "./live";

const view = params.get("view") ?? location.pathname.split("/").filter(Boolean)[1] ?? "";
document.body.dataset.view = view;
document.body.classList.toggle("clear", params.get("bg") === "none");

link.on("config", (c) => {
  if (!c) return;
  if (c.lang !== lang) {
    try {
      localStorage.setItem("fumen.lang", c.lang);
      location.reload();
      return;
    } catch {
      // no storage here: the page stays in its language
    }
  }
  live.use(c.tosu);
  document.documentElement.classList.toggle("reduce-motion", c.reduceMotion);
});

const pages: Record<string, () => Promise<{ start(): void }>> = {
  stage: () => import("./stage"),
  hud: () => import("./hud"),
  card: () => import("./card"),
  session: () => import("./session"),
};

const page = pages[view];
if (page)
  void page().then((m) => {
    m.start();
    connect();
  });
