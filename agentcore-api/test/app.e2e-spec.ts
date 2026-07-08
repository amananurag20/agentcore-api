import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
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
    content: string;
  }>;
}

interface CustomerChatSendMessageResponseBody {
  conversation: CustomerChatConversationResponseBody;
  visitorMessage: CustomerChatMessageResponseBody;
  assistantMessage: CustomerChatMessageResponseBody;
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
  organizationId?: string;
  widgetKey: string;
  enabled: boolean;
  greetingText: string;
  allowedDomains?: string[];
  settings: Record<string, unknown>;
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

    app = moduleFixture.createNestApplication();
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
        roles: ['super_admin', 'org_admin'],
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
        expect(body.slug).toBe('demo-organization');
        expect(body.status).toBe('active');
      });
  });

  it('/organizations/me (PATCH) updates the current organization', async () => {
    const loginBody = await loginAsAdmin();

    return request(app.getHttpServer())
      .patch('/api/v1/organizations/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({
        name: 'Demo Organization',
        plan: 'free',
        deploymentMode: 'saas',
      })
      .expect(200)
      .expect((response) => {
        const body = response.body as OrganizationResponseBody;

        expect(body.id).toBe('org_demo');
        expect(body.name).toBe('Demo Organization');
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
      })
      .expect(201);

    const createdBody = created.body as OrganizationResponseBody;

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
    const date = '2031-01-06';
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

    await request(app.getHttpServer())
      .post('/api/v1/appointment-booking/public/bookings')
      .send({
        organizationId: 'org_demo',
        serviceId: serviceBody.id,
        staffId: staffBody.id,
        customerName: 'Public Appointment Customer',
        customerEmail: `public-appointment-${suffix}@agentcore.local`,
        startAt: `${date}T10:00:00.000Z`,
      })
      .expect(201)
      .expect((response) => {
        const body = response.body as AppointmentBookingResponseBody;

        expect(body.status).toBe('confirmed');
        expect(body.organizationId).toBe('org_demo');
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
        const body = response.body as KnowledgeSourceResponseBody[];
        expect(body.some((source) => source.id === createdBody.id)).toBe(true);
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

    await request(app.getHttpServer())
      .get(`/api/v1/knowledge/chunks?sourceId=${createdBody.id}&q=business`)
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as KnowledgeChunkResponseBody[];

        expect(body.length).toBeGreaterThanOrEqual(1);
      });

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
        expect(body.assistantMessage.role).toBe('assistant');
        expect(body.assistantMessage.content).toContain(
          'support is available Monday through Friday',
        );
        expect(body.assistantMessage.citations.length).toBeGreaterThanOrEqual(
          1,
        );
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
      .patch(
        `/api/v1/customer-chat/conversations/${conversationBody.id}/status`,
      )
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .send({ status: 'closed' })
      .expect(200)
      .expect((response) => {
        const body = response.body as CustomerChatConversationResponseBody;

        expect(body.status).toBe('closed');
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
      .send({ content: 'When can widget visitors get help?' })
      .expect(201)
      .expect((response) => {
        const body = response.body as CustomerChatSendMessageResponseBody;

        expect(body.assistantMessage.content).toContain(
          'widget visitors can get help',
        );
        expect(body.assistantMessage.citations.length).toBeGreaterThanOrEqual(
          1,
        );
      });

    await request(app.getHttpServer())
      .get(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
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
      .expect(401);

    await request(app.getHttpServer())
      .post(
        `/api/v1/customer-chat/widget/conversations/${createdBody.conversation.id}/messages`,
      )
      .set('x-visitor-token', createdBody.visitorToken)
      .send({ content: 'x'.repeat(2001) })
      .expect(400);
  });

  afterAll(async () => {
    await app.close();
  });
});
