import {
  HttpException,
  HttpStatus,
  Injectable,
  MessageEvent,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VoiceReceptionistConfig } from '@prisma/client';
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
  configId: string;
  organizationId: string;
  providerCallId: string;
  connectedAt: Date;
  lastEventAt: Date;
  sendText: (content: string, language?: string) => void;
};

@Injectable()
export class VoiceRuntimeService {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly listeners = new Map<
    string,
    Set<(event: VoiceRuntimeEvent) => void>
  >();
  private readonly maxConnections: number;

  constructor(configService: ConfigService) {
    this.maxConnections = configService.get<number>(
      'VOICE_SSE_MAX_CONNECTIONS',
      250,
    );
  }

  registerSession(
    config: VoiceReceptionistConfig,
    providerCallId: string,
    sendText: RuntimeSession['sendText'],
  ): void {
    this.sessions.set(providerCallId, {
      configId: config.id,
      organizationId: config.organizationId,
      providerCallId,
      connectedAt: new Date(),
      lastEventAt: new Date(),
      sendText,
    });
    this.publish({
      type: 'session.connected',
      organizationId: config.organizationId,
      providerCallId,
    });
  }

  unregisterSession(providerCallId?: string): void {
    if (!providerCallId) return;
    const session = this.sessions.get(providerCallId);
    if (!session) return;
    this.sessions.delete(providerCallId);
    this.publish({
      type: 'session.disconnected',
      organizationId: session.organizationId,
      providerCallId,
    });
  }

  touch(providerCallId: string): void {
    const session = this.sessions.get(providerCallId);
    if (session) session.lastEventAt = new Date();
  }

  sendText(
    providerCallId: string,
    content: string,
    language?: string,
  ): boolean {
    const session = this.sessions.get(providerCallId);
    if (!session) return false;
    session.sendText(content, language);
    session.lastEventAt = new Date();
    return true;
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
    const complete = { ...event, occurredAt: new Date().toISOString() };
    for (const listener of this.listeners.get(event.organizationId) ?? []) {
      listener(complete);
    }
  }
}
