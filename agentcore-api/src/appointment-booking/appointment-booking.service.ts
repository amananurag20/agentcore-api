import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  constructor(
    private readonly auditService: AuditService,
    private readonly calendarService: AppointmentCalendarService,
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
            startAt: input.startAt!,
            timezone: input.timezone,
            notes: input.notes,
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
    const booking = result.data as {
      id: string;
      startAt: Date;
      timezone: string;
      status: string;
      manageToken?: string;
    };
    if (result.action === AppointmentActionTypeDto.cancel) {
      return `Appointment ${booking.id} has been cancelled.`;
    }
    return `Appointment ${booking.id} is ${booking.status} for ${new Date(booking.startAt).toISOString()}.${booking.manageToken ? ` Management token: ${booking.manageToken}` : ''}`;
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
      startAt: booking.startAt,
    });
    await this.calendarService.scheduleBookingSync({ booking });

    return this.toBookingResponse(booking, manageToken);
  }

  async createPublicBooking(input: PublicCreateAppointmentBookingDto) {
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
      startAt: booking.startAt,
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
    const staffId = input.staffId ?? booking.staffId;
    const staff = await this.findActiveStaffForService(
      booking.organizationId,
      staffId,
      service.id,
    );
    const startAt = new Date(input.startAt);
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
    });

    const updated = await this.runSerializable(async (tx) => {
      await this.assertNoConflict(tx, {
        organizationId: booking.organizationId,
        service,
        staffId: staff.id,
        startAt,
        endAt,
        excludeBookingId: booking.id,
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
      startAt: updated.startAt,
    });
    await this.calendarService.scheduleBookingSync({
      booking: updated,
      previousStaffId: booking.staffId,
    });

    return this.toBookingResponse(updated);
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
        startAt: updated.startAt,
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
    const endAt = this.addMinutes(startAt, service.durationMinutes);
    const timezone = input.timezone ?? 'UTC';
    this.timezoneService.assertValid(timezone);
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

    const manageToken = randomBytes(32).toString('base64url');
    const booking = await this.runSerializable(async (tx) => {
      await this.assertNoConflict(tx, {
        organizationId,
        service,
        staffId: staff.id,
        startAt,
        endAt,
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
    }> = [];

    for (const staffMember of staff) {
      this.timezoneService.assertValid(staffMember.timezone);
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
            const hasConflict = isInRequestedDay
              ? await this.hasConflict({
                  organizationId,
                  service,
                  staffId: staffMember.id,
                  startAt,
                  endAt,
                })
              : true;

            if (!hasConflict) {
              slots.push({
                staffId: staffMember.id,
                staffName: staffMember.name,
                startAt,
                endAt,
                timezone: staffMember.timezone,
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

    const [bookings, timeOff, resourceConflict, externalCalendarConflict] =
      await Promise.all([
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
        this.hasResourceConflict(input, conflictStart, conflictEnd, client),
        checkExternalCalendar
          ? this.calendarService.hasExternalConflict(
              input.staffId,
              conflictStart,
              conflictEnd,
            )
          : false,
      ]);

    const bookingConflict = bookings.some((booking) => {
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

    return (
      bookingConflict ||
      Boolean(timeOff) ||
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
