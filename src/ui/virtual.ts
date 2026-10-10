/* virtual.ts — windowed rendering for long row lists.
 *
 * Only rows inside the viewport (+ overscan) exist in the DOM. Rows are uniform (`rowHeight`) or
 * sized per row (`heightOf`). Row elements are keyed (by index, or by `keyOf` for lists whose rows
 * move) and kept while visible, so images don't reload while scrolling; a row is only rendered
 * when it enters the window or `refresh()` is called. `relayout()` is for rows inserted or removed
 * around others: rows whose key stays keep their element and only move.
 */

export interface VirtualListOptions {
  /** the scrolling element */
  scroller: HTMLElement;
  /** positioned container inside the scroller that receives the rows */
  body: HTMLElement;
  count: () => number;
  /** uniform row height (used when there's no `heightOf`) */
  rowHeight?: () => number;
  /** height of one row, for lists with mixed rows */
  heightOf?: (index: number) => number;
  /** stable identity of a row; defaults to its index */
  keyOf?: (index: number) => string | number;
  renderRow: (index: number, el: HTMLElement) => void;
  rowClass?: string;
  /** extra px rendered above/below the viewport */
  overscanPx?: number;
}

export class VirtualList {
  private rows = new Map<string | number, HTMLElement>();
  private pool: HTMLElement[] = [];
  /** row tops plus the total height at the end (`heightOf` lists only) */
  private offsets: number[] = [0];
  private stale = true;
  private raf = 0;
  private ro: ResizeObserver;
  private onScroll = () => this.schedule();

  constructor(private o: VirtualListOptions) {
    o.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(o.scroller);
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.update();
    });
  }

  /** Re-renders every visible row (data changed). */
  refresh(): void {
    for (const [, el] of this.rows) this.release(el);
    this.rows.clear();
    this.stale = true;
    this.update();
  }

  /** Rows were inserted or removed but kept their keys: moves the rows that stay, renders the new ones. */
  relayout(): void {
    this.stale = true;
    this.update();
  }

  private release(el: HTMLElement): void {
    el.remove();
    if (this.pool.length < 40) this.pool.push(el);
  }

  // ── geometry ──────────────────────────────────────────────────────────

  private uniform(): number {
    return this.o.rowHeight?.() ?? 0;
  }

  /** Recomputes the row offsets when needed; returns the total height. */
  private measure(n: number): number {
    const heightOf = this.o.heightOf;
    if (!heightOf) return n * this.uniform();
    if (this.stale || this.offsets.length !== n + 1) {
      const off = new Array<number>(n + 1);
      off[0] = 0;
      for (let i = 0; i < n; i++) off[i + 1] = off[i] + heightOf(i);
      this.offsets = off;
      this.stale = false;
    }
    return this.offsets[n];
  }

  private top(i: number): number {
    return this.o.heightOf ? this.offsets[i] : i * this.uniform();
  }

  private height(i: number): number {
    return this.o.heightOf ? this.offsets[i + 1] - this.offsets[i] : this.uniform();
  }

  /** Index of the row at `y` (clamped to the list). */
  private indexAt(y: number, n: number): number {
    if (!this.o.heightOf) {
      const h = this.uniform();
      return h ? Math.floor(y / h) : 0;
    }
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ── rendering ─────────────────────────────────────────────────────────

  update(): void {
    const { scroller, body, count, renderRow } = this.o;
    const n = count();
    const total = this.measure(n);
    body.style.height = `${total}px`;
    if (!n || !total) {
      for (const [, el] of this.rows) this.release(el);
      this.rows.clear();
      return;
    }
    // where the body sits inside the scroller's content
    const bodyTop = body.offsetTop;
    const over = this.o.overscanPx ?? 600;
    const first = Math.max(0, this.indexAt(scroller.scrollTop - bodyTop - over, n));
    const last = Math.min(n - 1, this.indexAt(scroller.scrollTop - bodyTop + scroller.clientHeight + over, n));
    const keyOf = this.o.keyOf ?? ((i: number) => i);

    const next = new Map<string | number, HTMLElement>();
    for (let i = first; i <= last; i++) {
      const k = keyOf(i);
      let el = this.rows.get(k);
      if (el) this.rows.delete(k);
      else {
        el = this.pool.pop() ?? document.createElement("div");
        el.className = this.o.rowClass ?? "vrow";
        renderRow(i, el);
        body.appendChild(el);
      }
      place(el, this.top(i), this.height(i));
      next.set(k, el);
    }
    for (const [, el] of this.rows) this.release(el);
    this.rows = next;
  }

  scrollToRow(i: number, align: "start" | "nearest" = "nearest"): void {
    this.reveal(i, i, align);
  }

  /**
   * Scrolls rows `first`..`last` into view with the least movement, never past `first`.
   * `inset` is covered space at the top of the scroller (sticky headers).
   */
  reveal(first: number, last: number, align: "start" | "nearest" = "nearest", opts: { inset?: number; smooth?: boolean } = {}): void {
    const { scroller, body } = this.o;
    this.measure(this.o.count());
    const inset = opts.inset ?? 0;
    const top = body.offsetTop + this.top(first) - inset;
    const bottom = body.offsetTop + this.top(last) + this.height(last);
    let y = scroller.scrollTop;
    if (align === "start" || top < y) y = top;
    else if (bottom > y + scroller.clientHeight) y = Math.min(top, bottom - scroller.clientHeight);
    if (y !== scroller.scrollTop) scroller.scrollTo({ top: y, behavior: opts.smooth ? "smooth" : "auto" });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.o.scroller.removeEventListener("scroll", this.onScroll);
    this.ro.disconnect();
    for (const [, el] of this.rows) el.remove();
    this.rows.clear();
    this.pool = [];
  }
}

function place(el: HTMLElement, y: number, h: number): void {
  const t = `translateY(${y}px)`;
  if (el.style.transform !== t) el.style.transform = t;
  const hh = `${h}px`;
  if (el.style.height !== hh) el.style.height = hh;
}
