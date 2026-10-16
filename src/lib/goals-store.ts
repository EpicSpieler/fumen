/* goals-store.ts — the player's goals: loaded once, saved through Fumen (src-tauri/src/goals.rs),
 * and checked whenever the plays or the library change. A goal that's been reached is marked with
 * the time and stays done, whatever happens to the numbers after. */
import { api, asApiError } from "./api";
import { goalContext, goalNow, goalTarget, goalTitle, isReached, type Goal, type GoalContext, type GoalSpec } from "./goals";
import { historyEvents, historyNow, loadHistory, mapIndexOf } from "./history";
import { Emitter, events, store } from "./store";
import { toast } from "../ui/controls";
import { t } from "./i18n";

export const goalEvents = new Emitter<{ goals: Goal[] }>();

let goals: Goal[] | null = null;
let loading: Promise<Goal[]> | null = null;
let started = false;

export const goalsNow = (): Goal[] | null => goals;

export function loadGoals(): Promise<Goal[]> {
  loading ??= api.getGoals().then(
    (g) => {
      goals = g;
      goalEvents.emit("goals", g);
      check();
      return g;
    },
    (e) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** What goals are measured against right now; null until the plays and the library are there. */
export function currentContext(): GoalContext | null {
  const h = historyNow();
  const snap = store.snap;
  return h && snap ? goalContext(h, snap.maps, mapIndexOf) : null;
}

function changed(): void {
  goalEvents.emit("goals", goals ?? []);
}

/** Sets a goal from where things stand now. */
export async function addGoal(spec: GoalSpec): Promise<Goal> {
  const ctx = currentContext();
  const goal: Goal = { ...spec, id: crypto.randomUUID(), created: Date.now(), start: ctx ? goalNow(spec, ctx) : null };
  await api.putGoal(goal);
  goals = [...(goals ?? []), goal];
  changed();
  return goal;
}

export async function removeGoal(id: string): Promise<void> {
  await api.deleteGoal(id);
  goals = (goals ?? []).filter((g) => g.id !== id);
  changed();
}

/** Marks the goals the plays have reached, with a toast each. */
function check(): void {
  const ctx = currentContext();
  if (!goals || !ctx) return;
  const reached = goals.filter((g) => !g.done && isReached(g, goalNow(g, ctx)));
  if (!reached.length) return;
  const now = Date.now();
  goals = goals.map((g) => (reached.includes(g) ? { ...g, done: now } : g));
  changed();
  for (const g of goals.filter((g) => g.done === now)) {
    toast(t("Goal reached: {goal}, {target}", { goal: goalTitle(g), target: goalTarget(g) }), { kind: "success", timeout: 8000 });
    api.putGoal(g).catch((e) => console.warn("[goals] save", asApiError(e).message));
  }
}

export function initGoals(): void {
  if (started) return;
  started = true;
  historyEvents.on("history", () => check());
  events.on("library", () => check());
  loadGoals().then(
    // open goals are checked against the plays, so those load now rather than when first shown
    (g) => void (g.some((x) => !x.done) && loadHistory().catch(() => {})),
    (e) => console.warn("[goals] load", asApiError(e).message),
  );
}
