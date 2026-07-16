import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  AppointmentBooking,
  AppointmentService,
  AppointmentStaff,
  AppointmentResource,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentReminderQueueService } from './appointment-reminder-queue.service';
import { AppointmentReminderDeliveryService } from './appointment-reminder-delivery.service';
import { AppointmentTimezoneService } from './appointment-timezone.service';
import { AppointmentCalendarService } from './appointment-calendar.service';
import {
  AppointmentActionDto,
  AppointmentActionTypeDto,
} from './dto/appointment-action.dto';
import {
  CancelAppointmentBookingDto,
  CreateAppointmentBookingDto,
  CreateAppointmentServiceDto,
  CreateAppointmentResourceDto,
  CreateAppointmentStaffDto,
  CreateStaffTimeOffDto,
  ListAppointmentBookingsDto,
  ListAvailabilityDto,
  PublicCreateAppointmentBookingDto,
  PublicCancelAppointmentBookingDto,
  PublicListAppointmentServicesDto,
  PublicListAvailabilityDto,
  PublicRescheduleAppointmentBookingDto,
  RescheduleAppointmentBookingDto,
  SetServiceResourceDto,
  SetStaffAvailabilityDto,
  UpdateAppointmentBookingStatusDto,
  UpdateAppointmentServiceDto,
  UpdateAppointmentResourceDto,
  UpdateAppointmentStaffDto,
} from './dto/appointment-booking.dto';
import {
  AppointmentReminderOptOutDto,
  AppointmentRecurrenceFrequencyDto,
  AppointmentReminderChannelDto,
  CancelAppointmentSeriesDto,
  CheckInAppointmentDto,
  ClaimAppointmentWaitlistDto,
  CreateAppointmentBlackoutDto,
  JoinAppointmentWaitlistDto,
  ListWaitlistDto,
  PublicCancelAppointmentSeriesDto,
  UpdateAppointmentPolicyDto,
} from './dto/appointment-features.dto';

type StaffWithServices = Prisma.AppointmentStaffGetPayload<{
  include: {
    services: {
      include: {
        service: true;
      };
    };
    resources: {
      include: {
        resource: true;
      };
    };
  };
}>;

type BookingCreationResult = {
  booking: AppointmentBooking;
  manageToken: string;
};

@Injectable()
export class AppointmentBookingService {
  private readonly logger = new Logger(AppointmentBookingService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly calendarService: AppointmentCalendarService,
    private readonly configService: ConfigService,
    private readonly reminderDeliveryService: AppointmentReminderDeliveryService,
    private readonly reminderQueueService: AppointmentReminderQueueService,
    private readonly prisma: PrismaService,
    private readonly timezoneService: AppointmentTimezoneService,
  ) {}

  async executeAction(organizationId: string, input: AppointmentActionDto) {
    await this.assertAppointmentBookingEnabled(organizationId);

    switch (input.action) {
      case AppointmentActionTypeDto.list_services:
        return {
          action: input.action,
          data: await this.listPublicServices({ organizationId }),
        };
      case AppointmentActionTypeDto.list_availability:
        this.requireActionFields(input, ['serviceId', 'date']);
        return {
          action: input.action,
          data: await this.listPublicAvailability({
            organizationId,
            serviceId: input.serviceId!,
            date: input.date!,
            staffId: input.staffId,
            timezone: input.timezone,
          }),
        };
      case AppointmentActionTypeDto.book:
        this.requireActionFields(input, [
          'serviceId',
          'startAt',
          'customerName',
        ]);
        return {
          action: input.action,
          data: await this.createPublicBooking({
            organizationId,
            serviceId: input.serviceId!,
            staffId: input.staffId,
            customerName: input.customerName!,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone,
            partySize: input.partySize,
            startAt: input.startAt!,
            timezone: input.timezone,
            notes: input.notes,
            recurrence: input.recurrence,
            metadata: { source: 'channel_action' },
          }),
        };
      case AppointmentActionTypeDto.reschedule:
        this.requireActionFields(input, [
          'bookingId',
          'manageToken',
          'startAt',
        ]);
        return {
          action: input.action,
          data: await this.reschedulePublicBooking(input.bookingId!, {
            organizationId,
            manageToken: input.manageToken!,
            staffId: input.staffId,
            startAt: input.startAt!,
            timezone: input.timezone,
            applyToFuture: input.applyToFuture,
          }),
        };
      case AppointmentActionTypeDto.cancel:
        this.requireActionFields(input, ['bookingId', 'manageToken']);
        return {
          action: input.action,
          data: await this.cancelPublicBooking(input.bookingId!, {
            organizationId,
            manageToken: input.manageToken!,
            reason: input.reason,
          }),
        };
      default:
        throw new BadRequestException('Unsupported appointment action');
    }
  }

  formatActionResult(result: {
    action: AppointmentActionTypeDto;
    data: unknown;
  }): string {
    if (result.action === AppointmentActionTypeDto.list_services) {
      const services = result.data as Array<{
        name: string;
        durationMinutes: number;
      }>;
      return services.length
        ? `Available services: ${services.map((service) => `${service.name} (${service.durationMinutes} minutes)`).join(', ')}.`
        : 'There are currently no bookable services.';
    }
    if (result.action === AppointmentActionTypeDto.list_availability) {
      const slots = result.data as Array<{
        startAt: Date;
        timezone: string;
        staffName: string;
      }>;
      return slots.length
        ? `Available times: ${slots
            .slice(0, 8)
            .map(
              (slot) =>
                `${new Date(slot.startAt).toISOString()} with ${slot.staffName}`,
            )
            .join(', ')}.`
        : 'No appointments are available for that date.';
    }
    const recurring = result.data as {
      series?: { id: string; manageToken?: string };
      bookings?: Array<{ startAt: Date }>;
    };
    if (recurring.series && recurring.bookings) {
      return `Recurring appointment series ${recurring.series.id} was created with ${recurring.bookings.length} occurrences.${recurring.series.manageToken ? ` Management token: ${recurring.series.manageToken}` : ''}`;
    }
    const booking = result.data as {
      id: string;
      startAt: Date;
      timezone: string;
      seatsRemaining: number;
      status: string;
      manageToken?: string;
    };
    if (result.action === AppointmentActionTypeDto.cancel) {
      return `Appointment ${booking.id} has been cancelled.`;
    }
    return `Appointment ${booking.id} is ${booking.status} for ${new Date(booking.startAt).toISOString()}.${booking.manageToken ? ` Management token: ${booking.manageToken}` : ''}`;
  }

  async getPolicy(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);
    return this.prisma.appointmentBookingPolicy.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    });
  }

  async updatePolicy(
    currentUser: AuthenticatedUser,
    requestedOrganizationId: string | undefined,
    input: UpdateAppointmentPolicyDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    this.timezoneService.assertValid(input.quietHoursTimezone ?? 'UTC');
    const policy = await this.prisma.appointmentBookingPolicy.upsert({
      where: { organizationId },
      create: { organizationId, ...input },
      update: input,
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.policy_updated',
      entityType: 'appointment_booking_policy',
      entityId: organizationId,
    });
    return policy;
  }

  async listBlackouts(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    return this.prisma.appointmentBlackout.findMany({
      where: { organizationId },
      orderBy: { startAt: 'asc' },
    });
  }

  async createBlackout(
    currentUser: AuthenticatedUser,
    input: CreateAppointmentBlackoutDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    this.assertDateRange(startAt, endAt);
    const blackout = await this.prisma.appointmentBlackout.create({
      data: {
        organizationId,
        name: input.name,
        startAt,
        endAt,
        annual: input.annual ?? false,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.blackout_created',
      entityType: 'appointment_blackout',
      entityId: blackout.id,
    });
    return blackout;
  }

  async deleteBlackout(currentUser: AuthenticatedUser, id: string) {
    const blackout = await this.prisma.appointmentBlackout.findUnique({
      where: { id },
    });
    if (
      !blackout ||
      (!this.isSuperAdmin(currentUser) &&
        blackout.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Appointment blackout not found');
    }
    await this.prisma.appointmentBlackout.delete({ where: { id } });
    return { deleted: true };
  }

  async checkInBooking(
    currentUser: AuthenticatedUser,
    id: string,
    input: CheckInAppointmentDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);
    if (!['pending', 'confirmed'].includes(booking.status)) {
      throw new ConflictException('Booking cannot be checked in');
    }
    const checkedInAt = input.checkedInAt
      ? new Date(input.checkedInAt)
      : new Date();
    const updated = await this.prisma.appointmentBooking.update({
      where: { id: booking.id },
      data: { checkedInAt },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: booking.organizationId,
      action: 'appointment.booking_checked_in',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: { checkedInAt: checkedInAt.toISOString() },
    });
    return this.toBookingResponse(updated);
  }

  async cancelSeries(
    currentUser: AuthenticatedUser,
    id: string,
    input: CancelAppointmentSeriesDto,
  ) {
    const series = await this.prisma.appointmentRecurrenceSeries.findUnique({
      where: { id },
    });
    if (
      !series ||
      (!this.isSuperAdmin(currentUser) &&
        series.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Appointment recurrence series not found');
    }
    return this.cancelSeriesRecord(series, input, currentUser);
  }

  async cancelPublicSeries(
    id: string,
    input: PublicCancelAppointmentSeriesDto,
  ) {
    const series = await this.prisma.appointmentRecurrenceSeries.findFirst({
      where: { id, organizationId: input.organizationId },
    });
    if (
      !series ||
      !this.manageTokenMatches(series.manageTokenHash, input.manageToken)
    ) {
      throw new NotFoundException('Appointment recurrence series not found');
    }
    return this.cancelSeriesRecord(series, input);
  }

  private async cancelSeriesRecord(
    series: Prisma.AppointmentRecurrenceSeriesGetPayload<object>,
    input: CancelAppointmentSeriesDto,
    actor?: AuthenticatedUser,
  ) {
    if (series.status !== 'active') {
      throw new ConflictException('Appointment series is not active');
    }
    const bookings = await this.prisma.appointmentBooking.findMany({
      where: {
        seriesId: series.id,
        status: { in: ['pending', 'confirmed'] },
        occurrenceIndex:
          input.fromOccurrenceIndex === undefined
            ? undefined
            : { gte: input.fromOccurrenceIndex },
      },
      orderBy: { occurrenceIndex: 'asc' },
    });
    if (!bookings.length) {
      throw new ConflictException('No active occurrences match this request');
    }
    const service = await this.findActiveService(
      series.organizationId,
      series.serviceId,
    );
    for (const booking of bookings) {
      await this.assertPublicChangeWindow(
        booking,
        service.cancellationWindowMinutes,
        'cancel',
        actor,
      );
    }
    await this.prisma.$transaction([
      this.prisma.appointmentBooking.updateMany({
        where: { id: { in: bookings.map((booking) => booking.id) } },
        data: {
          status: 'cancelled',
          cancellationReason: input.reason ?? 'Recurrence series cancelled',
        },
      }),
      ...(input.fromOccurrenceIndex === undefined
        ? [
            this.prisma.appointmentRecurrenceSeries.update({
              where: { id: series.id },
              data: { status: 'cancelled' },
            }),
          ]
        : []),
    ]);
    await Promise.all(
      bookings.map(async (booking) => {
        const cancelled = { ...booking, status: 'cancelled' as const };
        await this.reminderQueueService.cancelBookingReminders(booking.id);
        await this.calendarService.scheduleBookingSync({
          booking: cancelled,
          operation: 'delete',
        });
        await this.offerNextWaitlist(cancelled);
      }),
    );
    await this.auditService.record({
      actor,
      organizationId: series.organizationId,
      action: 'appointment.recurrence_series_cancelled',
      entityType: 'appointment_recurrence_series',
      entityId: series.id,
      metadata: {
        fromOccurrenceIndex: input.fromOccurrenceIndex,
        cancelledCount: bookings.length,
      },
    });
    return { cancelled: bookings.length, seriesId: series.id };
  }

  async listWaitlist(currentUser: AuthenticatedUser, input: ListWaitlistDto) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    return this.prisma.appointmentWaitlistEntry.findMany({
      where: {
        organizationId,
        serviceId: input.serviceId,
        staffId: input.staffId,
      },
      orderBy: [{ startAt: 'asc' }, { position: 'asc' }],
      take: input.limit,
    });
  }

  async listDeadLetters(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    const [reminders, calendarEvents] = await Promise.all([
      this.prisma.appointmentReminder.findMany({
        where: { organizationId, status: 'dead_letter' },
        include: {
          booking: {
            select: {
              id: true,
              customerName: true,
              startAt: true,
              service: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      this.prisma.appointmentCalendarEvent.findMany({
        where: { organizationId, status: 'dead_letter' },
        include: {
          booking: {
            select: {
              id: true,
              customerName: true,
              startAt: true,
              service: { select: { id: true, name: true } },
            },
          },
          connection: {
            select: { id: true, provider: true, accountEmail: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    ]);
    return { reminders, calendarEvents };
  }

  async retryReminderDeadLetter(currentUser: AuthenticatedUser, id: string) {
    const reminder = await this.prisma.appointmentReminder.findUnique({
      where: { id },
    });
    if (!reminder || reminder.status !== 'dead_letter') {
      throw new NotFoundException('Reminder dead letter not found');
    }
    this.resolveOrganizationId(currentUser, reminder.organizationId);
    await this.reminderQueueService.retryDeadLetter(reminder.id);
    await this.auditService.record({
      actor: currentUser,
      organizationId: reminder.organizationId,
      action: 'appointment.reminder_dead_letter_retried',
      entityType: 'appointment_reminder',
      entityId: reminder.id,
    });
    return { retried: true, id: reminder.id };
  }

  async retryCalendarDeadLetter(currentUser: AuthenticatedUser, id: string) {
    const event = await this.prisma.appointmentCalendarEvent.findUnique({
      where: { id },
    });
    if (!event || event.status !== 'dead_letter') {
      throw new NotFoundException('Calendar dead letter not found');
    }
    this.resolveOrganizationId(currentUser, event.organizationId);
    await this.calendarService.retryDeadLetter(event.id);
    await this.auditService.record({
      actor: currentUser,
      organizationId: event.organizationId,
      action: 'appointment.calendar_dead_letter_retried',
      entityType: 'appointment_calendar_event',
      entityId: event.id,
    });
    return { retried: true, id: event.id };
  }

  async joinWaitlist(input: JoinAppointmentWaitlistDto) {
    await this.assertAppointmentBookingEnabled(input.organizationId);
    const service = await this.findActiveService(
      input.organizationId,
      input.serviceId,
    );
    if (!service.waitlistEnabled) {
      throw new ConflictException('Waitlist is not enabled for this service');
    }
    const staff = await this.findActiveStaffForService(
      input.organizationId,
      input.staffId,
      service.id,
    );
    const startAt = new Date(input.startAt);
    this.assertBookableStart(startAt);
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? staff.timezone;
    this.timezoneService.assertValid(timezone);
    const hasConflict = await this.hasConflict({
      organizationId: input.organizationId,
      service,
      staffId: staff.id,
      startAt,
      endAt,
      partySize: input.partySize,
    });
    const internalBookings = await this.prisma.appointmentBooking.findMany({
      where: {
        organizationId: input.organizationId,
        staffId: staff.id,
        status: { in: ['pending', 'confirmed'] },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
    });
    const internallyFull =
      service.maxAttendees <= 1
        ? internalBookings.length > 0
        : internalBookings
            .filter(
              (booking) =>
                booking.serviceId === service.id &&
                booking.startAt.getTime() === startAt.getTime() &&
                booking.endAt.getTime() === endAt.getTime(),
            )
            .reduce((total, booking) => total + booking.partySize, 0) +
            input.partySize >
          service.maxAttendees;
    if (!hasConflict || !internallyFull) {
      throw new ConflictException('This slot is still available to book');
    }
    const normalizedEmail = input.customerEmail?.trim().toLowerCase();
    const normalizedPhone = input.customerPhone?.replace(/\s+/g, '');
    const duplicate = await this.prisma.appointmentWaitlistEntry.findFirst({
      where: {
        serviceId: service.id,
        staffId: staff.id,
        startAt,
        status: { in: ['waiting', 'offered', 'claimed'] },
        OR: [
          ...(normalizedEmail ? [{ customerEmail: normalizedEmail }] : []),
          ...(normalizedPhone ? [{ customerPhone: normalizedPhone }] : []),
        ],
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException('Customer is already on this waitlist');
    }
    const last = await this.prisma.appointmentWaitlistEntry.aggregate({
      where: { serviceId: service.id, staffId: staff.id, startAt },
      _max: { position: true },
    });
    const entry = await this.prisma.appointmentWaitlistEntry.create({
      data: {
        organizationId: input.organizationId,
        serviceId: service.id,
        staffId: staff.id,
        startAt,
        endAt,
        timezone,
        customerName: input.customerName,
        customerEmail: normalizedEmail,
        customerPhone: normalizedPhone,
        partySize: input.partySize,
        position: (last._max.position ?? 0) + 1,
      },
    });
    await this.auditService.record({
      organizationId: input.organizationId,
      action: 'appointment.waitlist_joined',
      entityType: 'appointment_waitlist_entry',
      entityId: entry.id,
      metadata: { serviceId: service.id, staffId: staff.id, startAt },
    });
    return entry;
  }

  async claimWaitlist(input: ClaimAppointmentWaitlistDto) {
    const suppliedHash = this.hashManageToken(input.offerToken);
    const entry = await this.prisma.appointmentWaitlistEntry.findFirst({
      where: {
        organizationId: input.organizationId,
        status: 'offered',
        offerTokenHash: suppliedHash,
        offerExpiresAt: { gt: new Date() },
      },
      orderBy: { offerExpiresAt: 'asc' },
    });
    if (!entry?.offerTokenHash || suppliedHash !== entry.offerTokenHash) {
      throw new NotFoundException('Waitlist offer not found or expired');
    }
    const claimed = await this.prisma.appointmentWaitlistEntry.updateMany({
      where: {
        id: entry.id,
        status: 'offered',
        offerTokenHash: suppliedHash,
        offerExpiresAt: { gt: new Date() },
      },
      data: { status: 'claimed' },
    });
    if (!claimed.count) {
      throw new ConflictException('Waitlist offer has already been claimed');
    }
    let result: BookingCreationResult;
    try {
      result = await this.createBookingForOrganization(entry.organizationId, {
        serviceId: entry.serviceId,
        staffId: entry.staffId,
        customerName: entry.customerName,
        customerEmail: entry.customerEmail ?? undefined,
        customerPhone: entry.customerPhone ?? undefined,
        partySize: entry.partySize,
        startAt: entry.startAt.toISOString(),
        timezone: entry.timezone,
        metadata: { source: 'waitlist', waitlistEntryId: entry.id },
      });
    } catch (error) {
      await this.prisma.appointmentWaitlistEntry.updateMany({
        where: { id: entry.id, status: 'claimed', claimedBookingId: null },
        data: { status: 'offered' },
      });
      throw error;
    }
    await this.prisma.appointmentWaitlistEntry.update({
      where: { id: entry.id },
      data: {
        claimedBookingId: result.booking.id,
        offerTokenHash: null,
        offerExpiresAt: null,
      },
    });
    await this.afterBookingCreated(result.booking);
    await this.offerNextWaitlist(result.booking);
    return this.toBookingResponse(result.booking, result.manageToken);
  }

  async optOutReminders(input: AppointmentReminderOptOutDto) {
    const booking = await this.prisma.appointmentBooking.findFirst({
      where: { id: input.bookingId, organizationId: input.organizationId },
    });
    if (
      !booking ||
      !this.reminderDeliveryService.verifyReminderOptOutToken(
        booking,
        input.token,
      )
    ) {
      throw new NotFoundException('Reminder preference link is invalid');
    }
    const contact =
      input.channel === AppointmentReminderChannelDto.email
        ? booking.customerEmail?.trim().toLowerCase()
        : booking.customerPhone?.replace(/\s+/g, '');
    if (!contact) {
      throw new BadRequestException(
        `Booking has no contact for ${input.channel} reminders`,
      );
    }
    await this.prisma.appointmentReminderSuppression.upsert({
      where: {
        organizationId_channel_contactNormalized: {
          organizationId: booking.organizationId,
          channel: input.channel,
          contactNormalized: contact,
        },
      },
      create: {
        organizationId: booking.organizationId,
        channel: input.channel,
        contactNormalized: contact,
        reason: 'customer_opt_out',
      },
      update: { reason: 'customer_opt_out' },
    });
    await this.auditService.record({
      organizationId: booking.organizationId,
      action: 'appointment.reminder_opted_out',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: { channel: input.channel },
    });
    return { optedOut: true, channel: input.channel };
  }

  async recoverExpiredWaitlistOffers(): Promise<void> {
    const stalledClaims = await this.prisma.appointmentWaitlistEntry.findMany({
      where: {
        status: 'claimed',
        claimedBookingId: null,
        updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      take: 500,
    });
    for (const stalled of stalledClaims) {
      const booking = await this.prisma.appointmentBooking.findFirst({
        where: {
          organizationId: stalled.organizationId,
          metadata: { path: ['waitlistEntryId'], equals: stalled.id },
        },
        select: { id: true },
      });
      await this.prisma.appointmentWaitlistEntry.updateMany({
        where: { id: stalled.id, status: 'claimed', claimedBookingId: null },
        data: booking
          ? {
              claimedBookingId: booking.id,
              offerTokenHash: null,
              offerExpiresAt: null,
            }
          : { status: 'offered' },
      });
    }
    const expired = await this.prisma.appointmentWaitlistEntry.findMany({
      where: { status: 'offered', offerExpiresAt: { lte: new Date() } },
      orderBy: { offerExpiresAt: 'asc' },
      take: 500,
    });
    for (const entry of expired) {
      const transitioned =
        await this.prisma.appointmentWaitlistEntry.updateMany({
          where: { id: entry.id, status: 'offered' },
          data: {
            status: 'expired',
            offerTokenHash: null,
            offerExpiresAt: null,
          },
        });
      if (!transitioned.count) continue;
      const service = await this.prisma.appointmentService.findUnique({
        where: { id: entry.serviceId },
      });
      if (!service) continue;
      const seatsRemaining = await this.getSeatsRemaining(
        service,
        entry.staffId,
        entry.startAt,
        entry.endAt,
      );
      const candidates = await this.prisma.appointmentWaitlistEntry.findMany({
        where: {
          serviceId: entry.serviceId,
          staffId: entry.staffId,
          startAt: entry.startAt,
          status: 'waiting',
          partySize: { lte: seatsRemaining },
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        take: 1,
      });
      const next = candidates[0];
      if (next) await this.offerWaitlistEntry(next);
    }
  }

  async listServices(currentUser: AuthenticatedUser, organizationId?: string) {
    const resolvedOrganizationId = this.resolveOrganizationId(
      currentUser,
      organizationId,
    );
    await this.assertAppointmentBookingEnabled(resolvedOrganizationId);

    const services = await this.prisma.appointmentService.findMany({
      where: { organizationId: resolvedOrganizationId },
      orderBy: { name: 'asc' },
    });

    return services.map((service) => this.toServiceResponse(service));
  }

  async listPublicServices(input: PublicListAppointmentServicesDto) {
    await this.assertAppointmentBookingEnabled(input.organizationId);

    const services = await this.prisma.appointmentService.findMany({
      where: {
        organizationId: input.organizationId,
        status: 'active',
      },
      orderBy: { name: 'asc' },
    });

    return services.map((service) => this.toServiceResponse(service));
  }

  async createService(
    currentUser: AuthenticatedUser,
    input: CreateAppointmentServiceDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);

    const service = await this.prisma.appointmentService.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
        priceCents: input.priceCents,
        currency: input.currency ?? 'USD',
        maxAttendees: input.maxAttendees ?? 1,
        cancellationWindowMinutes: input.cancellationWindowMinutes,
        rescheduleWindowMinutes: input.rescheduleWindowMinutes,
        waitlistEnabled: input.waitlistEnabled ?? true,
        reminderOffsetsMinutes: input.reminderOffsetsMinutes ?? [],
        reminderTemplates: this.toJsonObject(input.reminderTemplates),
        status: input.status ?? 'active',
        metadata: this.toJsonObject(input.metadata),
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.service_created',
      entityType: 'appointment_service',
      entityId: service.id,
      metadata: { name: service.name },
    });

    return this.toServiceResponse(service);
  }

  async updateService(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAppointmentServiceDto,
  ) {
    const existing = await this.findServiceForActor(currentUser, id);
    if (
      input.maxAttendees !== undefined &&
      input.maxAttendees !== existing.maxAttendees
    ) {
      await this.assertServiceCapacityChange(existing.id, input.maxAttendees);
    }

    const service = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.appointmentService.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          description: input.description,
          durationMinutes: input.durationMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          bufferAfterMinutes: input.bufferAfterMinutes,
          priceCents: input.priceCents,
          currency: input.currency,
          maxAttendees: input.maxAttendees,
          cancellationWindowMinutes: input.cancellationWindowMinutes,
          rescheduleWindowMinutes: input.rescheduleWindowMinutes,
          waitlistEnabled: input.waitlistEnabled,
          reminderOffsetsMinutes: input.reminderOffsetsMinutes,
          reminderTemplates: input.reminderTemplates
            ? this.toJsonObject(input.reminderTemplates)
            : undefined,
          status: input.status,
          metadata: input.metadata
            ? this.toJsonObject(input.metadata)
            : undefined,
        },
      });
      if (input.maxAttendees !== undefined) {
        await tx.appointmentBooking.updateMany({
          where: {
            serviceId: existing.id,
            status: { in: ['pending', 'confirmed'] },
          },
          data: { isGroupBooking: input.maxAttendees > 1 },
        });
      }
      return updated;
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: service.organizationId,
      action: 'appointment.service_updated',
      entityType: 'appointment_service',
      entityId: service.id,
    });

    return this.toServiceResponse(service);
  }

  async listResources(
    currentUser: AuthenticatedUser,
    requestedOrganizationId?: string,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      requestedOrganizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);
    const resources = await this.prisma.appointmentResource.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
    return resources.map((resource) => this.toResourceResponse(resource));
  }

  async createResource(
    currentUser: AuthenticatedUser,
    input: CreateAppointmentResourceDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);
    const resource = await this.prisma.appointmentResource.create({
      data: {
        organizationId,
        name: input.name,
        type: input.type ?? 'generic',
        capacity: input.capacity ?? 1,
        status: input.status ?? 'active',
        metadata: this.toJsonObject(input.metadata),
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.resource_created',
      entityType: 'appointment_resource',
      entityId: resource.id,
    });
    return this.toResourceResponse(resource);
  }

  async updateResource(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAppointmentResourceDto,
  ) {
    const existing = await this.findResourceForActor(currentUser, id);
    if (input.capacity !== undefined) {
      const largestRequirement =
        await this.prisma.appointmentServiceResource.aggregate({
          where: { resourceId: id },
          _max: { quantity: true },
        });
      if ((largestRequirement._max.quantity ?? 0) > input.capacity) {
        throw new ConflictException(
          'Resource capacity is below an existing service requirement',
        );
      }
      const peakAllocated = await this.getPeakResourceAllocation(id);
      if (peakAllocated > input.capacity) {
        throw new ConflictException(
          'Resource capacity is below existing concurrent booking allocations',
        );
      }
    }
    const resource = await this.prisma.appointmentResource.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        capacity: input.capacity,
        status: input.status,
        metadata: input.metadata
          ? this.toJsonObject(input.metadata)
          : undefined,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: existing.organizationId,
      action: 'appointment.resource_updated',
      entityType: 'appointment_resource',
      entityId: resource.id,
    });
    return this.toResourceResponse(resource);
  }

  async setServiceResource(
    currentUser: AuthenticatedUser,
    serviceId: string,
    input: SetServiceResourceDto,
  ) {
    const service = await this.findServiceForActor(currentUser, serviceId);
    const resource = await this.prisma.appointmentResource.findFirst({
      where: {
        id: input.resourceId,
        organizationId: service.organizationId,
        status: 'active',
      },
    });
    if (!resource)
      throw new NotFoundException('Appointment resource not found');
    const quantity = input.quantity ?? 1;
    if (quantity > resource.capacity) {
      throw new BadRequestException(
        'Required quantity exceeds resource capacity',
      );
    }
    const requirement = await this.prisma.appointmentServiceResource.upsert({
      where: {
        serviceId_resourceId: {
          serviceId: service.id,
          resourceId: resource.id,
        },
      },
      create: { serviceId: service.id, resourceId: resource.id, quantity },
      update: { quantity },
      include: { resource: true },
    });
    return requirement;
  }

  async listServiceResources(
    currentUser: AuthenticatedUser,
    serviceId: string,
  ) {
    await this.findServiceForActor(currentUser, serviceId);
    return this.prisma.appointmentServiceResource.findMany({
      where: { serviceId },
      include: { resource: true },
      orderBy: { resource: { name: 'asc' } },
    });
  }

  async removeServiceResource(
    currentUser: AuthenticatedUser,
    serviceId: string,
    resourceId: string,
  ) {
    await this.findServiceForActor(currentUser, serviceId);
    await this.prisma.appointmentServiceResource.deleteMany({
      where: { serviceId, resourceId },
    });
    return { removed: true };
  }

  async createResourceTimeOff(
    currentUser: AuthenticatedUser,
    resourceId: string,
    input: CreateStaffTimeOffDto,
  ) {
    const resource = await this.findResourceForActor(currentUser, resourceId);
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    this.assertDateRange(startAt, endAt);
    return this.prisma.appointmentResourceTimeOff.create({
      data: {
        organizationId: resource.organizationId,
        resourceId,
        startAt,
        endAt,
        reason: input.reason,
      },
    });
  }

  async listResourceTimeOff(
    currentUser: AuthenticatedUser,
    resourceId: string,
  ) {
    await this.findResourceForActor(currentUser, resourceId);
    return this.prisma.appointmentResourceTimeOff.findMany({
      where: { resourceId },
      orderBy: { startAt: 'asc' },
    });
  }

  async deleteResourceTimeOff(
    currentUser: AuthenticatedUser,
    resourceId: string,
    timeOffId: string,
  ) {
    await this.findResourceForActor(currentUser, resourceId);
    const deleted = await this.prisma.appointmentResourceTimeOff.deleteMany({
      where: { id: timeOffId, resourceId },
    });
    if (!deleted.count)
      throw new NotFoundException('Resource time off not found');
    return { removed: true };
  }

  async listStaff(currentUser: AuthenticatedUser, organizationId?: string) {
    const resolvedOrganizationId = this.resolveOrganizationId(
      currentUser,
      organizationId,
    );
    await this.assertAppointmentBookingEnabled(resolvedOrganizationId);

    const staff = await this.prisma.appointmentStaff.findMany({
      where: { organizationId: resolvedOrganizationId },
      include: this.staffInclude(),
      orderBy: { name: 'asc' },
    });

    return staff.map((item) => this.toStaffResponse(item));
  }

  async createStaff(
    currentUser: AuthenticatedUser,
    input: CreateAppointmentStaffDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);
    await this.assertUserBelongsToOrganization(organizationId, input.userId);
    await this.assertServicesBelongToOrganization(
      organizationId,
      input.serviceIds,
    );
    await this.assertResourcesBelongToOrganization(
      organizationId,
      input.resourceIds,
    );
    this.timezoneService.assertValid(input.timezone ?? 'UTC');

    const staff = await this.prisma.appointmentStaff.create({
      data: {
        organizationId,
        userId: input.userId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        timezone: input.timezone ?? 'UTC',
        status: input.status ?? 'active',
        metadata: this.toJsonObject(input.metadata),
        services: {
          create: (input.serviceIds ?? []).map((serviceId) => ({
            serviceId,
          })),
        },
        resources: {
          create: (input.resourceIds ?? []).map((resourceId) => ({
            resourceId,
          })),
        },
      },
      include: this.staffInclude(),
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.staff_created',
      entityType: 'appointment_staff',
      entityId: staff.id,
      metadata: { name: staff.name },
    });

    return this.toStaffResponse(staff);
  }

  async updateStaff(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAppointmentStaffDto,
  ) {
    const existing = await this.findStaffForActor(currentUser, id);
    await this.assertUserBelongsToOrganization(
      existing.organizationId,
      input.userId,
    );
    await this.assertServicesBelongToOrganization(
      existing.organizationId,
      input.serviceIds,
    );
    await this.assertResourcesBelongToOrganization(
      existing.organizationId,
      input.resourceIds,
    );
    if (input.timezone) {
      this.timezoneService.assertValid(input.timezone);
    }

    const staff = await this.prisma.$transaction(async (tx) => {
      if (input.serviceIds) {
        await tx.appointmentStaffService.deleteMany({
          where: { staffId: existing.id },
        });
      }
      if (input.resourceIds) {
        await tx.appointmentStaffResource.deleteMany({
          where: { staffId: existing.id },
        });
      }

      return tx.appointmentStaff.update({
        where: { id: existing.id },
        data: {
          userId: input.userId,
          name: input.name,
          email: input.email,
          phone: input.phone,
          timezone: input.timezone,
          status: input.status,
          metadata: input.metadata
            ? this.toJsonObject(input.metadata)
            : undefined,
          services: input.serviceIds
            ? {
                create: input.serviceIds.map((serviceId) => ({
                  serviceId,
                })),
              }
            : undefined,
          resources: input.resourceIds
            ? {
                create: input.resourceIds.map((resourceId) => ({ resourceId })),
              }
            : undefined,
        },
        include: this.staffInclude(),
      });
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: staff.organizationId,
      action: 'appointment.staff_updated',
      entityType: 'appointment_staff',
      entityId: staff.id,
    });

    return this.toStaffResponse(staff);
  }

  async listStaffAvailability(currentUser: AuthenticatedUser, staffId: string) {
    const staff = await this.findStaffForActor(currentUser, staffId);

    const availability =
      await this.prisma.appointmentStaffAvailability.findMany({
        where: { staffId: staff.id },
        orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
      });

    return availability.map((item) => this.toAvailabilityResponse(item));
  }

  async createStaffAvailability(
    currentUser: AuthenticatedUser,
    staffId: string,
    input: SetStaffAvailabilityDto,
  ) {
    const staff = await this.findStaffForActor(currentUser, staffId);
    this.assertTimeRange(input.startTime, input.endTime);

    const availability = await this.prisma.appointmentStaffAvailability.create({
      data: {
        organizationId: staff.organizationId,
        staffId: staff.id,
        dayOfWeek: input.dayOfWeek,
        startTime: input.startTime,
        endTime: input.endTime,
        isActive: input.isActive ?? true,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: staff.organizationId,
      action: 'appointment.availability_created',
      entityType: 'appointment_staff_availability',
      entityId: availability.id,
    });

    return this.toAvailabilityResponse(availability);
  }

  async deleteStaffAvailability(
    currentUser: AuthenticatedUser,
    staffId: string,
    availabilityId: string,
  ) {
    await this.findStaffForActor(currentUser, staffId);
    const deleted = await this.prisma.appointmentStaffAvailability.deleteMany({
      where: { id: availabilityId, staffId },
    });
    if (!deleted.count)
      throw new NotFoundException('Staff availability not found');
    return { removed: true };
  }

  async listStaffTimeOff(currentUser: AuthenticatedUser, staffId: string) {
    const staff = await this.findStaffForActor(currentUser, staffId);

    const timeOff = await this.prisma.appointmentStaffTimeOff.findMany({
      where: { staffId: staff.id },
      orderBy: { startAt: 'asc' },
    });

    return timeOff.map((item) => this.toTimeOffResponse(item));
  }

  async createStaffTimeOff(
    currentUser: AuthenticatedUser,
    staffId: string,
    input: CreateStaffTimeOffDto,
  ) {
    const staff = await this.findStaffForActor(currentUser, staffId);
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    this.assertDateRange(startAt, endAt);

    const timeOff = await this.prisma.appointmentStaffTimeOff.create({
      data: {
        organizationId: staff.organizationId,
        staffId: staff.id,
        startAt,
        endAt,
        reason: input.reason,
      },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId: staff.organizationId,
      action: 'appointment.time_off_created',
      entityType: 'appointment_staff_time_off',
      entityId: timeOff.id,
    });

    return this.toTimeOffResponse(timeOff);
  }

  async deleteStaffTimeOff(
    currentUser: AuthenticatedUser,
    staffId: string,
    timeOffId: string,
  ) {
    await this.findStaffForActor(currentUser, staffId);
    const deleted = await this.prisma.appointmentStaffTimeOff.deleteMany({
      where: { id: timeOffId, staffId },
    });
    if (!deleted.count) throw new NotFoundException('Staff time off not found');
    return { removed: true };
  }

  async listAvailability(
    currentUser: AuthenticatedUser,
    input: ListAvailabilityDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);
    return this.listAvailableSlots(organizationId, input);
  }

  async listPublicAvailability(input: PublicListAvailabilityDto) {
    await this.assertAppointmentBookingEnabled(input.organizationId);
    return this.listAvailableSlots(input.organizationId, input);
  }

  async listPublicWaitlistSessions(input: PublicListAvailabilityDto) {
    await this.assertAppointmentBookingEnabled(input.organizationId);
    const service = await this.findActiveService(
      input.organizationId,
      input.serviceId,
    );
    if (!service.waitlistEnabled) return [];
    const timezone = input.timezone ?? 'UTC';
    this.timezoneService.assertValid(timezone);
    const dayStart = this.timezoneService.startOfDay(input.date, timezone);
    const dayEnd = this.timezoneService.nextDayStart(input.date, timezone);
    const bookings = await this.prisma.appointmentBooking.findMany({
      where: {
        organizationId: input.organizationId,
        serviceId: service.id,
        staffId: input.staffId,
        status: { in: ['pending', 'confirmed'] },
        startAt: { gte: dayStart, lt: dayEnd, gt: new Date() },
      },
      include: { staff: { select: { id: true, name: true, timezone: true } } },
      orderBy: { startAt: 'asc' },
    });
    const sessions = new Map<
      string,
      {
        staffId: string;
        staffName: string;
        startAt: Date;
        endAt: Date;
        timezone: string;
        partySize: number;
      }
    >();
    for (const booking of bookings) {
      const key = `${booking.staffId}:${booking.startAt.toISOString()}`;
      const existing = sessions.get(key);
      if (existing) existing.partySize += booking.partySize;
      else {
        sessions.set(key, {
          staffId: booking.staff.id,
          staffName: booking.staff.name,
          startAt: booking.startAt,
          endAt: booking.endAt,
          timezone: booking.staff.timezone,
          partySize: booking.partySize,
        });
      }
    }
    return [...sessions.values()].map((session) => ({
      staffId: session.staffId,
      staffName: session.staffName,
      startAt: session.startAt,
      endAt: session.endAt,
      timezone: session.timezone,
      seatsRemaining: Math.max(0, service.maxAttendees - session.partySize),
    }));
  }

  async listBookings(
    currentUser: AuthenticatedUser,
    input: ListAppointmentBookingsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    await this.assertAppointmentBookingEnabled(organizationId);

    const where: Prisma.AppointmentBookingWhereInput = {
      organizationId,
      status: input.status,
      serviceId: input.serviceId,
      staffId: input.staffId,
      startAt: {
        ...(input.from ? { gte: new Date(input.from) } : {}),
        ...(input.to ? { lte: new Date(input.to) } : {}),
      },
    };
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const [total, data] = await this.prisma.$transaction([
      this.prisma.appointmentBooking.count({ where }),
      this.prisma.appointmentBooking.findMany({
        where,
        orderBy: { startAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: data.map((booking) => this.toBookingResponse(booking)),
      total,
      page,
      limit,
    };
  }

  async createBooking(
    currentUser: AuthenticatedUser,
    input: CreateAppointmentBookingDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    if (input.recurrence) {
      return this.createRecurringBooking(organizationId, input, currentUser);
    }
    const { booking, manageToken } = await this.createBookingForOrganization(
      organizationId,
      input,
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'appointment.booking_created',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: {
        serviceId: booking.serviceId,
        staffId: booking.staffId,
        startAt: booking.startAt.toISOString(),
      },
    });
    await this.reminderQueueService.enqueueBookingReminders({
      bookingId: booking.id,
      organizationId,
      serviceId: booking.serviceId,
      startAt: booking.startAt,
      timezone: booking.timezone,
    });
    await this.calendarService.scheduleBookingSync({ booking });

    return this.toBookingResponse(booking, manageToken);
  }

  async createPublicBooking(input: PublicCreateAppointmentBookingDto) {
    if (input.recurrence) {
      return this.createRecurringBooking(input.organizationId, input);
    }
    const { booking, manageToken } = await this.createBookingForOrganization(
      input.organizationId,
      input,
    );

    await this.auditService.record({
      organizationId: input.organizationId,
      action: 'appointment.public_booking_created',
      entityType: 'appointment_booking',
      entityId: booking.id,
      metadata: {
        serviceId: booking.serviceId,
        staffId: booking.staffId,
        startAt: booking.startAt.toISOString(),
      },
    });
    await this.reminderQueueService.enqueueBookingReminders({
      bookingId: booking.id,
      organizationId: input.organizationId,
      serviceId: booking.serviceId,
      startAt: booking.startAt,
      timezone: booking.timezone,
    });
    await this.calendarService.scheduleBookingSync({ booking });

    return this.toBookingResponse(booking, manageToken);
  }

  async rescheduleBooking(
    currentUser: AuthenticatedUser,
    id: string,
    input: RescheduleAppointmentBookingDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);

    return this.rescheduleBookingRecord(booking, input, currentUser);
  }

  async reschedulePublicBooking(
    id: string,
    input: PublicRescheduleAppointmentBookingDto,
  ) {
    const booking = await this.findPublicManageableBooking(
      id,
      input.organizationId,
      input.manageToken,
    );
    return this.rescheduleBookingRecord(booking, input);
  }

  private async rescheduleBookingRecord(
    booking: AppointmentBooking,
    input: RescheduleAppointmentBookingDto,
    actor?: AuthenticatedUser,
  ) {
    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      throw new ConflictException('Booking cannot be rescheduled');
    }

    const service = await this.findActiveService(
      booking.organizationId,
      booking.serviceId,
    );
    await this.assertPublicChangeWindow(
      booking,
      service.rescheduleWindowMinutes,
      'reschedule',
      actor,
    );
    if (input.applyToFuture && booking.seriesId !== null) {
      return this.rescheduleFutureOccurrences(booking, service, input, actor);
    }
    const staffId = input.staffId ?? booking.staffId;
    const staff = await this.findActiveStaffForService(
      booking.organizationId,
      staffId,
      service.id,
    );
    const startAt = new Date(input.startAt);
    this.assertBookableStart(startAt);
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? booking.timezone;
    this.timezoneService.assertValid(timezone);

    await this.assertSlotIsAvailable({
      organizationId: booking.organizationId,
      service,
      staff,
      startAt,
      endAt,
      excludeBookingId: booking.id,
      partySize: booking.partySize,
    });

    const updated = await this.runSerializable(async (tx) => {
      await this.assertNoConflict(tx, {
        organizationId: booking.organizationId,
        service,
        staffId: staff.id,
        startAt,
        endAt,
        excludeBookingId: booking.id,
        partySize: booking.partySize,
      });
      const resourceRequirements = await tx.appointmentServiceResource.findMany(
        {
          where: { serviceId: service.id },
          select: { resourceId: true, quantity: true },
        },
      );
      await tx.appointmentBookingResource.deleteMany({
        where: { bookingId: booking.id },
      });
      if (resourceRequirements.length) {
        await tx.appointmentBookingResource.createMany({
          data: resourceRequirements.map((requirement) => ({
            bookingId: booking.id,
            resourceId: requirement.resourceId,
            quantity: requirement.quantity,
          })),
        });
      }

      return tx.appointmentBooking.update({
        where: { id: booking.id },
        data: {
          staffId: staff.id,
          startAt,
          endAt,
          timezone,
          status: 'confirmed',
          rescheduledFromId: booking.rescheduledFromId ?? booking.id,
        },
      });
    });

    await this.auditService.record({
      actor,
      organizationId: updated.organizationId,
      action: 'appointment.booking_rescheduled',
      entityType: 'appointment_booking',
      entityId: updated.id,
      metadata: {
        staffId: updated.staffId,
        startAt: updated.startAt.toISOString(),
      },
    });
    await this.reminderQueueService.enqueueBookingReminders({
      bookingId: updated.id,
      organizationId: updated.organizationId,
      serviceId: updated.serviceId,
      startAt: updated.startAt,
      timezone: updated.timezone,
    });
    await this.calendarService.scheduleBookingSync({
      booking: updated,
      previousStaffId: booking.staffId,
    });

    return this.toBookingResponse(updated);
  }

  private async rescheduleFutureOccurrences(
    booking: AppointmentBooking,
    service: AppointmentService,
    input: RescheduleAppointmentBookingDto,
    actor?: AuthenticatedUser,
  ) {
    const occurrences = await this.prisma.appointmentBooking.findMany({
      where: {
        seriesId: booking.seriesId!,
        occurrenceIndex: { gte: booking.occurrenceIndex ?? 0 },
        status: { in: ['pending', 'confirmed'] },
      },
      orderBy: { occurrenceIndex: 'asc' },
    });
    if (!occurrences.length) {
      throw new ConflictException('No future occurrences can be rescheduled');
    }
    if (!actor) {
      for (const occurrence of occurrences) {
        await this.assertPublicChangeWindow(
          occurrence,
          service.rescheduleWindowMinutes,
          'reschedule',
        );
      }
    }
    const staffId = input.staffId ?? booking.staffId;
    const staff = await this.findActiveStaffForService(
      booking.organizationId,
      staffId,
      service.id,
    );
    const requestedStart = new Date(input.startAt);
    this.assertBookableStart(requestedStart);
    const shiftMs = requestedStart.getTime() - booking.startAt.getTime();
    const timezone = input.timezone ?? booking.timezone;
    this.timezoneService.assertValid(timezone);
    const shifted = occurrences.map((occurrence) => ({
      occurrence,
      startAt: new Date(occurrence.startAt.getTime() + shiftMs),
      endAt: new Date(occurrence.endAt.getTime() + shiftMs),
    }));
    for (const item of shifted) {
      this.assertBookableStart(item.startAt);
      if (!(await this.isInsideAvailability(staff, item.startAt, item.endAt))) {
        throw new ConflictException(
          `Occurrence ${item.occurrence.occurrenceIndex} is outside staff availability`,
        );
      }
      if (
        await this.calendarService.hasExternalConflict(
          staff.id,
          this.addMinutes(item.startAt, -service.bufferBeforeMinutes),
          this.addMinutes(item.endAt, service.bufferAfterMinutes),
        )
      ) {
        throw new ConflictException(
          `Occurrence ${item.occurrence.occurrenceIndex} conflicts with an external calendar`,
        );
      }
    }

    const updated = await this.runSerializable(async (tx) => {
      await tx.appointmentBooking.updateMany({
        where: { id: { in: occurrences.map((item) => item.id) } },
        data: { status: 'cancelled' },
      });
      const results: AppointmentBooking[] = [];
      for (const item of shifted) {
        await this.assertNoConflict(tx, {
          organizationId: booking.organizationId,
          service,
          staffId: staff.id,
          startAt: item.startAt,
          endAt: item.endAt,
          partySize: item.occurrence.partySize,
        });
        results.push(
          await tx.appointmentBooking.update({
            where: { id: item.occurrence.id },
            data: {
              staffId: staff.id,
              startAt: item.startAt,
              endAt: item.endAt,
              timezone,
              status: 'confirmed',
              rescheduledFromId:
                item.occurrence.rescheduledFromId ?? item.occurrence.id,
            },
          }),
        );
      }
      await tx.appointmentRecurrenceSeries.update({
        where: { id: booking.seriesId! },
        data: {
          staffId: staff.id,
          timezone,
          initialStartAt:
            booking.occurrenceIndex === 0 ? requestedStart : undefined,
        },
      });
      return results;
    });

    await Promise.all(
      updated.map(async (item, index) => {
        await this.reminderQueueService.enqueueBookingReminders({
          bookingId: item.id,
          organizationId: item.organizationId,
          serviceId: item.serviceId,
          startAt: item.startAt,
          timezone: item.timezone,
        });
        await this.calendarService.scheduleBookingSync({
          booking: item,
          previousStaffId: occurrences[index].staffId,
        });
      }),
    );
    await this.auditService.record({
      actor,
      organizationId: booking.organizationId,
      action: 'appointment.recurrence_future_rescheduled',
      entityType: 'appointment_recurrence_series',
      entityId: booking.seriesId,
      metadata: { fromOccurrenceIndex: booking.occurrenceIndex },
    });
    return {
      seriesId: booking.seriesId,
      bookings: updated.map((item) => this.toBookingResponse(item)),
    };
  }

  async cancelBooking(
    currentUser: AuthenticatedUser,
    id: string,
    input: CancelAppointmentBookingDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);

    return this.cancelBookingRecord(booking, input, currentUser);
  }

  async cancelPublicBooking(
    id: string,
    input: PublicCancelAppointmentBookingDto,
  ) {
    const booking = await this.findPublicManageableBooking(
      id,
      input.organizationId,
      input.manageToken,
    );
    return this.cancelBookingRecord(booking, input);
  }

  private async cancelBookingRecord(
    booking: AppointmentBooking,
    input: CancelAppointmentBookingDto,
    actor?: AuthenticatedUser,
  ) {
    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      throw new ConflictException('Booking cannot be cancelled');
    }

    const service = await this.findActiveService(
      booking.organizationId,
      booking.serviceId,
    );
    await this.assertPublicChangeWindow(
      booking,
      service.cancellationWindowMinutes,
      'cancel',
      actor,
    );

    const updated = await this.prisma.appointmentBooking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        cancellationReason: input.reason,
      },
    });
    await this.reminderQueueService.cancelBookingReminders(updated.id);
    await this.calendarService.scheduleBookingSync({
      booking: updated,
      operation: 'delete',
    });
    await this.offerNextWaitlist(updated);

    await this.auditService.record({
      actor,
      organizationId: updated.organizationId,
      action: 'appointment.booking_cancelled',
      entityType: 'appointment_booking',
      entityId: updated.id,
      metadata: {
        reason: input.reason,
      },
    });

    return this.toBookingResponse(updated);
  }

  async updateBookingStatus(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateAppointmentBookingStatusDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);
    this.assertStatusTransition(booking.status, input.status);

    const updated = await this.prisma.appointmentBooking.update({
      where: { id: booking.id },
      data: { status: input.status },
    });
    if (['cancelled', 'completed', 'no_show'].includes(updated.status)) {
      await this.reminderQueueService.cancelBookingReminders(updated.id);
      await this.calendarService.scheduleBookingSync({
        booking: updated,
        operation: 'delete',
      });
    } else if (updated.status === 'confirmed') {
      await this.reminderQueueService.enqueueBookingReminders({
        bookingId: updated.id,
        organizationId: updated.organizationId,
        serviceId: updated.serviceId,
        startAt: updated.startAt,
        timezone: updated.timezone,
      });
      await this.calendarService.scheduleBookingSync({ booking: updated });
    }

    await this.auditService.record({
      actor: currentUser,
      organizationId: updated.organizationId,
      action: 'appointment.booking_status_updated',
      entityType: 'appointment_booking',
      entityId: updated.id,
      metadata: {
        status: input.status,
      },
    });

    return this.toBookingResponse(updated);
  }

  private async createRecurringBooking(
    organizationId: string,
    input: CreateAppointmentBookingDto,
    actor?: AuthenticatedUser,
  ) {
    const recurrence = input.recurrence;
    if (!recurrence) {
      throw new BadRequestException('Recurrence rule is required');
    }
    await this.assertAppointmentBookingEnabled(organizationId);
    const service = await this.findActiveService(
      organizationId,
      input.serviceId,
    );
    const timezone = input.timezone ?? 'UTC';
    this.timezoneService.assertValid(timezone);
    const firstStart = new Date(input.startAt);
    this.assertBookableStart(firstStart);
    const partySize = input.partySize ?? 1;
    if (partySize > service.maxAttendees) {
      throw new BadRequestException(
        `Party size cannot exceed service capacity of ${service.maxAttendees}`,
      );
    }
    const firstEnd = this.addMinutes(firstStart, service.durationMinutes);
    const staff = input.staffId
      ? await this.findActiveStaffForService(
          organizationId,
          input.staffId,
          service.id,
        )
      : await this.findFirstAvailableStaff({
          organizationId,
          service,
          startAt: firstStart,
          endAt: firstEnd,
          partySize,
        });
    const localDate = this.timezoneService.dateInZone(firstStart, timezone);
    const localTime = this.timezoneService.timeInZone(firstStart, timezone);
    const occurrences = Array.from({ length: recurrence.count }, (_, index) => {
      const step = index * recurrence.interval;
      const date =
        recurrence.frequency === AppointmentRecurrenceFrequencyDto.monthly
          ? this.timezoneService.addLocalMonths(localDate, step)
          : this.timezoneService.addLocalDays(
              localDate,
              recurrence.frequency === AppointmentRecurrenceFrequencyDto.weekly
                ? step * 7
                : step,
            );
      const startAt = this.timezoneService.localToUtc(
        date,
        localTime,
        timezone,
      );
      this.assertBookableStart(startAt);
      return {
        index,
        startAt,
        endAt: this.addMinutes(startAt, service.durationMinutes),
      };
    });

    for (const occurrence of occurrences) {
      await this.assertSlotIsAvailable({
        organizationId,
        service,
        staff,
        startAt: occurrence.startAt,
        endAt: occurrence.endAt,
        partySize,
      });
    }

    const manageToken = randomBytes(32).toString('base64url');
    const result = await this.runSerializable(async (tx) => {
      const resourceRequirements = await tx.appointmentServiceResource.findMany(
        {
          where: { serviceId: service.id },
          select: { resourceId: true, quantity: true },
        },
      );
      const series = await tx.appointmentRecurrenceSeries.create({
        data: {
          organizationId,
          serviceId: service.id,
          staffId: staff.id,
          frequency: recurrence.frequency,
          interval: recurrence.interval,
          occurrenceCount: recurrence.count,
          initialStartAt: firstStart,
          timezone,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          partySize,
          notes: input.notes,
          manageTokenHash: this.hashManageToken(manageToken),
          metadata: this.toJsonObject(input.metadata),
        },
      });
      const bookings: AppointmentBooking[] = [];
      for (const occurrence of occurrences) {
        await this.assertNoConflict(tx, {
          organizationId,
          service,
          staffId: staff.id,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
          partySize,
        });
        bookings.push(
          await tx.appointmentBooking.create({
            data: {
              organizationId,
              serviceId: service.id,
              staffId: staff.id,
              customerName: input.customerName,
              customerEmail: input.customerEmail,
              customerPhone: input.customerPhone,
              startAt: occurrence.startAt,
              endAt: occurrence.endAt,
              timezone,
              notes: input.notes,
              manageTokenHash: this.hashManageToken(manageToken),
              partySize,
              isGroupBooking: service.maxAttendees > 1,
              seriesId: series.id,
              occurrenceIndex: occurrence.index,
              metadata: this.toJsonObject(input.metadata),
              resourceAllocations: {
                create: resourceRequirements.map((requirement) => ({
                  resourceId: requirement.resourceId,
                  quantity: requirement.quantity,
                })),
              },
            },
          }),
        );
      }
      return { series, bookings };
    });

    await Promise.all(
      result.bookings.map((booking) => this.afterBookingCreated(booking)),
    );
    await this.auditService.record({
      actor,
      organizationId,
      action: 'appointment.recurrence_series_created',
      entityType: 'appointment_recurrence_series',
      entityId: result.series.id,
      metadata: {
        frequency: recurrence.frequency,
        interval: recurrence.interval,
        occurrenceCount: recurrence.count,
      },
    });
    return {
      series: { ...result.series, manageTokenHash: undefined, manageToken },
      bookings: result.bookings.map((booking) =>
        this.toBookingResponse(booking),
      ),
    };
  }

  private async createBookingForOrganization(
    organizationId: string,
    input: CreateAppointmentBookingDto,
  ): Promise<BookingCreationResult> {
    await this.assertAppointmentBookingEnabled(organizationId);
    const service = await this.findActiveService(
      organizationId,
      input.serviceId,
    );
    const startAt = new Date(input.startAt);
    this.assertBookableStart(startAt);
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? 'UTC';
    this.timezoneService.assertValid(timezone);
    const partySize = input.partySize ?? 1;
    if (partySize > service.maxAttendees) {
      throw new BadRequestException(
        `Party size cannot exceed service capacity of ${service.maxAttendees}`,
      );
    }
    const staff = input.staffId
      ? await this.findActiveStaffForService(
          organizationId,
          input.staffId,
          service.id,
        )
      : await this.findFirstAvailableStaff({
          organizationId,
          service,
          startAt,
          endAt,
          partySize,
        });

    await this.assertSlotIsAvailable({
      organizationId,
      service,
      staff,
      startAt,
      endAt,
      partySize,
    });

    const manageToken = randomBytes(32).toString('base64url');
    const booking = await this.runSerializable(async (tx) => {
      await this.assertNoConflict(tx, {
        organizationId,
        service,
        staffId: staff.id,
        startAt,
        endAt,
        partySize,
      });
      const resourceRequirements = await tx.appointmentServiceResource.findMany(
        {
          where: { serviceId: service.id },
          select: { resourceId: true, quantity: true },
        },
      );

      return tx.appointmentBooking.create({
        data: {
          organizationId,
          serviceId: service.id,
          staffId: staff.id,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          startAt,
          endAt,
          timezone,
          notes: input.notes,
          manageTokenHash: this.hashManageToken(manageToken),
          partySize,
          isGroupBooking: service.maxAttendees > 1,
          metadata: this.toJsonObject(input.metadata),
          resourceAllocations: {
            create: resourceRequirements.map((requirement) => ({
              resourceId: requirement.resourceId,
              quantity: requirement.quantity,
            })),
          },
        },
      });
    });
    return { booking, manageToken };
  }

  private async afterBookingCreated(booking: AppointmentBooking) {
    await this.reminderQueueService.enqueueBookingReminders({
      bookingId: booking.id,
      organizationId: booking.organizationId,
      serviceId: booking.serviceId,
      startAt: booking.startAt,
      timezone: booking.timezone,
    });
    await this.calendarService.scheduleBookingSync({ booking });
  }

  private async offerNextWaitlist(cancelledBooking: AppointmentBooking) {
    const service = await this.prisma.appointmentService.findUnique({
      where: { id: cancelledBooking.serviceId },
    });
    if (!service?.waitlistEnabled || cancelledBooking.startAt <= new Date()) {
      return;
    }
    const candidates = await this.prisma.appointmentWaitlistEntry.findMany({
      where: {
        serviceId: cancelledBooking.serviceId,
        staffId: cancelledBooking.staffId,
        startAt: cancelledBooking.startAt,
        status: 'waiting',
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    });
    const seatsRemaining = await this.getSeatsRemaining(
      service,
      cancelledBooking.staffId,
      cancelledBooking.startAt,
      cancelledBooking.endAt,
    );
    const candidate = candidates.find(
      (entry) => entry.partySize <= seatsRemaining,
    );
    if (!candidate) return;
    await this.offerWaitlistEntry(candidate);
  }

  private async offerWaitlistEntry(
    candidate: Prisma.AppointmentWaitlistEntryGetPayload<object>,
  ) {
    const policy = await this.prisma.appointmentBookingPolicy.findUnique({
      where: { organizationId: candidate.organizationId },
    });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + (policy?.waitlistOfferMinutes ?? 15) * 60_000,
    );
    const transitioned = await this.prisma.appointmentWaitlistEntry.updateMany({
      where: { id: candidate.id, status: 'waiting' },
      data: {
        status: 'offered',
        offerTokenHash: this.hashManageToken(token),
        offerExpiresAt: expiresAt,
      },
    });
    if (!transitioned.count) return;

    const publicUrl = this.configService.get<string>('APPOINTMENT_PUBLIC_URL');
    const claimUrl = publicUrl
      ? new URL('/appointment-waitlist/claim', publicUrl)
      : undefined;
    claimUrl?.searchParams.set('organizationId', candidate.organizationId);
    claimUrl?.searchParams.set('offerToken', token);
    try {
      await this.reminderDeliveryService.deliverTransactional({
        email: candidate.customerEmail,
        phone: candidate.customerPhone,
        subject: 'An appointment slot is available',
        message: `A requested appointment slot is available until ${expiresAt.toISOString()}.${claimUrl ? ` Claim it here: ${claimUrl.toString()}` : ` Offer token: ${token}`}`,
      });
    } catch (error) {
      this.logger.error(
        `Waitlist offer delivery failed for ${candidate.id}`,
        error,
      );
      await this.auditService.record({
        organizationId: candidate.organizationId,
        action: 'appointment.waitlist_offer_delivery_failed',
        entityType: 'appointment_waitlist_entry',
        entityId: candidate.id,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    await this.auditService.record({
      organizationId: candidate.organizationId,
      action: 'appointment.waitlist_offered',
      entityType: 'appointment_waitlist_entry',
      entityId: candidate.id,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
  }

  private async listAvailableSlots(
    organizationId: string,
    input: ListAvailabilityDto,
  ) {
    const service = await this.findActiveService(
      organizationId,
      input.serviceId,
    );
    const requestedTimezone = input.timezone ?? 'UTC';
    this.timezoneService.assertValid(requestedTimezone);
    const dayStart = this.timezoneService.startOfDay(
      input.date,
      requestedTimezone,
    );
    const dayEnd = this.timezoneService.nextDayStart(
      input.date,
      requestedTimezone,
    );

    const staff = await this.prisma.appointmentStaff.findMany({
      where: {
        organizationId,
        status: 'active',
        ...(input.staffId ? { id: input.staffId } : {}),
        services: { some: { serviceId: service.id } },
        availability: { some: { isActive: true } },
      },
      include: {
        availability: {
          where: { isActive: true },
          orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
        },
      },
      orderBy: { name: 'asc' },
    });

    const slots: Array<{
      staffId: string;
      staffName: string;
      startAt: Date;
      endAt: Date;
      timezone: string;
      seatsRemaining: number;
    }> = [];

    for (const staffMember of staff) {
      this.timezoneService.assertValid(staffMember.timezone);
      const externalBusy = await this.calendarService.listExternalBusyIntervals(
        staffMember.id,
        this.addMinutes(dayStart, -service.bufferBeforeMinutes),
        this.addMinutes(dayEnd, service.bufferAfterMinutes),
      );
      const localDates = new Set([
        this.timezoneService.dateInZone(dayStart, staffMember.timezone),
        this.timezoneService.dateInZone(
          new Date(dayEnd.getTime() - 1),
          staffMember.timezone,
        ),
      ]);

      for (const localDate of localDates) {
        const dayOfWeek = this.timezoneService.dayOfWeek(localDate);
        const windows = staffMember.availability.filter(
          (availability) => availability.dayOfWeek === dayOfWeek,
        );

        for (const availability of windows) {
          const windowStart = this.timezoneService.localToUtc(
            localDate,
            availability.startTime,
            staffMember.timezone,
          );
          const windowEnd = this.timezoneService.localToUtc(
            localDate,
            availability.endTime,
            staffMember.timezone,
          );
          let cursor = new Date(windowStart);

          while (
            this.addMinutes(cursor, service.durationMinutes) <= windowEnd
          ) {
            const startAt = new Date(cursor);
            const endAt = this.addMinutes(startAt, service.durationMinutes);
            const isInRequestedDay = startAt >= dayStart && startAt < dayEnd;
            const hasInternalConflict = isInRequestedDay
              ? await this.hasConflict(
                  {
                    organizationId,
                    service,
                    staffId: staffMember.id,
                    startAt,
                    endAt,
                  },
                  this.prisma,
                  false,
                )
              : true;
            const conflictStart = this.addMinutes(
              startAt,
              -service.bufferBeforeMinutes,
            );
            const conflictEnd = this.addMinutes(
              endAt,
              service.bufferAfterMinutes,
            );
            const hasExternalConflict = externalBusy.some(
              (busy) =>
                busy.startAt < conflictEnd && busy.endAt > conflictStart,
            );
            const isWithinBookingWindow = this.isWithinBookingWindow(startAt);

            if (
              !hasInternalConflict &&
              !hasExternalConflict &&
              isWithinBookingWindow
            ) {
              const seatsRemaining = await this.getSeatsRemaining(
                service,
                staffMember.id,
                startAt,
                endAt,
              );
              slots.push({
                staffId: staffMember.id,
                staffName: staffMember.name,
                startAt,
                endAt,
                timezone: staffMember.timezone,
                seatsRemaining,
              });
            }

            cursor = this.addMinutes(cursor, service.durationMinutes);
          }
        }
      }
    }

    return slots.sort(
      (left, right) =>
        left.startAt.getTime() - right.startAt.getTime() ||
        left.staffName.localeCompare(right.staffName),
    );
  }

  private async findFirstAvailableStaff(input: {
    organizationId: string;
    service: AppointmentService;
    startAt: Date;
    endAt: Date;
    partySize?: number;
  }): Promise<AppointmentStaff> {
    const staff = await this.prisma.appointmentStaff.findMany({
      where: {
        organizationId: input.organizationId,
        status: 'active',
        services: { some: { serviceId: input.service.id } },
      },
      orderBy: { name: 'asc' },
    });

    for (const staffMember of staff) {
      const isAvailable = await this.isInsideAvailability(
        staffMember,
        input.startAt,
        input.endAt,
      );
      const hasConflict = await this.hasConflict({
        organizationId: input.organizationId,
        service: input.service,
        staffId: staffMember.id,
        startAt: input.startAt,
        endAt: input.endAt,
        partySize: input.partySize,
      });

      if (isAvailable && !hasConflict) {
        return staffMember;
      }
    }

    throw new ConflictException('No staff is available for this slot');
  }

  private async assertSlotIsAvailable(input: {
    organizationId: string;
    service: AppointmentService;
    staff: AppointmentStaff;
    startAt: Date;
    endAt: Date;
    excludeBookingId?: string;
    partySize?: number;
  }) {
    const isInsideAvailability = await this.isInsideAvailability(
      input.staff,
      input.startAt,
      input.endAt,
    );

    if (!isInsideAvailability) {
      throw new ConflictException(
        'Selected slot is outside staff availability',
      );
    }

    const hasConflict = await this.hasConflict({
      organizationId: input.organizationId,
      service: input.service,
      staffId: input.staff.id,
      startAt: input.startAt,
      endAt: input.endAt,
      excludeBookingId: input.excludeBookingId,
      partySize: input.partySize,
    });

    if (hasConflict) {
      throw new ConflictException('Selected slot is no longer available');
    }
  }

  private async assertNoConflict(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      service: AppointmentService;
      staffId: string;
      startAt: Date;
      endAt: Date;
      excludeBookingId?: string;
      partySize?: number;
    },
  ) {
    const hasConflict = await this.hasConflict(input, tx, false);

    if (hasConflict) {
      throw new ConflictException('Selected slot is no longer available');
    }
  }

  private async hasConflict(
    input: {
      organizationId: string;
      service: AppointmentService;
      staffId: string;
      startAt: Date;
      endAt: Date;
      excludeBookingId?: string;
      partySize?: number;
    },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
    checkExternalCalendar = true,
  ): Promise<boolean> {
    const conflictStart = this.addMinutes(
      input.startAt,
      -input.service.bufferBeforeMinutes,
    );
    const conflictEnd = this.addMinutes(
      input.endAt,
      input.service.bufferAfterMinutes,
    );
    const continuingGroupSession =
      input.service.maxAttendees > 1
        ? Boolean(
            await client.appointmentBooking.findFirst({
              where: {
                organizationId: input.organizationId,
                serviceId: input.service.id,
                staffId: input.staffId,
                id: input.excludeBookingId
                  ? { not: input.excludeBookingId }
                  : undefined,
                startAt: input.startAt,
                endAt: input.endAt,
                status: { in: ['pending', 'confirmed'] },
              },
              select: { id: true },
            }),
          )
        : false;

    const [
      bookings,
      timeOff,
      blackouts,
      resourceConflict,
      externalCalendarConflict,
    ] = await Promise.all([
      client.appointmentBooking.findMany({
        where: {
          organizationId: input.organizationId,
          staffId: input.staffId,
          id: input.excludeBookingId
            ? { not: input.excludeBookingId }
            : undefined,
          status: { in: ['pending', 'confirmed'] },
          startAt: {
            lt: this.addMinutes(conflictEnd, 240),
            gt: this.addMinutes(conflictStart, -24 * 60 - 240),
          },
        },
        include: { service: true },
      }),
      client.appointmentStaffTimeOff.findFirst({
        where: {
          organizationId: input.organizationId,
          staffId: input.staffId,
          startAt: { lt: conflictEnd },
          endAt: { gt: conflictStart },
        },
        select: { id: true },
      }),
      client.appointmentBlackout.findMany({
        where: {
          organizationId: input.organizationId,
          OR: [
            { annual: true },
            { startAt: { lt: conflictEnd }, endAt: { gt: conflictStart } },
          ],
        },
      }),
      this.hasResourceConflict(input, conflictStart, conflictEnd, client),
      checkExternalCalendar && !continuingGroupSession
        ? this.calendarService.hasExternalConflict(
            input.staffId,
            conflictStart,
            conflictEnd,
          )
        : false,
    ]);

    const overlappingBookings = bookings.filter((booking) => {
      const existingStart = this.addMinutes(
        booking.startAt,
        -booking.service.bufferBeforeMinutes,
      );
      const existingEnd = this.addMinutes(
        booking.endAt,
        booking.service.bufferAfterMinutes,
      );
      return existingStart < conflictEnd && existingEnd > conflictStart;
    });
    let bookingConflict = overlappingBookings.length > 0;
    if (input.service.maxAttendees > 1) {
      const differentSession = overlappingBookings.some(
        (booking) =>
          booking.serviceId !== input.service.id ||
          booking.startAt.getTime() !== input.startAt.getTime() ||
          booking.endAt.getTime() !== input.endAt.getTime(),
      );
      const usedSeats = overlappingBookings
        .filter(
          (booking) =>
            booking.serviceId === input.service.id &&
            booking.startAt.getTime() === input.startAt.getTime() &&
            booking.endAt.getTime() === input.endAt.getTime(),
        )
        .reduce((total, booking) => total + booking.partySize, 0);
      bookingConflict =
        differentSession ||
        usedSeats + (input.partySize ?? 1) > input.service.maxAttendees;
    }

    const blackoutConflict = blackouts.some((blackout) =>
      this.blackoutOverlaps(blackout, conflictStart, conflictEnd),
    );

    return (
      bookingConflict ||
      Boolean(timeOff) ||
      blackoutConflict ||
      resourceConflict ||
      externalCalendarConflict
    );
  }

  private async hasResourceConflict(
    input: {
      organizationId: string;
      service: AppointmentService;
      staffId: string;
      startAt: Date;
      endAt: Date;
      excludeBookingId?: string;
      partySize?: number;
    },
    conflictStart: Date,
    conflictEnd: Date,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<boolean> {
    const requirements = await client.appointmentServiceResource.findMany({
      where: { serviceId: input.service.id },
      include: { resource: { include: { staff: true } } },
    });

    for (const requirement of requirements) {
      if (requirement.resource.status !== 'active') return true;
      if (
        requirement.resource.staff.length > 0 &&
        !requirement.resource.staff.some(
          (mapping) => mapping.staffId === input.staffId,
        )
      ) {
        return true;
      }

      const [allocations, timeOff] = await Promise.all([
        client.appointmentBookingResource.findMany({
          where: {
            resourceId: requirement.resourceId,
            bookingId: input.excludeBookingId
              ? { not: input.excludeBookingId }
              : undefined,
            booking: {
              organizationId: input.organizationId,
              status: { in: ['pending', 'confirmed'] },
              startAt: {
                lt: this.addMinutes(conflictEnd, 240),
                gt: this.addMinutes(conflictStart, -24 * 60 - 240),
              },
            },
          },
          include: { booking: { include: { service: true } } },
        }),
        client.appointmentResourceTimeOff.findFirst({
          where: {
            resourceId: requirement.resourceId,
            startAt: { lt: conflictEnd },
            endAt: { gt: conflictStart },
          },
          select: { id: true },
        }),
      ]);
      if (timeOff) return true;

      const usedCapacity = allocations.reduce((total, allocation) => {
        const existing = allocation.booking;
        if (
          input.service.maxAttendees > 1 &&
          existing.serviceId === input.service.id &&
          existing.staffId === input.staffId &&
          existing.startAt.getTime() === input.startAt.getTime() &&
          existing.endAt.getTime() === input.endAt.getTime()
        ) {
          return total;
        }
        const existingStart = this.addMinutes(
          existing.startAt,
          -existing.service.bufferBeforeMinutes,
        );
        const existingEnd = this.addMinutes(
          existing.endAt,
          existing.service.bufferAfterMinutes,
        );
        return existingStart < conflictEnd && existingEnd > conflictStart
          ? total + allocation.quantity
          : total;
      }, 0);
      if (usedCapacity + requirement.quantity > requirement.resource.capacity) {
        return true;
      }
    }

    return false;
  }

  private assertBookableStart(startAt: Date): void {
    if (!Number.isFinite(startAt.getTime())) {
      throw new BadRequestException('Appointment start time is invalid');
    }
    const now = Date.now();
    const minLeadMinutes = this.configService.get<number>(
      'APPOINTMENT_MIN_LEAD_TIME_MINUTES',
      0,
    );
    const maxAdvanceDays = this.configService.get<number>(
      'APPOINTMENT_MAX_ADVANCE_DAYS',
      365,
    );
    if (startAt.getTime() < now + minLeadMinutes * 60_000) {
      throw new BadRequestException(
        `Appointment must be booked at least ${minLeadMinutes} minutes in advance`,
      );
    }
    if (startAt.getTime() > now + maxAdvanceDays * 24 * 60 * 60_000) {
      throw new BadRequestException(
        `Appointment cannot be booked more than ${maxAdvanceDays} days in advance`,
      );
    }
  }

  private async assertPublicChangeWindow(
    booking: AppointmentBooking,
    serviceWindowMinutes: number | null,
    action: 'cancel' | 'reschedule',
    actor?: AuthenticatedUser,
  ): Promise<void> {
    if (
      actor?.roles.some((role) =>
        ['super_admin', 'org_admin', 'product_admin'].includes(role),
      )
    ) {
      return;
    }
    const policy = await this.prisma.appointmentBookingPolicy.findUnique({
      where: { organizationId: booking.organizationId },
    });
    const windowMinutes =
      serviceWindowMinutes ??
      (action === 'cancel'
        ? policy?.cancellationWindowMinutes
        : policy?.rescheduleWindowMinutes) ??
      0;
    if (
      windowMinutes > 0 &&
      booking.startAt.getTime() - Date.now() < windowMinutes * 60_000
    ) {
      throw new ConflictException(
        `Public ${action} is not allowed within ${windowMinutes} minutes of the appointment`,
      );
    }
  }

  private blackoutOverlaps(
    blackout: { startAt: Date; endAt: Date; annual: boolean },
    startAt: Date,
    endAt: Date,
  ): boolean {
    if (!blackout.annual) {
      return blackout.startAt < endAt && blackout.endAt > startAt;
    }
    const duration = blackout.endAt.getTime() - blackout.startAt.getTime();
    return [startAt.getUTCFullYear() - 1, startAt.getUTCFullYear()].some(
      (year) => {
        const projectedStart = new Date(
          Date.UTC(
            year,
            blackout.startAt.getUTCMonth(),
            blackout.startAt.getUTCDate(),
            blackout.startAt.getUTCHours(),
            blackout.startAt.getUTCMinutes(),
            blackout.startAt.getUTCSeconds(),
          ),
        );
        const projectedEnd = new Date(projectedStart.getTime() + duration);
        return projectedStart < endAt && projectedEnd > startAt;
      },
    );
  }

  private async getSeatsRemaining(
    service: AppointmentService,
    staffId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<number> {
    if (service.maxAttendees <= 1) return 1;
    const aggregate = await this.prisma.appointmentBooking.aggregate({
      where: {
        serviceId: service.id,
        staffId,
        startAt,
        endAt,
        status: { in: ['pending', 'confirmed'] },
      },
      _sum: { partySize: true },
    });
    return Math.max(0, service.maxAttendees - (aggregate._sum.partySize ?? 0));
  }

  private async assertServiceCapacityChange(
    serviceId: string,
    maxAttendees: number,
  ): Promise<void> {
    const bookings = await this.prisma.appointmentBooking.findMany({
      where: { serviceId, status: { in: ['pending', 'confirmed'] } },
      select: {
        staffId: true,
        startAt: true,
        endAt: true,
        partySize: true,
      },
    });
    const sessions = new Map<string, { seats: number; bookings: number }>();
    for (const booking of bookings) {
      const key = `${booking.staffId}:${booking.startAt.toISOString()}:${booking.endAt.toISOString()}`;
      const current = sessions.get(key) ?? { seats: 0, bookings: 0 };
      current.seats += booking.partySize;
      current.bookings += 1;
      sessions.set(key, current);
    }
    if (
      [...sessions.values()].some(
        (session) =>
          session.seats > maxAttendees ||
          (maxAttendees === 1 && session.bookings > 1),
      )
    ) {
      throw new ConflictException(
        'Service capacity cannot be reduced below existing active bookings',
      );
    }
  }

  private isWithinBookingWindow(startAt: Date): boolean {
    const minLeadMinutes = this.configService.get<number>(
      'APPOINTMENT_MIN_LEAD_TIME_MINUTES',
      0,
    );
    const maxAdvanceDays = this.configService.get<number>(
      'APPOINTMENT_MAX_ADVANCE_DAYS',
      365,
    );
    const now = Date.now();
    return (
      startAt.getTime() >= now + minLeadMinutes * 60_000 &&
      startAt.getTime() <= now + maxAdvanceDays * 24 * 60 * 60_000
    );
  }

  private async isInsideAvailability(
    staff: AppointmentStaff,
    startAt: Date,
    endAt: Date,
  ): Promise<boolean> {
    this.timezoneService.assertValid(staff.timezone);
    const date = this.timezoneService.dateInZone(startAt, staff.timezone);
    const endDate = this.timezoneService.dateInZone(
      new Date(endAt.getTime() - 1),
      staff.timezone,
    );
    if (date !== endDate) return false;
    const dayOfWeek = this.timezoneService.dayOfWeek(date);
    const windows = await this.prisma.appointmentStaffAvailability.findMany({
      where: {
        staffId: staff.id,
        dayOfWeek,
        isActive: true,
      },
    });

    return windows.some((window) => {
      const windowStart = this.timezoneService.localToUtc(
        date,
        window.startTime,
        staff.timezone,
      );
      const windowEnd = this.timezoneService.localToUtc(
        date,
        window.endTime,
        staff.timezone,
      );
      return startAt >= windowStart && endAt <= windowEnd;
    });
  }

  private async findServiceForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ) {
    const service = await this.prisma.appointmentService.findUnique({
      where: { id },
    });

    if (!service) {
      throw new NotFoundException('Appointment service not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      service.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Appointment service not found');
    }

    await this.assertAppointmentBookingEnabled(service.organizationId);

    return service;
  }

  private async findActiveService(organizationId: string, id: string) {
    const service = await this.prisma.appointmentService.findFirst({
      where: {
        id,
        organizationId,
        status: 'active',
      },
    });

    if (!service) {
      throw new NotFoundException('Appointment service not found');
    }

    return service;
  }

  private async findStaffForActor(currentUser: AuthenticatedUser, id: string) {
    const staff = await this.prisma.appointmentStaff.findUnique({
      where: { id },
      include: this.staffInclude(),
    });

    if (!staff) {
      throw new NotFoundException('Appointment staff not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      staff.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Appointment staff not found');
    }

    await this.assertAppointmentBookingEnabled(staff.organizationId);

    return staff;
  }

  private async findResourceForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ) {
    const resource = await this.prisma.appointmentResource.findUnique({
      where: { id },
    });
    if (
      !resource ||
      (!this.isSuperAdmin(currentUser) &&
        resource.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Appointment resource not found');
    }
    await this.assertAppointmentBookingEnabled(resource.organizationId);
    return resource;
  }

  private async findActiveStaffForService(
    organizationId: string,
    staffId: string,
    serviceId: string,
  ) {
    const staff = await this.prisma.appointmentStaff.findFirst({
      where: {
        id: staffId,
        organizationId,
        status: 'active',
        services: { some: { serviceId } },
      },
    });

    if (!staff) {
      throw new NotFoundException('Appointment staff not found');
    }

    return staff;
  }

  private async findBookingForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ) {
    const booking = await this.prisma.appointmentBooking.findUnique({
      where: { id },
    });

    if (!booking) {
      throw new NotFoundException('Appointment booking not found');
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      booking.organizationId !== currentUser.orgId
    ) {
      throw new NotFoundException('Appointment booking not found');
    }

    await this.assertAppointmentBookingEnabled(booking.organizationId);

    return booking;
  }

  private async findPublicManageableBooking(
    id: string,
    organizationId: string,
    manageToken: string,
  ): Promise<AppointmentBooking> {
    await this.assertAppointmentBookingEnabled(organizationId);
    const booking = await this.prisma.appointmentBooking.findFirst({
      where: { id, organizationId },
    });
    const suppliedHash = Buffer.from(this.hashManageToken(manageToken), 'hex');
    const storedHash = booking?.manageTokenHash
      ? Buffer.from(booking.manageTokenHash, 'hex')
      : Buffer.alloc(suppliedHash.length);
    const matches =
      storedHash.length === suppliedHash.length &&
      timingSafeEqual(storedHash, suppliedHash);
    if (!booking || !matches) {
      throw new NotFoundException('Appointment booking not found');
    }
    return booking;
  }

  private async assertUserBelongsToOrganization(
    organizationId: string,
    userId?: string | null,
  ) {
    if (!userId) {
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        orgId: organizationId,
        isActive: true,
      },
      select: { id: true },
    });

    if (!user) {
      throw new ForbiddenException('User does not belong to this organization');
    }
  }

  private async assertServicesBelongToOrganization(
    organizationId: string,
    serviceIds?: string[],
  ) {
    if (!serviceIds?.length) {
      return;
    }

    const count = await this.prisma.appointmentService.count({
      where: {
        id: { in: serviceIds },
        organizationId,
      },
    });

    if (count !== new Set(serviceIds).size) {
      throw new ForbiddenException(
        'One or more services do not belong to this organization',
      );
    }
  }

  private async assertResourcesBelongToOrganization(
    organizationId: string,
    resourceIds?: string[],
  ) {
    if (!resourceIds?.length) return;
    const count = await this.prisma.appointmentResource.count({
      where: {
        id: { in: resourceIds },
        organizationId,
        status: 'active',
      },
    });
    if (count !== new Set(resourceIds).size) {
      throw new ForbiddenException(
        'One or more resources do not belong to this organization',
      );
    }
  }

  private async getPeakResourceAllocation(resourceId: string): Promise<number> {
    const allocations = await this.prisma.appointmentBookingResource.findMany({
      where: {
        resourceId,
        booking: { status: { in: ['pending', 'confirmed'] } },
      },
      include: { booking: { include: { service: true } } },
    });
    const events = allocations.flatMap((allocation) => {
      const start = this.addMinutes(
        allocation.booking.startAt,
        -allocation.booking.service.bufferBeforeMinutes,
      ).getTime();
      const end = this.addMinutes(
        allocation.booking.endAt,
        allocation.booking.service.bufferAfterMinutes,
      ).getTime();
      return [
        { at: start, delta: allocation.quantity },
        { at: end, delta: -allocation.quantity },
      ];
    });
    events.sort(
      (left, right) => left.at - right.at || left.delta - right.delta,
    );
    let current = 0;
    let peak = 0;
    for (const event of events) {
      current += event.delta;
      peak = Math.max(peak, current);
    }
    return peak;
  }

  private async assertAppointmentBookingEnabled(organizationId: string) {
    const entitlement = await this.prisma.organizationProduct.findFirst({
      where: {
        organizationId,
        status: 'enabled',
        product: { key: 'appointment_booking', status: 'active' },
      },
    });

    if (!entitlement) {
      throw new ForbiddenException('Appointment Booking is not enabled');
    }
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ): string {
    if (!organizationId) {
      return currentUser.orgId;
    }

    if (
      !this.isSuperAdmin(currentUser) &&
      organizationId !== currentUser.orgId
    ) {
      throw new ForbiddenException('Cannot manage another organization');
    }

    return organizationId;
  }

  private staffInclude() {
    return {
      services: {
        include: {
          service: true,
        },
      },
      resources: {
        include: { resource: true },
      },
    };
  }

  private toServiceResponse(service: AppointmentService) {
    return {
      ...service,
      metadata: this.toRecord(service.metadata),
      reminderTemplates: this.toRecord(service.reminderTemplates),
    };
  }

  private toStaffResponse(staff: StaffWithServices) {
    return {
      id: staff.id,
      organizationId: staff.organizationId,
      userId: staff.userId,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      timezone: staff.timezone,
      status: staff.status,
      services: staff.services.map((item) =>
        this.toServiceResponse(item.service),
      ),
      metadata: this.toRecord(staff.metadata),
      resources: staff.resources.map((item) =>
        this.toResourceResponse(item.resource),
      ),
    };
  }

  private toResourceResponse(resource: AppointmentResource) {
    return { ...resource, metadata: this.toRecord(resource.metadata) };
  }

  private toAvailabilityResponse(
    availability: Prisma.AppointmentStaffAvailabilityGetPayload<object>,
  ) {
    return availability;
  }

  private toTimeOffResponse(
    timeOff: Prisma.AppointmentStaffTimeOffGetPayload<object>,
  ) {
    return timeOff;
  }

  private toBookingResponse(booking: AppointmentBooking, manageToken?: string) {
    const safeBooking = { ...booking, manageTokenHash: undefined };
    return {
      ...safeBooking,
      metadata: this.toRecord(booking.metadata),
      ...(manageToken ? { manageToken } : {}),
    };
  }

  private hashManageToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private manageTokenMatches(storedHash: string, token: string): boolean {
    const supplied = Buffer.from(this.hashManageToken(token), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    return (
      stored.length === supplied.length && timingSafeEqual(stored, supplied)
    );
  }

  private requireActionFields(
    input: AppointmentActionDto,
    fields: Array<keyof AppointmentActionDto>,
  ): void {
    const missing = fields.filter((field) => !input[field]);
    if (missing.length) {
      throw new BadRequestException(
        `Missing fields for ${input.action}: ${missing.join(', ')}`,
      );
    }
  }

  private assertStatusTransition(
    current: AppointmentBooking['status'],
    next: AppointmentBooking['status'],
  ): void {
    const allowed: Record<
      AppointmentBooking['status'],
      AppointmentBooking['status'][]
    > = {
      pending: ['confirmed', 'cancelled'],
      confirmed: ['cancelled', 'completed', 'no_show'],
      cancelled: [],
      completed: [],
      no_show: [],
    };
    if (current !== next && !allowed[current].includes(next)) {
      throw new ConflictException(
        `Booking status cannot change from ${current} to ${next}`,
      );
    }
  }

  private async runSerializable<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const isOverlapConstraint = this.isOverlapConstraintViolation(error);
        if (isOverlapConstraint) {
          throw new ConflictException(
            'Selected slot was booked concurrently; please choose another slot',
          );
        }
        const isSerializationConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';
        if (!isSerializationConflict) throw error;
        if (attempt === 3) {
          throw new ConflictException(
            'Selected slot was booked concurrently; please choose another slot',
          );
        }
      }
    }
    throw new ConflictException('Selected slot is no longer available');
  }

  private isOverlapConstraintViolation(error: unknown): boolean {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2004'
    ) {
      return true;
    }

    const details = this.errorDetails(error);
    return (
      /\b23P01\b/i.test(details) ||
      /appointment_bookings_active_staff_no_overlap/i.test(details) ||
      /conflicting key value violates exclusion constraint/i.test(details)
    );
  }

  private errorDetails(error: unknown): string {
    if (!error || typeof error !== 'object') return String(error);
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      meta?: unknown;
      cause?: unknown;
    };
    return [candidate.code, candidate.message, candidate.meta, candidate.cause]
      .map((value) => this.serializeUnknown(value))
      .join(' ');
  }

  private serializeUnknown(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return `${value}`;
    }
    if (value instanceof Error) {
      return `${value.name} ${value.message} ${this.serializeUnknown(value.cause)}`;
    }
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private assertDateRange(startAt: Date, endAt: Date) {
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new BadRequestException('Invalid date range');
    }

    if (startAt >= endAt) {
      throw new BadRequestException('Start date must be before end date');
    }
  }

  private assertTimeRange(startTime: string, endTime: string) {
    if (this.timeToMinutes(startTime) >= this.timeToMinutes(endTime)) {
      throw new BadRequestException('Start time must be before end time');
    }
  }

  private parseDateOnly(date: string): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  private combineDateAndTime(date: string, time: string): Date {
    return new Date(`${date}T${time}:00.000Z`);
  }

  private addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  private addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60_000);
  }

  private timeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
