import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentCalendarService } from './appointment-calendar.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';

@Injectable()
export class AppointmentNoShowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppointmentNoShowService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly auditService: AuditService,
    private readonly calendarService: AppointmentCalendarService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reminderQueueService: AppointmentReminderQueueService,
  ) {}

  onModuleInit() {
    void this.scan();
    const interval = this.configService.get<number>(
      'APPOINTMENT_NO_SHOW_SCAN_INTERVAL_MS',
      60_000,
    );
    this.timer = setInterval(() => void this.scan(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async scan() {
    const now = new Date();
    try {
      const bookings = await this.prisma.appointmentBooking.findMany({
        where: {
          status: { in: ['pending', 'confirmed'] },
          checkedInAt: null,
          endAt: { lt: now },
        },
        orderBy: { endAt: 'asc' },
        take: 500,
      });
      const organizationIds = [
        ...new Set(bookings.map((booking) => booking.organizationId)),
      ];
      const policies = await this.prisma.appointmentBookingPolicy.findMany({
        where: { organizationId: { in: organizationIds } },
      });
      const graceByOrganization = new Map(
        policies.map((policy) => [
          policy.organizationId,
          policy.noShowGraceMinutes,
        ]),
      );

      for (const booking of bookings) {
        const graceMinutes =
          graceByOrganization.get(booking.organizationId) ?? 30;
        if (booking.endAt.getTime() + graceMinutes * 60_000 > now.getTime()) {
          continue;
        }
        const transitioned = await this.prisma.appointmentBooking.updateMany({
          where: {
            id: booking.id,
            status: { in: ['pending', 'confirmed'] },
            checkedInAt: null,
          },
          data: { status: 'no_show' },
        });
        if (!transitioned.count) continue;
        await this.reminderQueueService.cancelBookingReminders(booking.id);
        await this.calendarService.scheduleBookingSync({
          booking: { ...booking, status: 'no_show' },
          operation: 'delete',
        });
        await this.auditService.record({
          organizationId: booking.organizationId,
          action: 'appointment.booking_auto_no_show',
          entityType: 'appointment_booking',
          entityId: booking.id,
          metadata: { graceMinutes },
        });
      }
      await this.prisma.appointmentRecurrenceSeries.updateMany({
        where: {
          status: 'active',
          bookings: {
            none: { status: { in: ['pending', 'confirmed'] } },
          },
        },
        data: { status: 'completed' },
      });
    } catch (error) {
      this.logger.error('Appointment no-show scan failed', error);
    }
  }
}
