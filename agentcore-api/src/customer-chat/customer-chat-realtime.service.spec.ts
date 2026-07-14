import { HttpException, HttpStatus } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { CustomerChatRealtimeService } from './customer-chat-realtime.service';

function createService(maxConnections = 10, maxPerScope = 10) {
  return new CustomerChatRealtimeService({
    get: jest.fn((key: string) => {
      if (key === 'CUSTOMER_CHAT_SSE_MAX_CONNECTIONS') return maxConnections;
      if (key === 'CUSTOMER_CHAT_SSE_MAX_CONNECTIONS_PER_SCOPE') {
        return maxPerScope;
      }
      return undefined;
    }),
  } as never);
}

describe('CustomerChatRealtimeService', () => {
  it('projects organizationId out of public conversation events', async () => {
    const service = createService();
    const events: MessageEvent[] = [];
    const subscription = service
      .streamPublicConversation('conversation-a')
      .subscribe((event) => events.push(event));

    await service.publish({
      type: 'message.created',
      conversationId: 'conversation-a',
      organizationId: 'org-secret',
    });

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({ conversationId: 'conversation-a' }),
    );
    expect(events[0].data).not.toHaveProperty('organizationId');
    subscription.unsubscribe();
    await service.onModuleDestroy();
  });

  it('caps active streams and releases capacity on unsubscribe', () => {
    const service = createService(1, 1);
    const first = service.streamConversation('conversation-a').subscribe();
    let error: unknown;
    service.streamConversation('conversation-b').subscribe({
      error: (received: unknown) => {
        error = received;
      },
    });
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    first.unsubscribe();
    const replacement = service
      .streamConversation('conversation-b')
      .subscribe();
    expect(replacement.closed).toBe(false);
    replacement.unsubscribe();
  });
});
