import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

export interface AuditEventInput {
  actor?: AuthenticatedUser | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditEventInput) {
    try {
      await this.prisma.auditLog.create({
        data: {
          organizationId: input.organizationId ?? input.actor?.orgId,
          actorUserId: input.actor?.sub,
          actorEmail: input.actor?.email,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          metadata: this.toJsonObject(input.metadata),
        },
      });
    } catch (error) {
      this.logger.error('Failed to write audit log', error);
    }
  }

  async list(currentUser: AuthenticatedUser, input: ListAuditLogsDto) {
    const organizationId = this.isSuperAdmin(currentUser)
      ? input.organizationId
      : currentUser.orgId;
    const where: Prisma.AuditLogWhereInput = {
      ...(organizationId ? { organizationId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    };
    const page = input.page ?? 1;
    const limit = input.limit ?? 50;

    const [total, data] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: data.map((item) => ({
        ...item,
        metadata: this.toRecord(item.metadata),
      })),
      total,
      page,
      limit,
    };
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    return value;
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roles.includes('super_admin');
  }
}
