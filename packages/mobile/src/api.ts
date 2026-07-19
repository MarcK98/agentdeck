// Relay client — one WebSocket carries RPC (request/reply by id) and the
// daemon's event stream. Mirrors the desktop's daemon surface; same payload
// shapes (SQLite rows).

export interface SpawnEvent {
  type: string;
  payload: any;
}

type EventHandler = (ev: SpawnEvent) => void;
type StatusHandler = (status: "connecting" | "ready" | "daemon-offline" | "closed" | "unauthorized") => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private closed = false;

  constructor(
    private url: string,
    private token: string
  ) {}

  connect() {
    this.closed = false;
    this.emitStatus("connecting");
    const base = this.url.replace(/\/$/, "").replace(/^http/, "ws");
    this.ws = new WebSocket(`${base}/client?token=${encodeURIComponent(this.token)}`);
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
      // 4001 = relay rejected the token (bad/expired). Don't retry — the app
      // clears the stored token and sends the user back to the login screen.
      if (ev?.code === 4001) {
        this.closed = true;
        this.emitStatus("unauthorized");
        return;
      }
      if (!this.closed) {
        this.emitStatus("connecting");
        setTimeout(() => this.connect(), 1500);
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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }
      const id = `m${this.nextId++}`;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, args }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("timeout"));
      }, 30_000);
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
