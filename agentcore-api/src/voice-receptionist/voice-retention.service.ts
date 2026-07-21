import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceOutboundService } from './voice-outbound.service';

@Injectable()
export class VoiceRetentionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VoiceRetentionService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly outboundService: VoiceOutboundService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.configService.get<number>(
      'VOICE_RETENTION_SWEEP_INTERVAL_MS',
      3_600_000,
    );
    this.timer = setInterval(() => this.runScheduledSweep(), intervalMs);
    this.timer.unref();
    const initial = setTimeout(() => this.runScheduledSweep(), 60_000);
    initial.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private runScheduledSweep(): void {
    void this.sweep().catch((error) => {
      this.logger.error(
        `Voice retention sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.migrateLegacyTranscripts();
      await this.migrateLegacySummaries();
      const retentionDays = this.configService.get<number>(
        'VOICE_RECORDING_RETENTION_DAYS',
        30,
      );
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
      const calls = await this.prisma.voiceCall.findMany({
        where: {
          createdAt: { lt: cutoff },
          OR: [
            { recordingSid: { not: null } },
            { recordingUrl: { not: null } },
            { recordingUrlEncrypted: { not: null } },
          ],
        },
        include: { config: true },
        take: 100,
      });
      let purged = 0;
      for (const call of calls) {
        try {
          if (call.recordingSid && call.config.provider === 'twilio') {
            await this.outboundService.deleteRecording(
              call.config,
              call.recordingSid,
            );
          }
          await this.prisma.$transaction([
            this.prisma.voiceCall.update({
              where: { id: call.id },
              data: {
                recordingSid: null,
                recordingUrl: null,
                recordingUrlEncrypted: null,
                recordingDurationSeconds: null,
              },
            }),
            this.prisma.voiceCallEvent.updateMany({
              where: { callId: call.id, type: 'voicemail' },
              data: {
                content: null,
                contentEncrypted: null,
                audioUrl: null,
                audioUrlEncrypted: null,
              },
            }),
          ]);
          purged += 1;
        } catch (error) {
          this.logger.warn(
            `Voice retention retry required for call=${call.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      }
      return purged;
    } finally {
      this.sweeping = false;
    }
  }

  private async migrateLegacyTranscripts(): Promise<void> {
    for (let batch = 0; batch < 20; batch += 1) {
      const events = await this.prisma.voiceCallEvent.findMany({
        where: {
          role: { in: ['caller', 'assistant', 'agent'] },
          content: { not: null },
          contentEncrypted: null,
        },
        select: { id: true, content: true },
        orderBy: { createdAt: 'asc' },
        take: 250,
      });
      if (!events.length) return;
      await this.prisma.$transaction(
        events.flatMap((event) =>
          event.content
            ? [
                this.prisma.voiceCallEvent.update({
                  where: { id: event.id },
                  data: {
                    content: null,
                    contentEncrypted: this.cryptoService.encrypt(event.content),
                  },
                }),
              ]
            : [],
        ),
      );
      if (events.length < 250) return;
    }
  }

  private async migrateLegacySummaries(): Promise<void> {
    for (let batch = 0; batch < 20; batch += 1) {
      const calls = await this.prisma.voiceCall.findMany({
        where: { summary: { not: null }, summaryEncrypted: null },
        select: { id: true, summary: true },
        orderBy: { createdAt: 'asc' },
        take: 250,
      });
      if (!calls.length) return;
      const updates = calls.flatMap((call) =>
        call.summary
          ? [
              this.prisma.voiceCall.update({
                where: { id: call.id },
                data: {
                  summary: null,
                  summaryEncrypted: this.cryptoService.encrypt(call.summary),
                },
              }),
            ]
          : [],
      );
      if (updates.length) await this.prisma.$transaction(updates);
      if (calls.length < 250) return;
    }
  }
}
