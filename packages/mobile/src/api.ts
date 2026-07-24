// Relay client — one WebSocket carries RPC (request/reply by id) and the
// daemon's event stream. Mirrors the desktop's daemon surface; same payload
// shapes (SQLite rows).

export interface SpawnEvent {
  type: string;
  payload: any;
}

type EventHandler = (ev: SpawnEvent) => void;
type StatusHandler = (status: "connecting" | "ready" | "daemon-offline" | "closed" | "unauthorized") => void;

interface Outgoing {
  id: string;
  method: string;
  args: any[];
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT = 30_000;

export class RelayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // Calls made before the socket opens wait here and flush on open — screens
  // can fire their mount fetches without racing the connect handshake.
  private outbox: Outgoing[] = [];
  private eventHandlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private closed = false;
  private attempts = 0;

  constructor(
    private url: string,
    private token: string
  ) {}

  connect() {
    this.closed = false;
    this.emitStatus("connecting");
    const base = this.url.replace(/\/$/, "").replace(/^http/, "ws");
    this.ws = new WebSocket(`${base}/client?token=${encodeURIComponent(this.token)}`);
    this.ws.onopen = () => {
      this.attempts = 0;
      const queued = this.outbox.splice(0);
      for (const o of queued) this.ws?.send(JSON.stringify({ id: o.id, method: o.method, args: o.args }));
    };
    this.ws.onmessage = (e) => {
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.relay === "ready") this.emitStatus("ready");
      else if (msg.relay === "daemon-offline") this.emitStatus("daemon-offline");
      else if (msg.event) this.eventHandlers.forEach((h) => h(msg.event));
      else if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error ?? "rpc failed"));
        }
      }
    };
    this.ws.onclose = (ev?: { code?: number }) => {
      this.pending.forEach((p) => p.reject(new Error("connection closed")));
      this.pending.clear();
      this.outbox.forEach((o) => clearTimeout(o.timer));
      this.outbox = [];
      // 4001 = relay rejected the token (bad/expired). Don't retry — the app
      // clears the stored token and sends the user back to the login screen.
      if (ev?.code === 4001) {
        this.closed = true;
        this.emitStatus("unauthorized");
        return;
      }
      if (!this.closed) {
        this.emitStatus("connecting");
        // Exponential backoff with jitter, capped at 15s, so a dead relay
        // doesn't get hammered while the app sits in the foreground.
        const delay = Math.min(15_000, 1000 * 2 ** this.attempts++) + Math.random() * 400;
        setTimeout(() => this.connect(), delay);
      } else {
        this.emitStatus("closed");
      }
    };
    this.ws.onerror = () => this.ws?.close();
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  rpc<T = any>(method: string, ...args: any[]): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("not connected"));
        return;
      }
      const id = `m${this.nextId++}`;
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.outbox = this.outbox.filter((o) => o.id !== id);
        if (this.pending.delete(id)) reject(new Error("timeout"));
      }, RPC_TIMEOUT);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ id, method, args }));
      } else {
        this.outbox.push({ id, method, args, timer });
      }
    });
  }

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  onStatus(h: StatusHandler): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  private emitStatus(s: Parameters<StatusHandler>[0]) {
    this.statusHandlers.forEach((h) => h(s));
  }
}
