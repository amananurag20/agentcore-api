import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LeadCaptureFieldMapping, LeadCaptureFieldType } from '@prisma/client';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { LeadsService } from './leads.service';

describe('LeadsService', () => {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $transaction: jest.fn(),
    lead: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new LeadsService(audit as never, prisma as never);

  const fields = [
    {
      key: 'name',
      label: 'Name',
      type: LeadCaptureFieldType.text,
      mapping: LeadCaptureFieldMapping.name,
      required: true,
      enabled: true,
      options: [],
    },
    {
      key: 'email',
      label: 'Work email',
      type: LeadCaptureFieldType.email,
      mapping: LeadCaptureFieldMapping.email,
      required: false,
      enabled: true,
      options: [],
    },
    {
      key: 'company_size',
      label: 'Company size',
      type: LeadCaptureFieldType.radio,
      mapping: LeadCaptureFieldMapping.custom,
      required: false,
      enabled: true,
      options: ['1-10', '11-50'],
    },
  ];

  it('validates required fields before a public conversation is created', () => {
    expect(() =>
      service.prepareCapture(fields, { email: 'person@example.com' }, {}),
    ).toThrow(new BadRequestException('Name is required'));
  });

  it('normalizes canonical contact fields and preserves custom answers', () => {
    expect(
      service.prepareCapture(
        fields,
        {
          name: '  Ada Lovelace  ',
          email: ' ADA@Example.com ',
          company_size: '11-50',
        },
        {},
      ),
    ).toEqual({
      name: 'Ada Lovelace',
      email: 'ADA@Example.com',
      normalizedEmail: 'ada@example.com',
      fieldValues: {
        name: 'Ada Lovelace',
        email: 'ADA@Example.com',
        company_size: '11-50',
      },
    });
  });

  it('rejects values outside a configured radio or select option list', () => {
    expect(() =>
      service.prepareCapture(
        fields,
        { name: 'Ada', company_size: '1000+' },
        {},
      ),
    ).toThrow(new BadRequestException('Company size has an invalid option'));
  });

  it('does not create an empty lead when every configured field is optional', () => {
    expect(
      service.prepareCapture(
        fields.map((field) => ({ ...field, required: false })),
        {},
        {},
      ),
    ).toBeNull();
  });

  it('updates an existing tenant lead matched by normalized email', async () => {
    const transaction = {
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-a',
          name: 'Old name',
          email: 'ada@example.com',
          normalizedEmail: 'ada@example.com',
          phone: null,
          normalizedPhone: null,
          fieldValues: { source: 'pricing' },
          metadata: { campaign: 'spring' },
        }),
        update: jest.fn().mockResolvedValue({ id: 'lead-a' }),
        create: jest.fn(),
      },
    };

    await service.captureLead(
      transaction as never,
      {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        normalizedEmail: 'ada@example.com',
        fieldValues: { company_size: '11-50' },
      },
      {
        organizationId: 'org-a',
        widgetConfigId: 'widget-a',
        metadata: { page: '/contact' },
      },
    );

    expect(transaction.lead.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        OR: [{ normalizedEmail: 'ada@example.com' }],
      },
    });
    expect(transaction.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-a' },
        data: expect.objectContaining({
          name: 'Ada Lovelace',
          fieldValues: { source: 'pricing', company_size: '11-50' },
          metadata: { campaign: 'spring', page: '/contact' },
        }) as object,
      }),
    );
    expect(transaction.lead.create).not.toHaveBeenCalled();
  });

  it('prevents organization users from listing another tenant leads', async () => {
    const user = {
      id: 'user-a',
      orgId: 'org-a',
      roles: ['org_admin'],
    } as AuthenticatedUser;

    await expect(
      service.list(user, { organizationId: 'org-b', page: 1, limit: 25 }),
    ).rejects.toThrow(
      new ForbiddenException('Cannot access another organization'),
    );
  });
});
