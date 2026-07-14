import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CustomerChatService } from './customer-chat.service';

describe('CustomerChatService automatic reply recovery', () => {
  it('returns a graceful reply and requests handoff when retrieval fails', async () => {
    let handoffStatus: string | undefined;
    let recordedAudit:
      { action: string; metadata: { reason: string } } | undefined;
    const now = new Date();
    const visitorMessage = {
      id: 'message-visitor',
      organizationId: 'org-a',
      conversationId: 'conversation-a',
      role: 'visitor',
      content: 'Can I book tomorrow?',
      metadata: {},
      createdAt: now,
      citations: [],
    };
    const assistantMessage = {
      ...visitorMessage,
      id: 'message-assistant',
      role: 'assistant',
      content:
        'I could not complete that request right now. I have asked a human agent to help you.',
    };
    const conversationContext = {
      id: 'conversation-a',
      organizationId: 'org-a',
      status: 'open',
      assignedAgentId: null,
      widgetConfig: {
        id: 'widget-a',
        name: 'Support',
        knowledgeScope: 'all',
        folderScopes: [],
      },
    };
    const loadedConversation = {
      ...conversationContext,
      status: 'waiting_for_agent',
      version: 2,
      visitorId: 'visitor-a',
      visitorName: null,
      visitorEmail: null,
      handoffRequestedAt: now,
      lastMessageAt: now,
      expiresAt: null,
      metadata: {},
      messages: [assistantMessage, visitorMessage],
      createdAt: now,
      updatedAt: now,
    };
    const transaction = {
      customerChatConversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'open',
          assignedAgentId: null,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(
          (input: { data: { status: string } }): Promise<{ count: number }> => {
            handoffStatus = input.data.status;
            return Promise.resolve({ count: 1 });
          },
        ),
      },
      customerChatMessage: {
        create: jest
          .fn()
          .mockResolvedValueOnce(visitorMessage)
          .mockResolvedValueOnce(assistantMessage),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
      customerChatConversation: {
        findUnique: jest.fn().mockResolvedValue(loadedConversation),
      },
    };
    const audit = {
      record: jest.fn(
        (input: {
          action: string;
          metadata: { reason: string };
        }): Promise<void> => {
          recordedAudit = input;
          return Promise.resolve();
        },
      ),
    };
    const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = new CustomerChatService(
      audit as never,
      {} as never,
      {} as never,
      {
        get: jest.fn((_key: string, fallback: unknown) => fallback),
      } as never,
      {
        search: jest.fn().mockRejectedValue(new Error('provider unavailable')),
      } as never,
      prisma as never,
      {} as never,
      realtime as never,
    );
    const actor = {
      sub: 'visitor-a',
      email: 'visitor@example.com',
      orgId: 'org-a',
      roles: ['user'],
    } as AuthenticatedUser;

    const result = await (
      service as unknown as {
        processVisitorMessage: (...args: unknown[]) => Promise<{
          conversation: { status: string };
          assistantMessage: { content: string } | null;
        }>;
      }
    ).processVisitorMessage(
      actor,
      conversationContext,
      { content: visitorMessage.content },
      true,
    );

    expect(result.conversation.status).toBe('waiting_for_agent');
    expect(result.assistantMessage?.content).toContain('human agent');
    expect(handoffStatus).toBe('waiting_for_agent');
    expect(recordedAudit?.action).toBe('customer_chat.auto_handoff_requested');
    expect(recordedAudit?.metadata.reason).toBe('automatic_reply_failed');
  });
});
