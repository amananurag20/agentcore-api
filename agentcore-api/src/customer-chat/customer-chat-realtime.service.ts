import { Injectable, MessageEvent, OnModuleDestroy } from '@nestjs/common';
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

@Injectable()
export class CustomerChatRealtimeService implements OnModuleDestroy {
  private readonly channel: string;
  private readonly instanceId = randomUUID();
  private readonly listeners = new Set<
    (event: CustomerChatRealtimeEvent) => void
  >();
  private readonly publisher: Redis | null;
  private readonly subscriber: Redis | null;

  constructor(configService: ConfigService) {
    const redisUrl = configService.get<string>('REDIS_URL');
    const prefix = configService.get<string>('QUEUE_PREFIX') ?? 'agentcore';
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
      (event) => event.conversationId === conversationId,
    );
  }

  streamOrganization(organizationId: string): Observable<MessageEvent> {
    return this.createStream(
      (event) => event.organizationId === organizationId,
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
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private createStream(
    accepts: (event: CustomerChatRealtimeEvent) => boolean,
  ): Observable<MessageEvent> {
    const events = new Observable<MessageEvent>((subscriber) => {
      const listener = (event: CustomerChatRealtimeEvent) => {
        if (accepts(event)) {
          subscriber.next({ type: event.type, data: event });
        }
      };
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
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
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
