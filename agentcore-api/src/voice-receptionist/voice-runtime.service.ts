import {
  HttpException,
  HttpStatus,
  Injectable,
  MessageEvent,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceReceptionistConfig } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

export type VoiceRuntimeEvent = {
  type: 'call.updated' | 'session.connected' | 'session.disconnected';
  organizationId: string;
  callId?: string;
  providerCallId?: string;
  occurredAt: string;
};

type RuntimeSession = {
  ownerId: string;
  configId: string;
  organizationId: string;
  providerCallId: string;
  connectedAt: Date;
  lastEventAt: Date;
  sendText: (content: string, language?: string) => void | Promise<void>;
  close: () => void;
};

type RuntimeEnvelope =
  | { instanceId: string; kind: 'event'; event: VoiceRuntimeEvent }
  | {
      instanceId: string;
      kind: 'speak';
      providerCallId: string;
      content: string;
      language?: string;
    };

@Injectable()
export class VoiceRuntimeService implements OnModuleDestroy {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly listeners = new Map<
    string,
    Set<(event: VoiceRuntimeEvent) => void>
  >();
  private readonly instanceId = randomUUID();
  private readonly maxConnections: number;
  private readonly channel: string;
  private readonly redisPrefix: string;
  private readonly wsMaxConnections: number;
  private readonly wsMaxPerConfig: number;
  private readonly wsSlotTtlMs: number;
  private readonly publisher: Redis | null;
  private readonly subscriber: Redis | null;

  constructor(configService: ConfigService) {
    this.maxConnections = configService.get<number>(
      'VOICE_SSE_MAX_CONNECTIONS',
      250,
    );
    const redisUrl = configService.get<string>('REDIS_URL');
    const prefix = configService.get<string>('QUEUE_PREFIX') ?? 'agentcore';
    this.redisPrefix = prefix;
    this.wsMaxConnections = configService.get<number>(
      'VOICE_WS_MAX_CONNECTIONS',
      250,
    );
    this.wsMaxPerConfig = configService.get<number>(
      'VOICE_WS_MAX_CONNECTIONS_PER_CONFIG',
      50,
    );
    this.wsSlotTtlMs =
      (configService.get<number>('VOICE_MAX_CALL_DURATION_SECONDS', 1800) +
        120) *
      1000;
    this.channel = `${prefix}:voice:runtime`;
    this.publisher = redisUrl
      ? new Redis(redisUrl, { maxRetriesPerRequest: 1 })
      : null;
    this.subscriber = redisUrl
      ? new Redis(redisUrl, { maxRetriesPerRequest: null })
      : null;
    this.publisher?.on('error', () => undefined);
    this.subscriber?.on('error', () => undefined);
    this.subscriber?.on('message', (_channel, raw) => {
      try {
        const envelope = JSON.parse(raw) as RuntimeEnvelope;
        if (envelope.instanceId === this.instanceId) return;
        if (envelope.kind === 'event') {
          this.dispatch(envelope.event);
          return;
        }
        const session = this.sessions.get(envelope.providerCallId);
        if (session) {
          void Promise.resolve(
            session.sendText(envelope.content, envelope.language),
          ).catch(() => undefined);
          session.lastEventAt = new Date();
        }
      } catch {
        // Ignore malformed messages on the shared pub/sub channel.
      }
    });
    void this.subscriber?.subscribe(this.channel).catch(() => undefined);
  }

  registerSession(
    config: VoiceReceptionistConfig,
    providerCallId: string,
    ownerId: string,
    sendText: RuntimeSession['sendText'],
    close: RuntimeSession['close'],
  ): void {
    const previous = this.sessions.get(providerCallId);
    this.sessions.set(providerCallId, {
      ownerId,
      configId: config.id,
      organizationId: config.organizationId,
      providerCallId,
      connectedAt: new Date(),
      lastEventAt: new Date(),
      sendText,
      close,
    });
    if (previous && previous.ownerId !== ownerId) previous.close();
    this.publish({
      type: 'session.connected',
      organizationId: config.organizationId,
      providerCallId,
    });
  }

  async acquireWebSocketSlot(
    configId: string,
    connectionId: string,
  ): Promise<boolean> {
    if (!this.publisher) return true;
    const globalKey = `${this.redisPrefix}:voice:ws:global`;
    const configKey = `${this.redisPrefix}:voice:ws:config:${configId}`;
    const now = Date.now();
    const result = await this.publisher
      .eval(
        "redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1]); redis.call('zremrangebyscore', KEYS[2], '-inf', ARGV[1]); if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[3]) or redis.call('zcard', KEYS[2]) >= tonumber(ARGV[4]) then return 0 end; redis.call('zadd', KEYS[1], ARGV[2], ARGV[5]); redis.call('zadd', KEYS[2], ARGV[2], ARGV[5]); redis.call('pexpire', KEYS[1], ARGV[6]); redis.call('pexpire', KEYS[2], ARGV[6]); return 1",
        2,
        globalKey,
        configKey,
        now,
        now + this.wsSlotTtlMs,
        this.wsMaxConnections,
        this.wsMaxPerConfig,
        connectionId,
        this.wsSlotTtlMs,
      )
      .catch(() => 0);
    return Number(result) === 1;
  }

  async releaseWebSocketSlot(
    configId: string,
    connectionId: string,
  ): Promise<void> {
    if (!this.publisher) return;
    await this.publisher
      .zrem(`${this.redisPrefix}:voice:ws:global`, connectionId)
      .catch(() => undefined);
    await this.publisher
      .zrem(`${this.redisPrefix}:voice:ws:config:${configId}`, connectionId)
      .catch(() => undefined);
  }

  unregisterSession(providerCallId?: string, ownerId?: string): void {
    if (!providerCallId || !ownerId) return;
    const session = this.sessions.get(providerCallId);
    if (!session || session.ownerId !== ownerId) return;
    this.sessions.delete(providerCallId);
    this.publish({
      type: 'session.disconnected',
      organizationId: session.organizationId,
      providerCallId,
    });
  }

  touch(providerCallId: string, ownerId: string): void {
    const session = this.sessions.get(providerCallId);
    if (session?.ownerId === ownerId) session.lastEventAt = new Date();
  }

  async sendText(
    providerCallId: string,
    content: string,
    language?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(providerCallId);
    if (session) {
      await session.sendText(content, language);
      session.lastEventAt = new Date();
      return true;
    }
    if (!this.publisher) return false;
    const subscribers = await this.publisher
      .publish(
        this.channel,
        JSON.stringify({
          instanceId: this.instanceId,
          kind: 'speak',
          providerCallId,
          content,
          language,
        } satisfies RuntimeEnvelope),
      )
      .catch(() => 0);
    return subscribers > 0;
  }

  getHealth(configId: string | undefined, organizationId: string) {
    const now = Date.now();
    const sessions = [...this.sessions.values()]
      .filter(
        (session) =>
          session.organizationId === organizationId &&
          (!configId || session.configId === configId),
      )
      .map((session) => ({
        configId: session.configId,
        providerCallId: session.providerCallId,
        connectedAt: session.connectedAt,
        lastEventAt: session.lastEventAt,
        ageSeconds: Math.floor((now - session.connectedAt.getTime()) / 1000),
      }));
    return {
      status: 'ok',
      transport: 'twilio-conversation-relay',
      activeSessions: sessions.length,
      scope: this.publisher
        ? 'current-replica (Redis routing enabled)'
        : 'single-replica',
      sessions,
      checkedAt: new Date(),
    };
  }

  streamOrganization(organizationId: string): Observable<MessageEvent> {
    const events = new Observable<MessageEvent>((subscriber) => {
      const listeners = this.listeners.get(organizationId) ?? new Set();
      const activeConnections = [...this.listeners.values()].reduce(
        (total, entries) => total + entries.size,
        0,
      );
      if (activeConnections >= this.maxConnections) {
        subscriber.error(
          new HttpException(
            'Too many active voice event streams',
            HttpStatus.TOO_MANY_REQUESTS,
          ),
        );
        return;
      }
      const listener = (event: VoiceRuntimeEvent) =>
        subscriber.next({ type: event.type, data: event });
      listeners.add(listener);
      this.listeners.set(organizationId, listeners);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) this.listeners.delete(organizationId);
      };
    });
    const heartbeat = interval(25_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      })),
    );
    return merge(events, heartbeat);
  }

  publish(event: Omit<VoiceRuntimeEvent, 'occurredAt'>): void {
    const complete: VoiceRuntimeEvent = {
      ...event,
      occurredAt: new Date().toISOString(),
    };
    this.dispatch(complete);
    void this.publisher
      ?.publish(
        this.channel,
        JSON.stringify({
          instanceId: this.instanceId,
          kind: 'event',
          event: complete,
        } satisfies RuntimeEnvelope),
      )
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.listeners.clear();
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private dispatch(event: VoiceRuntimeEvent): void {
    for (const listener of this.listeners.get(event.organizationId) ?? []) {
      listener(event);
    }
  }
}
