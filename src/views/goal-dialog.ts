/* goal-dialog.ts — setting a goal: a skill to reach, an accuracy on a chart, or osu!'s pp or rank.
 * Opens with the kind and its details filled in from where it was asked for (a skill row, a
 * chart, a practice suggestion) and a target a step beyond where things stand. */
import { asApiError } from "../lib/api";
import { displayTitle, esc, fixed, pct } from "../lib/format";
import { addGoal, currentContext } from "../lib/goals-store";
import { goalNow, goalValue, isReached, RULESET_LABEL, RULESETS, suggestTarget, type GoalSpec, type Ruleset } from "../lib/goals";
import { historyNow, mapIndexOf } from "../lib/history";
import { keyModes, MIN_CHARTS, PATTERN_LABEL, PATTERNS, type SkillPattern } from "../lib/skills";
import { store } from "../lib/store";
import { RATE_MAX, RATE_MIN, RATE_STEP } from "../player";
import { attachSegIndicator, closeAnimated, createSelect, toast } from "../ui/controls";
import { icon } from "../ui/icons";
import { t } from "../lib/i18n";

type Kind = GoalSpec["kind"];

export interface GoalPreset {
  kind?: Kind;
  keys?: number;
  pattern?: SkillPattern;
  /** a chart: the library difficulty, and the rate to aim at */
  mapIdx?: number;
  rate?: number;
}

export function openGoalDialog(preset: GoalPreset = {}): void {
  const snap = store.snap;
  const h = historyNow();
  const chartMap = preset.mapIdx !== undefined ? snap?.maps[preset.mapIdx] : undefined;
  const modes = h && snap ? keyModes(h.plays, mapIndexOf, snap.maps).map((m) => m.keys) : [];
  if (!modes.length) modes.push(4);
  const rulesets = RULESETS.filter((r) => h?.stats[r]?.pp);

  let kind: Kind = preset.kind ?? (chartMap ? "chart" : "skill");
  let keys = preset.keys !== undefined && modes.includes(preset.keys) ? preset.keys : modes[0];
  let pattern: SkillPattern = preset.pattern ?? "jacks";
  let ruleset: Ruleset = rulesets.includes("mania") ? "mania" : (rulesets[0] ?? "mania");
  let metric: "pp" | "rank" = "pp";
  let rate = preset.rate ?? 1;
  /** the target as typed; null: the suggestion */
  let typed: string | null = null;

  const bd = document.createElement("div");
  bd.className = "modal-backdrop dialog-backdrop";
  bd.innerHTML = `
    <div class="modal-panel dialog goal-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-dialog-title">
      <div class="dialog-title" id="goal-dialog-title">${t("New goal")}</div>
      <div class="seg-pill goal-kinds" role="tablist" aria-label="${t("Kind of goal")}">
        <button type="button" data-kind="skill">${t("Skill")}</button>
        ${chartMap ? `<button type="button" data-kind="chart">${t("This chart")}</button>` : ""}
        <button type="button" data-kind="profile"${rulesets.length ? "" : ` disabled data-tip="${t("Log in with osu! in Settings first")}"`}>${t("osu! profile")}</button>
      </div>
      <div class="goal-fields"></div>
      <div class="goal-now"></div>
      <div class="dialog-actions">
        <button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button>
        <button class="btn btn-primary" type="button" data-act="ok">${t("Set goal")}</button>
      </div>
    </div>`;
  const fields = bd.querySelector<HTMLElement>(".goal-fields")!;
  const nowEl = bd.querySelector<HTMLElement>(".goal-now")!;
  const ok = bd.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
  const kinds = bd.querySelector<HTMLElement>(".goal-kinds")!;

  /** the goal as it stands, with the target as typed (or suggested) */
  const spec = (target: number): GoalSpec => {
    if (kind === "skill") return { kind, keys, pattern, target };
    if (kind === "profile") return { kind, ruleset, metric, target };
    const set = snap!.sets[chartMap!.set];
    return {
      kind: "chart",
      map: chartMap!.id,
      ...(chartMap!.onlineId ? { beatmapId: chartMap!.onlineId } : {}),
      title: displayTitle(set, store.prefs.unicode),
      version: chartMap!.version,
      acc: target,
      rate,
    };
  };
  const nowOf = (): number | null => {
    const ctx = currentContext();
    return ctx ? goalNow(spec(0), ctx) : null;
  };
  const suggestion = (now: number | null) => suggestTarget(kind === "profile" ? metric : kind, now);
  /** the target in the field's terms: accuracy in percent */
  const shown = (v: number) => (kind === "chart" ? fixed(v * 100, 1) : kind === "skill" ? fixed(v, 2) : String(Math.round(v)));
  const parse = (s: string): number | null => {
    const v = Number(s.replace(",", ".").replace(/[^\d.]/g, ""));
    if (!s.trim() || !Number.isFinite(v)) return null;
    return kind === "chart" ? v / 100 : v;
  };

  const select = <T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, label: string) => {
    const s = createSelect(options, value, (v) => {
      onChange(v);
      typed = null;
      render();
    }, { prefix: label });
    return s.el;
  };

  function render(): void {
    kinds.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
    const now = nowOf();
    const target = typed ?? shown(suggestion(now));
    fields.innerHTML = "";
    const row = document.createElement("div");
    row.className = "goal-row";
    if (kind === "skill") {
      row.append(
        select(PATTERNS.map((p) => ({ value: p, label: PATTERN_LABEL[p] })), pattern, (v) => (pattern = v), t("Pattern")),
        select(modes.map((k) => ({ value: String(k), label: `${k}K` })), String(keys), (v) => (keys = +v), t("Keys")),
      );
    } else if (kind === "profile") {
      row.append(select(rulesets.map((r) => ({ value: r, label: RULESET_LABEL[r] })), ruleset, (v) => (ruleset = v), t("Mode")));
      const seg = document.createElement("div");
      seg.className = "seg-pill goal-metric";
      seg.innerHTML = `<button type="button" data-metric="pp" class="${metric === "pp" ? "active" : ""}">pp</button><button type="button" data-metric="rank" class="${metric === "rank" ? "active" : ""}">${t("Rank")}</button>`;
      row.append(seg);
    } else {
      const set = snap!.sets[chartMap!.set];
      row.innerHTML = `
        <div class="goal-chart"><div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div><div class="t-sub">${esc(chartMap!.version)}</div></div>
        <div class="rate-step goal-rate" data-tip="${t("Plays at this rate or faster count")}">
          <button class="icon-btn sm" type="button" data-rate-step="-1" aria-label="${t("Slower")}"${rate <= RATE_MIN + 1e-6 ? " disabled" : ""}>${icon("minus")}</button>
          <span class="rate-val num">${fixed(rate, 2)}×</span>
          <button class="icon-btn sm" type="button" data-rate-step="1" aria-label="${t("Faster")}"${rate >= RATE_MAX - 1e-6 ? " disabled" : ""}>${icon("plus")}</button>
        </div>`;
    }
    const unit = kind === "skill" ? "★" : kind === "chart" ? "%" : metric === "pp" ? "pp" : "";
    const input = document.createElement("label");
    input.className = "goal-target";
    input.innerHTML = `<span class="goal-target-label">${t("Target")}</span>${kind === "profile" && metric === "rank" ? `<span class="goal-unit">#</span>` : ""}<input type="text" inputmode="decimal" spellcheck="false" autocomplete="off" aria-label="${t("Target")}" /><span class="goal-unit">${unit}</span>`;
    const field = input.querySelector("input")!;
    field.value = target;
    field.addEventListener("input", () => {
      typed = field.value;
      check();
    });
    fields.append(row, input);
    row.querySelectorAll<HTMLElement>(".seg-pill").forEach((s) => attachSegIndicator(s));
    check();
  }

  /** what's there now, and whether the target makes a goal */
  function check(): void {
    const now = nowOf();
    const field = fields.querySelector<HTMLInputElement>(".goal-target input")!;
    const v = parse(field.value);
    const sp = v !== null ? spec(v) : null;
    let note = "";
    let error = "";
    if (kind === "skill") {
      const skill = currentContext()?.skillsFor(keys)[PATTERNS.indexOf(pattern)];
      note = now !== null ? (skill && skill.charts < MIN_CHARTS ? t("Now {value}, a guess so far", { value: goalValue(spec(0), now) }) : t("Now {value}", { value: goalValue(spec(0), now) })) : t("No {keys}K {pattern} charts passed yet", { keys, pattern: PATTERN_LABEL[pattern].toLowerCase() });
    } else if (kind === "chart") note = now !== null ? t("Your best at {rate}× or faster: {acc}", { rate: fixed(rate, 2), acc: pct(now) }) : t("Not passed at {rate}× or faster yet", { rate: fixed(rate, 2) });
    else note = now !== null ? t("Now {value}", { value: goalValue(spec(0), now) }) : t("Nothing from osu! yet");
    if (v === null) error = t("Type a target.");
    else if (kind === "chart" && (v <= 0.5 || v > 1)) error = t("An accuracy between 50% and 100%.");
    else if (kind === "skill" && (v <= 0 || v > 20)) error = t("A star rating between 0 and 20.");
    else if (kind === "profile" && v < 1) error = metric === "rank" ? t("A rank from #1.") : t("Some pp above 0.");
    else if (sp && isReached(sp, now)) error = t("You're there already: aim higher.");
    nowEl.innerHTML = `<span>${esc(note)}</span>${error ? `<span class="goal-error">${esc(error)}</span>` : ""}`;
    ok.disabled = !!error;
  }

  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    closeAnimated(bd);
  };
  const save = async () => {
    const v = parse(fields.querySelector<HTMLInputElement>(".goal-target input")!.value);
    if (v === null || ok.disabled) return;
    ok.disabled = true;
    try {
      await addGoal(spec(kind === "profile" && metric === "rank" ? Math.round(v) : v));
      finish();
    } catch (e) {
      toast(t("Couldn't save the goal: {error}", { error: asApiError(e).message }), { kind: "danger" });
      ok.disabled = false;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    // an open select menu takes its own keys
    if (document.querySelector(".menu")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === "Enter" && (e.target as Element).closest?.(".goal-dialog")) {
      e.preventDefault();
      e.stopPropagation();
      void save();
    }
  };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) finish();
  });
  bd.addEventListener("click", (e) => {
    const t = e.target as Element;
    const k = t.closest<HTMLButtonElement>("[data-kind]");
    if (k && !k.disabled && k.dataset.kind !== kind) {
      kind = k.dataset.kind as Kind;
      typed = null;
      return render();
    }
    const m = t.closest<HTMLElement>("[data-metric]");
    if (m && m.dataset.metric !== metric) {
      metric = m.dataset.metric as "pp" | "rank";
      typed = null;
      return render();
    }
    const step = t.closest<HTMLButtonElement>("[data-rate-step]");
    if (step && !step.disabled) {
      rate = Math.round(Math.max(RATE_MIN, Math.min(RATE_MAX, rate + +step.dataset.rateStep! * RATE_STEP)) * 100) / 100;
      typed = null;
      return render();
    }
    if (t.closest('[data-act="cancel"]')) return finish();
    if (t.closest('[data-act="ok"]')) return void save();
  });

  document.body.appendChild(bd);
  render();
  attachSegIndicator(kinds);
  setTimeout(() => fields.querySelector<HTMLInputElement>(".goal-target input")?.focus(), 30);
}
