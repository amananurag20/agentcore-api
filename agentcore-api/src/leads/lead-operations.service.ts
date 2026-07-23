import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LeadAlertType,
  LeadConsentStatus,
  LeadPriority,
  LeadStatus,
  LeadWebhookDeliveryStatus,
  Prisma,
  ProductKey,
  UserRole,
} from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateLeadWebhookDto,
  ListLeadAlertsDto,
  ListLeadWebhookDeliveriesDto,
  UpdateLeadWebhookDto,
} from './dto/lead-operations.dto';

export type LeadOperationsPolicy = {
  autoAssign: 'none' | 'round_robin';
  firstResponseMinutes: number;
  alertPriority: 'high' | 'hot';
  retentionDays: number;
};

type LeadEventInput = {
  organizationId: string;
  leadId: string;
  eventType: string;
  actorUserId?: string;
  payload?: Record<string, unknown>;
};

const DEFAULT_POLICY: LeadOperationsPolicy = {
  autoAssign: 'none',
  firstResponseMinutes: 30,
  alertPriority: 'hot',
  retentionDays: 0,
};

@Injectable()
export class LeadOperationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadOperationsService.name);
  private timer?: NodeJS.Timeout;
  private sweepRunning = false;

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.get<number>(
      'LEAD_OPERATIONS_SWEEP_INTERVAL_MS',
      30_000,
    );
    this.timer = setInterval(() => void this.runSweep(), intervalMs);
    this.timer.unref();
    void this.runSweep();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  readPolicy(
    value: Prisma.JsonValue | Record<string, unknown> | null | undefined,
    strict = false,
  ) {
    const settings = this.toRecord(value);
    if (
      strict &&
      settings.leadOperations !== undefined &&
      (!settings.leadOperations ||
        typeof settings.leadOperations !== 'object' ||
        Array.isArray(settings.leadOperations))
    ) {
      throw new BadRequestException('leadOperations must be an object');
    }
    const configured = this.toRecord(settings.leadOperations);
    if (strict) {
      if (
        configured.autoAssign !== undefined &&
        configured.autoAssign !== 'none' &&
        configured.autoAssign !== 'round_robin'
      ) {
        throw new BadRequestException(
          'leadOperations.autoAssign must be none or round_robin',
        );
      }
      if (
        configured.alertPriority !== undefined &&
        configured.alertPriority !== 'high' &&
        configured.alertPriority !== 'hot'
      ) {
        throw new BadRequestException(
          'leadOperations.alertPriority must be high or hot',
        );
      }
      this.assertInteger(
        configured.firstResponseMinutes,
        'leadOperations.firstResponseMinutes',
        1,
        10_080,
      );
      this.assertInteger(
        configured.retentionDays,
        'leadOperations.retentionDays',
        0,
        3_650,
      );
    }
    const autoAssign =
      configured.autoAssign === 'round_robin' ? 'round_robin' : 'none';
    const alertPriority = configured.alertPriority === 'high' ? 'high' : 'hot';
    return {
      autoAssign,
      firstResponseMinutes: this.boundedInteger(
        configured.firstResponseMinutes,
        1,
        10_080,
        DEFAULT_POLICY.firstResponseMinutes,
      ),
      alertPriority,
      retentionDays: this.boundedInteger(
        configured.retentionDays,
        0,
        3_650,
        DEFAULT_POLICY.retentionDays,
      ),
    } satisfies LeadOperationsPolicy;
  }

  async prepareNewLead(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    policy: LeadOperationsPolicy,
    now: Date,
  ) {
    const ownerId =
      policy.autoAssign === 'round_robin'
        ? await this.chooseLeastLoadedOwner(transaction, organizationId)
        : null;
    return {
      ownerId,
      assignedAt: ownerId ? now : null,
      firstResponseDueAt: new Date(
        now.getTime() + policy.firstResponseMinutes * 60_000,
      ),
      retentionExpiresAt: policy.retentionDays
        ? new Date(now.getTime() + policy.retentionDays * 86_400_000)
        : null,
    };
  }

  async emit(transaction: Prisma.TransactionClient, input: LeadEventInput) {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload = {
      id: eventId,
      type: input.eventType,
      occurredAt: occurredAt.toISOString(),
      organizationId: input.organizationId,
      leadId: input.leadId,
      data: input.payload ?? {},
    };
    await transaction.leadLifecycleEvent.create({
      data: {
        id: eventId,
        organizationId: input.organizationId,
        leadId: input.leadId,
        type: input.eventType,
        actorUserId: input.actorUserId,
        metadata: (input.payload ?? {}) as Prisma.InputJsonObject,
        createdAt: occurredAt,
      },
    });
    const endpoints = await transaction.leadWebhookEndpoint.findMany({
      where: {
        organizationId: input.organizationId,
        enabled: true,
        OR: [
          { events: { isEmpty: true } },
          { events: { has: input.eventType } },
        ],
      },
      select: { id: true },
    });
    if (endpoints.length) {
      await transaction.leadWebhookDelivery.createMany({
        data: endpoints.map((endpoint) => ({
          organizationId: input.organizationId,
          endpointId: endpoint.id,
          leadId: input.leadId,
          eventId,
          eventType: input.eventType,
          payload: payload as Prisma.InputJsonObject,
        })),
        skipDuplicates: true,
      });
    }
    return eventId;
  }

  async recordPriorityTransition(
    transaction: Prisma.TransactionClient,
    input: {
      organizationId: string;
      leadId: string;
      previous: LeadPriority;
      next: LeadPriority;
      score: number;
      policy: LeadOperationsPolicy;
    },
  ) {
    if (input.previous === input.next) return;
    await this.emit(transaction, {
      organizationId: input.organizationId,
      leadId: input.leadId,
      eventType: 'lead.priority_changed',
      payload: {
        previous: input.previous,
        next: input.next,
        score: input.score,
      },
    });
    const threshold = input.policy.alertPriority === 'high' ? 2 : 3;
    const rank = { low: 0, medium: 1, high: 2, hot: 3 } as const;
    if (rank[input.next] >= threshold && rank[input.previous] < threshold) {
      await transaction.leadAlert.create({
        data: {
          organizationId: input.organizationId,
          leadId: input.leadId,
          type: LeadAlertType.hot_lead,
          message: `Lead reached ${input.next} priority with score ${input.score}`,
          metadata: { score: input.score, priority: input.next },
        },
      });
    }
  }

  async recordFirstResponse(
    transaction: Prisma.TransactionClient,
    input: {
      organizationId: string;
      leadId: string;
      actorUserId: string;
      at: Date;
    },
  ) {
    const changed = await transaction.lead.updateMany({
      where: {
        id: input.leadId,
        organizationId: input.organizationId,
        firstRespondedAt: null,
      },
      data: {
        firstRespondedAt: input.at,
        lastActivityAt: input.at,
      },
    });
    if (changed.count) {
      await transaction.lead.updateMany({
        where: {
          id: input.leadId,
          organizationId: input.organizationId,
          status: LeadStatus.new,
        },
        data: { status: LeadStatus.contacted },
      });
      await this.emit(transaction, {
        organizationId: input.organizationId,
        leadId: input.leadId,
        eventType: 'lead.first_response',
        actorUserId: input.actorUserId,
        payload: { respondedAt: input.at.toISOString() },
      });
    }
  }

  async listAssignableUsers(
    currentUser: AuthenticatedUser,
    organizationId?: string,
  ) {
    const orgId = this.resolveOrganizationId(currentUser, organizationId);
    return this.prisma.user.findMany({
      where: this.assignableUserWhere(orgId),
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async listAlerts(currentUser: AuthenticatedUser, input: ListLeadAlertsDto) {
    const organizationId = this.resolveOrganizationId(
      currentUser,
      input.organizationId,
    );
    return this.prisma.leadAlert.findMany({
      where: {
        organizationId,
        ...(input.unreadOnly ? { readAt: null } : {}),
      },
      include: {
        lead: { select: { id: true, name: true, score: true, priority: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });
  }

  async markAlertRead(currentUser: AuthenticatedUser, id: string) {
    const alert = await this.prisma.leadAlert.findUnique({ where: { id } });
    if (!alert || !this.canAccess(currentUser, alert.organizationId)) {
      throw new NotFoundException('Lead alert not found');
    }
    return this.prisma.leadAlert.update({
      where: { id },
      data: { readAt: alert.readAt ?? new Date() },
    });
  }

  async createWebhook(
    currentUser: AuthenticatedUser,
    input: CreateLeadWebhookDto,
  ) {
    this.assertWebhookManager(currentUser);
    this.assertSafeWebhookUrl(input.url);
    const endpoint = await this.prisma.leadWebhookEndpoint.create({
      data: {
        organizationId: currentUser.orgId,
        name: input.name.trim(),
        url: input.url,
        secretEncrypted: this.cryptoService.encrypt(input.secret),
        events: [...new Set(input.events)],
      },
    });
    await this.auditService.record({
      actor: currentUser,
      action: 'lead.webhook_created',
      entityType: 'lead_webhook_endpoint',
      entityId: endpoint.id,
      metadata: {
        name: endpoint.name,
        url: endpoint.url,
        events: endpoint.events,
      },
    });
    return this.toWebhookResponse(endpoint);
  }

  async listWebhooks(currentUser: AuthenticatedUser) {
    this.assertWebhookManager(currentUser);
    const endpoints = await this.prisma.leadWebhookEndpoint.findMany({
      where: { organizationId: currentUser.orgId },
      orderBy: { createdAt: 'desc' },
    });
    return endpoints.map((endpoint) => this.toWebhookResponse(endpoint));
  }

  async updateWebhook(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateLeadWebhookDto,
  ) {
    this.assertWebhookManager(currentUser);
    const existing = await this.findWebhook(currentUser, id);
    if (input.url) this.assertSafeWebhookUrl(input.url);
    const endpoint = await this.prisma.leadWebhookEndpoint.update({
      where: { id: existing.id },
      data: {
        name: input.name?.trim(),
        url: input.url,
        enabled: input.enabled,
        events: input.events ? [...new Set(input.events)] : undefined,
        secretEncrypted: input.secret
          ? this.cryptoService.encrypt(input.secret)
          : undefined,
      },
    });
    return this.toWebhookResponse(endpoint);
  }

  async deleteWebhook(currentUser: AuthenticatedUser, id: string) {
    this.assertWebhookManager(currentUser);
    const existing = await this.findWebhook(currentUser, id);
    await this.prisma.leadWebhookEndpoint.delete({
      where: { id: existing.id },
    });
    return { deleted: true };
  }

  async listDeliveries(
    currentUser: AuthenticatedUser,
    input: ListLeadWebhookDeliveriesDto,
  ) {
    this.assertWebhookManager(currentUser);
    return this.prisma.leadWebhookDelivery.findMany({
      where: {
        organizationId: currentUser.orgId,
        ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      },
      select: {
        id: true,
        endpointId: true,
        leadId: true,
        eventId: true,
        eventType: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        deliveredAt: true,
        responseStatus: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });
  }

  private async runSweep() {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      await this.sweepSlaBreaches();
      await this.sweepRetention();
      await this.deliverPendingWebhooks();
    } catch (error) {
      this.logger.error(
        'Lead operations sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.sweepRunning = false;
    }
  }

  private async sweepSlaBreaches() {
    const due = await this.prisma.lead.findMany({
      where: {
        firstResponseDueAt: { lte: new Date() },
        firstRespondedAt: null,
        slaBreachedAt: null,
        status: {
          notIn: [
            LeadStatus.converted,
            LeadStatus.disqualified,
            LeadStatus.archived,
          ],
        },
      },
      select: { id: true, organizationId: true, firstResponseDueAt: true },
      take: 100,
    });
    for (const lead of due) {
      await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.lead.updateMany({
          where: { id: lead.id, slaBreachedAt: null, firstRespondedAt: null },
          data: { slaBreachedAt: new Date() },
        });
        if (!changed.count) return;
        await transaction.leadAlert.create({
          data: {
            organizationId: lead.organizationId,
            leadId: lead.id,
            type: LeadAlertType.sla_breach,
            message: 'Lead first-response SLA has been breached',
            metadata: {
              firstResponseDueAt: lead.firstResponseDueAt?.toISOString(),
            },
          },
        });
        await this.emit(transaction, {
          organizationId: lead.organizationId,
          leadId: lead.id,
          eventType: 'lead.sla_breached',
          payload: {
            firstResponseDueAt: lead.firstResponseDueAt?.toISOString(),
          },
        });
      });
    }
  }

  private async sweepRetention() {
    const expired = await this.prisma.lead.findMany({
      where: { retentionExpiresAt: { lte: new Date() } },
      select: { id: true, organizationId: true },
      take: 100,
    });
    for (const lead of expired) {
      await this.prisma.$transaction(async (transaction) => {
        const changed = await transaction.lead.updateMany({
          where: { id: lead.id, retentionExpiresAt: { lte: new Date() } },
          data: {
            ownerId: null,
            assignedAt: null,
            name: null,
            email: null,
            normalizedEmail: null,
            phone: null,
            normalizedPhone: null,
            visitorId: null,
            fieldValues: {},
            metadata: { anonymizedAt: new Date().toISOString() },
            tags: [],
            notes: null,
            consentStatus: LeadConsentStatus.withdrawn,
            consentSource: 'retention_expired',
            consentedAt: null,
            retentionExpiresAt: null,
          },
        });
        if (!changed.count) return;
        await this.emit(transaction, {
          organizationId: lead.organizationId,
          leadId: lead.id,
          eventType: 'lead.deleted',
          payload: { reason: 'retention_expired', anonymized: true },
        });
      });
    }
  }

  private async deliverPendingWebhooks() {
    const deliveries = await this.prisma.leadWebhookDelivery.findMany({
      where: {
        status: {
          in: [
            LeadWebhookDeliveryStatus.pending,
            LeadWebhookDeliveryStatus.retrying,
            LeadWebhookDeliveryStatus.processing,
          ],
        },
        nextAttemptAt: { lte: new Date() },
      },
      include: { endpoint: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: 25,
    });
    for (const delivery of deliveries) {
      const claimed = await this.prisma.leadWebhookDelivery.updateMany({
        where: {
          id: delivery.id,
          status: delivery.status,
          nextAttemptAt: { lte: new Date() },
        },
        data: {
          status: LeadWebhookDeliveryStatus.processing,
          nextAttemptAt: new Date(Date.now() + 5 * 60_000),
        },
      });
      if (!claimed.count) continue;
      await this.deliverWebhook(delivery);
    }
  }

  private async deliverWebhook(
    delivery: Prisma.LeadWebhookDeliveryGetPayload<{
      include: { endpoint: true };
    }>,
  ) {
    const body = JSON.stringify(delivery.payload);
    const signature = createHmac(
      'sha256',
      this.cryptoService.decrypt(delivery.endpoint.secretEncrypted),
    )
      .update(body)
      .digest('hex');
    const attempts = delivery.attempts + 1;
    try {
      await this.assertResolvedWebhookUrl(delivery.endpoint.url);
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AgentCore-Lead-Webhook/1.0',
          'x-agentcore-event': delivery.eventType,
          'x-agentcore-event-id': delivery.eventId,
          'x-agentcore-signature': `sha256=${signature}`,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.prisma.leadWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: LeadWebhookDeliveryStatus.delivered,
          attempts,
          deliveredAt: new Date(),
          responseStatus: response.status,
          lastError: null,
        },
      });
    } catch (error) {
      const dead = attempts >= 5;
      await this.prisma.leadWebhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: dead
            ? LeadWebhookDeliveryStatus.dead
            : LeadWebhookDeliveryStatus.retrying,
          attempts,
          nextAttemptAt: new Date(
            Date.now() + Math.min(3_600_000, 5_000 * 2 ** attempts),
          ),
          lastError: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 1000),
        },
      });
    }
  }

  private async chooseLeastLoadedOwner(
    transaction: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const users = await transaction.user.findMany({
      where: this.assignableUserWhere(organizationId),
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!users.length) return null;
    const counts = await transaction.lead.groupBy({
      by: ['ownerId'],
      where: {
        organizationId,
        ownerId: { in: users.map((user) => user.id) },
        status: {
          notIn: [
            LeadStatus.converted,
            LeadStatus.disqualified,
            LeadStatus.archived,
          ],
        },
      },
      _count: { _all: true },
    });
    const countByOwner = new Map(
      counts.map((item) => [item.ownerId, item._count._all]),
    );
    return users.sort(
      (left, right) =>
        (countByOwner.get(left.id) ?? 0) - (countByOwner.get(right.id) ?? 0) ||
        left.id.localeCompare(right.id),
    )[0].id;
  }

  private assignableUserWhere(organizationId: string): Prisma.UserWhereInput {
    return {
      orgId: organizationId,
      isActive: true,
      OR: [
        {
          roles: {
            hasSome: [
              UserRole.agent,
              UserRole.org_admin,
              UserRole.product_admin,
            ],
          },
        },
        {
          productAccess: {
            some: { productKey: ProductKey.customer_chat, canUse: true },
          },
        },
      ],
    };
  }

  private async findWebhook(currentUser: AuthenticatedUser, id: string) {
    const endpoint = await this.prisma.leadWebhookEndpoint.findUnique({
      where: { id },
    });
    if (!endpoint || endpoint.organizationId !== currentUser.orgId) {
      throw new NotFoundException('Lead webhook endpoint not found');
    }
    return endpoint;
  }

  private toWebhookResponse<T extends { secretEncrypted: string }>(
    endpoint: T,
  ) {
    const { secretEncrypted: _secret, ...safe } = endpoint;
    return { ...safe, hasSecret: Boolean(_secret) };
  }

  private assertSafeWebhookUrl(value: string) {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      throw new BadRequestException('Webhook URL must be a public HTTPS URL');
    }
  }

  private async assertResolvedWebhookUrl(value: string) {
    const hostname = new URL(value).hostname;
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) => this.isPrivateIp(address))
    ) {
      throw new BadRequestException(
        'Webhook destination resolves to a private or unavailable address',
      );
    }
  }

  private isPrivateIp(address: string) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      /^127\./.test(normalized) ||
      /^10\./.test(normalized) ||
      /^192\.168\./.test(normalized) ||
      /^169\.254\./.test(normalized) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    );
  }

  private assertWebhookManager(user: AuthenticatedUser) {
    if (
      !user.roles.some((role) =>
        ['super_admin', 'org_admin', 'product_admin'].includes(role),
      )
    ) {
      throw new ForbiddenException(
        'Lead webhook management requires admin access',
      );
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

  private boundedInteger(
    value: unknown,
    minimum: number,
    maximum: number,
    fallback: number,
  ) {
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum
      ? value
      : fallback;
  }

  private assertInteger(
    value: unknown,
    path: string,
    minimum: number,
    maximum: number,
  ) {
    if (value === undefined) return;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new BadRequestException(
        `${path} must be an integer between ${minimum} and ${maximum}`,
      );
    }
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
