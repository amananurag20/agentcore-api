import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { VoiceAgentAvailabilityDto } from './dto/voice-receptionist.dto';
import { VoiceSoftphoneService } from './voice-softphone.service';

describe('VoiceSoftphoneService', () => {
  const user: AuthenticatedUser = {
    sub: 'ecfdf154-2b72-477e-b286-43120fe69ead',
    email: 'agent@example.com',
    orgId: 'org-1',
    roles: ['agent'],
  };

  function createService() {
    let upsertInput: unknown;
    const presence = {
      id: 'presence-1',
      organizationId: 'org-1',
      userId: user.sub,
      clientIdentity: 'agent_ecfdf1542b72477eb28643120fe69ead',
      availability: 'offline',
      lastSeenAt: new Date(),
      activeCallId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: user.sub,
          name: 'Agent One',
          email: user.email,
        }),
      },
      voiceReceptionistConfig: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'config-1',
          settings: { twilioAccountSid: 'AC123' },
        }),
      },
      voiceAgentPresence: {
        upsert: jest.fn((input: unknown) => {
          upsertInput = input;
          return Promise.resolve(presence);
        }),
        update: jest.fn().mockResolvedValue({
          ...presence,
          availability: 'available',
        }),
        findUnique: jest.fn().mockResolvedValue(presence),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      voiceCall: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          TWILIO_API_KEY_SID: 'SK123',
          TWILIO_API_KEY_SECRET: 'secret',
          TWILIO_TWIML_APP_SID: 'AP123',
          VOICE_AGENT_TOKEN_TTL_SECONDS: 3600,
          VOICE_AGENT_PRESENCE_TTL_SECONDS: 90,
        };
        return values[key] ?? fallback;
      }),
    };
    return {
      prisma,
      getUpsertInput: () => upsertInput,
      service: new VoiceSoftphoneService(
        config as unknown as ConfigService,
        prisma as never,
      ),
    };
  }

  it('issues a scoped Twilio token with a safe stable client identity', async () => {
    const { service } = createService();

    const result = await service.getState(user);

    expect(result.configured).toBe(true);
    expect(result.identity).toBe('agent_ecfdf1542b72477eb28643120fe69ead');
    expect(result.token).toMatch(/^eyJ/);
    expect(result.token).not.toContain('secret');
  });

  it('persists agent availability for browser routing', async () => {
    const { getUpsertInput, service } = createService();

    await service.setPresence(user, VoiceAgentAvailabilityDto.available);

    const invocation = getUpsertInput() as
      | {
          where: { userId: string };
          update: { availability: string };
        }
      | undefined;
    expect(invocation?.where.userId).toBe(user.sub);
    expect(invocation?.update.availability).toBe('available');
  });
});
