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

  jest.setTimeout(30000);

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

  afterAll(async () => {
    await app.close();
  });
});
