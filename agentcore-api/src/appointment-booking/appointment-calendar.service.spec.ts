import { ServiceUnavailableException } from '@nestjs/common';
import {
  AppointmentCalendarConnectionScopeDto,
  AppointmentCalendarProviderDto,
} from './dto/appointment-calendar.dto';
import { AppointmentCalendarService } from './appointment-calendar.service';

describe('AppointmentCalendarService', () => {
  const now = new Date();
  const connection = {
    id: 'connection-1',
    organizationId: 'org-1',
    staffId: null,
    scope: 'organization' as const,
    provider: 'google' as const,
    status: 'active' as const,
    accountEmail: 'owner@example.com',
    calendarId: 'primary',
    calendarName: 'Primary',
    accessTokenEncrypted: 'encrypted-access',
    refreshTokenEncrypted: 'encrypted-refresh',
    tokenExpiresAt: new Date(Date.now() + 5 * 60_000),
    oauthStateHash: null,
    oauthStateExpiresAt: null,
    lastSyncedAt: now,
    lastError: null,
    settings: {},
    createdAt: now,
    updatedAt: now,
  };

  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    appointmentStaff: { findUnique: jest.fn(), findFirst: jest.fn() },
    appointmentCalendarConnection: {
      upsert: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };
  prisma.$transaction.mockImplementation(
    (callback: (client: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  const configValues: Record<string, unknown> = {
    GOOGLE_CALENDAR_CLIENT_ID: 'google-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret',
    GOOGLE_CALENDAR_REDIRECT_URI:
      'https://api.example.com/appointment-booking/calendar/oauth/google/callback',
    APPOINTMENT_CALENDAR_FAIL_OPEN: false,
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in configValues ? configValues[key] : fallback,
    ),
  };
  const crypto = {
    encrypt: jest.fn((value: string) => `encrypted:${value}`),
    decrypt: jest.fn(() => 'access-token'),
  };
  const service = new AppointmentCalendarService(
    { record: jest.fn() } as never,
    config as never,
    crypto as never,
    prisma as never,
    { isEnabled: jest.fn(() => true), add: jest.fn() } as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    configValues.APPOINTMENT_CALENDAR_FAIL_OPEN = false;
  });

  it('starts Google OAuth with a short-lived hashed state and never returns secrets', async () => {
    let persistedStateHash: unknown;
    prisma.appointmentCalendarConnection.findFirst.mockResolvedValue(null);
    prisma.appointmentCalendarConnection.create.mockImplementation(
      ({ data: create }: { data: Record<string, unknown> }) => {
        persistedStateHash = create.oauthStateHash;
        return {
          ...connection,
          ...create,
          accessTokenEncrypted: 'must-not-leak',
          refreshTokenEncrypted: 'must-not-leak',
        };
      },
    );

    const result = await service.beginConnection(
      { orgId: 'org-1', roles: ['org_admin'] } as never,
      {
        organizationId: 'org-1',
        scope: AppointmentCalendarConnectionScopeDto.organization,
        provider: AppointmentCalendarProviderDto.google,
      },
    );

    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/calendar',
    );
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(persistedStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persistedStateHash).not.toBe(url.searchParams.get('state'));
    expect(result.connection).not.toHaveProperty('accessTokenEncrypted');
    expect(result.connection).not.toHaveProperty('refreshTokenEncrypted');
    expect(result.connection).not.toHaveProperty('oauthStateHash');
  });

  it('treats Google busy periods as appointment conflicts', async () => {
    prisma.appointmentCalendarConnection.findMany.mockResolvedValue([
      connection,
    ]);
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          calendars: {
            primary: {
              busy: [
                {
                  start: '2026-07-14T09:10:00.000Z',
                  end: '2026-07-14T09:20:00.000Z',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      await expect(
        service.hasExternalConflict(
          'staff-1',
          new Date('2026-07-14T09:00:00.000Z'),
          new Date('2026-07-14T09:30:00.000Z'),
        ),
      ).resolves.toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails closed when provider availability cannot be verified', async () => {
    let lastUpdateInput: unknown;
    prisma.appointmentCalendarConnection.findMany.mockResolvedValue([
      connection,
    ]);
    prisma.appointmentCalendarConnection.update.mockImplementation(
      (input: unknown) => {
        lastUpdateInput = input;
        return connection;
      },
    );
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'provider unavailable' } }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    try {
      await expect(
        service.hasExternalConflict(
          'staff-1',
          new Date('2026-07-14T09:00:00.000Z'),
          new Date('2026-07-14T09:30:00.000Z'),
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const update = lastUpdateInput as {
        where: { id: string };
        data: { status: string; lastError: string };
      };
      expect(update.where.id).toBe(connection.id);
      expect(update.data.status).toBe('error');
      expect(update.data.lastError).toContain('provider unavailable');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('shares one OAuth refresh across concurrent work for a connection', async () => {
    const expired = {
      ...connection,
      tokenExpiresAt: new Date(Date.now() - 60_000),
    };
    prisma.appointmentCalendarConnection.findUnique.mockResolvedValue(expired);
    prisma.appointmentCalendarConnection.update.mockResolvedValue(connection);
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const tokenService = service as unknown as {
      getAccessToken(value: typeof connection): Promise<string>;
    };

    try {
      await expect(
        Promise.all([
          tokenService.getAccessToken(expired),
          tokenService.getAccessToken(expired),
        ]),
      ).resolves.toEqual(['new-access-token', 'new-access-token']);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(prisma.appointmentCalendarConnection.update).toHaveBeenCalledTimes(
        1,
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('creates a Google Meet conference and sends the customer invitation', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'google-event-1',
          etag: 'etag-1',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const calendar = service as unknown as {
      upsertExternalEvent(
        connectionValue: typeof connection,
        accessToken: string,
        booking: Record<string, unknown>,
        externalEventId: string | null,
        createOnlineMeeting: boolean,
      ): Promise<{ meetingUrl?: string }>;
    };

    try {
      await expect(
        calendar.upsertExternalEvent(
          connection,
          'access-token',
          {
            id: 'booking-1',
            customerName: 'Ada',
            customerEmail: 'ada@example.com',
            attendeeEmails: ['host@example.com', 'sales@example.com'],
            customerPhone: null,
            startAt: new Date('2026-08-01T10:00:00.000Z'),
            endAt: new Date('2026-08-01T10:30:00.000Z'),
            timezone: 'UTC',
            notes: null,
            meetingType: 'online',
            meetingUrl: null,
            location: null,
            service: { name: 'Consultation' },
          },
          null,
          true,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          meetingUrl: 'https://meet.google.com/abc-defg-hij',
        }),
      );
      const [url, init] = jest.mocked(global.fetch).mock.calls[0];
      const requestUrl =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      expect(requestUrl).toContain('conferenceDataVersion=1');
      expect(requestUrl).toContain('sendUpdates=all');
      const body = JSON.parse((init?.body ?? '{}') as string) as {
        conferenceData: {
          createRequest: { conferenceSolutionKey: { type: string } };
        };
        attendees: Array<{ email: string; displayName?: string }>;
      };
      expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe(
        'hangoutsMeet',
      );
      expect(body.attendees).toEqual([
        { email: 'host@example.com' },
        { email: 'sales@example.com' },
        { email: 'ada@example.com', displayName: 'Ada' },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('creates a Microsoft Teams meeting for an Outlook connection', async () => {
    const microsoftConnection = {
      ...connection,
      id: 'connection-2',
      provider: 'microsoft' as const,
    };
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'outlook-event-1',
          '@odata.etag': 'etag-2',
          onlineMeeting: {
            joinUrl: 'https://teams.microsoft.com/l/meetup-join/example',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const calendar = service as unknown as {
      upsertExternalEvent(
        connectionValue: typeof microsoftConnection,
        accessToken: string,
        booking: Record<string, unknown>,
        externalEventId: string | null,
        createOnlineMeeting: boolean,
      ): Promise<{ meetingUrl?: string }>;
    };

    try {
      await expect(
        calendar.upsertExternalEvent(
          microsoftConnection,
          'access-token',
          {
            id: 'booking-2',
            customerName: 'Ada',
            customerEmail: 'ada@example.com',
            attendeeEmails: ['host@example.com', 'sales@example.com'],
            customerPhone: null,
            startAt: new Date('2026-08-01T10:00:00.000Z'),
            endAt: new Date('2026-08-01T10:30:00.000Z'),
            timezone: 'UTC',
            notes: null,
            meetingType: 'online',
            meetingUrl: null,
            location: null,
            service: { name: 'Consultation' },
          },
          null,
          true,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          meetingUrl: 'https://teams.microsoft.com/l/meetup-join/example',
        }),
      );
      const [, init] = jest.mocked(global.fetch).mock.calls[0];
      const body = JSON.parse((init?.body ?? '{}') as string) as {
        isOnlineMeeting: boolean;
        onlineMeetingProvider: string;
        attendees: Array<{ emailAddress: { address: string } }>;
      };
      expect(body.isOnlineMeeting).toBe(true);
      expect(body.onlineMeetingProvider).toBe('teamsForBusiness');
      expect(
        body.attendees.map(
          (item: { emailAddress: { address: string } }) =>
            item.emailAddress.address,
        ),
      ).toEqual(['host@example.com', 'sales@example.com', 'ada@example.com']);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
