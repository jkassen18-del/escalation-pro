import crypto from 'node:crypto';
import { acquireLease } from '../ops/lease.ts';
import { loadIntegration, setIntegrationStatus } from './store.ts';
import { discordApi, GATEWAY_INTENTS, isDiscordConfigured, readDiscordConfig, type DiscordConfig } from './discord.ts';

/**
 * The Discord Gateway: one outbound websocket that carries every message and
 * button click from Discord to this server.
 *
 * Interactions arrive here too, because the application has no Interactions
 * Endpoint URL - which is the point: nothing on the internet needs to reach
 * this server for Discord to work.
 *
 * One connection per deployment. Every instance runs the supervisor, and only
 * the holder of the `discord-gateway` lease connects; another instance takes
 * over within a minute if it stops.
 */

const OP = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 } as const;

/** Close codes Discord documents as "do not reconnect": the configuration is wrong. */
const FATAL_CLOSE_CODES: Record<number, string> = {
  4004: 'Discord rejected the bot token. Reset it in the Developer Portal and save the new one.',
  4010: 'Discord reported an invalid shard.',
  4011: 'This bot is in too many servers for a single connection (sharding required).',
  4012: 'Discord rejected the gateway API version.',
  4013: 'Discord rejected the requested intents.',
  4014: 'Turn on "Message Content Intent" under Bot → Privileged Gateway Intents in the Discord Developer Portal, then save here again.',
};
/** Close codes after which the session cannot be resumed and a fresh identify is needed. */
const RESET_SESSION_CODES = new Set([4007, 4009]);

export interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export type DispatchHandler = (event: string, data: unknown, gateway: DiscordGateway) => Promise<void> | void;

export interface GatewayOptions {
  token: string;
  /** Called for every dispatch (op 0) event. Errors are logged, never fatal. */
  onDispatch: DispatchHandler;
  /** A configuration problem Discord will not accept a retry for. */
  onFatal: (message: string) => void;
  onReady?: (data: { session_id: string; user: { id: string; username: string }; guilds?: Array<{ id: string }> }) => void;
  /** The gateway URL to start from; resolved with GET /gateway/bot when omitted. */
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

export class DiscordGateway {
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private awaitingAck = false;
  private attempts = 0;
  private stopped = false;
  botUserId: string | null = null;
  connected = false;

  constructor(private readonly options: GatewayOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.open(false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      // 1000 ends the session; nothing will resume it.
      this.socket?.close(1000, 'stopping');
    } catch {
      // already closed
    }
    this.socket = null;
    this.connected = false;
  }

  private clearTimers() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private send(payload: GatewayPayload) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  private async open(resume: boolean): Promise<void> {
    if (this.stopped) return;
    let base = resume && this.resumeUrl ? this.resumeUrl : this.options.url;
    if (!base) {
      const info = await discordApi<{ url: string }>(this.options.token, 'GET', '/gateway/bot');
      base = info.url;
    }
    const url = `${base.replace(/\/?$/, '/')}?v=10&encoding=json`;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(url);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String((event as MessageEvent).data));
      } catch {
        return;
      }
      void this.handle(payload, resume);
    });
    socket.addEventListener('close', (event) => this.onClose((event as CloseEvent).code, socket));
    socket.addEventListener('error', () => {
      // A close follows every error, and that is where reconnection happens.
    });
  }

  private async handle(payload: GatewayPayload, resuming: boolean): Promise<void> {
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case OP.hello: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(interval);
        if (resuming && this.sessionId) {
          this.send({ op: OP.resume, d: { token: this.options.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send({
            op: OP.identify,
            d: { token: this.options.token, intents: GATEWAY_INTENTS, properties: { os: process.platform, browser: 'infraticket', device: 'infraticket' } },
          });
        }
        return;
      }
      case OP.heartbeatAck:
        this.awaitingAck = false;
        return;
      case OP.heartbeat:
        this.send({ op: OP.heartbeat, d: this.seq });
        return;
      case OP.reconnect:
        this.reconnectSoon(true);
        return;
      case OP.invalidSession: {
        const resumable = Boolean(payload.d);
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
        }
        // Discord asks for a random 1-5s pause before identifying again.
        this.reconnectSoon(resumable, 1000 + Math.random() * 4000);
        return;
      }
      case OP.dispatch: {
        if (payload.t === 'READY') {
          const ready = payload.d as { session_id: string; resume_gateway_url: string; user: { id: string; username: string }; guilds?: Array<{ id: string }> };
          this.sessionId = ready.session_id;
          this.resumeUrl = ready.resume_gateway_url;
          this.botUserId = ready.user.id;
          this.connected = true;
          this.attempts = 0;
          this.options.onReady?.(ready);
        }
        if (payload.t === 'RESUMED') {
          this.connected = true;
          this.attempts = 0;
        }
        try {
          await this.options.onDispatch(payload.t ?? '', payload.d, this);
        } catch (error) {
          console.error(`[discord] handling ${payload.t} failed`, error);
        }
        return;
      }
    }
  }

  private startHeartbeat(interval: number) {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.awaitingAck = false;
    const beat = () => {
      if (this.awaitingAck) {
        // No ACK since the last beat: the connection is a zombie. Close with a
        // non-1000 code so the session can be resumed on the new one.
        this.reconnectSoon(true);
        return;
      }
      this.awaitingAck = true;
      this.send({ op: OP.heartbeat, d: this.seq });
      this.heartbeatTimer = setTimeout(beat, interval);
    };
    // The first beat is jittered, as Discord asks, so a fleet does not beat in step.
    this.heartbeatTimer = setTimeout(beat, interval * Math.random());
  }

  /** Drop this socket and open another, resuming the session when that is allowed. */
  private reconnectSoon(resume: boolean, delayMs = 0) {
    const socket = this.socket;
    this.clearTimers();
    this.socket = null;
    this.connected = false;
    try {
      socket?.close(4000, 'reconnecting');
    } catch {
      // already gone
    }
    this.scheduleOpen(resume, delayMs);
  }

  private scheduleOpen(resume: boolean, delayMs: number) {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      void this.open(resume).catch((error) => {
        console.warn('[discord] could not reconnect', (error as Error).message);
        this.backoff(resume);
      });
    }, delayMs);
  }

  private backoff(resume: boolean) {
    this.attempts += 1;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts, 6)) * (0.5 + Math.random() / 2);
    this.scheduleOpen(resume, delay);
  }

  private onClose(code: number, socket: WebSocket) {
    // A socket we already replaced or stopped has nothing more to say.
    if (socket !== this.socket) return;
    this.clearTimers();
    this.socket = null;
    this.connected = false;
    if (this.stopped) return;

    const fatal = FATAL_CLOSE_CODES[code];
    if (fatal) {
      this.stopped = true;
      this.options.onFatal(`${fatal} (Discord close code ${code})`);
      return;
    }
    if (RESET_SESSION_CODES.has(code)) {
      this.sessionId = null;
      this.seq = null;
    }
    this.backoff(Boolean(this.sessionId));
  }
}

/* ------------------------------- Supervisor ------------------------------- */

const LEASE_MS = 60_000;
const SUPERVISE_MS = Number(process.env.DISCORD_SUPERVISE_MS || 20_000);

let current: { gateway: DiscordGateway; fingerprint: string } | null = null;
/** The configuration that last failed fatally: not retried until it changes. */
let fatalFingerprint: string | null = null;
let supervising: Promise<void> | null = null;
let dispatchHandler: DispatchHandler | null = null;

function fingerprintOf(config: DiscordConfig): string {
  return crypto.createHash('sha256').update(`${config.applicationId}:${config.botToken}`).digest('hex');
}

/** Whether this instance currently holds the Discord connection. */
export function discordGatewayStatus(): { running: boolean; connected: boolean; botUserId: string | null } {
  return { running: Boolean(current), connected: Boolean(current?.gateway.connected), botUserId: current?.gateway.botUserId ?? null };
}

export function currentGateway(): DiscordGateway | null {
  return current?.gateway ?? null;
}

async function supervise(options: { url?: string; WebSocketImpl?: typeof WebSocket }): Promise<void> {
  const record = await loadIntegration('discord');
  const config = readDiscordConfig(record);
  const wanted = record.enabled && isDiscordConfigured(config);
  const fingerprint = wanted ? fingerprintOf(config) : '';

  if (!wanted || fingerprint === fatalFingerprint) {
    if (current) {
      current.gateway.stop();
      current = null;
    }
    return;
  }
  if (current && current.fingerprint !== fingerprint) {
    current.gateway.stop();
    current = null;
  }

  const leader = await acquireLease('discord-gateway', LEASE_MS);
  if (!leader) {
    if (current) {
      current.gateway.stop();
      current = null;
    }
    return;
  }
  if (current) return;

  const gateway = new DiscordGateway({
    token: config.botToken!,
    url: options.url,
    WebSocketImpl: options.WebSocketImpl,
    onDispatch: (event, data, gw) => dispatchHandler?.(event, data, gw),
    onFatal: (message) => {
      fatalFingerprint = fingerprint;
      if (current?.gateway === gateway) current = null;
      console.error(`[discord] ${message}`);
      void setIntegrationStatus('discord', 'error', message, { stampCheckedAt: true }).catch(() => undefined);
    },
  });
  current = { gateway, fingerprint };
  await gateway.start().catch((error) => {
    console.warn('[discord] could not connect', (error as Error).message);
    if (current?.gateway === gateway) {
      gateway.stop();
      current = null;
    }
  });
}

/** Runs one supervision pass now (after a settings change), never two at once. */
export function refreshDiscordGateway(options: { url?: string; WebSocketImpl?: typeof WebSocket } = {}): Promise<void> {
  if (!supervising) {
    // A saved configuration deserves a fresh attempt even if the last one was fatal.
    fatalFingerprint = null;
    supervising = supervise(options)
      .catch((error) => console.error('[discord] supervisor failed', error))
      .finally(() => {
        supervising = null;
      });
  }
  return supervising;
}

/**
 * Starts the supervisor loop. `handler` receives every dispatch event; it is
 * passed in rather than imported to keep this module free of ticket logic.
 */
export function startDiscordGateway(handler: DispatchHandler, options: { url?: string; WebSocketImpl?: typeof WebSocket } = {}): () => void {
  dispatchHandler = handler;
  const tick = () => {
    if (supervising) return;
    supervising = supervise(options)
      .catch((error) => console.error('[discord] supervisor failed', error))
      .finally(() => {
        supervising = null;
      });
  };
  const initial = setTimeout(tick, 2000);
  const timer = setInterval(tick, SUPERVISE_MS);
  initial.unref();
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
    current?.gateway.stop();
    current = null;
  };
}
