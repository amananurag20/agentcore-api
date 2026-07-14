import {
  HttpException,
  HttpStatus,
  Injectable,
  MessageEvent,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

export type CustomerChatRealtimeEvent = {
  type:
    | 'conversation.created'
    | 'conversation.updated'
    | 'message.created'
    | 'handoff.requested';
  conversationId: string;
  organizationId: string;
  occurredAt: string;
};

export type PublicCustomerChatRealtimeEvent = Omit<
  CustomerChatRealtimeEvent,
  'organizationId'
>;

type RealtimeListener = (event: CustomerChatRealtimeEvent) => void;

@Injectable()
export class CustomerChatRealtimeService implements OnModuleDestroy {
  private readonly channel: string;
  private readonly instanceId = randomUUID();
  private readonly conversationListeners = new Map<
    string,
    Set<RealtimeListener>
  >();
  private readonly organizationListeners = new Map<
    string,
    Set<RealtimeListener>
  >();
  private readonly maxConnections: number;
  private readonly maxConnectionsPerScope: number;
  private activeConnections = 0;
  private readonly publisher: Redis | null;
  private readonly subscriber: Redis | null;

  constructor(configService: ConfigService) {
    const redisUrl = configService.get<string>('REDIS_URL');
    const prefix = configService.get<string>('QUEUE_PREFIX') ?? 'agentcore';
    this.maxConnections =
      configService.get<number>('CUSTOMER_CHAT_SSE_MAX_CONNECTIONS') ?? 1000;
    this.maxConnectionsPerScope =
      configService.get<number>(
        'CUSTOMER_CHAT_SSE_MAX_CONNECTIONS_PER_SCOPE',
      ) ?? 25;
    this.channel = `${prefix}:customer-chat:events`;
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
        const envelope = JSON.parse(raw) as {
          instanceId: string;
          event: CustomerChatRealtimeEvent;
        };
        if (envelope.instanceId !== this.instanceId) {
          this.dispatch(envelope.event);
        }
      } catch {
        // Ignore malformed pub/sub messages from outside this service.
      }
    });
    void this.subscriber?.subscribe(this.channel).catch(() => undefined);
  }

  streamConversation(conversationId: string): Observable<MessageEvent> {
    return this.createStream(
      this.conversationListeners,
      conversationId,
      (event) => event,
    );
  }

  streamPublicConversation(conversationId: string): Observable<MessageEvent> {
    return this.createStream(
      this.conversationListeners,
      conversationId,
      (event) => ({
        type: event.type,
        conversationId: event.conversationId,
        occurredAt: event.occurredAt,
      }),
    );
  }

  streamOrganization(organizationId: string): Observable<MessageEvent> {
    return this.createStream(
      this.organizationListeners,
      organizationId,
      (event) => event,
    );
  }

  async publish(
    event: Omit<CustomerChatRealtimeEvent, 'occurredAt'>,
  ): Promise<void> {
    const completeEvent: CustomerChatRealtimeEvent = {
      ...event,
      occurredAt: new Date().toISOString(),
    };
    this.dispatch(completeEvent);
    if (this.publisher) {
      await this.publisher
        .publish(
          this.channel,
          JSON.stringify({ instanceId: this.instanceId, event: completeEvent }),
        )
        .catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    this.conversationListeners.clear();
    this.organizationListeners.clear();
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private createStream(
    listenerMap: Map<string, Set<RealtimeListener>>,
    scopeId: string,
    project: (
      event: CustomerChatRealtimeEvent,
    ) => CustomerChatRealtimeEvent | PublicCustomerChatRealtimeEvent,
  ): Observable<MessageEvent> {
    const events = new Observable<MessageEvent>((subscriber) => {
      const listeners = listenerMap.get(scopeId) ?? new Set<RealtimeListener>();
      if (
        this.activeConnections >= this.maxConnections ||
        listeners.size >= this.maxConnectionsPerScope
      ) {
        subscriber.error(
          new HttpException(
            'Too many active customer chat event streams',
            HttpStatus.TOO_MANY_REQUESTS,
          ),
        );
        return;
      }

      const listener = (event: CustomerChatRealtimeEvent) => {
        subscriber.next({ type: event.type, data: project(event) });
      };
      listeners.add(listener);
      listenerMap.set(scopeId, listeners);
      this.activeConnections += 1;

      return () => {
        listeners.delete(listener);
        this.activeConnections = Math.max(0, this.activeConnections - 1);
        if (listeners.size === 0) listenerMap.delete(scopeId);
      };
    });
    const heartbeat = interval(25000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: { at: new Date().toISOString() },
      })),
    );
    return merge(events, heartbeat);
  }

  private dispatch(event: CustomerChatRealtimeEvent) {
    const listeners = [
      ...(this.conversationListeners.get(event.conversationId) ?? []),
      ...(this.organizationListeners.get(event.organizationId) ?? []),
    ];
    for (const listener of listeners) {
      listener(event);
    }
  }
}
