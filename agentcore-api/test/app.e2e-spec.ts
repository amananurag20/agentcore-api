import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { createOpenApiDocument } from './../src/docs/openapi';
import { AppModule } from './../src/app.module';

interface AuthResponseBody {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
  user: {
    id: string;
    email: string;
    orgId: string;
    roles: string[];
    passwordHash?: string;
  };
}

interface ProfileResponseBody {
  email: string;
  passwordHash?: string;
}

interface OrganizationResponseBody {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  deploymentMode: string;
  isSystem: boolean;
}

interface UserResponseBody {
  id: string;
  orgId: string;
  email: string;
  name: string;
  roles: string[];
  isActive: boolean;
  passwordHash?: string;
}

interface ProductResponseBody {
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
}

interface OrganizationProductResponseBody {
  id: string;
  organizationId: string;
  status: string;
  config: Record<string, unknown>;
  product: ProductResponseBody;
}

interface AIProviderResponseBody {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
  name: string;
  baseUrl?: string | null;
  hasApiKey: boolean;
  chatModel?: string | null;
  embeddingModel?: string | null;
  settings: Record<string, unknown>;
  apiKey?: string;
  apiKeyEncrypted?: string;
}

interface KnowledgeSourceResponseBody {
  id: string;
  organizationId: string;
  type: string;
  status: string;
  name: string;
  storageProvider?: string | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  fileSizeBytes?: number | null;
  checksumSha256?: string | null;
  rawText?: string | null;
  metadata: Record<string, unknown>;
}

interface KnowledgeDocumentResponseBody {
  id: string;
  organizationId: string;
  sourceId?: string | null;
  title: string;
  contentText?: string | null;
  metadata: Record<string, unknown>;
}

interface KnowledgeChunkResponseBody {
  id: string;
  organizationId: string;
  sourceId?: string | null;
  documentId: string;
  chunkIndex: number;
  content: string;
  charCount: number;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}

interface KnowledgeSearchResponseBody {
  id: string;
  organizationId: string;
  sourceId?: string | null;
  documentId: string;
  chunkIndex: number;
  content: string;
  score: number;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
}

interface CustomerChatConversationResponseBody {
  id: string;
  organizationId: string;
  status: string;
  version: number;
  assignedAgentId?: string | null;
  visitorId?: string | null;
  visitorName?: string | null;
  visitorEmail?: string | null;
  messages: CustomerChatMessageResponseBody[];
}

interface CustomerChatMessageResponseBody {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  citations: Array<{
    chunkId: string;
    score: number;
    content?: string;
  }>;
}

interface CustomerChatSendMessageResponseBody {
  conversation: CustomerChatConversationResponseBody;
  visitorMessage: CustomerChatMessageResponseBody;
  assistantMessage: CustomerChatMessageResponseBody | null;
}

interface CustomerChatAgentMessageResponseBody {
  conversation: CustomerChatConversationResponseBody;
  agentMessage: CustomerChatMessageResponseBody;
}

interface CustomerChatConversationListResponseBody {
  data: CustomerChatConversationResponseBody[];
  total: number;
  page: number;
  limit: number;
}

interface CustomerChatWidgetConfigResponseBody {
  id: string;
  organizationId: string;
  name: string;
  widgetKey: string;
  enabled: boolean;
  knowledgeScope?: 'all' | 'folders';
  folderIds?: string[];
  greetingText: string;
  allowedDomains?: string[];
  settings: Record<string, unknown>;
}

interface CustomerChatWidgetConfigListResponseBody {
  data: CustomerChatWidgetConfigResponseBody[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface PublicCustomerChatConversationCreatedBody {
  conversation: CustomerChatConversationResponseBody;
  visitorToken: string;
}

interface OpenApiResponseBody {
  info: {
    title: string;
  };
  paths: Record<string, unknown>;
}

interface AuditLogListResponseBody {
  data: Array<{
    id: string;
    organizationId?: string | null;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata: Record<string, unknown>;
  }>;
  total: number;
  page: number;
  limit: number;
}

interface AppointmentServiceResponseBody {
  id: string;
  organizationId: string;
  name: string;
  durationMinutes: number;
  status: string;
}

interface AppointmentStaffResponseBody {
  id: string;
  organizationId: string;
  name: string;
  status: string;
  services: AppointmentServiceResponseBody[];
}

interface AppointmentSlotResponseBody {
  staffId: string;
  staffName: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

interface AppointmentBookingResponseBody {
  id: string;
  organizationId: string;
  serviceId: string;
  staffId: string;
  status: string;
  manageToken?: string;
  customerName: string;
  customerEmail?: string | null;
  startAt: string;
  endAt: string;
}

interface AppointmentBookingListResponseBody {
  data: AppointmentBookingResponseBody[];
  total: number;
  page: number;
  limit: number;
}

interface WhatsAppConfigResponseBody {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
  name: string;
  hasAccessToken: boolean;
  hasWebhookVerifyToken: boolean;
  hasAppSecret: boolean;
}

interface WhatsAppMessageResponseBody {
  id: string;
  direction: string;
  role: string;
  type: string;
  content?: string | null;
  metadata: Record<string, unknown>;
}

interface WhatsAppConversationResponseBody {
  id: string;
  organizationId: string;
  configId: string;
  status: string;
  contactWaId: string;
  contactName?: string | null;
  assignedAgentId?: string | null;
  messages: WhatsAppMessageResponseBody[];
}

interface WhatsAppConversationListResponseBody {
  data: WhatsAppConversationResponseBody[];
  total: number;
  page: number;
  limit: number;
}

interface WhatsAppInboundWebhookResponseBody {
  conversation: WhatsAppConversationResponseBody;
  inboundMessage: WhatsAppMessageResponseBody;
  assistantMessage?: WhatsAppMessageResponseBody | null;
  delivery: {
    provider: string;
    status: string;
  };
}

interface VoiceConfigResponseBody {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
  name: string;
  hasWebhookVerifyToken: boolean;
  hasApiKey: boolean;
}

interface VoiceCallEventResponseBody {
  id: string;
  type: string;
  role: string;
  content?: string | null;
  metadata: Record<string, unknown>;
}

interface VoiceCallResponseBody {
  id: string;
  organizationId: string;
  configId: string;
  status: string;
  providerCallId?: string | null;
  fromNumber?: string | null;
  callerName?: string | null;
  assignedAgentId?: string | null;
  events: VoiceCallEventResponseBody[];
}

interface VoiceCallListResponseBody {
  data: VoiceCallResponseBody[];
  total: number;
  page: number;
  limit: number;
}

interface VoiceWebhookResponseBody {
  call: VoiceCallResponseBody;
  inboundEvent: VoiceCallEventResponseBody;
  assistantEvent?: VoiceCallEventResponseBody | null;
  action: {
    provider: string;
    status: string;
  };
}

interface HealthResponseBody {
  status: string;
  database: string;
  redis: {
    status: string;
  };
  queue: {
    status: string;
  };
  storage: {
    status: string;
  };
}

interface ResponseLike {
  json(body: unknown): void;
}

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  jest.setTimeout(120000);

  async function loginAsAdmin(): Promise<AuthResponseBody> {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@agentcore.local',
        password: 'Admin@12345',
      })
      .expect(201);

    return login.body as AuthResponseBody;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    const document = createOpenApiDocument(app);
    app
      .getHttpAdapter()
      .get('/openapi.json', (_request: unknown, response: ResponseLike) => {
        response.json(document);
      });
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health (GET) returns API and database health', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((response) => {
        const body = response.body as HealthResponseBody;

        expect(['ok', 'degraded']).toContain(body.status);
        expect(body.database).toBe('ok');
        expect(body.redis.status).toEqual(expect.any(String));
        expect(body.queue.status).toEqual(expect.any(String));
        expect(body.storage.status).toEqual(expect.any(String));
      });
  });

  it('/observability/summary (GET) returns admin operational summary', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .get('/api/v1/observability/summary')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as {
          process: { uptimeSeconds: number };
          customerChat: { open: number };
          appointmentBooking: { upcoming: number };
        };

        expect(body.process.uptimeSeconds).toEqual(expect.any(Number));
        expect(body.customerChat.open).toEqual(expect.any(Number));
        expect(body.appointmentBooking.upcoming).toEqual(expect.any(Number));
      });
  });

  it('/openapi.json (GET) returns the generated API schema', () => {
    return request(app.getHttpServer())
      .get('/openapi.json')
      .expect(200)
      .expect((response) => {
        const body = response.body as OpenApiResponseBody;

        expect(body.info.title).toBe('AgentCore API');
        expect(body.paths).toHaveProperty('/api/v1/auth/login');
        expect(body.paths).toHaveProperty('/api/v1/audit-logs');
        expect(body.paths).toHaveProperty('/api/v1/health');
        expect(body.paths).toHaveProperty('/api/v1/observability/summary');
        expect(body.paths).toHaveProperty('/api/v1/organizations/me');
        expect(body.paths).toHaveProperty('/api/v1/users');
        expect(body.paths).toHaveProperty('/api/v1/products');
        expect(body.paths).toHaveProperty('/api/v1/organizations/me/products');
        expect(body.paths).toHaveProperty('/api/v1/ai/providers');
        expect(body.paths).toHaveProperty('/api/v1/knowledge/sources');
        expect(body.paths).toHaveProperty('/api/v1/knowledge/sources/upload');
        expect(body.paths).toHaveProperty(
          '/api/v1/knowledge/sources/{id}/ingest',
        );
        expect(body.paths).toHaveProperty('/api/v1/knowledge/documents');
        expect(body.paths).toHaveProperty('/api/v1/knowledge/chunks');
        expect(body.paths).toHaveProperty('/api/v1/knowledge/search');
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}/messages',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}/agent-messages',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}/assignment',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}/status',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/conversations/{id}/handoff',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget-config',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget-configs',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget-configs/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget/{widgetKey}/config',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget/{widgetKey}/conversations',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget/conversations/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/customer-chat/widget/conversations/{id}/messages',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/services',
        );
        expect(body.paths).toHaveProperty('/api/v1/appointment-booking/staff');
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/staff/{id}/availability',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/availability',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/bookings',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/bookings/{id}/reschedule',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/bookings/{id}/cancel',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/calendars/connections',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/calendars/connections/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/calendar/oauth/{provider}/callback',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/public/services',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/public/availability',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/appointment-booking/public/bookings',
        );
        expect(body.paths).toHaveProperty('/api/v1/whatsapp-assistant/configs');
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/conversations',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/conversations/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/conversations/{id}/agent-messages',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/conversations/{id}/handoff',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/webhook/{configId}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/whatsapp-assistant/webhook/{configId}/inbound',
        );
        expect(body.paths).toHaveProperty('/api/v1/voice-receptionist/configs');
        expect(body.paths).toHaveProperty('/api/v1/voice-receptionist/calls');
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/calls/{id}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/calls/{id}/agent-messages',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/calls/{id}/handoff',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/calls/{id}/route',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/webhook/{configId}',
        );
        expect(body.paths).toHaveProperty(
          '/api/v1/voice-receptionist/webhook/{configId}/events',
        );
      });
  });

  it('/auth/login (POST) returns an access token for the seeded admin', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@agentcore.local',
        password: 'Admin@12345',
      })
      .expect(201);

    const body = response.body as AuthResponseBody;

    expect(body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: '15m',
      user: {
        email: 'admin@agentcore.local',
        orgId: 'org_demo',
        roles: ['super_admin'],
      },
    });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('/audit-logs lists business audit events', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .query({ action: 'auth.login', limit: 10 })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as AuditLogListResponseBody;

        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(body.data.some((item) => item.action === 'auth.login')).toBe(
          true,
        );
      });
  });

  it('/auth/me (GET) returns the current user when authenticated', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as ProfileResponseBody;

        expect(body.email).toBe('admin@agentcore.local');
        expect(body.passwordHash).toBeUndefined();
      });
  });

  it('/auth/me (GET) rejects anonymous requests', () => {
    return request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('/organizations/me (GET) returns the current organization', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .get('/api/v1/organizations/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationResponseBody;

        expect(body.id).toBe('org_demo');
        expect(body.slug).toBe('platform-test-workspace');
        expect(body.status).toBe('active');
      });
  });

  it('/organizations/me (PATCH) updates the current organization', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .patch('/api/v1/organizations/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'Platform Test Workspace',
        plan: 'free',
        deploymentMode: 'saas',
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationResponseBody;

        expect(body.id).toBe('org_demo');
        expect(body.name).toBe('Platform Test Workspace');
        expect(body.isSystem).toBe(true);
        expect(body.plan).toBe('free');
      });
  });

  it('/organizations (POST) creates and reads an organization as super admin', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();

    const created = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E Organization ${suffix}`,
        slug: `e2e-organization-${suffix}`,
        plan: 'starter',
        deploymentMode: 'saas',
        firstAdmin: {
          name: 'E2E Organization Admin',
          email: `e2e-org-admin-${suffix}@agentcore.local`,
          password: 'E2E-Admin@12345',
        },
      })
      .expect(201);

    const createdBody = created.body as OrganizationResponseBody;
    expect(createdBody.isSystem).toBe(false);

    return request(app.getHttpServer())
      .get(`/api/v1/organizations/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationResponseBody;

        expect(body.id).toBe(createdBody.id);
        expect(body.slug).toBe(`e2e-organization-${suffix}`);
        expect(body.plan).toBe('starter');
      });
  });

  it('/organizations (GET) lists tenants without the system workspace', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .get('/api/v1/organizations')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationResponseBody[];

        expect(
          body.some((organization) => organization.id === 'org_demo'),
        ).toBe(false);
        expect(
          body.every(
            (organization) => organization.name !== 'Platform Test Workspace',
          ),
        ).toBe(true);
      });
  });

  it('/users manages organization users as super admin', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const email = `managed-${suffix}@agentcore.local`;

    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'Managed User',
        email,
        password: 'StrongPassword@123',
        orgId: 'org_demo',
        roles: ['agent'],
      })
      .expect(201);

    const createdBody = created.body as UserResponseBody;

    expect(createdBody.email).toBe(email);
    expect(createdBody.orgId).toBe('org_demo');
    expect(createdBody.roles).toEqual(['agent']);
    expect(createdBody.passwordHash).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as UserResponseBody[];
        expect(body.some((user) => user.id === createdBody.id)).toBe(true);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/users/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as UserResponseBody;
        expect(body.email).toBe(email);
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ name: 'Managed User Updated' })
      .expect(200)
      .expect((response) => {
        const body = response.body as UserResponseBody;
        expect(body.name).toBe('Managed User Updated');
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdBody.id}/status`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'inactive' })
      .expect(200)
      .expect((response) => {
        const body = response.body as UserResponseBody;
        expect(body.isActive).toBe(false);
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/users/${createdBody.id}/roles`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ roles: ['user'] })
      .expect(200)
      .expect((response) => {
        const body = response.body as UserResponseBody;
        expect(body.roles).toEqual(['user']);
      });
  });

  it('/users prevents self-deactivation', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .patch(`/api/v1/users/${loginBody.user.id}/status`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'inactive' })
      .expect(400);
  });

  it('/users prevents org admins from assigning super_admin', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();

    const orgAdmin = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'Org Admin',
        email: `org-admin-${suffix}@agentcore.local`,
        password: 'StrongPassword@123',
        orgId: 'org_demo',
        roles: ['org_admin'],
      })
      .expect(201);
    const orgAdminBody = orgAdmin.body as UserResponseBody;

    const orgAdminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: orgAdminBody.email,
        password: 'StrongPassword@123',
      })
      .expect(201);
    const orgAdminLoginBody = orgAdminLogin.body as AuthResponseBody;

    return request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${orgAdminLoginBody.accessToken}`)
      .send({
        name: 'Blocked Super Admin',
        email: `blocked-super-admin-${suffix}@agentcore.local`,
        password: 'StrongPassword@123',
        roles: ['super_admin'],
      })
      .expect(403);
  });

  it('/products (GET) lists the product catalog', () => {
    return request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200)
      .expect((response) => {
        const body = response.body as ProductResponseBody[];
        const keys = body.map((product) => product.key);

        expect(keys).toEqual(
          expect.arrayContaining([
            'customer_chat',
            'appointment_booking',
            'whatsapp_assistant',
            'voice_receptionist',
          ]),
        );
      });
  });

  it('/organizations/me/products lists and updates current org entitlements', async () => {
    const loginBody = await loginAsAdmin();

    await request(app.getHttpServer())
      .get('/api/v1/organizations/me/products')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationProductResponseBody[];
        const customerChat = body.find(
          (item) => item.product.key === 'customer_chat',
        );

        expect(customerChat?.status).toBe('enabled');
      });

    await request(app.getHttpServer())
      .patch('/api/v1/organizations/me/products/appointment_booking')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        status: 'enabled',
        config: { defaultDurationMinutes: 30 },
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationProductResponseBody;

        expect(body.status).toBe('enabled');
        expect(body.product.key).toBe('appointment_booking');
        expect(body.config).toMatchObject({ defaultDurationMinutes: 30 });
      });
  });

  it('/appointment-booking manages availability, conflicts, reschedule, cancel, and public booking', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const date = new Date(Date.now() + 30 * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
    const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();

    await request(app.getHttpServer())
      .patch('/api/v1/organizations/me/products/appointment_booking')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'enabled' })
      .expect(200);

    const service = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/services')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E Consultation ${suffix}`,
        description: 'E2E appointment service',
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      })
      .expect(201);
    const serviceBody = service.body as AppointmentServiceResponseBody;

    expect(serviceBody.organizationId).toBe('org_demo');
    expect(serviceBody.durationMinutes).toBe(30);
    expect(serviceBody.status).toBe('active');

    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/public/bookings')
      .send({
        organizationId: 'org_demo',
        serviceId: serviceBody.id,
        customerName: 'Past Booking Customer',
        startAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/public/bookings')
      .send({
        organizationId: 'org_demo',
        serviceId: serviceBody.id,
        customerName: 'Far Future Booking Customer',
        startAt: new Date(Date.now() + 366 * 24 * 60 * 60_000).toISOString(),
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/actions/execute')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ action: 'list_services' })
      .expect(201)
      .expect((response) => {
        const body = response.body as {
          action: string;
          data: AppointmentServiceResponseBody[];
        };
        expect(body.action).toBe('list_services');
        expect(body.data.some((item) => item.id === serviceBody.id)).toBe(true);
      });

    const staff = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/staff')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E Staff ${suffix}`,
        email: `appointment-staff-${suffix}@agentcore.local`,
        timezone: 'UTC',
        serviceIds: [serviceBody.id],
      })
      .expect(201);
    const staffBody = staff.body as AppointmentStaffResponseBody;

    expect(staffBody.organizationId).toBe('org_demo');
    expect(staffBody.services.map((item) => item.id)).toContain(serviceBody.id);

    await request(app.getHttpServer())
      .post(`/api/v1/appointment-booking/staff/${staffBody.id}/availability`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        dayOfWeek,
        startTime: '09:00',
        endTime: '12:00',
      })
      .expect(201);

    const resource = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/resources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ name: `E2E Room ${suffix}`, type: 'room', capacity: 1 })
      .expect(201);
    const resourceId = (resource.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/api/v1/appointment-booking/services/${serviceBody.id}/resources`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ resourceId, quantity: 1 })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/appointment-booking/staff/${staffBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ resourceIds: [resourceId] })
      .expect(200);

    const secondStaff = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/staff')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E Second Staff ${suffix}`,
        timezone: 'UTC',
        serviceIds: [serviceBody.id],
        resourceIds: [resourceId],
      })
      .expect(201);
    const secondStaffId = (secondStaff.body as AppointmentStaffResponseBody).id;
    await request(app.getHttpServer())
      .post(`/api/v1/appointment-booking/staff/${secondStaffId}/availability`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ dayOfWeek, startTime: '09:00', endTime: '12:00' })
      .expect(201);

    const resourceBooking = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/bookings')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        serviceId: serviceBody.id,
        staffId: staffBody.id,
        customerName: 'Resource Capacity Customer',
        startAt: `${date}T09:00:00.000Z`,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/bookings')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        serviceId: serviceBody.id,
        staffId: secondStaffId,
        customerName: 'Blocked Resource Customer',
        startAt: `${date}T09:00:00.000Z`,
      })
      .expect(409);
    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/bookings/${(resourceBooking.body as AppointmentBookingResponseBody).id}/cancel`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ reason: 'Release resource for remaining test' })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/appointment-booking/staff/${staffBody.id}/availability`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as Array<{ dayOfWeek: number }>;

        expect(body.some((item) => item.dayOfWeek === dayOfWeek)).toBe(true);
      });

    await request(app.getHttpServer())
      .get('/api/v1/appointment-booking/availability')
      .query({ serviceId: serviceBody.id, date })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentSlotResponseBody[];

        expect(
          body.some(
            (slot) =>
              slot.staffId === staffBody.id &&
              slot.startAt === `${date}T10:00:00.000Z`,
          ),
        ).toBe(true);
      });

    const booking = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/bookings')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        serviceId: serviceBody.id,
        staffId: staffBody.id,
        customerName: 'E2E Appointment Customer',
        customerEmail: `appointment-customer-${suffix}@agentcore.local`,
        startAt: `${date}T10:00:00.000Z`,
      })
      .expect(201);
    const bookingBody = booking.body as AppointmentBookingResponseBody;

    expect(bookingBody.status).toBe('confirmed');
    expect(bookingBody.staffId).toBe(staffBody.id);

    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/bookings')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        serviceId: serviceBody.id,
        staffId: staffBody.id,
        customerName: 'Blocked Double Booking',
        startAt: `${date}T10:00:00.000Z`,
      })
      .expect(409);

    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/bookings/${bookingBody.id}/reschedule`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        staffId: staffBody.id,
        startAt: `${date}T11:00:00.000Z`,
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentBookingResponseBody;

        expect(body.startAt).toBe(`${date}T11:00:00.000Z`);
        expect(body.status).toBe('confirmed');
      });

    await request(app.getHttpServer())
      .get('/api/v1/appointment-booking/bookings')
      .query({ serviceId: serviceBody.id, staffId: staffBody.id, limit: 10 })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentBookingListResponseBody;

        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(body.data.some((item) => item.id === bookingBody.id)).toBe(true);
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/appointment-booking/bookings/${bookingBody.id}/cancel`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ reason: 'E2E cancellation' })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentBookingResponseBody;

        expect(body.status).toBe('cancelled');
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/bookings/${bookingBody.id}/reschedule`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        staffId: staffBody.id,
        startAt: `${date}T11:30:00.000Z`,
      })
      .expect(409);

    await request(app.getHttpServer())
      .get('/api/v1/appointment-booking/public/services')
      .query({ organizationId: 'org_demo' })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentServiceResponseBody[];

        expect(body.some((item) => item.id === serviceBody.id)).toBe(true);
      });

    await request(app.getHttpServer())
      .get('/api/v1/appointment-booking/public/availability')
      .query({
        organizationId: 'org_demo',
        serviceId: serviceBody.id,
        date,
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentSlotResponseBody[];

        expect(
          body.some(
            (slot) =>
              slot.staffId === staffBody.id &&
              slot.startAt === `${date}T10:00:00.000Z`,
          ),
        ).toBe(true);
      });

    const publicBooking = await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/public/bookings')
      .send({
        organizationId: 'org_demo',
        serviceId: serviceBody.id,
        staffId: staffBody.id,
        customerName: 'Public Appointment Customer',
        customerEmail: `public-appointment-${suffix}@agentcore.local`,
        startAt: `${date}T10:00:00.000Z`,
      })
      .expect(201);
    const publicBookingBody =
      publicBooking.body as AppointmentBookingResponseBody;
    expect(publicBookingBody.status).toBe('confirmed');
    expect(publicBookingBody.organizationId).toBe('org_demo');
    expect(publicBookingBody.manageToken).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/public/bookings/${publicBookingBody.id}/reschedule`,
      )
      .send({
        organizationId: 'org_demo',
        manageToken: publicBookingBody.manageToken,
        startAt: `${date}T10:30:00.000Z`,
        timezone: 'UTC',
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentBookingResponseBody;
        expect(body.startAt).toBe(`${date}T10:30:00.000Z`);
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/public/bookings/${publicBookingBody.id}/cancel`,
      )
      .send({
        organizationId: 'org_demo',
        manageToken: 'invalid-management-token-that-is-long-enough',
      })
      .expect(404);

    await request(app.getHttpServer())
      .patch(
        `/api/v1/appointment-booking/public/bookings/${publicBookingBody.id}/cancel`,
      )
      .send({
        organizationId: 'org_demo',
        manageToken: publicBookingBody.manageToken,
        reason: 'Customer self-service cancellation',
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as AppointmentBookingResponseBody;
        expect(body.status).toBe('cancelled');
      });
  });

  it('/whatsapp-assistant handles inbound RAG, handoff, transcript, and agent replies', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const contactWaId = `1555${suffix}`;
    const allowedAnswer = `E2E WhatsApp support ${suffix}: WhatsApp customers can book appointments from 9am to 3pm.`;

    await request(app.getHttpServer())
      .patch('/api/v1/organizations/me/products/whatsapp_assistant')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'enabled' })
      .expect(200);

    const source = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `E2E WhatsApp Knowledge ${suffix}`,
        rawText: allowedAnswer,
      })
      .expect(201);
    const sourceBody = source.body as KnowledgeSourceResponseBody;

    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/sources/${sourceBody.id}/ingest`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(201);

    const config = await request(app.getHttpServer())
      .post('/api/v1/whatsapp-assistant/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E WhatsApp ${suffix}`,
        provider: 'meta',
        phoneNumberId: `phone-${suffix}`,
        accessToken: 'test-access-token',
        webhookVerifyToken: `verify-${suffix}`,
        defaultLocale: 'en',
      })
      .expect(201);
    const configBody = config.body as WhatsAppConfigResponseBody;

    expect(configBody.organizationId).toBe('org_demo');
    expect(configBody.hasAccessToken).toBe(true);
    expect(configBody.hasWebhookVerifyToken).toBe(true);

    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp-assistant/webhook/${configBody.id}`)
      .query({
        'hub.verify_token': `verify-${suffix}`,
        'hub.challenge': `challenge-${suffix}`,
      })
      .expect(200)
      .expect('challenge-' + suffix);

    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp-assistant/webhook/${configBody.id}`)
      .query({
        'hub.verify_token': 'wrong-token',
        'hub.challenge': `challenge-${suffix}`,
      })
      .expect(403);

    const inbound = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp-assistant/webhook/${configBody.id}/inbound`)
      .send({
        contactWaId,
        contactName: 'WhatsApp Customer',
        contactPhone: `+${contactWaId}`,
        providerMessageId: `wamid-${suffix}`,
        type: 'text',
        content: 'When can WhatsApp customers book appointments?',
      })
      .expect(201);
    const inboundBody = inbound.body as WhatsAppInboundWebhookResponseBody;

    expect(inboundBody.conversation.status).toBe('open');
    expect(inboundBody.inboundMessage.role).toBe('contact');
    expect(inboundBody.assistantMessage?.role).toBe('assistant');
    expect(inboundBody.assistantMessage?.content).toContain(
      'WhatsApp customers can book appointments',
    );
    expect(inboundBody.delivery).toMatchObject({
      provider: 'mock',
      status: 'queued',
    });

    await request(app.getHttpServer())
      .get('/api/v1/whatsapp-assistant/conversations')
      .query({ search: contactWaId, limit: 10 })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as WhatsAppConversationListResponseBody;

        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(
          body.data.some((item) => item.id === inboundBody.conversation.id),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp-assistant/conversations/${inboundBody.conversation.id}`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as WhatsAppConversationResponseBody;

        expect(body.messages).toHaveLength(2);
        expect(body.messages.map((message) => message.role)).toEqual([
          'contact',
          'assistant',
        ]);
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/whatsapp-assistant/conversations/${inboundBody.conversation.id}/handoff`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as WhatsAppConversationResponseBody;

        expect(body.status).toBe('waiting_for_agent');
      });

    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp-assistant/webhook/${configBody.id}/inbound`)
      .send({
        contactWaId,
        type: 'text',
        content: 'I still need a human.',
      })
      .expect(201)
      .expect((response) => {
        const body = response.body as WhatsAppInboundWebhookResponseBody;

        expect(body.assistantMessage).toBeNull();
        expect(body.delivery.status).toBe('handoff_waiting');
      });

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp-assistant/conversations/${inboundBody.conversation.id}/agent-messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ content: 'A human agent is joining this WhatsApp chat.' })
      .expect(201)
      .expect((response) => {
        const body = response.body as {
          conversation: WhatsAppConversationResponseBody;
          agentMessage: WhatsAppMessageResponseBody;
        };

        expect(body.agentMessage.role).toBe('agent');
        expect(body.agentMessage.direction).toBe('outbound');
        expect(
          body.conversation.messages.some(
            (message) => message.role === 'agent',
          ),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/whatsapp-assistant/conversations/${inboundBody.conversation.id}/status`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'closed' })
      .expect(200)
      .expect((response) => {
        const body = response.body as WhatsAppConversationResponseBody;

        expect(body.status).toBe('closed');
      });
  });

  it('/voice-receptionist handles call events, RAG, handoff, routing, and transcript history', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const providerCallId = `call-${suffix}`;
    const allowedAnswer = `E2E Voice support ${suffix}: Voice callers can reach reception from 10am to 4pm.`;

    await request(app.getHttpServer())
      .patch('/api/v1/organizations/me/products/voice_receptionist')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'enabled' })
      .expect(200);

    const source = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `E2E Voice Knowledge ${suffix}`,
        rawText: allowedAnswer,
      })
      .expect(201);
    const sourceBody = source.body as KnowledgeSourceResponseBody;

    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/sources/${sourceBody.id}/ingest`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(201);

    const config = await request(app.getHttpServer())
      .post('/api/v1/voice-receptionist/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `E2E Voice ${suffix}`,
        provider: 'twilio',
        phoneNumber: `+1555${suffix}`,
        apiKey: 'test-voice-api-key',
        webhookVerifyToken: `verify-${suffix}`,
        sttProvider: 'openai',
        ttsProvider: 'openai',
        ttsVoice: 'alloy',
        transferPhoneNumber: '+15550001111',
        voicemailEnabled: true,
      })
      .expect(201);
    const configBody = config.body as VoiceConfigResponseBody;

    expect(configBody.organizationId).toBe('org_demo');
    expect(configBody.hasApiKey).toBe(true);
    expect(configBody.hasWebhookVerifyToken).toBe(true);

    await request(app.getHttpServer())
      .get(`/api/v1/voice-receptionist/webhook/${configBody.id}`)
      .query({
        verify_token: `verify-${suffix}`,
        challenge: `challenge-${suffix}`,
      })
      .expect(200)
      .expect('challenge-' + suffix);

    await request(app.getHttpServer())
      .get(`/api/v1/voice-receptionist/webhook/${configBody.id}`)
      .query({
        verify_token: 'wrong-token',
        challenge: `challenge-${suffix}`,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/voice-receptionist/webhook/${configBody.id}/events`)
      .send({
        providerCallId,
        fromNumber: '+15551230000',
        toNumber: `+1555${suffix}`,
        callerName: 'Voice Customer',
        eventType: 'call_started',
      })
      .expect(201);

    const signedPayload = {
      providerCallId,
      eventType: 'stt_partial',
      content: 'When can voice',
      confidence: 0.88,
    };
    const signedJson = JSON.stringify(signedPayload);
    const signature = createHmac('sha256', 'test-voice-api-key')
      .update(Buffer.from(signedJson))
      .digest('hex');

    await request(app.getHttpServer())
      .post(`/api/v1/voice-receptionist/webhook/${configBody.id}/events`)
      .set('Content-Type', 'application/json')
      .set('x-agentcore-signature', `sha256=${signature}`)
      .send(signedJson)
      .expect(201);

    const transcript = await request(app.getHttpServer())
      .post(`/api/v1/voice-receptionist/webhook/${configBody.id}/events`)
      .send({
        providerCallId,
        eventType: 'transcript',
        content: 'When can voice callers reach reception?',
        confidence: 0.96,
      })
      .expect(201);
    const transcriptBody = transcript.body as VoiceWebhookResponseBody;

    expect(transcriptBody.call.status).toBe('in_progress');
    expect(transcriptBody.inboundEvent.role).toBe('caller');
    expect(transcriptBody.assistantEvent?.role).toBe('assistant');
    expect(transcriptBody.assistantEvent?.content).toContain(
      'Voice callers can reach reception',
    );
    expect(transcriptBody.action).toMatchObject({
      provider: 'mock',
      status: 'queued',
    });

    await request(app.getHttpServer())
      .post(`/api/v1/voice-receptionist/webhook/${configBody.id}/events`)
      .send({
        providerCallId,
        eventType: 'barge_in',
        content: 'Actually I need a human.',
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/voice-receptionist/calls')
      .query({ search: providerCallId, limit: 10 })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as VoiceCallListResponseBody;

        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(
          body.data.some((item) => item.id === transcriptBody.call.id),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/voice-receptionist/calls/${transcriptBody.call.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as VoiceCallResponseBody;

        expect(body.events.some((event) => event.type === 'transcript')).toBe(
          true,
        );
        expect(
          body.events.some((event) => event.type === 'assistant_response'),
        ).toBe(true);
        expect(body.events.some((event) => event.type === 'barge_in')).toBe(
          true,
        );
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/voice-receptionist/calls/${transcriptBody.call.id}/handoff`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as VoiceCallResponseBody;

        expect(body.status).toBe('waiting_for_agent');
      });

    await request(app.getHttpServer())
      .post(
        `/api/v1/voice-receptionist/calls/${transcriptBody.call.id}/agent-messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ content: 'A human agent is joining this voice call.' })
      .expect(201)
      .expect((response) => {
        const body = response.body as {
          call: VoiceCallResponseBody;
          event: VoiceCallEventResponseBody;
        };

        expect(body.event.role).toBe('agent');
        expect(body.call.events.some((event) => event.role === 'agent')).toBe(
          true,
        );
      });

    await request(app.getHttpServer())
      .post(`/api/v1/voice-receptionist/calls/${transcriptBody.call.id}/route`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ action: 'voicemail', reason: 'Caller requested voicemail.' })
      .expect(201)
      .expect((response) => {
        const body = response.body as { call: VoiceCallResponseBody };

        expect(body.call.status).toBe('voicemail');
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/voice-receptionist/calls/${transcriptBody.call.id}/status`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'completed' })
      .expect(200)
      .expect((response) => {
        const body = response.body as VoiceCallResponseBody;

        expect(body.status).toBe('completed');
      });
  });

  it('/ai/providers manages encrypted provider configs', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();

    const created = await request(app.getHttpServer())
      .post('/api/v1/ai/providers')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        provider: 'openai',
        name: `E2E OpenAI ${suffix}`,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-secret',
        chatModel: 'gpt-4.1-mini',
        embeddingModel: 'text-embedding-3-small',
        settings: { temperature: 0.2 },
      })
      .expect(201);

    const createdBody = created.body as AIProviderResponseBody;

    expect(createdBody.provider).toBe('openai');
    expect(createdBody.organizationId).toBe('org_demo');
    expect(createdBody.hasApiKey).toBe(true);
    expect(createdBody.apiKey).toBeUndefined();
    expect(createdBody.apiKeyEncrypted).toBeUndefined();
    expect(createdBody.settings).toMatchObject({ temperature: 0.2 });

    await request(app.getHttpServer())
      .get('/api/v1/ai/providers')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as AIProviderResponseBody[];
        expect(body.some((provider) => provider.id === createdBody.id)).toBe(
          true,
        );
      });

    await request(app.getHttpServer())
      .get(`/api/v1/ai/providers/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as AIProviderResponseBody;

        expect(body.name).toBe(`E2E OpenAI ${suffix}`);
        expect(body.provider).toBe('openai');
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/ai/providers/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        status: 'inactive',
        chatModel: 'gpt-4.1',
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as AIProviderResponseBody;

        expect(body.status).toBe('inactive');
        expect(body.chatModel).toBe('gpt-4.1');
        expect(body.hasApiKey).toBe(true);
      });

    await request(app.getHttpServer())
      .delete(`/api/v1/ai/providers/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect({ deleted: true });

    await request(app.getHttpServer())
      .get(`/api/v1/ai/providers/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(404);
  });

  it('keeps platform workspace operations isolated until a tenant is selected', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const tenant = await request(app.getHttpServer())
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: `Isolation Tenant ${suffix}`,
        slug: `isolation-tenant-${suffix}`,
        plan: 'starter',
        deploymentMode: 'saas',
        enabledProducts: ['whatsapp_assistant', 'voice_receptionist'],
        firstAdmin: {
          name: 'Isolation Tenant Admin',
          email: `isolation-admin-${suffix}@agentcore.local`,
          password: 'E2E-Admin@12345',
        },
      })
      .expect(201);
    const tenantBody = tenant.body as OrganizationResponseBody;

    const provider = await request(app.getHttpServer())
      .post('/api/v1/ai/providers')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        organizationId: tenantBody.id,
        provider: 'openai',
        name: `Tenant OpenAI ${suffix}`,
      })
      .expect(201);
    const providerBody = provider.body as AIProviderResponseBody;

    const whatsApp = await request(app.getHttpServer())
      .post('/api/v1/whatsapp-assistant/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        organizationId: tenantBody.id,
        name: `Tenant WhatsApp ${suffix}`,
        provider: 'meta',
      })
      .expect(201);
    const whatsAppBody = whatsApp.body as WhatsAppConfigResponseBody;

    const voice = await request(app.getHttpServer())
      .post('/api/v1/voice-receptionist/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        organizationId: tenantBody.id,
        name: `Tenant Voice ${suffix}`,
        provider: 'twilio',
      })
      .expect(201);
    const voiceBody = voice.body as VoiceConfigResponseBody;

    const knowledge = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        organizationId: tenantBody.id,
        type: 'text',
        name: `Tenant Knowledge ${suffix}`,
        rawText: `Private tenant knowledge ${suffix}`,
      })
      .expect(201);
    const knowledgeBody = knowledge.body as KnowledgeSourceResponseBody;

    const platformProviders = await request(app.getHttpServer())
      .get('/api/v1/ai/providers')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (platformProviders.body as AIProviderResponseBody[]).some(
        (item) => item.id === providerBody.id,
      ),
    ).toBe(false);

    const platformWhatsApp = await request(app.getHttpServer())
      .get('/api/v1/whatsapp-assistant/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (platformWhatsApp.body as WhatsAppConfigResponseBody[]).some(
        (item) => item.id === whatsAppBody.id,
      ),
    ).toBe(false);

    const platformVoice = await request(app.getHttpServer())
      .get('/api/v1/voice-receptionist/configs')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (platformVoice.body as VoiceConfigResponseBody[]).some(
        (item) => item.id === voiceBody.id,
      ),
    ).toBe(false);

    const platformKnowledge = await request(app.getHttpServer())
      .get('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (
        platformKnowledge.body as { data: KnowledgeSourceResponseBody[] }
      ).data.some((item) => item.id === knowledgeBody.id),
    ).toBe(false);

    const tenantProviders = await request(app.getHttpServer())
      .get('/api/v1/ai/providers')
      .query({ organizationId: tenantBody.id })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (tenantProviders.body as AIProviderResponseBody[]).some(
        (item) => item.id === providerBody.id,
      ),
    ).toBe(true);

    const tenantWhatsApp = await request(app.getHttpServer())
      .get('/api/v1/whatsapp-assistant/configs')
      .query({ organizationId: tenantBody.id })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (tenantWhatsApp.body as WhatsAppConfigResponseBody[]).some(
        (item) => item.id === whatsAppBody.id,
      ),
    ).toBe(true);

    const tenantVoice = await request(app.getHttpServer())
      .get('/api/v1/voice-receptionist/configs')
      .query({ organizationId: tenantBody.id })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (tenantVoice.body as VoiceConfigResponseBody[]).some(
        (item) => item.id === voiceBody.id,
      ),
    ).toBe(true);

    const tenantKnowledge = await request(app.getHttpServer())
      .get('/api/v1/knowledge/sources')
      .query({ organizationId: tenantBody.id })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    expect(
      (
        tenantKnowledge.body as { data: KnowledgeSourceResponseBody[] }
      ).data.some((item) => item.id === knowledgeBody.id),
    ).toBe(true);

    const tenantLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: `isolation-admin-${suffix}@agentcore.local`,
        password: 'E2E-Admin@12345',
      })
      .expect(201);
    const tenantLoginBody = tenantLogin.body as AuthResponseBody;

    await request(app.getHttpServer())
      .get('/api/v1/ai/providers')
      .query({ organizationId: 'org_demo' })
      .set('Authorization', `Bearer ${tenantLoginBody.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/whatsapp-assistant/configs')
      .query({ organizationId: 'org_demo' })
      .set('Authorization', `Bearer ${tenantLoginBody.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/voice-receptionist/configs')
      .query({ organizationId: 'org_demo' })
      .set('Authorization', `Bearer ${tenantLoginBody.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/knowledge/sources')
      .query({ organizationId: 'org_demo' })
      .set('Authorization', `Bearer ${tenantLoginBody.accessToken}`)
      .expect(403);
  });

  it('/knowledge/sources manages knowledge base sources and documents', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const rawText = `E2E business hours ${suffix}: 9am to 6pm.`;

    const created = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `E2E Knowledge ${suffix}`,
        rawText,
        metadata: { locale: 'en' },
      })
      .expect(201);

    const createdBody = created.body as KnowledgeSourceResponseBody;

    expect(createdBody.organizationId).toBe('org_demo');
    expect(createdBody.type).toBe('text');
    expect(['pending', 'ready']).toContain(createdBody.status);
    expect(createdBody.rawText).toBe(rawText);
    expect(createdBody.metadata).toMatchObject({ locale: 'en' });

    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/sources/${createdBody.id}/ingest`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(201)
      .expect((response) => {
        const body = response.body as KnowledgeSourceResponseBody;

        expect(body.status).toBe('ready');
      });

    await request(app.getHttpServer())
      .get('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as { data: KnowledgeSourceResponseBody[] };
        expect(body.data.some((source) => source.id === createdBody.id)).toBe(
          true,
        );
      });

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/sources/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as KnowledgeSourceResponseBody;

        expect(body.name).toBe(`E2E Knowledge ${suffix}`);
        expect(body.status).toBe('ready');
      });

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/documents?sourceId=${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as KnowledgeDocumentResponseBody[];

        expect(body).toHaveLength(1);
        expect(body[0].sourceId).toBe(createdBody.id);
        expect(body[0].contentText).toBe(rawText);
      });

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/chunks?sourceId=${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as KnowledgeChunkResponseBody[];

        expect(body.length).toBeGreaterThanOrEqual(1);
        expect(body[0].sourceId).toBe(createdBody.id);
        expect(body[0].content).toContain(`E2E business hours ${suffix}`);
        expect(body[0].chunkIndex).toBe(0);
      });

    const filteredChunksResponse = await request(app.getHttpServer())
      .get(`/api/v1/knowledge/chunks?sourceId=${createdBody.id}&q=business`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`);

    expect({
      status: filteredChunksResponse.status,
      body: filteredChunksResponse.body as unknown,
    }).toEqual({
      status: 200,
      body: expect.any(Array) as unknown,
    });
    expect(
      (filteredChunksResponse.body as KnowledgeChunkResponseBody[]).length,
    ).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .post('/api/v1/knowledge/search')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        query: 'When is the business open?',
        sourceId: createdBody.id,
        limit: 3,
      })
      .expect(201)
      .expect((response) => {
        const body = response.body as KnowledgeSearchResponseBody[];

        expect(body.length).toBeGreaterThanOrEqual(1);
        expect(body[0].sourceId).toBe(createdBody.id);
        expect(body[0].content).toContain(`E2E business hours ${suffix}`);
        expect(body[0].score).toEqual(expect.any(Number));
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/knowledge/sources/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        status: 'processing',
        metadata: { locale: 'en', refresh: true },
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as KnowledgeSourceResponseBody;

        expect(body.status).toBe('processing');
        expect(body.metadata).toMatchObject({ refresh: true });
      });

    await request(app.getHttpServer())
      .delete(`/api/v1/knowledge/sources/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect({ deleted: true });

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/sources/${createdBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(404);
  });

  it('/knowledge/sources/upload requires a file', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .post('/api/v1/knowledge/sources/upload')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .field('name', 'Missing File Upload')
      .expect(400);
  });

  it('/customer-chat answers with RAG citations and supports handoff', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const rawText = `E2E chat support ${suffix}: support is available Monday through Friday from 10am to 5pm.`;

    const agent = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'E2E Chat Agent',
        email: `chat-agent-${suffix}@agentcore.local`,
        password: 'StrongPassword@123',
        orgId: 'org_demo',
        roles: ['agent'],
      })
      .expect(201);
    const agentBody = agent.body as UserResponseBody;

    const basicUserEmail = `chat-user-${suffix}@agentcore.local`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'E2E Basic User',
        email: basicUserEmail,
        password: 'StrongPassword@123',
        orgId: 'org_demo',
        roles: ['user'],
      })
      .expect(201);
    const basicLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: basicUserEmail, password: 'StrongPassword@123' })
      .expect(201);
    await request(app.getHttpServer())
      .get('/api/v1/customer-chat/conversations')
      .set('Authorization', `Bearer ${basicLogin.body.accessToken as string}`)
      .expect(403);

    const source = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `E2E Chat Knowledge ${suffix}`,
        rawText,
      })
      .expect(201);
    const sourceBody = source.body as KnowledgeSourceResponseBody;

    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/sources/${sourceBody.id}/ingest`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(201);

    const conversation = await request(app.getHttpServer())
      .post('/api/v1/customer-chat/conversations')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        visitorId: `visitor-${suffix}`,
        visitorName: 'E2E Visitor',
        visitorEmail: `visitor-${suffix}@agentcore.local`,
      })
      .expect(201);
    const conversationBody =
      conversation.body as CustomerChatConversationResponseBody;

    expect(conversationBody.status).toBe('open');
    expect(conversationBody.messages).toHaveLength(0);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        content: 'When is support available?',
      })
      .expect(201)
      .expect((response) => {
        const body = response.body as CustomerChatSendMessageResponseBody;

        expect(body.visitorMessage.role).toBe('visitor');
        expect(body.assistantMessage?.role).toBe('assistant');
        expect(body.assistantMessage?.content).toContain(
          'requested a human agent',
        );
        expect(body.assistantMessage?.citations.length).toBeGreaterThanOrEqual(
          1,
        );
        expect(body.assistantMessage?.metadata).toMatchObject({
          usedFallback: true,
        });
        expect(body.conversation.status).toBe('waiting_for_agent');
      });

    await request(app.getHttpServer())
      .get(`/api/v1/customer-chat/conversations/${conversationBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.messages).toHaveLength(2);
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/handoff`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.status).toBe('waiting_for_agent');
      });

    let assignedVersion = 0;
    await request(app.getHttpServer())
      .patch(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/assignment`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ assignedAgentId: agentBody.id })
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.assignedAgentId).toBe(agentBody.id);
        expect(body.version).toBeGreaterThan(conversationBody.version);
        assignedVersion = body.version;
      });

    await request(app.getHttpServer())
      .get('/api/v1/customer-chat/conversations')
      .query({
        status: 'waiting_for_agent',
        assignedAgentId: agentBody.id,
        search: `visitor-${suffix}`,
      })
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationListResponseBody;

        expect(body.total).toBeGreaterThanOrEqual(1);
        expect(body.data.some((item) => item.id === conversationBody.id)).toBe(
          true,
        );
      });

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/agent-messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ content: 'x'.repeat(2001) })
      .expect(400);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/agent-messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ content: 'A human agent is now helping you.' })
      .expect(201)
      .expect((response) => {
        const body = response.body as CustomerChatAgentMessageResponseBody;

        expect(body.agentMessage.role).toBe('agent');
        expect(body.agentMessage.content).toContain('human agent');
        expect(body.conversation.assignedAgentId).toBe(agentBody.id);
        expect(
          body.conversation.messages.some(
            (message) => message.role === 'agent',
          ),
        ).toBe(true);
      });

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/messages`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ content: 'Does the bot still answer after assignment?' })
      .expect(201)
      .expect((response) => {
        const body = response.body as CustomerChatSendMessageResponseBody;
        expect(body.visitorMessage.role).toBe('visitor');
        expect(body.assistantMessage).toBeNull();
      });

    await request(app.getHttpServer())
      .get(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/messages?page=1&limit=2`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data).toHaveLength(2);
        expect(response.body.total).toBeGreaterThanOrEqual(4);
        expect(response.body.limit).toBe(2);
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/status`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'closed', expectedVersion: assignedVersion })
      .expect(409);

    const latestConversation = await request(app.getHttpServer())
      .get(`/api/v1/customer-chat/conversations/${conversationBody.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    const latestConversationBody =
      latestConversation.body as CustomerChatConversationResponseBody;

    await request(app.getHttpServer())
      .patch(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/status`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        status: 'closed',
        expectedVersion: latestConversationBody.version,
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.status).toBe('closed');
        expect(body.version).toBe(latestConversationBody.version + 1);
      });
  });

  it('/customer-chat/widget supports public visitor conversations', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const allowedOrigin = `https://widget-${suffix}.example.com`;
    const rawText = `E2E widget support ${suffix}: widget visitors can get help from 8am to 4pm.`;

    const source = await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `E2E Widget Knowledge ${suffix}`,
        rawText,
      })
      .expect(201);
    const sourceBody = source.body as KnowledgeSourceResponseBody;

    await request(app.getHttpServer())
      .post(`/api/v1/knowledge/sources/${sourceBody.id}/ingest`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(201);

    const config = await request(app.getHttpServer())
      .patch('/api/v1/customer-chat/widget-config')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        enabled: true,
        greetingText: `Hello widget ${suffix}`,
        allowedDomains: [allowedOrigin],
        settings: { primaryColor: '#111827' },
      })
      .expect(200);
    const configBody = config.body as CustomerChatWidgetConfigResponseBody;

    expect(configBody.widgetKey).toEqual(expect.any(String));
    expect(configBody.allowedDomains).toContain(allowedOrigin);

    await request(app.getHttpServer())
      .get(`/api/v1/customer-chat/widget/${configBody.widgetKey}/config`)
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatWidgetConfigResponseBody;

        expect(body.greetingText).toBe(`Hello widget ${suffix}`);
        expect(body.allowedDomains).toBeUndefined();
      });

    await request(app.getHttpServer())
      .get(`/api/v1/customer-chat/widget/${configBody.widgetKey}/config`)
      .set('Origin', 'https://blocked.example.com')
      .expect(403);

    const created = await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/widget/${configBody.widgetKey}/conversations`,
      )
      .set('Origin', allowedOrigin)
      .send({
        visitorId: `public-${suffix}`,
        visitorName: 'Public Visitor',
      })
      .expect(201);
    const createdBody =
      created.body as PublicCustomerChatConversationCreatedBody;

    expect(createdBody.visitorToken).toEqual(expect.any(String));
    expect(createdBody.conversation.messages).toHaveLength(0);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}/messages`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .set('Origin', 'https://blocked.example.com')
      .send({ content: 'This origin must not be accepted.' })
      .expect(403);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}/messages`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .set('Origin', allowedOrigin)
      .send({ content: 'When can widget visitors get help?' })
      .expect(201)
      .expect((response) => {
        const body = response.body as CustomerChatSendMessageResponseBody;

        expect(body.assistantMessage?.content).toContain(
          'requested a human agent',
        );
        expect(body.assistantMessage?.citations.length).toBeGreaterThanOrEqual(
          1,
        );
        expect(body.assistantMessage?.metadata).toEqual({});
        expect(body.assistantMessage?.citations[0]?.content).toBeUndefined();
        expect(body.conversation.organizationId).toBeUndefined();
        expect(body.conversation.visitorEmail).toBeUndefined();
      });

    await request(app.getHttpServer())
      .patch(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}/handoff`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect((response) => {
        expect(response.body.status).toBe('waiting_for_agent');
      });

    await request(app.getHttpServer())
      .get(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .set('Origin', allowedOrigin)
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.messages).toHaveLength(2);
      });

    await request(app.getHttpServer())
      .get(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}`,
      )
      .set('x-visitor-token', 'wrong-token')
      .set('Origin', allowedOrigin)
      .expect(401);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}/messages`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .set('Origin', allowedOrigin)
      .send({ content: 'x'.repeat(2001) })
      .expect(400);
  });

  it('/customer-chat/widgets supports multiple folder-scoped widgets', async () => {
    const loginBody = await loginAsAdmin();
    const suffix = Date.now();
    const allowedOrigin = `https://multi-widget-${suffix}.example.com`;

    const createFolder = async (name: string) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/knowledge/taxonomy/folders')
        .set('Authorization', `Bearer ${loginBody.accessToken}`)
        .send({ name })
        .expect(201);
      return (response.body as { id: string }).id;
    };
    const alphaFolderId = await createFolder(`Widget Alpha ${suffix}`);
    const betaFolderId = await createFolder(`Widget Beta ${suffix}`);

    await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `Alpha scope ${suffix}`,
        folderId: alphaFolderId,
        sensitivityLevel: 0,
        rawText: `Alpha scope ${suffix}: the public support code is ORBIT-ALPHA.`,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/knowledge/sources')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        type: 'text',
        name: `Beta scope ${suffix}`,
        folderId: betaFolderId,
        sensitivityLevel: 0,
        rawText: `Beta scope ${suffix}: the public support code is ORBIT-BETA.`,
      })
      .expect(201);

    const createWidget = async (name: string, folderId: string) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/customer-chat/widget-configs')
        .set('Authorization', `Bearer ${loginBody.accessToken}`)
        .send({
          name,
          enabled: true,
          knowledgeScope: 'folders',
          folderIds: [folderId],
          allowedDomains: [allowedOrigin],
        })
        .expect(201);
      return response.body as CustomerChatWidgetConfigResponseBody;
    };
    const alphaWidget = await createWidget(
      `Alpha Widget ${suffix}`,
      alphaFolderId,
    );
    const betaWidget = await createWidget(
      `Beta Widget ${suffix}`,
      betaFolderId,
    );
    expect(alphaWidget.id).toBeDefined();
    expect(betaWidget.id).toBeDefined();

    const askWidget = async (widgetKey: string) => {
      const created = await request(app.getHttpServer())
        .post(`/api/v1/customer-chat/widget/${widgetKey}/conversations`)
        .set('Origin', allowedOrigin)
        .send({ visitorId: `scope-test-${suffix}` })
        .expect(201);
      const body = created.body as PublicCustomerChatConversationCreatedBody;
      const sent = await request(app.getHttpServer())
        .post(
          `/api/v1/customer-chat/widget/conversations/${body.conversation.id}/messages`,
        )
        .set('x-visitor-token', body.visitorToken)
        .set('Origin', allowedOrigin)
        .send({ content: 'What is the public support code?' })
        .expect(201);
      const internal = await request(app.getHttpServer())
        .get(`/api/v1/customer-chat/conversations/${body.conversation.id}`)
        .set('Authorization', `Bearer ${loginBody.accessToken}`)
        .expect(200);
      return (
        internal.body as CustomerChatConversationResponseBody
      ).messages.find((message) => message.role === 'assistant')!;
    };

    const alphaAnswer = await askWidget(alphaWidget.widgetKey);
    const betaAnswer = await askWidget(betaWidget.widgetKey);
    expect(
      alphaAnswer.citations.map((citation) => citation.content).join(' '),
    ).toContain('ORBIT-ALPHA');
    expect(
      alphaAnswer.citations.map((citation) => citation.content).join(' '),
    ).not.toContain('ORBIT-BETA');
    expect(
      betaAnswer.citations.map((citation) => citation.content).join(' '),
    ).toContain('ORBIT-BETA');
    expect(
      betaAnswer.citations.map((citation) => citation.content).join(' '),
    ).not.toContain('ORBIT-ALPHA');

    const widgets = await request(app.getHttpServer())
      .get('/api/v1/customer-chat/widget-configs?page=1&limit=10')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200);
    const widgetList = widgets.body as CustomerChatWidgetConfigListResponseBody;
    expect(widgetList.page).toBe(1);
    expect(widgetList.limit).toBe(10);
    expect(widgetList.total).toBeGreaterThanOrEqual(2);
    expect(
      widgetList.data.some(
        (widget) => widget.widgetKey === alphaWidget.widgetKey,
      ),
    ).toBe(true);
    expect(
      widgetList.data.some(
        (widget) => widget.widgetKey === betaWidget.widgetKey,
      ),
    ).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/v1/customer-chat/widget-configs/${betaWidget.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect({ deleted: true });

    await request(app.getHttpServer())
      .get(`/api/v1/customer-chat/widget-configs/${betaWidget.id}`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(404);
  });

  afterAll(async () => {
    await app.close();
  });
});
