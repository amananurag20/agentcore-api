import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LeadCaptureFieldMapping,
  LeadCaptureFieldType,
  LeadStatus,
  Prisma,
} from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

type CaptureField = {
  key: string;
  label: string;
  type: LeadCaptureFieldType;
  mapping: LeadCaptureFieldMapping;
  required: boolean;
  enabled: boolean;
  options: string[];
};

export type PreparedLeadCapture = {
  name?: string;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  fieldValues: Prisma.InputJsonObject;
};

export type CapturedLeadResult = {
  lead: Prisma.LeadGetPayload<object>;
  action: 'created' | 'updated' | 'merged';
  mergedLeadIds: string[];
};

const ALLOWED_STATUS_TRANSITIONS: Record<LeadStatus, Set<LeadStatus>> = {
  new: new Set(['new', 'contacted', 'qualified', 'disqualified', 'archived']),
  contacted: new Set(['contacted', 'qualified', 'disqualified', 'archived']),
  qualified: new Set(['qualified', 'converted', 'disqualified', 'archived']),
  converted: new Set(['converted', 'archived']),
  disqualified: new Set(['disqualified', 'new', 'archived']),
  archived: new Set(['archived', 'new']),
};

@Injectable()
export class LeadsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  prepareCapture(
    fields: CaptureField[],
    submitted: Record<string, unknown> | undefined,
    legacy: { name?: string; email?: string },
  ): PreparedLeadCapture | null {
    const enabledFields = fields.filter((field) => field.enabled);
    if (!enabledFields.length) return null;

    const values = submitted ?? {};
    const allowedKeys = new Set(enabledFields.map((field) => field.key));
    const unknownKey = Object.keys(values).find((key) => !allowedKeys.has(key));
    if (unknownKey) {
      throw new BadRequestException(`Unknown lead field: ${unknownKey}`);
    }

    const normalizedValues: Record<string, string | number | boolean> = {};
    const canonical: Omit<PreparedLeadCapture, 'fieldValues'> = {};

    for (const field of enabledFields) {
      const legacyValue =
        field.mapping === 'name'
          ? legacy.name
          : field.mapping === 'email'
            ? legacy.email
            : undefined;
      const value = this.normalizeValue(
        field,
        values[field.key] ?? legacyValue,
      );
      const missing =
        value === undefined || value === '' || value === false || value === 0;
      if (field.required && missing) {
        throw new BadRequestException(`${field.label} is required`);
      }
      if (missing) continue;

      normalizedValues[field.key] = value;
      if (field.mapping === 'name' && typeof value === 'string') {
        canonical.name = value;
      } else if (field.mapping === 'email' && typeof value === 'string') {
        canonical.email = value;
        canonical.normalizedEmail = value.toLowerCase();
      } else if (field.mapping === 'phone' && typeof value === 'string') {
        canonical.phone = value;
        canonical.normalizedPhone = this.normalizePhone(value);
      }
    }

    if (!Object.keys(normalizedValues).length) return null;

    return {
      ...canonical,
      fieldValues: normalizedValues,
    };
  }

  async captureLead(
    transaction: Prisma.TransactionClient,
    input: PreparedLeadCapture,
    context: {
      organizationId: string;
      widgetConfigId: string;
      visitorId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CapturedLeadResult> {
    await this.lockIdentities(
      transaction,
      context.organizationId,
      input.normalizedEmail,
      input.normalizedPhone,
    );

    const [emailLead, phoneLead] = await Promise.all([
      input.normalizedEmail
        ? transaction.lead.findUnique({
            where: {
              organizationId_normalizedEmail: {
                organizationId: context.organizationId,
                normalizedEmail: input.normalizedEmail,
              },
            },
          })
        : null,
      input.normalizedPhone
        ? transaction.lead.findUnique({
            where: {
              organizationId_normalizedPhone: {
                organizationId: context.organizationId,
                normalizedPhone: input.normalizedPhone,
              },
            },
          })
        : null,
    ]);
    const matches = [emailLead, phoneLead]
      .filter((lead): lead is NonNullable<typeof lead> => Boolean(lead))
      .filter(
        (lead, index, leads) =>
          leads.findIndex((candidate) => candidate.id === lead.id) === index,
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      );
    const now = new Date();
    const captureData = {
      widgetConfigId: context.widgetConfigId,
      name: input.name,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      phone: input.phone,
      normalizedPhone: input.normalizedPhone,
      visitorId: context.visitorId,
      fieldValues: input.fieldValues,
      metadata: (context.metadata ?? {}) as Prisma.InputJsonObject,
      lastActivityAt: now,
    };

    if (matches.length) {
      const survivor = matches[0];
      const mergedLeadIds = matches.slice(1).map((lead) => lead.id);
      const combinedFieldValues = matches.reduce<Record<string, unknown>>(
        (values, lead) => ({
          ...values,
          ...this.toRecord(lead.fieldValues),
        }),
        {},
      );
      const combinedMetadata = matches.reduce<Record<string, unknown>>(
        (metadata, lead) => ({
          ...metadata,
          ...this.toRecord(lead.metadata),
        }),
        {},
      );
      const combinedTags = [...new Set(matches.flatMap((lead) => lead.tags))];

      if (mergedLeadIds.length) {
        await transaction.customerChatConversation.updateMany({
          where: { leadId: { in: mergedLeadIds } },
          data: { leadId: survivor.id },
        });
        await transaction.lead.deleteMany({
          where: { id: { in: mergedLeadIds } },
        });
      }

      const lead = await transaction.lead.update({
        where: { id: survivor.id },
        data: {
          ...captureData,
          name: input.name ?? matches.find((lead) => lead.name)?.name,
          email: input.email ?? matches.find((lead) => lead.email)?.email,
          normalizedEmail:
            input.normalizedEmail ??
            matches.find((lead) => lead.normalizedEmail)?.normalizedEmail,
          phone: input.phone ?? matches.find((lead) => lead.phone)?.phone,
          normalizedPhone:
            input.normalizedPhone ??
            matches.find((lead) => lead.normalizedPhone)?.normalizedPhone,
          visitorId:
            context.visitorId ??
            matches.find((lead) => lead.visitorId)?.visitorId,
          fieldValues: {
            ...combinedFieldValues,
            ...input.fieldValues,
          } as Prisma.InputJsonObject,
          metadata: {
            ...combinedMetadata,
            ...(context.metadata ?? {}),
          } as Prisma.InputJsonObject,
          tags: combinedTags,
          notes: matches.find((lead) => lead.notes)?.notes,
        },
      });
      return {
        lead,
        action: mergedLeadIds.length ? 'merged' : 'updated',
        mergedLeadIds,
      };
    }

    const lead = await transaction.lead.create({
      data: {
        organizationId: context.organizationId,
        ...captureData,
      },
    });
    return { lead, action: 'created', mergedLeadIds: [] };
  }

  async list(currentUser: AuthenticatedUser, input: ListLeadsDto) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    const page = input.page ?? 1;
    const limit = input.limit ?? 25;
    const search = input.search?.trim();
    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.widgetConfigId ? { widgetConfigId: input.widgetConfigId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        include: {
          widgetConfig: { select: { id: true, name: true } },
          _count: { select: { conversations: true } },
        },
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: data.map((lead) => this.toResponse(lead)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(currentUser: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        widgetConfig: { select: { id: true, name: true } },
        conversations: {
          select: {
            id: true,
            status: true,
            lastMessageAt: true,
            createdAt: true,
          },
          orderBy: { lastMessageAt: 'desc' },
          take: 25,
        },
        _count: { select: { conversations: true } },
      },
    });
    if (!lead || !this.canAccess(currentUser, lead.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    return this.toResponse(lead);
  }

  async update(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateLeadDto,
  ) {
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing || !this.canAccess(currentUser, existing.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    if (
      input.status &&
      !ALLOWED_STATUS_TRANSITIONS[existing.status].has(input.status)
    ) {
      throw new BadRequestException(
        `Lead status cannot change from ${existing.status} to ${input.status}`,
      );
    }
    const emailProvided = input.email !== undefined;
    const phoneProvided = input.phone !== undefined;
    const email = emailProvided ? input.email?.trim() || null : undefined;
    const phone = phoneProvided ? input.phone?.trim() || null : undefined;
    const normalizedEmail =
      email === undefined ? undefined : (email?.toLowerCase() ?? null);
    const normalizedPhone =
      phone === undefined
        ? undefined
        : phone
          ? this.normalizePhone(phone)
          : null;

    const updateLead = () =>
      this.prisma.$transaction(async (transaction) => {
        await this.lockIdentities(
          transaction,
          existing.organizationId,
          normalizedEmail ?? undefined,
          normalizedPhone ?? undefined,
        );
        const [emailConflict, phoneConflict] = await Promise.all([
          normalizedEmail
            ? transaction.lead.findUnique({
                where: {
                  organizationId_normalizedEmail: {
                    organizationId: existing.organizationId,
                    normalizedEmail,
                  },
                },
                select: { id: true },
              })
            : null,
          normalizedPhone
            ? transaction.lead.findUnique({
                where: {
                  organizationId_normalizedPhone: {
                    organizationId: existing.organizationId,
                    normalizedPhone,
                  },
                },
                select: { id: true },
              })
            : null,
        ]);
        if (emailConflict && emailConflict.id !== id) {
          throw new ConflictException('Another lead already uses this email');
        }
        if (phoneConflict && phoneConflict.id !== id) {
          throw new ConflictException('Another lead already uses this phone');
        }
        return transaction.lead.update({
          where: { id },
          data: {
            status: input.status,
            name:
              input.name === undefined ? undefined : input.name?.trim() || null,
            email,
            normalizedEmail,
            phone,
            normalizedPhone,
            notes:
              input.notes === undefined
                ? undefined
                : input.notes?.trim() || null,
            tags: input.tags
              ? [
                  ...new Set(
                    input.tags.map((tag) => tag.trim()).filter(Boolean),
                  ),
                ]
              : undefined,
            lastActivityAt: new Date(),
          },
          include: {
            widgetConfig: { select: { id: true, name: true } },
            conversations: {
              select: {
                id: true,
                status: true,
                lastMessageAt: true,
                createdAt: true,
              },
              orderBy: { lastMessageAt: 'desc' },
              take: 25,
            },
            _count: { select: { conversations: true } },
          },
        });
      });
    let lead: Awaited<ReturnType<typeof updateLead>>;
    try {
      lead = await updateLead();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another lead already uses this email or phone',
        );
      }
      throw error;
    }
    await this.auditService.record({
      actor: currentUser,
      organizationId: existing.organizationId,
      action: 'lead.updated',
      entityType: 'lead',
      entityId: id,
      metadata: { status: input.status, tags: input.tags },
    });
    return this.toResponse(lead);
  }

  private normalizeValue(field: CaptureField, raw: unknown) {
    if (raw === undefined || raw === null) return undefined;
    if (field.type === 'checkbox') {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0' || raw === '') return false;
      throw new BadRequestException(`${field.label} must be true or false`);
    }
    if (field.type === 'number') {
      const numberValue = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(numberValue)) {
        throw new BadRequestException(`${field.label} must be a number`);
      }
      return numberValue;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException(`${field.label} must be text`);
    }
    const value = raw.trim();
    const maxLength = field.type === 'textarea' ? 2000 : 320;
    if (value.length > maxLength) {
      throw new BadRequestException(
        `${field.label} must be at most ${maxLength} characters`,
      );
    }
    if (
      field.type === 'email' &&
      value &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ) {
      throw new BadRequestException(`${field.label} must be a valid email`);
    }
    if (
      field.type === 'phone' &&
      value &&
      !/^\+?[0-9 ()-]{7,40}$/.test(value)
    ) {
      throw new BadRequestException(
        `${field.label} must be a valid phone number`,
      );
    }
    if (
      (field.type === 'select' || field.type === 'radio') &&
      value &&
      !field.options.includes(value)
    ) {
      throw new BadRequestException(`${field.label} has an invalid option`);
    }
    return value;
  }

  private normalizePhone(value: string) {
    const phone = parsePhoneNumberFromString(value);
    if (!phone?.isValid()) {
      throw new BadRequestException(
        'Phone must be a valid international number including country code',
      );
    }
    return phone.number;
  }

  private async lockIdentities(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    normalizedEmail?: string,
    normalizedPhone?: string,
  ) {
    const identities = [
      normalizedEmail
        ? `lead:${organizationId}:email:${normalizedEmail}`
        : null,
      normalizedPhone
        ? `lead:${organizationId}:phone:${normalizedPhone}`
        : null,
    ]
      .filter((identity): identity is string => Boolean(identity))
      .sort();
    for (const identity of identities) {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))
      `;
    }
  }

  private resolveOrganizationId(
    user: AuthenticatedUser,
    organizationId?: string,
  ) {
    if (!organizationId) return user.orgId;
    if (!user.roles.includes('super_admin') && organizationId !== user.orgId) {
      throw new ForbiddenException('Cannot access another organization');
    }
    return organizationId;
  }

  private canAccess(user: AuthenticatedUser, organizationId: string) {
    return user.roles.includes('super_admin') || user.orgId === organizationId;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  private toResponse<
    T extends { fieldValues: Prisma.JsonValue; metadata: Prisma.JsonValue },
  >(lead: T) {
    return {
      ...lead,
      fieldValues: this.toRecord(lead.fieldValues),
      metadata: this.toRecord(lead.metadata),
    };
  }
}
