import { Injectable } from '@nestjs/common';
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
    ]);

    const memory = process.memoryUsage();

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
}
