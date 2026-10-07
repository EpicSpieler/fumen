/* virtual.ts — windowed rendering for long uniform-height row lists.
 *
 * Only rows inside the viewport (+ overscan) exist in the DOM. Row elements are keyed by row
 * index and kept while visible, so images don't reload while scrolling; a row is only re-rendered
 * when it enters the window or `refresh()` is called.
 */

export interface VirtualListOptions {
  /** the scrolling element */
  scroller: HTMLElement;
  /** positioned container inside the scroller that receives the rows */
  body: HTMLElement;
  count: () => number;
  rowHeight: () => number;
  renderRow: (index: number, el: HTMLElement) => void;
  rowClass?: string;
  /** extra px rendered above/below the viewport */
  overscanPx?: number;
}

export class VirtualList {
  private rows = new Map<number, HTMLElement>();
  private pool: HTMLElement[] = [];
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
    this.update();
  }

  private release(el: HTMLElement): void {
    el.remove();
    if (this.pool.length < 40) this.pool.push(el);
  }

  update(): void {
    const { scroller, body, count, rowHeight, renderRow } = this.o;
    const n = count();
    const h = rowHeight();
    body.style.height = `${n * h}px`;
    if (!n || !h) {
      for (const [, el] of this.rows) this.release(el);
      this.rows.clear();
      return;
    }
    // where the body sits inside the scroller's content
    const bodyTop = body.offsetTop;
    const over = this.o.overscanPx ?? 600;
    const top = scroller.scrollTop - bodyTop - over;
    const bottom = scroller.scrollTop - bodyTop + scroller.clientHeight + over;
    const first = Math.max(0, Math.floor(top / h));
    const last = Math.min(n - 1, Math.floor(bottom / h));

    for (const [i, el] of this.rows) {
      if (i < first || i > last) {
        this.release(el);
        this.rows.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const el = this.pool.pop() ?? document.createElement("div");
      el.className = this.o.rowClass ?? "vrow";
      el.style.transform = `translateY(${i * h}px)`;
      el.style.height = `${h}px`;
      renderRow(i, el);
      body.appendChild(el);
      this.rows.set(i, el);
    }
  }

  scrollToRow(i: number, align: "start" | "nearest" = "nearest"): void {
    const h = this.o.rowHeight();
    const { scroller, body } = this.o;
    const y = body.offsetTop + i * h;
    if (align === "start") scroller.scrollTop = y;
    else if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + h - scroller.clientHeight;
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
