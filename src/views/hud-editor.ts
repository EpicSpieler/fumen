/* hud-editor.ts — arranging the live overlay (/obs/hud, lib/hud-layout, docs/OBS.md). Skins put
 * their own numbers in different places, so every part goes where the skin leaves room: the page
 * itself in a frame the shape of the stream with a made-up try playing on it (src/obs/demo.ts),
 * each part dragged into place, grown or shrunk from its corners, snapped to the edges, the
 * middle and the other parts. A screenshot from osu! can go behind it to see where the skin has
 * its own numbers. OBS follows while you drag. */
import { thumbUrl } from "../lib/api";
import { esc } from "../lib/format";
import { DEFAULT_HUD, guides, HUD_PARTS, hudPrefs, placeAt, shapeOf, SIZE_MAX, SIZE_MIN, snapEdge, snapRect, type HudPart, type HudPartId, type HudPrefs, type Rect } from "../lib/hud-layout";
import { t } from "../lib/i18n";
import { setPrefs, store } from "../lib/store";
import type { Moment } from "../obs/demo";
import { closeAnimated, toast, uiConfirm } from "../ui/controls";
import { icon } from "../ui/icons";
import { demoParts, obsConfig } from "./obs-feed";

/** the screenshot behind the frame (a JPEG, 1280 × 720, only for arranging) */
const SHOT_KEY = "fumen.hudShot";
/** px a part snaps from */
const SNAP = 7;
/** the smallest a line or the lamps' area gets, 0–1 of the source */
const MIN_W = 0.04;
const MIN_H = 0.03;

const NAMES: Record<HudPartId, () => string> = {
  bar: () => t("Progress"),
  title: () => t("Title"),
  stars: () => t("Stars"),
  combo: () => t("Combo"),
  hp: () => t("Health"),
  acc: () => t("Accuracy"),
  pp: () => "pp",
  lines: () => t("Fumen's lines"),
  judges: () => t("Judgements"),
  keys: () => t("Keys"),
  heart: () => t("Heart rate"),
  vis: () => t("Visualizer"),
};

const ABOUT: Record<HudPartId, () => string> = {
  bar: () => t("How far into the map, with a notch where each earlier try ended and the part where most of them did."),
  title: () => t("The map's title, its difficulty and which try this is."),
  stars: () => t("Stars at the rate played, and the mods."),
  combo: () => t("Drops away on a combo break and turns into the rank at the end."),
  hp: () => t("Drains toward the side it's pinned to and turns red when it's low."),
  acc: () => t("Rolls with every judgement."),
  pp: () => t("What the play is worth so far."),
  lines: () => t("At the end: how it ended and what that means against your tries before."),
  judges: () => t("How many of each judgement so far."),
  keys: () => t("Which keys are held, with a trail for each press. Needs reading the keys switched on in OBS's settings."),
  heart: () => t("Your pulse, beating along. Only there with a heart rate monitor connected in Settings, While you play."),
  vis: () => t("Lamps that play with the song and answer the play."),
};

const MOMENTS: { id: Moment; label: () => string }[] = [
  { id: "play", label: () => t("Playing") },
  { id: "break", label: () => t("Combo break") },
  { id: "low", label: () => t("Low health") },
  { id: "pass", label: () => t("Pass") },
  { id: "fail", label: () => t("Fail") },
];

/** The page in the frame, once it's there (src/obs/main.ts, src/obs/hud.ts). */
interface ObsWindow extends Window {
  fumenObs?: { take(name: string, value: unknown): void; play(): void; pause(): void; moment(m: Moment): void; running(): boolean };
  fumenHud?: { rects(): Partial<Record<HudPartId, Rect>> };
}

interface Drag {
  id: HudPartId;
  /** "move", a corner (nw ne sw se) or a side (w e) */
  how: string;
  from: { x: number; y: number };
  rect: Rect;
  part: HudPart;
  lines: { x: number[]; y: number[] };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
let open = false;

export function openHudEditor(): void {
  if (open) return;
  open = true;
  let look: HudPrefs = hudPrefs(store.prefs.obs?.hud);
  let sel: HudPartId | null = null;
  let rects: Partial<Record<HudPartId, Rect>> = {};
  let drag: Drag | null = null;
  let moment: Moment | null = null;
  let mapBg: string | null = null;
  let shot: string | null = null;
  try {
    shot = localStorage.getItem(SHOT_KEY);
  } catch {
    // no storage: nothing behind it
  }

  const bd = document.createElement("div");
  bd.className = "modal-backdrop he-backdrop";
  bd.innerHTML = `
    <div class="modal-panel he" role="dialog" aria-modal="true" aria-labelledby="he-title">
      <header class="he-head">
        <div class="he-heading">
          <div class="dialog-title" id="he-title">${t("Live overlay")}</div>
          <div class="he-sub">${t("Put each part where your skin leaves room for it. OBS follows as you go.")}</div>
        </div>
        <div class="he-head-actions">
          <button class="btn btn-ghost" type="button" data-act="reset">${icon("refresh")}${t("Start over")}</button>
          <button class="btn btn-primary" type="button" data-act="done">${t("Done")}</button>
        </div>
      </header>
      <div class="he-body">
        <div class="he-main">
          <div class="he-stage-box">
            <div class="he-stage">
              <div class="he-back"></div>
              <iframe class="he-frame" src="obs.html?view=hud&edit=1" title="${t("Live overlay")}" tabindex="-1"></iframe>
              <div class="he-layer">
                <i class="he-guide he-guide-x" hidden></i>
                <i class="he-guide he-guide-y" hidden></i>
              </div>
            </div>
          </div>
          <div class="he-demo">
            <button class="icon-btn he-play" type="button" data-act="play" aria-label="${t("Pause")}">${icon("pause")}</button>
            <div class="he-moments">
              ${MOMENTS.map((m) => `<button class="chip-toggle" type="button" data-moment="${m.id}">${m.label()}</button>`).join("")}
            </div>
          </div>
        </div>
        <aside class="he-side">
          <section>
            <div class="label-caps he-label">${t("Parts")}</div>
            <div class="he-parts"></div>
          </section>
          <section class="he-inspect"></section>
          <section>
            <div class="label-caps he-label">${t("Behind it")}</div>
            <div class="he-shot">
              <button class="btn btn-sm" type="button" data-act="shot">${icon("folder")}${t("Screenshot…")}</button>
              <button class="btn btn-sm btn-ghost" type="button" data-act="shot-clear" hidden>${t("Remove")}</button>
              <input type="file" accept="image/*" hidden />
            </div>
            <p class="he-note">${t("Take a screenshot in osu! and paste it here with Ctrl+V, or pick the file. It's only for arranging and stays on this PC.")}</p>
          </section>
        </aside>
      </div>
    </div>`;
  document.body.append(bd);
  const $ = <T extends HTMLElement>(s: string) => bd.querySelector<T>(s)!;
  const stage = $(".he-stage");
  const frame = $<HTMLIFrameElement>(".he-frame");
  const layer = $(".he-layer");
  const back = $(".he-back");
  const guideX = $(".he-guide-x");
  const guideY = $(".he-guide-y");
  const playBtn = $(".he-play");
  const fileInput = $<HTMLInputElement>('.he-shot input[type="file"]');

  // a frame over each part, its handles, its name
  const boxes = {} as Record<HudPartId, HTMLElement>;
  for (const { id, shape } of HUD_PARTS) {
    const b = document.createElement("div");
    b.className = "he-box";
    b.dataset.part = id;
    b.dataset.shape = shape;
    b.hidden = true;
    const handles = shape === "line" ? ["w", "e"] : ["nw", "ne", "sw", "se"];
    b.innerHTML = `<span class="he-tag">${esc(NAMES[id]())}</span>${handles.map((h) => `<i class="he-handle" data-h="${h}"></i>`).join("")}`;
    layer.append(b);
    boxes[id] = b;
  }

  const win = (): ObsWindow | null => frame.contentWindow as ObsWindow | null;

  // ── the layout: to the frame at once, to Fumen's settings (and so to OBS) a little behind ──
  const tell = (): void => win()?.fumenObs?.take("config", { ...obsConfig(), hud: look });
  let savedAt = 0;
  let saveTimer = 0;
  let dirty = false;
  const save = (now = false): void => {
    clearTimeout(saveTimer);
    dirty = true;
    const go = (): void => {
      savedAt = performance.now();
      dirty = false;
      setPrefs({ obs: { ...store.prefs.obs, hud: look } });
    };
    const wait = 90 - (performance.now() - savedAt);
    if (now || wait <= 0) go();
    else saveTimer = window.setTimeout(go, wait);
  };
  const change = (id: HudPartId, p: HudPart): void => {
    look = { ...look, layout: { ...look.layout, [id]: p } };
    tell();
    save();
  };

  // ── picking a part: the list, what it is, its size ──
  const list = (): void => {
    $(".he-parts").innerHTML = HUD_PARTS.map(({ id }) => {
      const on = look.layout[id].on;
      return `<div class="he-part${id === sel ? " sel" : ""}${on ? "" : " off"}" data-part="${id}">
        <button type="button" class="he-part-name" data-pick="${id}">${esc(NAMES[id]())}</button>
        <button type="button" class="icon-btn sm he-eye" data-eye="${id}" aria-pressed="${on}" aria-label="${on ? t("Hide") : t("Show again")}" data-tip="${on ? t("Hide") : t("Show again")}">${icon("eye")}</button>
      </div>`;
    }).join("");
  };
  const inspect = (): void => {
    const el = $(".he-inspect");
    if (!sel) {
      el.innerHTML = `<p class="he-note">${t("Click a part to pick it. Drag it to move it, drag a corner to make it bigger or smaller. Arrow keys move it a pixel, Alt while dragging keeps it from snapping.")}</p>`;
      return;
    }
    const p = look.layout[sel];
    const sized = shapeOf(sel) !== "area";
    el.innerHTML = `
      <div class="he-inspect-name">${esc(NAMES[sel]())}</div>
      <p class="he-note">${esc(ABOUT[sel]())}</p>
      ${
        sized
          ? `<label class="he-size"><span>${t("Size")}</span><input type="range" min="${SIZE_MIN * 100}" max="${SIZE_MAX * 100}" step="5" value="${Math.round(p.size * 100)}" style="--pct:${(((p.size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)) * 100).toFixed(2)}%" aria-label="${t("Size")}" /><b class="num">${Math.round(p.size * 100)} %</b></label>`
          : ""
      }
      <div class="he-inspect-actions">
        <button class="btn btn-sm" type="button" data-act="part-reset">${t("Back to its place")}</button>
        <button class="btn btn-sm btn-ghost" type="button" data-eye="${sel}">${p.on ? t("Hide") : t("Show again")}</button>
      </div>`;
  };
  const select = (id: HudPartId | null): void => {
    sel = id;
    list();
    inspect();
  };
  const show = (id: HudPartId, on: boolean): void => {
    change(id, { ...look.layout[id], on });
    list();
    if (sel === id) inspect();
  };

  // ── behind it: a screenshot, or the map's own background, dimmed ──
  const backdrop = (): void => {
    back.style.backgroundImage = shot ? `url("${shot}")` : mapBg ? `url("${thumbUrl(mapBg, 1280)}")` : "";
    back.classList.toggle("shot", !!shot);
    $('[data-act="shot-clear"]').hidden = !shot;
  };
  const takeShot = async (file: Blob): Promise<void> => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const s = Math.max(1280 / img.naturalWidth, 720 / img.naturalHeight);
      c.getContext("2d")!.drawImage(img, (1280 - img.naturalWidth * s) / 2, (720 - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
      shot = c.toDataURL("image/jpeg", 0.86);
      try {
        localStorage.setItem(SHOT_KEY, shot);
      } catch {
        // too big to keep: it stays for now
      }
      backdrop();
    } catch {
      toast(t("That image couldn't be read."), { kind: "danger" });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // ── the page in the frame: told the layout, a stand-in map and tries, then the demo plays ──
  const hook = window.setInterval(() => {
    const w = win();
    if (!w?.fumenObs) return;
    clearInterval(hook);
    tell();
    void demoParts().then(({ map, tries }) => {
      if (!open) return;
      w.fumenObs?.take("tries", tries);
      w.fumenObs?.take("map", map);
      mapBg = map?.bg ?? null;
      backdrop();
    });
  }, 60);

  // ── every frame: the frames follow the parts as the page draws them ──
  let raf = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const w = win();
    const hud = w?.fumenHud;
    if (!hud) return;
    rects = hud.rects();
    for (const { id } of HUD_PARTS) {
      const r = rects[id];
      const b = boxes[id];
      b.hidden = !r;
      if (!r) continue;
      b.style.left = `${(r.x * 100).toFixed(3)}%`;
      b.style.top = `${(r.y * 100).toFixed(3)}%`;
      b.style.width = `${(r.w * 100).toFixed(3)}%`;
      b.style.height = `${(r.h * 100).toFixed(3)}%`;
      b.classList.toggle("on", id === sel);
      b.classList.toggle("dragging", drag?.id === id);
      b.dataset.near = r.y < 0.07 ? "top" : "";
      b.dataset.end = r.x + r.w / 2 > 0.6 ? "1" : "";
    }
    const running = w.fumenObs?.running() ?? true;
    if (playBtn.dataset.running !== String(running)) {
      playBtn.dataset.running = String(running);
      playBtn.innerHTML = icon(running ? "pause" : "play");
      playBtn.setAttribute("aria-label", running ? t("Pause") : t("Play"));
    }
  };
  raf = requestAnimationFrame(tick);

  // ── dragging ──
  const point = (e: PointerEvent): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const within = (): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: SNAP / Math.max(1, r.width), y: SNAP / Math.max(1, r.height) };
  };
  const guide = (gx: number | null, gy: number | null): void => {
    guideX.hidden = gx === null;
    guideY.hidden = gy === null;
    if (gx !== null) guideX.style.left = `${(gx * 100).toFixed(3)}%`;
    if (gy !== null) guideY.style.top = `${(gy * 100).toFixed(3)}%`;
  };

  layer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const box = target.closest<HTMLElement>(".he-box");
    if (!box) return select(null);
    const id = box.dataset.part as HudPartId;
    if (sel !== id) select(id);
    const r = rects[id];
    if (!r) return;
    e.preventDefault();
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // a pointer that isn't down any more: the drag goes on as long as moves come
    }
    const others = HUD_PARTS.map((p) => p.id)
      .filter((o) => o !== id && rects[o])
      .map((o) => rects[o]!);
    drag = { id, how: target.closest<HTMLElement>(".he-handle")?.dataset.h ?? "move", from: point(e), rect: { ...r }, part: { ...look.layout[id] }, lines: guides(others) };
    layer.dataset.drag = drag.how;
  });

  layer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const d = drag;
    const p = point(e);
    const free = e.altKey;
    const shape = shapeOf(d.id);
    const near = within();
    if (d.how === "move") {
      const r = { ...d.rect, x: clamp(d.rect.x + p.x - d.from.x, 0, 1 - d.rect.w), y: clamp(d.rect.y + p.y - d.from.y, 0, 1 - d.rect.h) };
      const s = free ? null : snapRect(r, d.lines, near);
      if (s) {
        r.x = clamp(r.x + s.dx, 0, 1 - r.w);
        r.y = clamp(r.y + s.dy, 0, 1 - r.h);
      }
      guide(s?.gx ?? null, s?.gy ?? null);
      change(d.id, placeAt(d.part, shape, r));
      return;
    }
    if (shape === "line") {
      // a side: as wide as it's pulled
      const left = d.rect.x;
      const right = d.rect.x + d.rect.w;
      const s = free ? null : snapEdge(clamp(p.x, 0, 1), d.lines.x, near.x);
      const edge = s ? s.at : clamp(p.x, 0, 1);
      guide(s?.guide ?? null, null);
      const r = d.how === "w" ? { ...d.rect, x: Math.min(edge, right - MIN_W), w: right - Math.min(edge, right - MIN_W) } : { ...d.rect, w: Math.max(MIN_W, edge - left) };
      change(d.id, placeAt(d.part, shape, r));
      return;
    }
    // a corner: the one across stays where it is
    const fx = d.how.includes("w") ? d.rect.x + d.rect.w : d.rect.x;
    const fy = d.how.includes("n") ? d.rect.y + d.rect.h : d.rect.y;
    if (shape === "area") {
      const sx = free ? null : snapEdge(clamp(p.x, 0, 1), d.lines.x, near.x);
      const sy = free ? null : snapEdge(clamp(p.y, 0, 1), d.lines.y, near.y);
      const ex = sx ? sx.at : clamp(p.x, 0, 1);
      const ey = sy ? sy.at : clamp(p.y, 0, 1);
      guide(sx?.guide ?? null, sy?.guide ?? null);
      const w = Math.max(MIN_W, Math.abs(ex - fx));
      const h = Math.max(MIN_H, Math.abs(ey - fy));
      const r = { x: ex < fx ? fx - w : fx, y: ey < fy ? fy - h : fy, w, h };
      change(d.id, placeAt(d.part, shape, r));
      return;
    }
    // words grow as a whole, by how far the corner went from the one across
    const cx = d.how.includes("w") ? d.rect.x : d.rect.x + d.rect.w;
    const cy = d.how.includes("n") ? d.rect.y : d.rect.y + d.rect.h;
    const stageBox = stage.getBoundingClientRect();
    const dist = (x: number, y: number): number => Math.hypot((x - fx) * stageBox.width, (y - fy) * stageBox.height);
    const k = dist(p.x, p.y) / Math.max(1, dist(cx, cy));
    const size = clamp(Math.round(d.part.size * k * 100) / 100, SIZE_MIN, SIZE_MAX);
    const kk = size / d.part.size;
    const w = d.rect.w * kk;
    const h = d.rect.h * kk;
    const r = { x: d.how.includes("w") ? fx - w : fx, y: d.how.includes("n") ? fy - h : fy, w, h };
    guide(null, null);
    change(d.id, { ...placeAt(d.part, shape, r), size });
    if (sel === d.id) {
      const range = bd.querySelector<HTMLInputElement>(".he-size input");
      if (range) {
        range.value = String(Math.round(size * 100));
        range.style.setProperty("--pct", `${(((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN)) * 100).toFixed(2)}%`);
        range.parentElement!.querySelector("b")!.textContent = `${Math.round(size * 100)} %`;
      }
    }
  });

  const endDrag = (): void => {
    if (!drag) return;
    drag = null;
    delete layer.dataset.drag;
    guide(null, null);
    save(true);
  };
  layer.addEventListener("pointerup", endDrag);
  layer.addEventListener("pointercancel", endDrag);

  // ── clicks ──
  bd.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const pick = el.closest<HTMLElement>("[data-pick]");
    if (pick) return select(pick.dataset.pick as HudPartId);
    const eye = el.closest<HTMLElement>("[data-eye]");
    if (eye) {
      const id = eye.dataset.eye as HudPartId;
      return show(id, !look.layout[id].on);
    }
    const m = el.closest<HTMLElement>("[data-moment]");
    if (m) {
      moment = m.dataset.moment as Moment;
      win()?.fumenObs?.moment(moment);
      for (const b of bd.querySelectorAll<HTMLElement>("[data-moment]")) b.classList.toggle("active", b === m);
      return;
    }
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "done") return close();
    if (act === "play") {
      const o = win()?.fumenObs;
      if (!o) return;
      if (o.running()) o.pause();
      else {
        o.play();
        moment = null;
        for (const b of bd.querySelectorAll<HTMLElement>("[data-moment]")) b.classList.remove("active");
      }
      return;
    }
    if (act === "part-reset" && sel) {
      change(sel, { ...DEFAULT_HUD[sel], on: true });
      list();
      inspect();
      return;
    }
    if (act === "shot") return fileInput.click();
    if (act === "shot-clear") {
      shot = null;
      try {
        localStorage.removeItem(SHOT_KEY);
      } catch {
        // nothing kept
      }
      return backdrop();
    }
    if (act === "reset")
      void uiConfirm(t("Put every part back where it was at first?"), { confirmLabel: t("Start over") }).then((ok) => {
        if (!ok || !open) return;
        look = { ...look, layout: DEFAULT_HUD };
        tell();
        save(true);
        list();
        inspect();
      });
  });
  bd.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.closest(".he-size") && sel) {
      const size = clamp(+el.value / 100, SIZE_MIN, SIZE_MAX);
      el.parentElement!.querySelector("b")!.textContent = `${Math.round(size * 100)} %`;
      change(sel, { ...look.layout[sel], size });
    }
  });
  bd.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el === fileInput && el.files?.[0]) {
      void takeShot(el.files[0]);
      el.value = "";
    }
  });

  // ── keys: arrows move, Delete hides, Escape lets go (then closes) ──
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (document.querySelector(".dialog-backdrop")) return;
      e.preventDefault();
      e.stopPropagation();
      if (sel) select(null);
      else close();
      return;
    }
    if (!sel || (e.target as HTMLElement).closest("input, textarea")) return;
    const step = e.shiftKey ? 10 : 1;
    const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = by[e.key];
    const r = rects[sel];
    if (d && r) {
      e.preventDefault();
      e.stopPropagation();
      change(sel, placeAt(look.layout[sel], shapeOf(sel), { ...r, x: clamp(r.x + d[0] / 1920, 0, 1 - r.w), y: clamp(r.y + d[1] / 1080, 0, 1 - r.h) }));
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      show(sel, false);
    }
  };
  const onPaste = (e: ClipboardEvent): void => {
    const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void takeShot(file);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("paste", onPaste);

  const close = (): void => {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    clearInterval(hook);
    if (dirty) save(true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("paste", onPaste);
    closeAnimated(bd);
  };

  list();
  inspect();
  backdrop();
}
