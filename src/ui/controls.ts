/* controls.ts — custom UI building blocks instead of native browser widgets.
 *
 *  - Tooltips:   any [title] / [data-tip] gets a small custom surface (350 ms delay, flips below
 *                when there's no room above). Native title tooltips never show.
 *  - Menus:      openMenu(anchor, items) — dropdowns and context menus share one look.
 *  - Select:     createSelect() — a trigger button + menu; no native <select> anywhere.
 *  - Slider:     <input type=range> gets --pct for the filled track.
 *  - Segments:   attachSegIndicator() slides a surface under the active option.
 *  - Dialogs:    uiConfirm / uiPrompt / toast instead of confirm() / prompt() / alert().
 */
import { t } from "../lib/i18n";
import { icon, type IconName } from "./icons";

export const reduceMotion = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// ════════════════════════════════════════════════════════════════════════════
// Tooltips
// ════════════════════════════════════════════════════════════════════════════
let tipEl: HTMLDivElement | null = null;
let tipTimer: number | undefined;
let tipFor: HTMLElement | null = null;

function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hideTip(): void {
  clearTimeout(tipTimer);
  tipTimer = undefined;
  tipFor = null;
  tipEl?.classList.remove("on", "below");
}

function showTip(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  const t = tip();
  t.textContent = text;
  t.classList.remove("on", "below");
  t.style.left = "0px";
  t.style.top = "0px";
  const r = target.getBoundingClientRect();
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
  let top = r.top - th - 8;
  let below = false;
  if (top < 6) {
    top = r.bottom + 8;
    below = true;
  }
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(top)}px`;
  t.classList.toggle("below", below);
  void t.offsetWidth;
  t.classList.add("on");
}

function initTooltips(): void {
  document.addEventListener("pointerover", (e) => {
    const t = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-tip]");
    if (!t) return;
    if (t.hasAttribute("title")) {
      const v = t.getAttribute("title");
      t.removeAttribute("title");
      if (v) t.dataset.tip = v;
    }
    if (t === tipFor) return;
    hideTip();
    if (!t.dataset.tip) return;
    tipFor = t;
    tipTimer = window.setTimeout(() => showTip(t), 350);
  });
  document.addEventListener("pointerout", (e) => {
    if (tipFor && !tipFor.contains(e.relatedTarget as Node | null)) hideTip();
  });
  document.addEventListener("pointerdown", hideTip, true);
  document.addEventListener("keydown", hideTip, true);
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("blur", hideTip);
}

// ════════════════════════════════════════════════════════════════════════════
// Menus
// ════════════════════════════════════════════════════════════════════════════
export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** For toggles: return the new checked state. */
  action?: () => void | boolean;
  /** Toggle in place instead of closing the menu. */
  keepOpen?: boolean;
  /** Items sharing a radio name check exclusively (with keepOpen). */
  radio?: string;
  /** Stays in view whatever is searched for (menus with `search`). */
  always?: boolean;
}
export type MenuEntry = MenuItem | { group: string } | "sep";

interface OpenMenu {
  el: HTMLDivElement;
  anchor: Element | null;
  close: (instant?: boolean) => void;
}
let openMenuState: OpenMenu | null = null;

export function closeMenus(instant = false): void {
  openMenuState?.close(instant);
}

/**
 * Opens a menu under `anchor` (or at a point for context menus). Items are keyboard
 * navigable; returns a close function.
 */
export function openMenu(
  anchor: Element | { x: number; y: number },
  entries: MenuEntry[],
  opts: { minWidth?: number; className?: string; onClose?: () => void; header?: HTMLElement; search?: string } = {},
): () => void {
  closeMenus(true);
  const el = document.createElement("div");
  el.className = `menu${opts.className ? " " + opts.className : ""}`;
  el.setAttribute("role", "menu");
  let search: HTMLInputElement | null = null;
  if (opts.search) {
    const box = document.createElement("label");
    box.className = "menu-search";
    box.innerHTML = `${icon("search")}<input type="search" spellcheck="false" />`;
    search = box.querySelector("input")!;
    search.placeholder = opts.search;
    search.setAttribute("aria-label", opts.search);
    el.appendChild(box);
  }
  if (opts.header) el.appendChild(opts.header);
  const items: { el: HTMLElement; item: MenuItem }[] = [];
  let k = 0;
  for (const entry of entries) {
    if (entry === "sep") {
      el.insertAdjacentHTML("beforeend", `<div class="menu-sep"></div>`);
    } else if ("group" in entry) {
      const g = document.createElement("div");
      g.className = "menu-group";
      g.textContent = entry.group;
      el.appendChild(g);
    } else {
      const it = document.createElement("div");
      it.className = `menu-item mi${entry.danger ? " danger" : ""}${entry.disabled ? " disabled" : ""}${entry.checked ? " sel" : ""}`;
      it.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemradio");
      it.style.setProperty("--k", String(k++));
      it.innerHTML = `${entry.icon ? icon(entry.icon) : ""}<span class="menu-label"></span>${
        entry.hint ? `<span class="menu-hint"></span>` : ""
      }${entry.checked !== undefined ? icon("check", "menu-check") : ""}`;
      it.querySelector(".menu-label")!.textContent = entry.label;
      if (entry.hint) it.querySelector(".menu-hint")!.textContent = entry.hint;
      if (!entry.disabled) {
        it.addEventListener("click", () => activate(entry, it));
        it.addEventListener("pointermove", () => highlight(items.findIndex((x) => x.el === it)));
      }
      el.appendChild(it);
      items.push({ el: it, item: entry });
    }
  }
  document.body.appendChild(el);

  // position (anchored menus follow their anchor when the page scrolls underneath)
  const isPoint = !(anchor instanceof Element);
  const anchorRect = () =>
    isPoint
      ? new DOMRect((anchor as { x: number }).x, (anchor as { y: number }).y, 0, 0)
      : (anchor as Element).getBoundingClientRect();
  let up = false;
  const place = (first: boolean) => {
    const r = anchorRect();
    if (first) {
      el.style.minWidth = `${Math.max(opts.minWidth ?? 0, isPoint ? 180 : Math.round(r.width))}px`;
      const mh = Math.min(el.scrollHeight, 420);
      const spaceBelow = window.innerHeight - r.bottom - 10;
      up = spaceBelow < Math.min(mh, 220) && r.top > spaceBelow;
      el.classList.toggle("up", up);
      el.style.maxHeight = `${Math.max(120, Math.min(420, up ? r.top - 14 : spaceBelow))}px`;
    }
    const mw = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.round(Math.min(r.left, window.innerWidth - mw - 8)))}px`;
    if (up) el.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    else el.style.top = `${Math.round(r.bottom + (isPoint ? 2 : 6))}px`;
  };
  place(true);

  function activate(entry: MenuItem, it: HTMLElement): void {
    if (!entry.keepOpen) {
      close();
      entry.action?.();
      return;
    }
    const res = entry.action?.();
    if (entry.radio) {
      for (const x of items) if (x.item.radio === entry.radio) x.el.classList.toggle("sel", x.el === it);
    } else if (typeof res === "boolean") {
      it.classList.toggle("sel", res);
    }
  }

  let idx = items.findIndex((x) => x.item.checked);
  const highlight = (i: number) => {
    items.forEach((x, j) => x.el.classList.toggle("hl", j === i));
    idx = i;
  };
  // searching hides what doesn't match and picks the first that does
  search?.addEventListener("input", () => {
    const q = search!.value.trim().toLowerCase();
    for (const x of items) x.el.hidden = !!q && !x.item.always && !x.item.label.toLowerCase().includes(q);
    const first = items.findIndex((x) => !x.el.hidden && !x.item.disabled && !x.item.always);
    highlight(first);
    if (first >= 0) items[first].el.scrollIntoView({ block: "nearest" });
  });
  if (idx >= 0) {
    highlight(idx);
    items[idx].el.scrollIntoView({ block: "nearest" });
  }
  if (anchor instanceof Element) {
    anchor.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      if (anchor instanceof HTMLElement) anchor.focus({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      if (!n) return;
      let i = idx;
      for (let s = 0; s < n; s++) {
        i = (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        if (!items[i].item.disabled && !items[i].el.hidden) break;
      }
      highlight(i);
      items[i].el.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" || (e.key === " " && e.target !== search)) {
      const it = items[idx];
      if (it && !it.item.disabled) {
        e.preventDefault();
        activate(it.item, it.el);
      }
    } else if (e.key === "Tab") {
      close();
    }
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!el.contains(t) && !(anchor instanceof Element && anchor.contains(t))) close();
  };
  const onScroll = (e: Event) => {
    if (el.contains(e.target as Node)) return;
    if (isPoint) return close();
    const r = anchorRect();
    if (r.bottom < 0 || r.top > window.innerHeight || !(anchor as Element).isConnected) close();
    else place(false);
  };
  const onResize = () => close();
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);

  let closed = false;
  function close(instant = false) {
    if (closed) return;
    closed = true;
    if (openMenuState?.el === el) openMenuState = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    if (anchor instanceof Element) {
      anchor.classList.remove("open");
      anchor.setAttribute("aria-expanded", "false");
    }
    opts.onClose?.();
    if (instant || reduceMotion()) {
      el.remove();
      return;
    }
    el.classList.add("closing");
    setTimeout(() => el.remove(), 150);
  }
  openMenuState = { el, anchor: anchor instanceof Element ? anchor : null, close };
  search?.focus({ preventScroll: true });
  return close;
}

// ════════════════════════════════════════════════════════════════════════════
// Select (button + menu)
// ════════════════════════════════════════════════════════════════════════════
export interface SelectOption<T extends string> {
  value: T;
  label: string;
  group?: string;
}

export interface SelectHandle<T extends string> {
  el: HTMLButtonElement;
  get value(): T;
  set value(v: T);
}

export function createSelect<T extends string>(
  options: SelectOption<T>[],
  value: T,
  onChange: (v: T) => void,
  opts: { className?: string; prefix?: string; tip?: string } = {},
): SelectHandle<T> {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `cs${opts.className ? " " + opts.className : ""}`;
  el.setAttribute("aria-haspopup", "menu");
  el.setAttribute("aria-expanded", "false");
  if (opts.tip) el.dataset.tip = opts.tip;
  el.innerHTML = `${opts.prefix ? `<span class="cs-prefix"></span>` : ""}<span class="cs-label"></span>${icon("chevron-down", "cs-chev")}`;
  if (opts.prefix) el.querySelector(".cs-prefix")!.textContent = opts.prefix;
  let current = value;
  const render = () => {
    el.querySelector(".cs-label")!.textContent = options.find((o) => o.value === current)?.label ?? "";
  };
  render();
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (el.classList.contains("open")) {
      closeMenus();
      return;
    }
    const entries: MenuEntry[] = [];
    let group: string | undefined;
    for (const o of options) {
      if (o.group && o.group !== group) {
        group = o.group;
        entries.push({ group });
      }
      entries.push({
        label: o.label,
        checked: o.value === current,
        action: () => {
          if (o.value === current) return;
          current = o.value;
          render();
          onChange(current);
        },
      });
    }
    openMenu(el, entries);
  });
  el.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !el.classList.contains("open")) {
      e.preventDefault();
      el.click();
    }
  });
  return {
    el,
    get value() {
      return current;
    },
    set value(v: T) {
      current = v;
      render();
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Slider fill (--pct)
// ════════════════════════════════════════════════════════════════════════════
export function updateRange(el: HTMLInputElement): void {
  const min = el.min === "" ? 0 : +el.min;
  const max = el.max === "" ? 100 : +el.max;
  const pct = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--pct", `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
}

function initRangeFill(): void {
  document.addEventListener(
    "input",
    (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === "range") updateRange(t);
    },
    true,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Segment indicator
// ════════════════════════════════════════════════════════════════════════════
export function attachSegIndicator(container: HTMLElement, activeSel = ".active"): () => void {
  container.classList.add("seg-host");
  const ind = document.createElement("span");
  ind.className = "seg-ind";
  ind.setAttribute("aria-hidden", "true");
  container.appendChild(ind);
  let first = true;
  const place = () => {
    if (ind.parentNode !== container) container.appendChild(ind);
    const a = container.querySelector<HTMLElement>(activeSel);
    if (!a || !a.offsetParent) {
      ind.style.opacity = "0";
      return;
    }
    const cr = container.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    ind.style.setProperty("--seg-x", `${ar.left - cr.left + container.scrollLeft}px`);
    ind.style.setProperty("--seg-w", `${ar.width}px`);
    ind.style.opacity = "1";
    if (first) {
      first = false;
      requestAnimationFrame(() => ind.classList.add("ready"));
    }
  };
  new MutationObserver((muts) => {
    if (muts.some((m) => m.target !== ind)) requestAnimationFrame(place);
  }).observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(() => place()).observe(container);
  requestAnimationFrame(place);
  return place;
}

// ════════════════════════════════════════════════════════════════════════════
// Modals, dialogs, toasts
// ════════════════════════════════════════════════════════════════════════════
export function closeAnimated(el: HTMLElement, after?: () => void): void {
  if (reduceMotion()) {
    el.remove();
    after?.();
    return;
  }
  el.classList.add("closing");
  setTimeout(() => {
    el.remove();
    after?.();
  }, 220);
}

export function uiConfirm(
  message: string,
  opts: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop dialog-backdrop";
    bd.innerHTML = `
      <div class="modal-panel dialog" role="dialog" aria-modal="true">
        <div class="dialog-title"></div>
        <div class="dialog-msg"></div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-act="cancel"></button>
          <button class="btn ${opts.danger ? "btn-danger" : "btn-primary"}" data-act="ok"></button>
        </div>
      </div>`;
    bd.querySelector(".dialog-title")!.textContent = opts.title ?? t("Confirm");
    bd.querySelector(".dialog-msg")!.textContent = message;
    bd.querySelector('[data-act="cancel"]')!.textContent = opts.cancelLabel ?? t("Cancel");
    bd.querySelector('[data-act="ok"]')!.textContent = opts.confirmLabel ?? t("OK");
    document.body.appendChild(bd);
    setTimeout(() => bd.querySelector<HTMLButtonElement>('[data-act="ok"]')!.focus(), 30);
    const finish = (ok: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      closeAnimated(bd);
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        finish(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    bd.addEventListener("pointerdown", (e) => {
      if (e.target === bd) finish(false);
    });
    bd.querySelector('[data-act="cancel"]')!.addEventListener("click", () => finish(false));
    bd.querySelector('[data-act="ok"]')!.addEventListener("click", () => finish(true));
  });
}

let toastHost: HTMLDivElement | null = null;
/** Asks for a line of text (a name, say); null when cancelled. Empty input can't be confirmed. */
export function uiPrompt(
  message: string,
  opts: { title?: string; value?: string; placeholder?: string; confirmLabel?: string; maxLength?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop dialog-backdrop";
    bd.innerHTML = `
      <div class="modal-panel dialog" role="dialog" aria-modal="true">
        <div class="dialog-title"></div>
        <div class="dialog-msg"></div>
        <input class="dialog-input" type="text" spellcheck="false" autocomplete="off" />
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-act="cancel">${t("Cancel")}</button>
          <button class="btn btn-primary" data-act="ok"></button>
        </div>
      </div>`;
    bd.querySelector(".dialog-title")!.textContent = opts.title ?? "";
    const msg = bd.querySelector<HTMLElement>(".dialog-msg")!;
    msg.textContent = message;
    msg.hidden = !message;
    const input = bd.querySelector<HTMLInputElement>(".dialog-input")!;
    input.value = opts.value ?? "";
    input.placeholder = opts.placeholder ?? "";
    input.maxLength = opts.maxLength ?? 100;
    input.setAttribute("aria-label", opts.title ?? message);
    const ok = bd.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
    ok.textContent = opts.confirmLabel ?? t("OK");
    const sync = () => (ok.disabled = !input.value.trim());
    sync();
    input.addEventListener("input", sync);
    document.body.appendChild(bd);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    const finish = (value: string | null) => {
      document.removeEventListener("keydown", onKey, true);
      closeAnimated(bd);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && !ok.disabled) {
        e.preventDefault();
        e.stopPropagation();
        finish(input.value.trim());
      }
    };
    document.addEventListener("keydown", onKey, true);
    bd.addEventListener("pointerdown", (e) => {
      if (e.target === bd) finish(null);
    });
    bd.querySelector('[data-act="cancel"]')!.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () => finish(input.value.trim()));
  });
}

export function toast(
  message: string,
  opts: { kind?: "info" | "success" | "danger"; timeout?: number; action?: { label: string; run: () => void } } = {},
): () => void {
  const kind = opts.kind ?? "info";
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-host";
    document.body.appendChild(toastHost);
  }
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.setAttribute("role", "status");
  t.innerHTML = `${icon(kind === "danger" ? "alert" : kind === "success" ? "check" : "info", "toast-ic")}<span class="toast-msg"></span>`;
  t.querySelector(".toast-msg")!.textContent = message;
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm toast-action";
    b.textContent = opts.action.label;
    b.addEventListener("click", opts.action.run);
    t.appendChild(b);
  }
  toastHost.appendChild(t);
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    t.classList.add("closing");
    setTimeout(() => t.remove(), 220);
  };
  setTimeout(close, opts.timeout ?? 3600);
  t.addEventListener("click", close);
  return close;
}

// ════════════════════════════════════════════════════════════════════════════
// Cursor reveal glow (.reveal elements)
// ════════════════════════════════════════════════════════════════════════════
function initRevealGlow(): void {
  document.addEventListener(
    "pointermove",
    (e) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(".reveal");
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--rx", `${e.clientX - r.left}px`);
      el.style.setProperty("--ry", `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}

export function initControls(): void {
  initTooltips();
  initRangeFill();
  initRevealGlow();
}
