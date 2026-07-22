import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentBooking,
  AppointmentCalendarConnection,
  AppointmentCalendarProvider,
  Prisma,
} from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  APPOINTMENT_CALENDAR_SYNC_JOB,
  APPOINTMENT_CALENDAR_SYNC_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  AppointmentCalendarConnectionScopeDto,
  ConnectAppointmentCalendarDto,
  ListAppointmentCalendarConnectionsDto,
} from './dto/appointment-calendar.dto';

type BookingForCalendar = Prisma.AppointmentBookingGetPayload<{
  include: { service: true; staff: true };
}>;

export type AppointmentCalendarSyncJobData = {
  calendarEventId: string;
  expectedUpdatedAt: string;
};

export type ExternalBusyInterval = { startAt: Date; endAt: Date };

@Injectable()
export class AppointmentCalendarService {
  private readonly tokenRefreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async listConnections(
    currentUser: AuthenticatedUser,
    input: ListAppointmentCalendarConnectionsDto,
  ) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    const connections =
      await this.prisma.appointmentCalendarConnection.findMany({
        where: { organizationId, staffId: input.staffId },
        include: {
          staff: { select: { id: true, name: true, timezone: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    return connections.map((connection) =>
      this.toConnectionResponse(connection),
    );
  }

  async beginConnection(
    currentUser: AuthenticatedUser,
    input: ConnectAppointmentCalendarDto,
  ) {
    this.providerConfig(input.provider);
    const scope =
      input.scope ?? AppointmentCalendarConnectionScopeDto.organization;
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    if (scope === AppointmentCalendarConnectionScopeDto.staff) {
      const staff = input.staffId
        ? await this.prisma.appointmentStaff.findFirst({
            where: { id: input.staffId, organizationId },
          })
        : null;
      if (!staff) throw new NotFoundException('Appointment staff not found');
    }

    const state = randomBytes(32).toString('base64url');
    const stateHash = this.hash(state);
    const calendarId = input.calendarId ?? 'primary';
    const existing = await this.prisma.appointmentCalendarConnection.findFirst({
      where:
        scope === AppointmentCalendarConnectionScopeDto.organization
          ? { organizationId, scope }
          : {
              organizationId,
              scope,
              provider: input.provider,
              calendarId,
              staffId: input.staffId,
            },
    });
    const connectionData = {
      status: 'pending' as const,
      scope,
      staffId:
        scope === AppointmentCalendarConnectionScopeDto.staff
          ? input.staffId
          : null,
      oauthStateHash: stateHash,
      oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000),
      lastError: null,
    };
    const connection = existing
      ? await this.prisma.appointmentCalendarConnection.update({
          where: { id: existing.id },
          data: { ...connectionData, provider: input.provider, calendarId },
        })
      : await this.prisma.appointmentCalendarConnection.create({
          data: {
            organizationId,
            provider: input.provider,
            calendarId,
            ...connectionData,
          },
        });

    return {
      connection: this.toConnectionResponse(connection),
      authorizationUrl: this.buildAuthorizationUrl(input.provider, state),
    };
  }

  async completeConnection(
    provider: AppointmentCalendarProvider,
    code: string,
    state: string,
  ) {
    const connection =
      await this.prisma.appointmentCalendarConnection.findFirst({
        where: {
          provider,
          oauthStateHash: this.hash(state),
          oauthStateExpiresAt: { gt: new Date() },
        },
      });
    if (!connection)
      throw new ForbiddenException('Invalid or expired OAuth state');

    try {
      const tokens = await this.exchangeAuthorizationCode(provider, code);
      const account = await this.fetchCalendarAccount(
        provider,
        tokens.accessToken,
        connection.calendarId,
      );
      const updated = await this.prisma.appointmentCalendarConnection.update({
        where: { id: connection.id },
        data: {
          status: 'active',
          accountEmail: account.email,
          calendarName: account.calendarName,
          accessTokenEncrypted: this.cryptoService.encrypt(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken
            ? this.cryptoService.encrypt(tokens.refreshToken)
            : connection.refreshTokenEncrypted,
          tokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
          oauthStateHash: null,
          oauthStateExpiresAt: null,
          lastError: null,
          lastSyncedAt: new Date(),
        },
      });
      await this.auditService.record({
        organizationId: updated.organizationId,
        action: 'appointment.calendar_connected',
        entityType: 'appointment_calendar_connection',
        entityId: updated.id,
        metadata: { provider, scope: updated.scope, staffId: updated.staffId },
      });
      const upcomingBookings =
        updated.scope === 'organization'
          ? await this.prisma.appointmentBooking.findMany({
              where: {
                organizationId: updated.organizationId,
                status: { in: ['pending', 'confirmed'] },
                endAt: { gt: new Date() },
              },
            })
          : [];
      await Promise.allSettled(
        upcomingBookings.map((booking) =>
          this.scheduleBookingSync({ booking, operation: 'upsert' }),
        ),
      );
      return updated;
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.appointmentCalendarConnection.update({
        where: { id: connection.id },
        data: { status: 'error', lastError: message.slice(0, 2000) },
      });
      throw error;
    }
  }

  async disconnect(currentUser: AuthenticatedUser, connectionId: string) {
    const connection = await this.findConnectionForActor(
      currentUser,
      connectionId,
    );
    const events = await this.prisma.appointmentCalendarEvent.findMany({
      where: { connectionId, externalEventId: { not: null } },
    });
    if (connection.accessTokenEncrypted || connection.refreshTokenEncrypted) {
      const accessToken = await this.getAccessToken(connection);
      for (const event of events) {
        await this.deleteExternalEvent(
          connection,
          accessToken,
          event.externalEventId!,
        );
      }
    }
    await this.prisma.appointmentCalendarEvent.updateMany({
      where: { connectionId },
      data: {
        status: 'deleted',
        externalEventId: null,
        externalEtag: null,
        lastSyncedAt: new Date(),
      },
    });
    await this.prisma.appointmentCalendarConnection.update({
      where: { id: connection.id },
      data: {
        status: 'disconnected',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        tokenExpiresAt: null,
      },
    });
    return { disconnected: true };
  }

  async hasExternalConflict(
    staffId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<boolean> {
    const intervals = await this.listExternalBusyIntervals(
      staffId,
      startAt,
      endAt,
    );
    return intervals.some(
      (interval) => interval.startAt < endAt && interval.endAt > startAt,
    );
  }

  async listExternalBusyIntervals(
    staffId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<ExternalBusyInterval[]> {
    const connections =
      await this.prisma.appointmentCalendarConnection.findMany({
        where: {
          staffId,
          scope: 'staff',
          status: { in: ['active', 'error'] },
        },
      });
    const intervals: ExternalBusyInterval[] = [];
    for (const connection of connections) {
      try {
        const accessToken = await this.getAccessToken(connection);
        intervals.push(
          ...(await this.queryFreeBusy(
            connection,
            accessToken,
            startAt,
            endAt,
          )),
        );
        if (connection.status === 'error' || connection.lastError) {
          await this.prisma.appointmentCalendarConnection.update({
            where: { id: connection.id },
            data: { status: 'active', lastError: null },
          });
        }
      } catch (error) {
        const message = this.errorMessage(error);
        await this.prisma.appointmentCalendarConnection.update({
          where: { id: connection.id },
          data: { status: 'error', lastError: message.slice(0, 2000) },
        });
        if (
          !this.configService.get<boolean>(
            'APPOINTMENT_CALENDAR_FAIL_OPEN',
            true,
          )
        ) {
          throw new ServiceUnavailableException(
            'External calendar availability could not be verified',
          );
        }
      }
    }
    return intervals;
  }

  async scheduleBookingSync(input: {
    booking: AppointmentBooking;
    previousStaffId?: string;
    operation?: 'upsert' | 'delete';
  }) {
    const workspaceConnection =
      await this.prisma.appointmentCalendarConnection.findFirst({
        where: {
          organizationId: input.booking.organizationId,
          scope: 'organization',
          status: 'active',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    const connections = workspaceConnection ? [workspaceConnection] : [];

    for (const connection of connections) {
      const operation = input.operation ?? 'upsert';
      const existing = await this.prisma.appointmentCalendarEvent.findUnique({
        where: {
          bookingId_connectionId: {
            bookingId: input.booking.id,
            connectionId: connection.id,
          },
        },
      });
      if (operation === 'delete' && !existing) continue;
      const calendarEvent = await this.prisma.appointmentCalendarEvent.upsert({
        where: {
          bookingId_connectionId: {
            bookingId: input.booking.id,
            connectionId: connection.id,
          },
        },
        create: {
          organizationId: input.booking.organizationId,
          bookingId: input.booking.id,
          connectionId: connection.id,
          operation,
        },
        update: { operation, status: 'pending', lastError: null },
      });
      if (this.queueService.isEnabled()) {
        const jobId = this.calendarJobId(
          calendarEvent.id,
          calendarEvent.updatedAt,
        );
        try {
          await this.queueService.add(
            APPOINTMENT_CALENDAR_SYNC_QUEUE,
            APPOINTMENT_CALENDAR_SYNC_JOB,
            {
              calendarEventId: calendarEvent.id,
              expectedUpdatedAt: calendarEvent.updatedAt.toISOString(),
            } satisfies AppointmentCalendarSyncJobData,
            { jobId },
          );
        } catch (error) {
          await this.prisma.appointmentCalendarEvent.update({
            where: { id: calendarEvent.id },
            data: {
              status: 'failed',
              lastError: `Queue publish failed: ${this.errorMessage(error)}`,
            },
          });
        }
      } else {
        await this.prisma.appointmentCalendarEvent.update({
          where: { id: calendarEvent.id },
          data: {
            status: 'failed',
            lastError: 'Calendar sync queue is disabled',
          },
        });
      }
    }
  }

  async processCalendarEvent(data: AppointmentCalendarSyncJobData) {
    const event = await this.prisma.appointmentCalendarEvent.findUnique({
      where: { id: data.calendarEventId },
      include: {
        connection: true,
        booking: { include: { service: true, staff: true } },
      },
    });
    if (!event || event.updatedAt.toISOString() !== data.expectedUpdatedAt)
      return;
    const claimed = await this.prisma.appointmentCalendarEvent.updateMany({
      where: { id: event.id, status: { in: ['pending', 'failed'] } },
      data: { status: 'syncing', attempts: { increment: 1 }, lastError: null },
    });
    if (!claimed.count) return;

    try {
      const accessToken = await this.getAccessToken(event.connection);
      if (event.operation === 'delete') {
        if (event.externalEventId) {
          await this.deleteExternalEvent(
            event.connection,
            accessToken,
            event.externalEventId,
          );
        }
        await this.prisma.appointmentCalendarEvent.update({
          where: { id: event.id },
          data: { status: 'deleted', lastSyncedAt: new Date() },
        });
        return;
      }

      const external = await this.upsertExternalEvent(
        event.connection,
        accessToken,
        event.booking,
        event.externalEventId,
        await this.shouldCreateOnlineMeeting(event.booking, event.connection),
      );
      if (external.meetingUrl) {
        await this.prisma.appointmentBooking.update({
          where: { id: event.bookingId },
          data: {
            meetingProvider: event.connection.provider,
            meetingUrl: external.meetingUrl,
          },
        });
      }
      await this.prisma.appointmentCalendarEvent.update({
        where: { id: event.id },
        data: {
          status: 'synced',
          externalEventId: external.id,
          externalEtag: external.etag,
          lastSyncedAt: new Date(),
        },
      });
      await this.prisma.appointmentCalendarConnection.update({
        where: { id: event.connectionId },
        data: { status: 'active', lastSyncedAt: new Date(), lastError: null },
      });
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.appointmentCalendarEvent.update({
        where: { id: event.id },
        data: { status: 'failed', lastError: message.slice(0, 2000) },
      });
      throw error;
    }
  }

  calendarJobId(eventId: string, updatedAt: Date): string {
    return `${eventId}-${updatedAt.getTime()}`;
  }

  async retryDeadLetter(eventId: string): Promise<void> {
    const event = await this.prisma.appointmentCalendarEvent.update({
      where: { id: eventId },
      data: { attempts: 0, status: 'pending', lastError: null },
    });
    if (!this.queueService.isEnabled()) {
      await this.prisma.appointmentCalendarEvent.update({
        where: { id: event.id },
        data: {
          status: 'failed',
          lastError: 'Calendar sync queue is disabled',
        },
      });
      return;
    }
    const jobId = this.calendarJobId(event.id, event.updatedAt);
    try {
      await this.queueService.add(
        APPOINTMENT_CALENDAR_SYNC_QUEUE,
        APPOINTMENT_CALENDAR_SYNC_JOB,
        {
          calendarEventId: event.id,
          expectedUpdatedAt: event.updatedAt.toISOString(),
        } satisfies AppointmentCalendarSyncJobData,
        { jobId },
      );
    } catch (error) {
      await this.prisma.appointmentCalendarEvent.update({
        where: { id: event.id },
        data: {
          status: 'failed',
          lastError: `Queue publish failed: ${this.errorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private async queryFreeBusy(
    connection: AppointmentCalendarConnection,
    accessToken: string,
    startAt: Date,
    endAt: Date,
  ): Promise<ExternalBusyInterval[]> {
    if (connection.provider === 'google') {
      const response = await fetch(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        {
          method: 'POST',
          headers: this.bearerHeaders(accessToken),
          body: JSON.stringify({
            timeMin: startAt.toISOString(),
            timeMax: endAt.toISOString(),
            items: [{ id: connection.calendarId }],
          }),
          signal: this.providerTimeoutSignal(),
        },
      );
      const body = await this.readProviderJson<{
        calendars?: Record<
          string,
          { busy?: Array<{ start?: string; end?: string }> }
        >;
      }>(response);
      return (body.calendars?.[connection.calendarId]?.busy ?? [])
        .map((busy) => ({
          startAt: new Date(busy.start ?? ''),
          endAt: new Date(busy.end ?? ''),
        }))
        .filter(
          (busy) =>
            Number.isFinite(busy.startAt.getTime()) &&
            Number.isFinite(busy.endAt.getTime()),
        );
    }

    const calendarPath =
      connection.calendarId === 'primary'
        ? '/me/calendarView'
        : `/me/calendars/${encodeURIComponent(connection.calendarId)}/calendarView`;
    const params = new URLSearchParams({
      startDateTime: startAt.toISOString(),
      endDateTime: endAt.toISOString(),
      $select: 'id,showAs,isCancelled,start,end',
      $top: '1000',
    });
    const response = await fetch(
      `https://graph.microsoft.com/v1.0${calendarPath}?${params}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.timezone="UTC"',
        },
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = await this.readProviderJson<{
      value?: Array<{
        showAs?: string;
        isCancelled?: boolean;
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
      }>;
    }>(response);
    return (body.value ?? [])
      .filter((item) => !item.isCancelled && item.showAs !== 'free')
      .map((item) => ({
        startAt: this.graphDateTime(item.start?.dateTime),
        endAt: this.graphDateTime(item.end?.dateTime),
      }))
      .filter(
        (busy) =>
          Number.isFinite(busy.startAt.getTime()) &&
          Number.isFinite(busy.endAt.getTime()),
      );
  }

  private async upsertExternalEvent(
    connection: AppointmentCalendarConnection,
    accessToken: string,
    booking: BookingForCalendar,
    externalEventId?: string | null,
    createOnlineMeeting = false,
  ): Promise<{ id: string; etag?: string; meetingUrl?: string }> {
    const attendeeEmails = [
      ...new Set(
        [...(booking.attendeeEmails ?? []), booking.customerEmail]
          .filter((email): email is string => Boolean(email))
          .map((email) => email.trim().toLowerCase()),
      ),
    ];
    if (connection.provider === 'google') {
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events`;
      const eventUrl = externalEventId
        ? `${base}/${encodeURIComponent(externalEventId)}`
        : base;
      const response = await fetch(
        `${eventUrl}?conferenceDataVersion=1&sendUpdates=all`,
        {
          method: externalEventId ? 'PATCH' : 'POST',
          headers: this.bearerHeaders(accessToken),
          body: JSON.stringify({
            summary: booking.service.name,
            description: this.eventDescription(booking),
            location:
              booking.meetingType === 'in_person'
                ? (booking.location ?? undefined)
                : undefined,
            start: {
              dateTime: booking.startAt.toISOString(),
              timeZone: booking.timezone,
            },
            end: {
              dateTime: booking.endAt.toISOString(),
              timeZone: booking.timezone,
            },
            attendees: attendeeEmails.map((email) => ({
              email,
              displayName:
                email === booking.customerEmail?.trim().toLowerCase()
                  ? booking.customerName
                  : undefined,
            })),
            conferenceData: createOnlineMeeting
              ? {
                  createRequest: {
                    requestId: `agentcore-${booking.id}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                  },
                }
              : undefined,
            extendedProperties: { private: { agentcoreBookingId: booking.id } },
          }),
          signal: this.providerTimeoutSignal(),
        },
      );
      const body = await this.readProviderJson<{
        id: string;
        etag?: string;
        hangoutLink?: string;
        conferenceData?: {
          entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
        };
      }>(response);
      return {
        id: body.id,
        etag: body.etag,
        meetingUrl:
          body.hangoutLink ??
          body.conferenceData?.entryPoints?.find(
            (entry) => entry.entryPointType === 'video',
          )?.uri,
      };
    }

    const base =
      connection.calendarId === 'primary'
        ? 'https://graph.microsoft.com/v1.0/me/events'
        : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(connection.calendarId)}/events`;
    const response = await fetch(
      externalEventId ? `${base}/${encodeURIComponent(externalEventId)}` : base,
      {
        method: externalEventId ? 'PATCH' : 'POST',
        headers: this.bearerHeaders(accessToken),
        body: JSON.stringify({
          subject: booking.service.name,
          body: {
            contentType: 'text',
            content: this.eventDescription(booking),
          },
          location:
            booking.meetingType === 'in_person' && booking.location
              ? { displayName: booking.location }
              : undefined,
          start: {
            dateTime: this.graphUtcDateTime(booking.startAt),
            timeZone: 'UTC',
          },
          end: {
            dateTime: this.graphUtcDateTime(booking.endAt),
            timeZone: 'UTC',
          },
          attendees: attendeeEmails.map((email) => ({
            emailAddress: {
              address: email,
              name:
                email === booking.customerEmail?.trim().toLowerCase()
                  ? booking.customerName
                  : email,
            },
            type: 'required',
          })),
          ...(createOnlineMeeting
            ? {
                isOnlineMeeting: true,
                onlineMeetingProvider: 'teamsForBusiness',
              }
            : {}),
          transactionId: booking.id,
        }),
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = await this.readProviderJson<{
      id: string;
      '@odata.etag'?: string;
      onlineMeeting?: { joinUrl?: string };
    }>(response);
    return {
      id: body.id,
      etag: body['@odata.etag'],
      meetingUrl: body.onlineMeeting?.joinUrl,
    };
  }

  private async shouldCreateOnlineMeeting(
    booking: BookingForCalendar,
    connection: AppointmentCalendarConnection,
  ): Promise<boolean> {
    if (booking.meetingType !== 'online' || booking.meetingUrl) return false;
    const hostConnection =
      await this.prisma.appointmentCalendarConnection.findFirst({
        where: {
          organizationId: booking.organizationId,
          scope: 'organization',
          status: 'active',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
    return hostConnection?.id === connection.id;
  }

  private async deleteExternalEvent(
    connection: AppointmentCalendarConnection,
    accessToken: string,
    externalEventId: string,
  ) {
    const url =
      connection.provider === 'google'
        ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events/${encodeURIComponent(externalEventId)}`
        : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: this.providerTimeoutSignal(),
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      await this.readProviderJson(response);
    }
  }

  private buildAuthorizationUrl(
    provider: AppointmentCalendarProvider,
    state: string,
  ): string {
    const config = this.providerConfig(provider);
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      state,
      scope:
        provider === 'google'
          ? 'openid email https://www.googleapis.com/auth/calendar'
          : 'openid email offline_access User.Read Calendars.ReadWrite',
    });
    if (provider === 'google') {
      params.set('access_type', 'offline');
      params.set('prompt', 'consent');
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    params.set('response_mode', 'query');
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  private async exchangeAuthorizationCode(
    provider: AppointmentCalendarProvider,
    code: string,
  ) {
    const config = this.providerConfig(provider);
    const response = await fetch(
      provider === 'google'
        ? 'https://oauth2.googleapis.com/token'
        : 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
          code,
          ...(provider === 'microsoft'
            ? {
                scope:
                  'openid email offline_access User.Read Calendars.ReadWrite',
              }
            : {}),
        }),
        signal: this.providerTimeoutSignal(),
      },
    );
    const body = await this.readProviderJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    }>(response);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in ?? 3600,
    };
  }

  private async getAccessToken(
    connection: AppointmentCalendarConnection,
  ): Promise<string> {
    if (
      connection.accessTokenEncrypted &&
      connection.tokenExpiresAt &&
      connection.tokenExpiresAt.getTime() > Date.now() + 60_000
    ) {
      return this.cryptoService.decrypt(connection.accessTokenEncrypted);
    }
    const existingRefresh = this.tokenRefreshes.get(connection.id);
    if (existingRefresh) return existingRefresh;
    const refresh = this.refreshAccessToken(connection.id).finally(() => {
      this.tokenRefreshes.delete(connection.id);
    });
    this.tokenRefreshes.set(connection.id, refresh);
    return refresh;
  }

  private async refreshAccessToken(connectionId: string): Promise<string> {
    const providerTimeout = this.configService.get<number>(
      'APPOINTMENT_PROVIDER_TIMEOUT_MS',
      10_000,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`appointment-calendar-token:${connectionId}`}, 0)
          )
        `;
        const connection = await tx.appointmentCalendarConnection.findUnique({
          where: { id: connectionId },
        });
        if (!connection) {
          throw new NotFoundException('Calendar connection not found');
        }
        if (
          connection.accessTokenEncrypted &&
          connection.tokenExpiresAt &&
          connection.tokenExpiresAt.getTime() > Date.now() + 60_000
        ) {
          return this.cryptoService.decrypt(connection.accessTokenEncrypted);
        }
        if (!connection.refreshTokenEncrypted) {
          throw new ConflictException(
            'Calendar connection requires reauthorization',
          );
        }
        const config = this.providerConfig(connection.provider);
        const refreshToken = this.cryptoService.decrypt(
          connection.refreshTokenEncrypted,
        );
        const response = await fetch(
          connection.provider === 'google'
            ? 'https://oauth2.googleapis.com/token'
            : 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
              ...(connection.provider === 'microsoft'
                ? {
                    scope:
                      'openid email offline_access User.Read Calendars.ReadWrite',
                  }
                : {}),
            }),
            signal: this.providerTimeoutSignal(),
          },
        );
        const body = await this.readProviderJson<{
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        }>(response);
        await tx.appointmentCalendarConnection.update({
          where: { id: connection.id },
          data: {
            accessTokenEncrypted: this.cryptoService.encrypt(body.access_token),
            refreshTokenEncrypted: body.refresh_token
              ? this.cryptoService.encrypt(body.refresh_token)
              : undefined,
            tokenExpiresAt: new Date(
              Date.now() + (body.expires_in ?? 3600) * 1000,
            ),
            status: 'active',
            lastError: null,
          },
        });
        return body.access_token;
      },
      { timeout: providerTimeout + 5_000, maxWait: providerTimeout },
    );
  }

  private async fetchCalendarAccount(
    provider: AppointmentCalendarProvider,
    accessToken: string,
    calendarId: string,
  ) {
    if (provider === 'google') {
      const [profileResponse, calendarResponse] = await Promise.all([
        fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: this.providerTimeoutSignal(),
        }),
        fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: this.providerTimeoutSignal(),
          },
        ),
      ]);
      const profile = await this.readProviderJson<{ email?: string }>(
        profileResponse,
      );
      const calendar = await this.readProviderJson<{ summary?: string }>(
        calendarResponse,
      );
      return { email: profile.email, calendarName: calendar.summary };
    }
    const microsoftCalendarPath =
      calendarId === 'primary'
        ? '/me/calendar'
        : `/me/calendars/${encodeURIComponent(calendarId)}`;
    const [profileResponse, calendarResponse] = await Promise.all([
      fetch(
        'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: this.providerTimeoutSignal(),
        },
      ),
      fetch(`https://graph.microsoft.com/v1.0${microsoftCalendarPath}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: this.providerTimeoutSignal(),
      }),
    ]);
    const profile = await this.readProviderJson<{
      mail?: string;
      userPrincipalName?: string;
    }>(profileResponse);
    const calendar = await this.readProviderJson<{ name?: string }>(
      calendarResponse,
    );
    return {
      email: profile.mail ?? profile.userPrincipalName,
      calendarName: calendar.name,
    };
  }

  private providerConfig(provider: AppointmentCalendarProvider) {
    const prefix =
      provider === 'google' ? 'GOOGLE_CALENDAR' : 'MICROSOFT_CALENDAR';
    const clientId = this.configService.get<string>(`${prefix}_CLIENT_ID`);
    const clientSecret = this.configService.get<string>(
      `${prefix}_CLIENT_SECRET`,
    );
    const redirectUri = this.configService.get<string>(
      `${prefix}_REDIRECT_URI`,
    );
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException(
        `${provider} calendar OAuth is not configured`,
      );
    }
    return { clientId, clientSecret, redirectUri };
  }

  private async readProviderJson<T>(response: Response): Promise<T> {
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: { message?: string } | string;
      error_description?: string;
    };
    if (!response.ok) {
      const providerError =
        typeof body.error === 'string' ? body.error : body.error?.message;
      throw new BadGatewayException(
        body.error_description ??
          providerError ??
          `Calendar provider returned ${response.status}`,
      );
    }
    return body;
  }

  private bearerHeaders(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private providerTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(
      this.configService.get<number>('APPOINTMENT_PROVIDER_TIMEOUT_MS', 10_000),
    );
  }

  private graphUtcDateTime(value: Date): string {
    return value.toISOString().replace(/Z$/, '');
  }

  private graphDateTime(value?: string): Date {
    if (!value) return new Date(Number.NaN);
    return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  }

  private eventDescription(booking: BookingForCalendar): string {
    return [
      `Customer: ${booking.customerName}`,
      booking.customerEmail ? `Email: ${booking.customerEmail}` : undefined,
      booking.customerPhone ? `Phone: ${booking.customerPhone}` : undefined,
      booking.notes ? `Notes: ${booking.notes}` : undefined,
      booking.meetingUrl ? `Join meeting: ${booking.meetingUrl}` : undefined,
      booking.meetingType === 'in_person' && booking.location
        ? `Location: ${booking.location}`
        : undefined,
      booking.meetingType === 'phone' && booking.location
        ? `Call details: ${booking.location}`
        : undefined,
      `AgentCore booking: ${booking.id}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async findConnectionForActor(
    currentUser: AuthenticatedUser,
    id: string,
  ) {
    const connection =
      await this.prisma.appointmentCalendarConnection.findUnique({
        where: { id },
      });
    if (
      !connection ||
      (!this.isSuperAdmin(currentUser) &&
        connection.organizationId !== currentUser.orgId)
    ) {
      throw new NotFoundException('Calendar connection not found');
    }
    return connection;
  }

  private toConnectionResponse<T extends AppointmentCalendarConnection>(
    connection: T,
  ) {
    const {
      accessTokenEncrypted: _access,
      refreshTokenEncrypted: _refresh,
      oauthStateHash: _state,
      ...safe
    } = connection;
    void _access;
    void _refresh;
    void _state;
    return safe;
  }

  private resolveOrganizationId(
    currentUser: AuthenticatedUser,
    requested?: string,
  ) {
    if (!requested) return currentUser.orgId;
    if (!this.isSuperAdmin(currentUser) && requested !== currentUser.orgId) {
      throw new ForbiddenException('Cannot manage another organization');
    }
    return requested;
  }

  private isSuperAdmin(user: AuthenticatedUser) {
    return user.roles.includes('super_admin');
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
