import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CustomerChatService } from './customer-chat.service';

describe('CustomerChatService automatic reply recovery', () => {
  it('closes a visitor conversation without deleting its history', async () => {
    const now = new Date();
    let closeExpiresAt: Date | undefined;
    const conversation = {
      id: 'conversation-a',
      organizationId: 'org-a',
      status: 'open',
      version: 3,
    };
    const closedConversation = {
      ...conversation,
      status: 'closed',
      version: 4,
      messages: [{ id: 'message-a' }],
      createdAt: now,
      updatedAt: now,
    };
    const prisma = {
      customerChatConversation: {
        updateMany: jest.fn(
          (input: {
            data: { expiresAt?: Date };
          }): Promise<{ count: number }> => {
            closeExpiresAt = input.data.expiresAt;
            return Promise.resolve({ count: 1 });
          },
        ),
      },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const realtime = { publish: jest.fn().mockResolvedValue(undefined) };
    const service = Object.create(
      CustomerChatService.prototype,
    ) as CustomerChatService;
    Object.assign(service as object, {
      prisma,
      auditService: audit,
      realtimeService: realtime,
      configService: {
        get: jest.fn((_key: string, fallback: unknown) => fallback),
      },
    });
    jest
      .spyOn(service as never, 'findConversationContextForVisitor' as never)
      .mockResolvedValue(conversation as never);
    jest
      .spyOn(service as never, 'loadConversation' as never)
      .mockResolvedValue(closedConversation as never);
    jest
      .spyOn(service as never, 'createSystemUser' as never)
      .mockReturnValue({ orgId: 'org-a' } as never);
    jest
      .spyOn(service as never, 'toConversationResponse' as never)
      .mockReturnValue(closedConversation as never);

    const result = await service.closePublicConversation(
      conversation.id,
      'visitor-token',
      'https://example.com',
    );

    expect(prisma.customerChatConversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversation.id, status: { not: 'closed' } },
        data: expect.objectContaining({
          status: 'closed',
          version: { increment: 1 },
        }) as object,
      }),
    );
    expect(closeExpiresAt).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer_chat.conversation_closed',
        metadata: {
          source: 'public_widget',
          reason: 'visitor_started_new_chat',
        },
      }),
    );
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'conversation.updated',
        conversationId: conversation.id,
      }),
    );
    expect(result).toEqual(closedConversation);
  });

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
      {
        answerConversationally: jest.fn().mockReturnValue(null),
        detectLanguage: jest.fn().mockResolvedValue('en'),
      } as never,
      {
        get: jest.fn((_key: string, fallback: unknown) => fallback),
      } as never,
      {
        search: jest.fn().mockRejectedValue(new Error('provider unavailable')),
        getSearchClearanceDiagnostics: jest.fn().mockResolvedValue({
          visibleCandidateCount: 0,
          restrictedCandidateCount: 0,
        }),
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

  it('clears streamed output when an agent claims the conversation mid-generation', async () => {
    const now = new Date();
    const visitorMessage = {
      id: 'message-visitor',
      organizationId: 'org-a',
      conversationId: 'conversation-a',
      clientMessageId: 'client-a',
      role: 'visitor',
      content: 'What is the refund policy?',
      metadata: {},
      createdAt: now,
      citations: [],
    };
    const conversationContext = {
      id: 'conversation-a',
      organizationId: 'org-a',
      status: 'open',
      assignedAgentId: null,
      version: 1,
      metadata: {},
      widgetConfig: {
        id: 'widget-a',
        name: 'Support',
        knowledgeScope: 'all',
        folderScopes: [],
        settings: {},
      },
    };
    const loadedConversation = {
      ...conversationContext,
      status: 'open',
      assignedAgentId: 'agent-a',
      visitorId: 'visitor-a',
      visitorName: null,
      visitorEmail: null,
      handoffRequestedAt: null,
      lastMessageAt: now,
      expiresAt: now,
      messages: [visitorMessage],
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
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      customerChatMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(visitorMessage),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
      customerChatMessage: { findMany: jest.fn().mockResolvedValue([]) },
      customerChatConversation: {
        findUnique: jest.fn().mockResolvedValue(loadedConversation),
      },
    };
    const chat = {
      answerConversationally: jest.fn().mockReturnValue(null),
      detectLanguage: jest.fn().mockResolvedValue('en'),
      rerankKnowledgeCandidates: jest.fn((items: unknown[]) => items),
      answerWithContext: jest.fn(
        async (input: { onDelta?: (delta: string) => Promise<void> }) => {
          await input.onDelta?.('partial answer');
          return {
            answer: 'partial answer',
            model: 'chat-model',
            provider: 'openai',
            adapter: 'openai',
            usedFallback: false,
            includedContextIndexes: [0],
          };
        },
      ),
    };
    const knowledge = {
      search: jest.fn().mockResolvedValue([
        {
          id: 'chunk-a',
          organizationId: 'org-a',
          sourceId: 'source-a',
          documentId: 'document-a',
          chunkIndex: 0,
          content: 'Refunds are available for 30 days.',
          score: 0.9,
          embeddingModel: 'embedding-model',
          embeddingProvider: 'openai',
        },
      ]),
      getSearchClearanceDiagnostics: jest.fn().mockResolvedValue({
        effectiveClearance: 0,
        excludedChunkCount: 0,
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
    const onReplace = jest.fn();

    const result = await (
      service as unknown as {
        processVisitorMessage: (...args: unknown[]) => Promise<{
          assistantMessage: object | null;
        }>;
      }
    ).processVisitorMessage(
      {
        sub: 'visitor-a',
        email: 'visitor@example.com',
        orgId: 'org-a',
        roles: ['user'],
      },
      conversationContext,
      {
        content: visitorMessage.content,
        clientMessageId: visitorMessage.clientMessageId,
      },
      true,
      { onDelta: jest.fn(), onReplace },
    );

    expect(result.assistantMessage).toBeNull();
    expect(onReplace).toHaveBeenCalledWith('');
  });
});
