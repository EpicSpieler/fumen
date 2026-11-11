/* emitter.ts — a tiny typed event bus (re-exported by store.ts), on its own so pure modules can
 * use it without the app's state. */
type Handler<T> = (payload: T) => void;

export class Emitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Set<Handler<E[K]>> } = {};

  on<K extends keyof E>(evt: K, fn: Handler<E[K]>): () => void {
    (this.handlers[evt] ??= new Set()).add(fn);
    return () => this.handlers[evt]?.delete(fn);
  }

  emit<K extends keyof E>(evt: K, payload: E[K]): void {
    this.handlers[evt]?.forEach((fn) => fn(payload));
  }
}
