/* odometer.ts — a number whose digits roll (the tracker's odometer): each digit a strip of 0–9 with
 * one more 0 under the 9, moved up by translateY; past 9 it rolls on to that 0 and snaps back. A
 * digit that changes all the time (the units in a stream) rolls short or not at all, the slower
 * ones in full: a constant roll only reads as a blur. */

const FULL = 0.42;

interface Cell {
  el: HTMLElement;
  strip: HTMLElement;
  d: number;
  /** performance.now() of its last change */
  at: number;
  snap: number;
}

export class Odometer {
  readonly el: HTMLElement;
  /** units first */
  private cells: Cell[] = [];
  private value: number | null = null;

  constructor(cls = "") {
    this.el = document.createElement("span");
    this.el.className = `odo${cls ? ` ${cls}` : ""}`;
  }

  get current(): number | null {
    return this.value;
  }

  /** Shows `n`; `instant` without rolling (a reset, a page coming up). */
  set(n: number, instant = false): void {
    n = Math.max(0, Math.round(n));
    if (n === this.value) return;
    const up = this.value !== null && n > this.value;
    this.value = n;
    const digits = String(n);
    while (this.cells.length < digits.length) this.cells.push(this.cell());
    while (this.cells.length > digits.length) this.cells.pop()!.el.remove();
    const now = performance.now();
    this.cells.forEach((c, j) => {
      const d = Number(digits[digits.length - 1 - j]);
      if (d === c.d) return;
      const since = (now - c.at) / 1000;
      c.at = now;
      const dur = instant ? 0 : Math.min(FULL, Math.max(0, since * 0.6 - 0.04));
      // rolling up past 9: on to the 0 under it, then back to the top one unseen
      const to = up && d < c.d ? 10 : d;
      c.d = d;
      clearTimeout(c.snap);
      c.strip.style.transition = dur > 0.03 ? `transform ${dur}s cubic-bezier(.22,.9,.25,1)` : "none";
      c.strip.style.transform = `translateY(${-to}em)`;
      if (to === 10)
        c.snap = window.setTimeout(
          () => {
            c.strip.style.transition = "none";
            c.strip.style.transform = "translateY(0)";
          },
          dur * 1000 + 30,
        );
    });
  }

  private cell(): Cell {
    const el = document.createElement("span");
    el.className = "odo-cell";
    const strip = document.createElement("span");
    strip.className = "odo-strip";
    for (const d of "01234567890") {
      const s = document.createElement("span");
      s.textContent = d;
      strip.append(s);
    }
    el.append(strip);
    // a new digit comes in on the left
    this.el.prepend(el);
    return { el, strip, d: 0, at: 0, snap: 0 };
  }
}
