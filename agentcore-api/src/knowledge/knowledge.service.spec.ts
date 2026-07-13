import { NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { KnowledgeService } from './knowledge.service';

const actor = {
  sub: 'user-a',
  email: 'admin@a.test',
  orgId: 'org-a',
  roles: ['org_admin'],
  clearanceLevel: 2,
  productAccess: [],
  customRoleIds: [],
} as unknown as AuthenticatedUser;

function createService(source: Record<string, unknown> | null = null) {
  let capturedQuery = '';
  let capturedValues = '';
  const rawQuery = (
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    capturedQuery = query.join(' ');
    capturedValues = JSON.stringify(values);
    return Promise.resolve([]);
  };
  const prisma = {
    knowledgeSource: {
      findUnique: jest.fn().mockResolvedValue(source),
    },
    $queryRaw: rawQuery,
  };
  const embeddings = {
    embedText: jest.fn().mockResolvedValue({
      vector: [0, 1],
      model: 'test',
      provider: 'local',
    }),
  };
  const policy = {
    getEffectiveClearance: jest.fn().mockReturnValue(2),
  };
  const service = new KnowledgeService(
    {} as never,
    embeddings as never,
    {} as never,
    {} as never,
    policy as never,
    prisma as never,
    {} as never,
    {} as never,
  );
  return {
    service,
    getCapturedQuery: () => capturedQuery,
    getCapturedValues: () => capturedValues,
  };
}

describe('KnowledgeService tenant and retrieval boundaries', () => {
  it('does not reveal a source belonging to another organization', async () => {
    const { service } = createService({
      id: 'source-b',
      organizationId: 'org-b',
      productVisibility: ['customer_chat'],
      sensitivityLevel: 0,
      isQuarantined: false,
    });

    await expect(
      service.getSourceById(actor, 'source-b'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('binds semantic retrieval to organization, clearance, and quarantine', async () => {
    const { service, getCapturedQuery, getCapturedValues } = createService();
    await service.search(actor, {
      query: 'refund policy',
      productKey: 'customer_chat',
      limit: 5,
    });

    const query = getCapturedQuery();
    expect(query).toContain('"organization_id"');
    expect(query).toContain('"sensitivity_level"');
    expect(query).toContain('"is_quarantined" = false');
    expect(getCapturedValues()).toContain('product_visibility');
  });
});
