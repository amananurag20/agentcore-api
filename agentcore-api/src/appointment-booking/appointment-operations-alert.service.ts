import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppointmentOperationsAlertService {
  private readonly logger = new Logger(AppointmentOperationsAlertService.name);

  constructor(private readonly configService: ConfigService) {}

  async deadLetter(input: {
    event:
      'appointment.reminder.dead_letter' | 'appointment.calendar.dead_letter';
    organizationId: string;
    bookingId: string;
    recordId: string;
    attempts: number;
    lastError?: string | null;
  }): Promise<void> {
    const url = this.configService.get<string>(
      'APPOINTMENT_OPERATIONS_ALERT_WEBHOOK_URL',
    );
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...input,
          occurredAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(
          this.configService.get<number>(
            'APPOINTMENT_PROVIDER_TIMEOUT_MS',
            10_000,
          ),
        ),
      });
      if (!response.ok) {
        this.logger.warn(
          `Appointment alert webhook returned ${response.status}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Appointment alert webhook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
