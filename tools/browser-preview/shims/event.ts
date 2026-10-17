/* Browser-preview stand-in for @tauri-apps/api/event. */
export type UnlistenFn = () => void;

const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();

export async function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  const set = handlers.get(event) ?? new Set();
  handlers.set(event, set);
  const fn = cb as (e: { payload: unknown }) => void;
  set.add(fn);
  return () => set.delete(fn);
}

export function emit(event: string, payload: unknown): void {
  handlers.get(event)?.forEach((fn) => fn({ payload }));
}

/** another window's events: the preview has one window, so they arrive here */
export async function emitTo(_target: string, event: string, payload?: unknown): Promise<void> {
  emit(event, payload);
}
