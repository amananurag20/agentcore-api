import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LeadCaptureFieldMapping,
  LeadCaptureFieldType,
  Prisma,
} from '@prisma/client';
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
      const missing = value === undefined || value === '' || value === false;
      if (field.required && missing) {
        throw new BadRequestException(`${field.label} is required`);
      }
      if (value === undefined || value === '') continue;

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
  ) {
    const identityFilters: Prisma.LeadWhereInput[] = [];
    if (input.normalizedEmail) {
      identityFilters.push({ normalizedEmail: input.normalizedEmail });
    }
    if (input.normalizedPhone) {
      identityFilters.push({ normalizedPhone: input.normalizedPhone });
    }

    const existing = identityFilters.length
      ? await transaction.lead.findFirst({
          where: {
            organizationId: context.organizationId,
            OR: identityFilters,
          },
        })
      : null;
    const now = new Date();
    const data = {
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

    if (existing) {
      return transaction.lead.update({
        where: { id: existing.id },
        data: {
          ...data,
          name: input.name ?? existing.name,
          email: input.email ?? existing.email,
          normalizedEmail: input.normalizedEmail ?? existing.normalizedEmail,
          phone: input.phone ?? existing.phone,
          normalizedPhone: input.normalizedPhone ?? existing.normalizedPhone,
          fieldValues: {
            ...this.toRecord(existing.fieldValues),
            ...input.fieldValues,
          } as Prisma.InputJsonObject,
          metadata: {
            ...this.toRecord(existing.metadata),
            ...(context.metadata ?? {}),
          } as Prisma.InputJsonObject,
        },
      });
    }

    return transaction.lead.create({
      data: {
        organizationId: context.organizationId,
        ...data,
      },
    });
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
    const email = input.email?.trim();
    const phone = input.phone?.trim();
    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        status: input.status,
        name: input.name?.trim(),
        email,
        normalizedEmail: email?.toLowerCase(),
        phone,
        normalizedPhone: phone ? this.normalizePhone(phone) : undefined,
        notes: input.notes?.trim(),
        tags: input.tags
          ? [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))]
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
    const normalized = value.replace(/[^0-9+]/g, '');
    return normalized.startsWith('+')
      ? `+${normalized.slice(1).replace(/\+/g, '')}`
      : normalized.replace(/\+/g, '');
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
