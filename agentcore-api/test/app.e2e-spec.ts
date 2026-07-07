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
        expect(response.body).toMatchObject({
          status: 'ok',
          database: 'ok',
        });
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
  });

  afterAll(async () => {
    await app.close();
  });
});
