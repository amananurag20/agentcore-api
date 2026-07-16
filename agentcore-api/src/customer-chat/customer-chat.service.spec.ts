import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CustomerChatService } from './customer-chat.service';

describe('CustomerChatService automatic reply recovery', () => {
  it('uses bounded production defaults for widget conversation memory', () => {
    const policyReader = CustomerChatService.prototype as unknown as {
      readWidgetMemoryPolicy: (
        settings: Record<string, unknown> | undefined,
        strict?: boolean,
      ) => {
        enabled: boolean;
        recentMessageLimit: number;
        lowConfidenceAction: string;
        maxClarificationAttempts: number;
      };
    };

    expect(policyReader.readWidgetMemoryPolicy(undefined)).toEqual({
      enabled: true,
      recentMessageLimit: 8,
      lowConfidenceAction: 'clarify',
      maxClarificationAttempts: 2,
    });
    expect(
      policyReader.readWidgetMemoryPolicy({
        memoryEnabled: true,
        recentMessageLimit: 20,
        lowConfidenceAction: 'handoff',
        maxClarificationAttempts: 3,
      }),
    ).toEqual({
      enabled: true,
      recentMessageLimit: 20,
      lowConfidenceAction: 'handoff',
      maxClarificationAttempts: 3,
    });
    expect(() =>
      policyReader.readWidgetMemoryPolicy({ recentMessageLimit: 100 }, true),
    ).toThrow('recentMessageLimit must be an integer between 4 and 20');
  });

  it('clarifies once before handing off repeated low-confidence questions', () => {
    const decisionMaker = CustomerChatService.prototype as unknown as {
      resolveLowConfidenceDecision: (
        policy: {
          enabled: boolean;
          recentMessageLimit: number;
          lowConfidenceAction: 'clarify' | 'handoff';
          maxClarificationAttempts: number;
        },
        previous: {
          clarificationRequested: boolean;
          clarificationAttempts: number;
        },
      ) => { attempts: number; shouldHandoff: boolean };
    };
    const policy = {
      enabled: true,
      recentMessageLimit: 8,
      lowConfidenceAction: 'clarify' as const,
      maxClarificationAttempts: 2,
    };

    expect(
      decisionMaker.resolveLowConfidenceDecision(policy, {
        clarificationRequested: false,
        clarificationAttempts: 0,
      }),
    ).toEqual({ attempts: 1, shouldHandoff: false });
    expect(
      decisionMaker.resolveLowConfidenceDecision(policy, {
        clarificationRequested: true,
        clarificationAttempts: 1,
      }),
    ).toEqual({ attempts: 2, shouldHandoff: true });
  });

  it('rescues near-threshold results with direct lexical support', () => {
    const matcher = CustomerChatService.prototype as unknown as {
      hasLexicalSupport: (query: string, content: string) => boolean;
    };

    expect(
      matcher.hasLexicalSupport(
        'watcher ?',
        'Watch & Notify stores payment notification settings.',
      ),
    ).toBe(true);
    expect(
      matcher.hasLexicalSupport(
        'watcher ?',
        'Appointment cancellation and refund policy.',
      ),
    ).toBe(false);
  });

  it('recognizes multi-turn elaboration and formatting requests', () => {
    const matcher = CustomerChatService.prototype as unknown as {
      isContextualFollowUp: (content: string, hasHistory: boolean) => boolean;
    };

    expect(
      matcher.isContextualFollowUp('Can you give that in Markdown?', true),
    ).toBe(true);
    expect(
      matcher.isContextualFollowUp('Ok can you elaborate it more?', true),
    ).toBe(true);
    expect(matcher.isContextualFollowUp('Watcher', true)).toBe(false);
  });

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
      customerChatMessage: {
        findMany: jest.fn().mockResolvedValue([]),
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
      { answerConversationally: jest.fn().mockReturnValue(null) } as never,
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

  it('answers greetings locally without retrieval or handoff', async () => {
    let persistedStatus: string | undefined;
    const now = new Date();
    const visitorMessage = {
      id: 'message-visitor',
      organizationId: 'org-a',
      conversationId: 'conversation-a',
      role: 'visitor',
      content: 'Hi',
      metadata: {},
      createdAt: now,
      citations: [],
    };
    const assistantMessage = {
      ...visitorMessage,
      id: 'message-assistant',
      role: 'assistant',
      content: 'Hi! How can I help you today?',
      metadata: { handledWithoutKnowledge: true },
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
      version: 2,
      visitorId: 'visitor-a',
      visitorName: null,
      visitorEmail: null,
      handoffRequestedAt: null,
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
            persistedStatus = input.data.status;
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
    const knowledge = { search: jest.fn() };
    const chat = {
      answerConversationally: jest.fn().mockReturnValue({
        answer: 'Hi! How can I help you today?',
        model: 'local-intent',
        provider: 'local',
        adapter: 'local-intent',
        usedFallback: false,
        handledWithoutKnowledge: true,
      }),
    };
    const service = new CustomerChatService(
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      chat as never,
      {
        get: jest.fn((_key: string, fallback: unknown) => fallback),
      } as never,
      knowledge as never,
      prisma as never,
      {} as never,
      { publish: jest.fn().mockResolvedValue(undefined) } as never,
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

    expect(result.conversation.status).toBe('open');
    expect(result.assistantMessage?.content).toBe(
      'Hi! How can I help you today?',
    );
    expect(knowledge.search).not.toHaveBeenCalled();
    expect(persistedStatus).toBe('open');
  });
});
