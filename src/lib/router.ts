/* router.ts — in-memory navigation with back/forward (mouse buttons 4/5, Alt+←/→). */
import { Emitter } from "./store";

export type Route =
  | { name: "home" }
  | { name: "library" }
  | { name: "history" }
  | { name: "skills" }
  | { name: "browse" }
  | { name: "care" }
  /** similar: open the difficulty's similar maps */
  | { name: "set"; id: string; map?: string; similar?: boolean }
  | { name: "collection"; id: string }
  | { name: "settings" }
  | { name: "welcome" };

const stack: Route[] = [{ name: "home" }];
let pos = 0;

export const router = new Emitter<{ change: Route }>();

export const current = (): Route => stack[pos];

/** The section the current page was reached from (sidebar highlighting). */
export const sectionRoot = (): Route => stack[0];

export const canGoBack = (): boolean => pos > 0;

function same(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function go(route: Route, opts: { replace?: boolean } = {}): void {
  if (same(route, stack[pos])) return;
  if (opts.replace) {
    stack[pos] = route;
  } else {
    stack.splice(pos + 1);
    stack.push(route);
    if (stack.length > 100) stack.shift();
    pos = stack.length - 1;
  }
  router.emit("change", route);
}

/** Top-level sections reset the history so "back" never leads somewhere unexpected. */
export function goSection(route: Route): void {
  stack.splice(0, stack.length, route);
  pos = 0;
  router.emit("change", route);
}

export function back(): void {
  if (pos === 0) return;
  pos--;
  router.emit("change", stack[pos]);
}

export function forward(): void {
  if (pos >= stack.length - 1) return;
  pos++;
  router.emit("change", stack[pos]);
}

export function initRouterInput(): void {
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3) {
      e.preventDefault();
      back();
    } else if (e.button === 4) {
      e.preventDefault();
      forward();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      back();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      forward();
    }
  });
}
