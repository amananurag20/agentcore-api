import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ObservabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [
      auditEvents24h,
      customerChatOpen,
      customerChatWaiting,
      whatsappOpen,
      whatsappWaiting,
      voiceInProgress,
      voiceWaiting,
      appointmentUpcoming,
      appointmentCancelled24h,
      knowledgeReady,
      knowledgeFailed,
      activeSessions,
      pendingInvites,
      passwordResetTokens24h,
      customerChatAssistantMessages,
      whatsappAssistantMessages,
      voiceAssistantEvents,
    ] = await Promise.all([
      this.prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.customerChatConversation.count({
        where: { status: 'open' },
      }),
      this.prisma.customerChatConversation.count({
        where: { status: 'waiting_for_agent' },
      }),
      this.prisma.whatsAppConversation.count({ where: { status: 'open' } }),
      this.prisma.whatsAppConversation.count({
        where: { status: 'waiting_for_agent' },
      }),
      this.prisma.voiceCall.count({ where: { status: 'in_progress' } }),
      this.prisma.voiceCall.count({
        where: { status: 'waiting_for_agent' },
      }),
      this.prisma.appointmentBooking.count({
        where: {
          status: { in: ['pending', 'confirmed'] },
          startAt: { gte: new Date() },
        },
      }),
      this.prisma.appointmentBooking.count({
        where: {
          status: 'cancelled',
          updatedAt: { gte: since },
        },
      }),
      this.prisma.knowledgeSource.count({ where: { status: 'ready' } }),
      this.prisma.knowledgeSource.count({ where: { status: 'failed' } }),
      this.prisma.authSession.count({
        where: {
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
      this.prisma.authOneTimeToken.count({
        where: {
          type: 'invite',
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
      this.prisma.authOneTimeToken.count({
        where: {
          type: 'password_reset',
          createdAt: { gte: since },
        },
      }),
      this.prisma.customerChatMessage.findMany({
        where: {
          role: 'assistant',
          createdAt: { gte: since },
        },
        select: { metadata: true },
        take: 500,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.whatsAppMessage.findMany({
        where: {
          role: 'assistant',
          createdAt: { gte: since },
        },
        select: { metadata: true },
        take: 500,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.voiceCallEvent.findMany({
        where: {
          type: 'assistant_response',
          createdAt: { gte: since },
        },
        select: { metadata: true },
        take: 500,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const memory = process.memoryUsage();
    const aiMessages = [
      ...customerChatAssistantMessages,
      ...whatsappAssistantMessages,
      ...voiceAssistantEvents,
    ];
    const aiFallbacks24h = aiMessages.filter(
      (message) => this.toRecord(message.metadata).usedFallback === true,
    ).length;
    const aiProviderErrors24h = aiMessages.filter((message) =>
      Boolean(this.toRecord(message.metadata).error),
    ).length;

    return {
      generatedAt: new Date().toISOString(),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        memoryRssMb: Math.round(memory.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      audit: {
        events24h: auditEvents24h,
      },
      auth: {
        activeSessions,
        pendingInvites,
        passwordResetTokens24h,
      },
      ai: {
        assistantMessagesSampled24h: aiMessages.length,
        fallbacks24h: aiFallbacks24h,
        providerErrors24h: aiProviderErrors24h,
      },
      customerChat: {
        open: customerChatOpen,
        waitingForAgent: customerChatWaiting,
      },
      whatsappAssistant: {
        open: whatsappOpen,
        waitingForAgent: whatsappWaiting,
      },
      voiceReceptionist: {
        inProgress: voiceInProgress,
        waitingForAgent: voiceWaiting,
      },
      appointmentBooking: {
        upcoming: appointmentUpcoming,
        cancelled24h: appointmentCancelled24h,
      },
      knowledge: {
        readySources: knowledgeReady,
        failedSources: knowledgeFailed,
      },
    };
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }
}
