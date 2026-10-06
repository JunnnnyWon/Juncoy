// Discord Gateway 실시간 수신기 — spec §6.3/P3.
// REST 수집기와 같은 프로세스에서만 실행해 canonical 이벤트 작성자를 하나로 유지한다.
// uncached UPDATE는 항상 REST로 재조회(hydrate)하고, seq gap/재연결은 head 대조로 복구한다.

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalid: 9, hello: 10, ack: 11 };
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

interface GatewayPacket {
  op: number;
  t?: string;
  s?: number | null;
  d?: any;
}

export interface GatewayEvents {
  /** READY/RESUMED 이후 디스패치. type은 DISCORD 이벤트명. */
  onDispatch(type: string, data: any): Promise<void> | void;
  /** seq 역행/유실·resume 실패 등 — 호출자가 head 대조로 복구. */
  onResyncNeeded(reason: string): Promise<void> | void;
  onStateChange?(state: 'connecting' | 'ready' | 'resumed' | 'closed', detail?: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DiscordGateway {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private stopped = false;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly intents: number,
    private readonly events: GatewayEvents,
  ) {}

  private send(p: GatewayPacket) {
    try {
      this.ws?.send(JSON.stringify(p));
    } catch {
      /* zombie */
    }
  }

  private heartbeatLoop(interval: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.acked) {
        // zombie 연결 — ACK 유실 시 재연결 후 resume (§6.3 resume 우선)
        this.ws?.close(4000, 'zombie');
        return;
      }
      this.acked = false;
      this.send({ op: OP.heartbeat, d: this.seq });
    }, interval);
    // 첫 하트비트는 jitter — Discord 요구사항
    setTimeout(() => {
      if (this.ws && this.acked) {
        this.acked = false;
        this.send({ op: OP.heartbeat, d: this.seq });
      }
    }, Math.random() * interval);
  }

  private async onPacket(raw: WebSocket | any) {
    const p: GatewayPacket = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    if (p.s != null) {
      if (this.seq != null && p.s <= this.seq)
        await this.events.onResyncNeeded(`seq regression ${p.s}<=${this.seq}`);
      this.seq = p.s;
    }
    switch (p.op) {
      case OP.hello:
        this.acked = true;
        this.heartbeatLoop(p.d.heartbeat_interval);
        if (this.sessionId && this.seq != null)
          this.send({
            op: OP.resume,
            d: { token: this.token, session_id: this.sessionId, seq: this.seq },
          });
        else
          this.send({
            op: OP.identify,
            d: {
              token: this.token,
              intents: this.intents,
              properties: { os: 'linux', browser: 'juncoy-knowledge', device: 'juncoy-knowledge' },
            },
          });
        break;
      case OP.ack:
        this.acked = true;
        break;
      case OP.reconnect:
        this.ws?.close(4000, 'reconnect requested');
        break;
      case OP.invalid:
        if (p.d === true) {
          this.send({
            op: OP.resume,
            d: { token: this.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.sessionId = null;
          this.seq = null;
          await this.events.onResyncNeeded('invalid_session');
          this.send({
            op: OP.identify,
            d: {
              token: this.token,
              intents: this.intents,
              properties: { os: 'linux', browser: 'juncoy-knowledge', device: 'juncoy-knowledge' },
            },
          });
        }
        break;
      case OP.dispatch: {
        const { t, d } = p;
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
          this.events.onStateChange?.('ready', `session ${this.sessionId}`);
        } else if (t === 'RESUMED') {
          this.events.onStateChange?.('resumed');
        }
        if (t) await this.events.onDispatch(t, d);
        break;
      }
    }
  }

  /** 영구 루프 — fatal(토큰/권한)만 throw, 그 외는 백오프 재연결. */
  async run() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        const msg = (e as Error).message;
        if (msg.startsWith('fatal')) throw e;
        this.events.onStateChange?.('closed', msg);
        await this.events.onResyncNeeded(`reconnect:${msg}`);
        await sleep(backoff + Math.random() * 500);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private connectOnce() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const url = this.sessionId && this.resumeUrl ? this.resumeUrl : GATEWAY;
      const ws = new WebSocket(`${url}?v=10&encoding=json`);
      this.ws = ws;
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
      });
      ws.onmessage = (ev) => void this.onPacket(ev.data).catch(() => {});
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('ws error'));
        setTimeout(() => reject(new Error('connect timeout')), 15_000);
      });
      const c = await closed;
      ws.onmessage = null;
      ws.onclose = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (FATAL_CLOSE.has(c.code)) throw new Error(`fatal close ${c.code}: ${c.reason}`);
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close(1000, 'shutdown');
  }
}
