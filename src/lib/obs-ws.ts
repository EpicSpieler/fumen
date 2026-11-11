/* obs-ws.ts — talking to OBS through obs-websocket 5 (built into OBS 28 and later): the handshake
 * with its password, requests and their answers, the events Fumen listens to (scenes, the replay
 * buffer, the recording). What Fumen does with it is in views/obs-control.ts. */
import { Emitter } from "./emitter";

export type ObsLinkState =
  | { kind: "off" }
  | { kind: "connecting" }
  /** connected; OBS's own version once known */
  | { kind: "on"; version: string }
  /** OBS wants a password, or the one kept is wrong */
  | { kind: "password" }
  /** nothing answers there: OBS closed, or its websocket server is off */
  | { kind: "away" };

export interface ObsEvent {
  type: string;
  data: Record<string, unknown>;
}

const OP = { hello: 0, identify: 1, identified: 2, event: 5, request: 6, response: 7 } as const;
/** what Fumen hears of: scenes (1 << 2) and outputs, the replay buffer and recording (1 << 6) */
export const EVENTS = (1 << 2) | (1 << 6);
/** obs-websocket closes with this when the password is wrong */
const AUTH_FAILED = 4009;
/** ms between looks for OBS while it isn't there */
const RETRY = 5000;
/** ms OBS gets to answer a request */
const ANSWER = 5000;

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let s = "";
  for (const b of new Uint8Array(d)) s += String.fromCharCode(b);
  return btoa(s);
}

/** obs-websocket's answer to its challenge: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export async function authAnswer(password: string, salt: string, challenge: string): Promise<string> {
  return sha256((await sha256(password + salt)) + challenge);
}

/** The message that says who Fumen is and what it wants to hear. */
export function identify(auth: string | null): { op: number; d: Record<string, unknown> } {
  return { op: OP.identify, d: { rpcVersion: 1, eventSubscriptions: EVENTS, ...(auth ? { authentication: auth } : {}) } };
}

export class ObsSocket {
  readonly bus = new Emitter<{ state: ObsLinkState; event: ObsEvent }>();
  state: ObsLinkState = { kind: "off" };
  private url: string | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private n = 0;
  private pending = new Map<string, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void; timer: number }>();

  constructor(private readonly password: () => Promise<string | null>) {}

  /** Talks to OBS at `url` (again: the password changed); null stops. */
  use(url: string | null): void {
    clearTimeout(this.retry);
    this.url = url;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.flush();
    if (!url) return this.set({ kind: "off" });
    this.open();
  }

  get on(): boolean {
    return this.state.kind === "on";
  }

  /** One of obs-websocket's requests; its answer's data. */
  request<T = Record<string, unknown>>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || !this.on) return Promise.reject(new Error("OBS isn't connected"));
    const id = `fumen-${++this.n}`;
    return new Promise<T>((ok, fail) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        fail(new Error("OBS didn't answer"));
      }, ANSWER);
      this.pending.set(id, { ok: ok as (v: Record<string, unknown>) => void, fail, timer });
      ws.send(JSON.stringify({ op: OP.request, d: { requestType: type, requestId: id, requestData: data } }));
    });
  }

  private set(s: ObsLinkState): void {
    if (JSON.stringify(s) === JSON.stringify(this.state)) return;
    this.state = s;
    this.bus.emit("state", s);
  }

  private flush(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.fail(new Error("OBS went"));
    }
    this.pending.clear();
  }

  private open(): void {
    const url = this.url;
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.set({ kind: "away" });
      this.retry = window.setTimeout(() => this.open(), RETRY);
      return;
    }
    this.ws = ws;
    if (this.state.kind !== "away" && this.state.kind !== "password") this.set({ kind: "connecting" });
    ws.onmessage = (e) => void this.read(ws, e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.flush();
      if (e.code === AUTH_FAILED) {
        // the same password won't do better: until another is given
        this.set({ kind: "password" });
        return;
      }
      if (this.state.kind !== "password") this.set({ kind: "away" });
      this.retry = window.setTimeout(() => this.open(), RETRY);
    };
  }

  private async read(ws: WebSocket, raw: unknown): Promise<void> {
    let msg: { op?: number; d?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const d = msg.d ?? {};
    if (msg.op === OP.hello) {
      const auth = d.authentication as { salt: string; challenge: string } | undefined;
      let answer: string | null = null;
      if (auth) {
        const pw = await this.password();
        if (this.ws !== ws) return;
        if (!pw) {
          this.set({ kind: "password" });
          this.ws = null;
          ws.close();
          return;
        }
        answer = await authAnswer(pw, auth.salt, auth.challenge);
      }
      if (this.ws === ws) ws.send(JSON.stringify(identify(answer)));
    } else if (msg.op === OP.identified) {
      this.set({ kind: "on", version: "" });
      void this.request<{ obsVersion?: string }>("GetVersion")
        .then((v) => {
          if (this.ws === ws && this.on) this.set({ kind: "on", version: v.obsVersion ?? "" });
        })
        .catch(() => {});
    } else if (msg.op === OP.event) {
      this.bus.emit("event", { type: String(d.eventType ?? ""), data: (d.eventData as Record<string, unknown>) ?? {} });
    } else if (msg.op === OP.response) {
      const p = this.pending.get(String(d.requestId));
      if (!p) return;
      this.pending.delete(String(d.requestId));
      clearTimeout(p.timer);
      const status = (d.requestStatus ?? {}) as { result?: boolean; code?: number; comment?: string };
      if (status.result) p.ok((d.responseData as Record<string, unknown>) ?? {});
      else p.fail(new Error(status.comment || `OBS said no (${status.code ?? "?"})`));
    }
  }
}
