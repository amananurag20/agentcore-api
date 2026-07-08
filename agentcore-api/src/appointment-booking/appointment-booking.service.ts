import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentBooking,
  AppointmentService,
  AppointmentStaff,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import {
  CancelAppointmentBookingDto,
  CreateAppointmentBookingDto,
  CreateAppointmentServiceDto,
  CreateAppointmentStaffDto,
  CreateStaffTimeOffDto,
  ListAppointmentBookingsDto,
  ListAvailabilityDto,
  PublicCreateAppointmentBookingDto,
  PublicListAppointmentServicesDto,
  PublicListAvailabilityDto,
  RescheduleAppointmentBookingDto,
  SetStaffAvailabilityDto,
  UpdateAppointmentBookingStatusDto,
  UpdateAppointmentServiceDto,
  UpdateAppointmentStaffDto,
} from './dto/appointment-booking.dto';

type StaffWithServices = Prisma.AppointmentStaffGetPayload<{
  include: {
    services: {
      include: {
        service: true;
      };
    };
  };
}>;

@Injectable()
export class AppointmentBookingService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

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

    const service = await this.prisma.appointmentService.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        description: input.description,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
        priceCents: input.priceCents,
        currency: input.currency,
        status: input.status,
        metadata: input.metadata
          ? this.toJsonObject(input.metadata)
          : undefined,
      },
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

    const staff = await this.prisma.$transaction(async (tx) => {
      if (input.serviceIds) {
        await tx.appointmentStaffService.deleteMany({
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
    const booking = await this.createBookingForOrganization(
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

    return this.toBookingResponse(booking);
  }

  async createPublicBooking(input: PublicCreateAppointmentBookingDto) {
    const booking = await this.createBookingForOrganization(
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

    return this.toBookingResponse(booking);
  }

  async rescheduleBooking(
    currentUser: AuthenticatedUser,
    id: string,
    input: RescheduleAppointmentBookingDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      throw new ConflictException('Booking cannot be rescheduled');
    }

    const service = await this.findActiveService(
      booking.organizationId,
      booking.serviceId,
    );
    const staffId = input.staffId ?? booking.staffId;
    const staff = await this.findActiveStaffForService(
      booking.organizationId,
      staffId,
      service.id,
    );
    const startAt = new Date(input.startAt);
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? booking.timezone;

    await this.assertSlotIsAvailable({
      organizationId: booking.organizationId,
      service,
      staff,
      startAt,
      endAt,
      excludeBookingId: booking.id,
    });

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await this.assertNoConflict(tx, {
          organizationId: booking.organizationId,
          service,
          staffId: staff.id,
          startAt,
          endAt,
          excludeBookingId: booking.id,
        });

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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.auditService.record({
      actor: currentUser,
      organizationId: updated.organizationId,
      action: 'appointment.booking_rescheduled',
      entityType: 'appointment_booking',
      entityId: updated.id,
      metadata: {
        staffId: updated.staffId,
        startAt: updated.startAt.toISOString(),
      },
    });

    return this.toBookingResponse(updated);
  }

  async cancelBooking(
    currentUser: AuthenticatedUser,
    id: string,
    input: CancelAppointmentBookingDto,
  ) {
    const booking = await this.findBookingForActor(currentUser, id);

    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      throw new ConflictException('Booking cannot be cancelled');
    }

    const updated = await this.prisma.appointmentBooking.update({
      where: { id: booking.id },
      data: {
        status: 'cancelled',
        cancellationReason: input.reason,
      },
    });

    await this.auditService.record({
      actor: currentUser,
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

    const updated = await this.prisma.appointmentBooking.update({
      where: { id: booking.id },
      data: { status: input.status },
    });

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

  private async createBookingForOrganization(
    organizationId: string,
    input: CreateAppointmentBookingDto,
  ): Promise<AppointmentBooking> {
    await this.assertAppointmentBookingEnabled(organizationId);
    const service = await this.findActiveService(
      organizationId,
      input.serviceId,
    );
    const startAt = new Date(input.startAt);
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? 'UTC';
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
        });

    await this.assertSlotIsAvailable({
      organizationId,
      service,
      staff,
      startAt,
      endAt,
    });

    return this.prisma.$transaction(
      async (tx) => {
        await this.assertNoConflict(tx, {
          organizationId,
          service,
          staffId: staff.id,
          startAt,
          endAt,
        });

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
            metadata: this.toJsonObject(input.metadata),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async listAvailableSlots(
    organizationId: string,
    input: ListAvailabilityDto,
  ) {
    const service = await this.findActiveService(
      organizationId,
      input.serviceId,
    );
    const date = this.parseDateOnly(input.date);
    const dayOfWeek = date.getUTCDay();
    const dayStart = date;
    const dayEnd = this.addDays(dayStart, 1);

    const staff = await this.prisma.appointmentStaff.findMany({
      where: {
        organizationId,
        status: 'active',
        ...(input.staffId ? { id: input.staffId } : {}),
        services: { some: { serviceId: service.id } },
        availability: {
          some: {
            dayOfWeek,
            isActive: true,
          },
        },
      },
      include: {
        availability: {
          where: {
            dayOfWeek,
            isActive: true,
          },
          orderBy: { startTime: 'asc' },
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
    }> = [];

    for (const staffMember of staff) {
      for (const availability of staffMember.availability) {
        const windowStart = this.combineDateAndTime(
          input.date,
          availability.startTime,
        );
        const windowEnd = this.combineDateAndTime(
          input.date,
          availability.endTime,
        );
        let cursor = new Date(windowStart);

        while (this.addMinutes(cursor, service.durationMinutes) <= windowEnd) {
          const startAt = new Date(cursor);
          const endAt = this.addMinutes(startAt, service.durationMinutes);
          const hasConflict = await this.hasConflict({
            organizationId,
            service,
            staffId: staffMember.id,
            startAt,
            endAt,
            dayStart,
            dayEnd,
          });

          if (!hasConflict) {
            slots.push({
              staffId: staffMember.id,
              staffName: staffMember.name,
              startAt,
              endAt,
              timezone: staffMember.timezone,
            });
          }

          cursor = this.addMinutes(
            cursor,
            service.durationMinutes +
              service.bufferBeforeMinutes +
              service.bufferAfterMinutes,
          );
        }
      }
    }

    return slots;
  }

  private async findFirstAvailableStaff(input: {
    organizationId: string;
    service: AppointmentService;
    startAt: Date;
    endAt: Date;
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
        staffMember.id,
        input.startAt,
        input.endAt,
      );
      const hasConflict = await this.hasConflict({
        organizationId: input.organizationId,
        service: input.service,
        staffId: staffMember.id,
        startAt: input.startAt,
        endAt: input.endAt,
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
  }) {
    const isInsideAvailability = await this.isInsideAvailability(
      input.staff.id,
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
    },
  ) {
    const hasConflict = await this.hasConflict(input, tx);

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
      dayStart?: Date;
      dayEnd?: Date;
    },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const conflictStart = this.addMinutes(
      input.startAt,
      -input.service.bufferBeforeMinutes,
    );
    const conflictEnd = this.addMinutes(
      input.endAt,
      input.service.bufferAfterMinutes,
    );

    const [booking, timeOff] = await Promise.all([
      client.appointmentBooking.findFirst({
        where: {
          organizationId: input.organizationId,
          staffId: input.staffId,
          id: input.excludeBookingId
            ? { not: input.excludeBookingId }
            : undefined,
          status: { notIn: ['cancelled', 'no_show'] },
          startAt: { lt: conflictEnd },
          endAt: { gt: conflictStart },
        },
        select: { id: true },
      }),
      client.appointmentStaffTimeOff.findFirst({
        where: {
          organizationId: input.organizationId,
          staffId: input.staffId,
          startAt: { lt: input.endAt },
          endAt: { gt: input.startAt },
        },
        select: { id: true },
      }),
    ]);

    return Boolean(booking || timeOff);
  }

  private async isInsideAvailability(
    staffId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<boolean> {
    const date = startAt.toISOString().slice(0, 10);
    const dayOfWeek = startAt.getUTCDay();
    const windows = await this.prisma.appointmentStaffAvailability.findMany({
      where: {
        staffId,
        dayOfWeek,
        isActive: true,
      },
    });

    return windows.some((window) => {
      const windowStart = this.combineDateAndTime(date, window.startTime);
      const windowEnd = this.combineDateAndTime(date, window.endTime);
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
    };
  }

  private toServiceResponse(service: AppointmentService) {
    return {
      ...service,
      metadata: this.toRecord(service.metadata),
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
    };
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

  private toBookingResponse(booking: AppointmentBooking) {
    return {
      ...booking,
      metadata: this.toRecord(booking.metadata),
    };
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
