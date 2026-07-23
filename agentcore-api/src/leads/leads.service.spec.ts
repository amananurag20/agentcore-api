import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  LeadCaptureFieldMapping,
  LeadCaptureFieldType,
  LeadPriority,
} from '@prisma/client';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { LeadStatusDto } from './dto/list-leads.dto';
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  it('treats optional false and zero values as an empty capture', () => {
    expect(
      service.prepareCapture(
        [
          {
            key: 'consent',
            label: 'Consent',
            type: LeadCaptureFieldType.checkbox,
            mapping: LeadCaptureFieldMapping.custom,
            required: false,
            enabled: true,
            options: [],
          },
          {
            key: 'employees',
            label: 'Employees',
            type: LeadCaptureFieldType.number,
            mapping: LeadCaptureFieldMapping.custom,
            required: false,
            enabled: true,
            options: [],
          },
        ],
        { consent: false, employees: 0 },
        {},
      ),
    ).toBeNull();
  });

  it('normalizes valid international phones to E.164', () => {
    expect(
      service.prepareCapture(
        [
          {
            key: 'phone',
            label: 'Phone',
            type: LeadCaptureFieldType.phone,
            mapping: LeadCaptureFieldMapping.phone,
            required: true,
            enabled: true,
            options: [],
          },
        ],
        { phone: '+1 (650) 253-0000' },
        {},
      ),
    ).toEqual({
      phone: '+1 (650) 253-0000',
      normalizedPhone: '+16502530000',
      fieldValues: { phone: '+1 (650) 253-0000' },
    });
  });

  it('captures contact details shared naturally during a conversation', () => {
    expect(
      service.prepareConversationalCapture(
        'Please email me at Ada@example.com or call +91 98765 43210.',
      ),
    ).toEqual({
      email: 'Ada@example.com',
      normalizedEmail: 'ada@example.com',
      phone: '+91 98765 43210',
      normalizedPhone: '+919876543210',
      fieldValues: {},
    });
  });

  it('scores profile, attribution and intent with explainable reasons', () => {
    const initial = service.calculateScore({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+919876543210',
      fieldValues: { company_size: '51-200' },
      metadata: {
        pageUrl: 'https://example.com/pricing',
        utmCampaign: 'summer',
      },
      qualification: {
        signals: ['demo_interest', 'urgent_timeline'],
      },
    });

    expect(initial.score).toBe(83);
    expect(initial.priority).toBe(LeadPriority.hot);
    expect(initial.qualification).toEqual(
      expect.objectContaining({
        signals: ['demo_interest', 'urgent_timeline'],
        scoreVersion: 'hybrid_v2',
      }),
    );
  });

  it('keeps a manual score override while retaining the automatic score', () => {
    const scored = service.calculateScore({
      email: 'ada@example.com',
      scoreOverride: 92,
    });

    expect(scored.automaticScore).toBe(15);
    expect(scored.score).toBe(92);
    expect(scored.priority).toBe(LeadPriority.hot);
  });

  it('applies a relative manual adjustment without locking automatic scoring', () => {
    const scored = service.calculateScore({
      email: 'ada@example.com',
      qualification: { manualScoreAdjustment: 10 },
    });

    expect(scored.automaticScore).toBe(15);
    expect(scored.score).toBe(25);
    expect(scored.qualification).toEqual(
      expect.objectContaining({ manualScoreAdjustment: 10 }),
    );
  });

  it('decays old intent evidence using the configured half-life', () => {
    const policy = service.readScoringPolicy({
      leadScoring: { signalDecayDays: 30 },
    });
    const scored = service.calculateScore({
      qualification: {
        signals: ['demo_interest'],
        signalEvidence: [
          {
            signal: 'demo_interest',
            source: 'rules',
            confidence: 1,
            firstSeenAt: '2026-05-24T00:00:00.000Z',
            lastSeenAt: '2026-05-24T00:00:00.000Z',
          },
        ],
      },
      policy,
      evaluatedAt: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(scored.automaticScore).toBe(5);
  });

  it('uses per-widget priority thresholds', () => {
    const policy = service.readScoringPolicy({
      leadScoring: {
        thresholds: { medium: 10, high: 20, hot: 30 },
      },
    });
    const scored = service.calculateScore({
      email: 'ada@example.com',
      policy,
    });

    expect(scored.priority).toBe(LeadPriority.medium);
  });

  it('raises a lead score when high-intent conversation signals appear', async () => {
    const transaction = {
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-a',
          organizationId: 'org-a',
          status: 'new',
          name: null,
          email: 'ada@example.com',
          phone: null,
          fieldValues: {},
          metadata: {},
          qualification: {},
          scoreOverride: null,
        }),
        update: jest.fn().mockResolvedValue({ id: 'lead-a' }),
      },
    };

    await service.recordConversationActivity(transaction as never, {
      leadId: 'lead-a',
      organizationId: 'org-a',
      content:
        'I need pricing and want to book a demo tomorrow. Budget is ₹100000.',
      activityAt: new Date('2026-07-23T10:00:00Z'),
    });

    expect(transaction.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-a' },
        data: expect.objectContaining({
          score: 87,
          priority: LeadPriority.hot,
          qualification: expect.objectContaining({
            signals: expect.arrayContaining([
              'pricing_interest',
              'demo_interest',
              'booking_intent',
              'urgent_timeline',
              'budget_shared',
            ]),
          }),
        }) as object,
      }),
    );
  });

  it('updates an existing tenant lead matched by normalized email', async () => {
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      customerChatConversation: { updateMany: jest.fn() },
      lead: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'lead-a',
            name: 'Old name',
            email: 'ada@example.com',
            normalizedEmail: 'ada@example.com',
            phone: null,
            normalizedPhone: null,
            fieldValues: { source: 'pricing' },
            metadata: { campaign: 'spring' },
            tags: [],
            notes: null,
            visitorId: null,
            createdAt: new Date('2026-01-01'),
          })
          .mockResolvedValueOnce(null),
        update: jest.fn().mockResolvedValue({ id: 'lead-a' }),
        create: jest.fn(),
        deleteMany: jest.fn(),
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

    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.lead.findUnique).toHaveBeenCalledTimes(1);
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

  it('deterministically merges separate email and phone matches', async () => {
    const emailLead = {
      id: 'lead-email',
      name: 'Ada',
      email: 'ada@example.com',
      normalizedEmail: 'ada@example.com',
      phone: null,
      normalizedPhone: null,
      visitorId: null,
      fieldValues: { campaign: 'email' },
      metadata: {},
      tags: ['email'],
      notes: null,
      createdAt: new Date('2026-01-01'),
    };
    const phoneLead = {
      ...emailLead,
      id: 'lead-phone',
      email: null,
      normalizedEmail: null,
      phone: '+1 650 253 0000',
      normalizedPhone: '+16502530000',
      fieldValues: { campaign: 'phone' },
      tags: ['phone'],
      createdAt: new Date('2026-02-01'),
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      customerChatConversation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appointmentBooking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      lead: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(emailLead)
          .mockResolvedValueOnce(phoneLead),
        update: jest.fn().mockResolvedValue({ id: 'lead-email' }),
        create: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await service.captureLead(
      transaction as never,
      {
        email: 'ada@example.com',
        normalizedEmail: 'ada@example.com',
        phone: '+1 650 253 0000',
        normalizedPhone: '+16502530000',
        fieldValues: {},
      },
      { organizationId: 'org-a', widgetConfigId: 'widget-a' },
    );

    expect(
      transaction.customerChatConversation.updateMany,
    ).toHaveBeenCalledWith({
      where: { leadId: { in: ['lead-phone'] } },
      data: { leadId: 'lead-email' },
    });
    expect(transaction.appointmentBooking.updateMany).toHaveBeenCalledWith({
      where: { leadId: { in: ['lead-phone'] } },
      data: { leadId: 'lead-email' },
    });
    expect(transaction.lead.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['lead-phone'] } },
    });
    expect(result).toEqual({
      lead: { id: 'lead-email' },
      action: 'merged',
      mergedLeadIds: ['lead-phone'],
    });
  });

  it('prevents organization users from listing another tenant leads', async () => {
    const user = {
      sub: 'user-a',
      email: 'agent@example.com',
      orgId: 'org-a',
      roles: ['org_admin'],
    } as AuthenticatedUser;

    await expect(
      service.list(user, { organizationId: 'org-b', page: 1, limit: 25 }),
    ).rejects.toThrow(
      new ForbiddenException('Cannot access another organization'),
    );
  });

  it('returns a conflict instead of a database error for admin identity collisions', async () => {
    prisma.lead.findUnique.mockResolvedValueOnce({
      id: 'lead-a',
      organizationId: 'org-a',
      status: 'new',
    });
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      lead: {
        findUnique: jest.fn().mockResolvedValue({ id: 'lead-b' }),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementationOnce((callback: unknown) =>
      (callback as (value: typeof transaction) => Promise<unknown>)(
        transaction,
      ),
    );

    await expect(
      service.update(
        {
          sub: 'user-a',
          email: 'agent@example.com',
          orgId: 'org-a',
          roles: ['org_admin'],
        },
        'lead-a',
        { email: 'used@example.com' },
      ),
    ).rejects.toThrow(
      new ConflictException('Another lead already uses this email'),
    );
    expect(transaction.lead.update).not.toHaveBeenCalled();
  });

  it('rejects invalid lifecycle regressions', async () => {
    prisma.lead.findUnique.mockResolvedValueOnce({
      id: 'lead-a',
      organizationId: 'org-a',
      status: 'converted',
    });

    await expect(
      service.update(
        {
          sub: 'user-a',
          email: 'agent@example.com',
          orgId: 'org-a',
          roles: ['org_admin'],
        },
        'lead-a',
        { status: LeadStatusDto.new },
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'Lead status cannot change from converted to new',
      ),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
