import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  LeadCaptureFieldMapping,
  LeadCaptureFieldType,
  LeadConsentStatus,
  LeadPriority,
  LeadStatus,
  Prisma,
} from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { ListLeadsDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import {
  LeadOperationsPolicy,
  LeadOperationsService,
} from './lead-operations.service';

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

export type LeadSignal =
  | 'pricing_interest'
  | 'demo_interest'
  | 'booking_intent'
  | 'purchase_intent'
  | 'urgent_timeline'
  | 'budget_shared'
  | 'company_size_shared'
  | 'decision_maker'
  | 'negative_intent';

export type LeadSignalEvidence = {
  signal: LeadSignal;
  source: 'rules' | 'ai';
  confidence: number;
  evidence?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type LeadScoringPolicy = {
  enabled: boolean;
  aiEnabled: boolean;
  aiConfidenceThreshold: number;
  signalDecayDays: number;
  thresholds: { medium: number; high: number; hot: number };
  weights: Record<LeadSignal, number> & {
    name: number;
    email: number;
    phone: number;
    customField: number;
    customFieldMaximum: number;
    campaignAttribution: number;
    highIntentPage: number;
    qualifiedByTeam: number;
  };
};

export type AiLeadQualification = {
  intent: 'low' | 'medium' | 'high';
  confidence: number;
  summary?: string;
  signals: Array<{
    signal: LeadSignal;
    confidence: number;
    evidence: string;
  }>;
};

type LeadScoreInput = {
  status?: LeadStatus;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  fieldValues?: Prisma.JsonValue | Prisma.InputJsonValue;
  metadata?: Prisma.JsonValue | Prisma.InputJsonValue;
  qualification?:
    Prisma.JsonValue | Prisma.InputJsonValue | Record<string, unknown>;
  scoreOverride?: number | null;
  policy?: LeadScoringPolicy;
  evaluatedAt?: Date;
};

export type LeadScoreSnapshot = {
  automaticScore: number;
  score: number;
  priority: LeadPriority;
  qualification: Prisma.InputJsonObject;
};

const SIGNAL_WEIGHTS: Record<LeadSignal, number> = {
  pricing_interest: 12,
  demo_interest: 18,
  booking_intent: 22,
  purchase_intent: 22,
  urgent_timeline: 10,
  budget_shared: 10,
  company_size_shared: 6,
  decision_maker: 8,
  negative_intent: -25,
};

const DEFAULT_SCORING_POLICY: LeadScoringPolicy = {
  enabled: true,
  aiEnabled: false,
  aiConfidenceThreshold: 0.65,
  signalDecayDays: 30,
  thresholds: { medium: 35, high: 60, hot: 80 },
  weights: {
    name: 5,
    email: 15,
    phone: 15,
    customField: 5,
    customFieldMaximum: 20,
    campaignAttribution: 5,
    highIntentPage: 10,
    qualifiedByTeam: 15,
    ...SIGNAL_WEIGHTS,
  },
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
    @Optional() private readonly leadOperationsService?: LeadOperationsService,
  ) {}

  readOperationsPolicy(
    value: Prisma.JsonValue | Record<string, unknown> | null | undefined,
    strict = false,
  ) {
    return (
      this.leadOperationsService?.readPolicy(value, strict) ?? {
        autoAssign: 'none' as const,
        firstResponseMinutes: 30,
        alertPriority: 'hot' as const,
        retentionDays: 0,
      }
    );
  }

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

  prepareConversationalCapture(content: string): PreparedLeadCapture | null {
    const email = content
      .match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]
      ?.replace(/[),.;:]+$/, '');
    const phoneCandidate = content.match(/\+[1-9][0-9 ()-]{6,24}[0-9]/)?.[0];
    let phone: string | undefined;
    let normalizedPhone: string | undefined;
    if (phoneCandidate) {
      try {
        normalizedPhone = this.normalizePhone(phoneCandidate.trim());
        phone = phoneCandidate.trim();
      } catch {
        // Ignore number-like text that is not a valid international phone.
      }
    }
    if (!email && !phone) return null;

    return {
      email,
      normalizedEmail: email?.toLowerCase(),
      phone,
      normalizedPhone,
      fieldValues: {},
    };
  }

  calculateScore(input: LeadScoreInput): LeadScoreSnapshot {
    const policy = input.policy ?? DEFAULT_SCORING_POLICY;
    const evaluatedAt = input.evaluatedAt ?? new Date();
    const fieldValues = this.toRecord(input.fieldValues);
    const metadata = this.toRecord(input.metadata);
    const previousQualification = this.toRecord(input.qualification);
    const signals = this.readSignals(previousQualification.signals);
    const signalEvidence = this.readSignalEvidence(
      previousQualification.signalEvidence,
      signals,
      evaluatedAt,
    );
    const breakdown: Record<string, number> = {};

    if (policy.enabled && input.name) breakdown.name = policy.weights.name;
    if (policy.enabled && input.email) breakdown.email = policy.weights.email;
    if (policy.enabled && input.phone) breakdown.phone = policy.weights.phone;

    const customFieldCount = Object.entries(fieldValues).filter(
      ([key, value]) =>
        !['name', 'email', 'phone'].includes(key) &&
        value !== null &&
        value !== '' &&
        value !== false,
    ).length;
    if (policy.enabled && customFieldCount) {
      breakdown.profileCompleteness = Math.min(
        policy.weights.customFieldMaximum,
        customFieldCount * policy.weights.customField,
      );
    }

    const attribution = this.readAttribution(metadata);
    if (policy.enabled && attribution.hasCampaign) {
      breakdown.campaignAttribution = policy.weights.campaignAttribution;
    }
    if (policy.enabled && attribution.highIntentPage) {
      breakdown.highIntentPage = policy.weights.highIntentPage;
    }
    if (policy.enabled) {
      for (const signal of signals) {
        const strongestMultiplier = signalEvidence
          .filter((item) => item.signal === signal)
          .reduce(
            (maximum, item) =>
              Math.max(
                maximum,
                item.confidence *
                  this.signalDecayMultiplier(
                    item.lastSeenAt,
                    evaluatedAt,
                    policy.signalDecayDays,
                  ),
              ),
            0,
          );
        const points = Math.round(policy.weights[signal] * strongestMultiplier);
        if (points) breakdown[signal] = points;
      }
    }
    if (policy.enabled && input.status === LeadStatus.qualified) {
      breakdown.qualifiedByTeam = policy.weights.qualifiedByTeam;
    }

    const calculatedAutomaticScore = this.clampScore(
      Object.values(breakdown).reduce((total, value) => total + value, 0),
    );
    const automaticScore =
      input.status === LeadStatus.converted
        ? 100
        : input.status === LeadStatus.disqualified
          ? 0
          : calculatedAutomaticScore;
    if (input.status === LeadStatus.converted) breakdown.converted = 100;
    if (input.status === LeadStatus.disqualified) breakdown.disqualified = -100;
    const manualAdjustment = this.readBoundedNumber(
      previousQualification.manualScoreAdjustment,
      -100,
      100,
      0,
    );
    const score =
      input.scoreOverride === null || input.scoreOverride === undefined
        ? this.clampScore(automaticScore + manualAdjustment)
        : this.clampScore(input.scoreOverride);
    const reasons = Object.entries(breakdown)
      .filter(([, value]) => value !== 0)
      .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
      .map(([key, points]) => ({ key, points }));

    return {
      automaticScore,
      score,
      priority: this.priorityForScore(score, policy),
      qualification: {
        ...previousQualification,
        signals,
        signalEvidence,
        manualScoreAdjustment: manualAdjustment,
        reasons,
        scoringPolicy: {
          aiEnabled: policy.aiEnabled,
          aiConfidenceThreshold: policy.aiConfidenceThreshold,
          signalDecayDays: policy.signalDecayDays,
          thresholds: policy.thresholds,
        },
        scoreVersion: 'hybrid_v2',
        evaluatedAt: evaluatedAt.toISOString(),
      },
    };
  }

  readScoringPolicy(
    value: Prisma.JsonValue | Record<string, unknown> | null | undefined,
    strict = false,
  ): LeadScoringPolicy {
    const settings = this.toRecord(value ?? undefined);
    if (
      strict &&
      settings.leadScoring !== undefined &&
      (!settings.leadScoring ||
        typeof settings.leadScoring !== 'object' ||
        Array.isArray(settings.leadScoring))
    ) {
      throw new BadRequestException('leadScoring must be an object');
    }
    const configured = this.toRecord(settings.leadScoring as Prisma.JsonValue);
    if (strict) {
      for (const key of ['thresholds', 'weights'] as const) {
        if (
          configured[key] !== undefined &&
          (!configured[key] ||
            typeof configured[key] !== 'object' ||
            Array.isArray(configured[key]))
        ) {
          throw new BadRequestException(`leadScoring.${key} must be an object`);
        }
      }
    }
    const thresholds = this.toRecord(configured.thresholds as Prisma.JsonValue);
    const weights = this.toRecord(configured.weights as Prisma.JsonValue);
    if (strict) {
      for (const key of ['enabled', 'aiEnabled'] as const) {
        if (
          configured[key] !== undefined &&
          typeof configured[key] !== 'boolean'
        ) {
          throw new BadRequestException(`leadScoring.${key} must be a boolean`);
        }
      }
      this.assertScoringNumber(
        configured.aiConfidenceThreshold,
        'leadScoring.aiConfidenceThreshold',
        0.5,
        1,
      );
      this.assertScoringNumber(
        configured.signalDecayDays,
        'leadScoring.signalDecayDays',
        1,
        365,
        true,
      );
      this.assertScoringNumber(
        thresholds.medium,
        'leadScoring.thresholds.medium',
        1,
        98,
        true,
      );
      this.assertScoringNumber(
        thresholds.high,
        'leadScoring.thresholds.high',
        2,
        99,
        true,
      );
      this.assertScoringNumber(
        thresholds.hot,
        'leadScoring.thresholds.hot',
        3,
        100,
        true,
      );
      for (const [key, weight] of Object.entries(weights)) {
        if (!(key in DEFAULT_SCORING_POLICY.weights)) {
          throw new BadRequestException(`Unknown lead scoring weight: ${key}`);
        }
        this.assertScoringNumber(
          weight,
          `leadScoring.weights.${key}`,
          -100,
          100,
          true,
        );
      }
    }
    const policy: LeadScoringPolicy = {
      enabled: this.readBoolean(
        configured.enabled,
        DEFAULT_SCORING_POLICY.enabled,
      ),
      aiEnabled: this.readBoolean(
        configured.aiEnabled,
        DEFAULT_SCORING_POLICY.aiEnabled,
      ),
      aiConfidenceThreshold: this.readBoundedNumber(
        configured.aiConfidenceThreshold,
        0.5,
        1,
        DEFAULT_SCORING_POLICY.aiConfidenceThreshold,
      ),
      signalDecayDays: this.readBoundedNumber(
        configured.signalDecayDays,
        1,
        365,
        DEFAULT_SCORING_POLICY.signalDecayDays,
      ),
      thresholds: {
        medium: this.readBoundedNumber(
          thresholds.medium,
          1,
          98,
          DEFAULT_SCORING_POLICY.thresholds.medium,
        ),
        high: this.readBoundedNumber(
          thresholds.high,
          2,
          99,
          DEFAULT_SCORING_POLICY.thresholds.high,
        ),
        hot: this.readBoundedNumber(
          thresholds.hot,
          3,
          100,
          DEFAULT_SCORING_POLICY.thresholds.hot,
        ),
      },
      weights: { ...DEFAULT_SCORING_POLICY.weights },
    };
    for (const key of Object.keys(policy.weights) as Array<
      keyof LeadScoringPolicy['weights']
    >) {
      policy.weights[key] = this.readBoundedNumber(
        weights[key],
        -100,
        100,
        policy.weights[key],
      );
    }
    if (
      policy.thresholds.medium >= policy.thresholds.high ||
      policy.thresholds.high >= policy.thresholds.hot
    ) {
      if (strict) {
        throw new BadRequestException(
          'Lead scoring thresholds must increase from medium to high to hot',
        );
      }
      policy.thresholds = { ...DEFAULT_SCORING_POLICY.thresholds };
    }
    return policy;
  }

  async recordConversationActivity(
    transaction: Prisma.TransactionClient,
    input: {
      leadId: string;
      organizationId: string;
      content: string;
      activityAt: Date;
      policy?: LeadScoringPolicy;
      operationsPolicy?: LeadOperationsPolicy;
    },
  ) {
    const lead = await transaction.lead.findFirst({
      where: { id: input.leadId, organizationId: input.organizationId },
    });
    if (!lead) return null;

    const qualification = this.toRecord(lead.qualification);
    const existingSignals = this.readSignals(qualification.signals);
    const detectedSignals = this.detectConversationSignals(input.content);
    const signals = [...new Set([...existingSignals, ...detectedSignals])];
    const signalEvidence = this.upsertSignalEvidence(
      this.readSignalEvidence(
        qualification.signalEvidence,
        existingSignals,
        input.activityAt,
      ),
      detectedSignals.map((signal) => ({
        signal,
        source: 'rules' as const,
        confidence: 1,
        evidence: input.content.slice(0, 240),
      })),
      input.activityAt,
    );
    const snapshot = this.calculateScore({
      ...lead,
      qualification: { ...qualification, signals, signalEvidence },
      policy: input.policy,
      evaluatedAt: input.activityAt,
    });
    const updated = await transaction.lead.update({
      where: { id: lead.id },
      data: {
        automaticScore: snapshot.automaticScore,
        score: snapshot.score,
        priority: snapshot.priority,
        qualification: snapshot.qualification,
        scoreUpdatedAt: input.activityAt,
        lastActivityAt: input.activityAt,
      },
    });
    await this.leadOperationsService?.recordPriorityTransition(transaction, {
      organizationId: input.organizationId,
      leadId: lead.id,
      previous: lead.priority,
      next: updated.priority,
      score: updated.score,
      policy: input.operationsPolicy ?? this.readOperationsPolicy(undefined),
    });
    return updated;
  }

  async recordAiQualification(input: {
    leadId: string;
    organizationId: string;
    qualification: AiLeadQualification;
    activityAt: Date;
    policy?: LeadScoringPolicy;
    operationsPolicy?: LeadOperationsPolicy;
  }) {
    const policy = input.policy ?? DEFAULT_SCORING_POLICY;
    const accepted = input.qualification.signals.filter(
      (signal) => signal.confidence >= policy.aiConfidenceThreshold,
    );
    if (!accepted.length) return null;
    return this.prisma.$transaction(async (transaction) => {
      const lead = await transaction.lead.findFirst({
        where: { id: input.leadId, organizationId: input.organizationId },
      });
      if (!lead) return null;
      const qualification = this.toRecord(lead.qualification);
      const existingSignals = this.readSignals(qualification.signals);
      const signals = [
        ...new Set([
          ...existingSignals,
          ...accepted.map((item) => item.signal),
        ]),
      ];
      const signalEvidence = this.upsertSignalEvidence(
        this.readSignalEvidence(
          qualification.signalEvidence,
          existingSignals,
          input.activityAt,
        ),
        accepted.map((item) => ({ ...item, source: 'ai' as const })),
        input.activityAt,
      );
      const snapshot = this.calculateScore({
        ...lead,
        qualification: {
          ...qualification,
          signals,
          signalEvidence,
          aiIntent: input.qualification.intent,
          aiConfidence: input.qualification.confidence,
          aiSummary: input.qualification.summary,
        },
        policy,
        evaluatedAt: input.activityAt,
      });
      const updated = await transaction.lead.update({
        where: { id: lead.id },
        data: {
          automaticScore: snapshot.automaticScore,
          score: snapshot.score,
          priority: snapshot.priority,
          qualification: snapshot.qualification,
          scoreUpdatedAt: input.activityAt,
        },
      });
      await this.leadOperationsService?.recordPriorityTransition(transaction, {
        organizationId: input.organizationId,
        leadId: lead.id,
        previous: lead.priority,
        next: updated.priority,
        score: updated.score,
        policy: input.operationsPolicy ?? this.readOperationsPolicy(undefined),
      });
      return updated;
    });
  }

  async captureLead(
    transaction: Prisma.TransactionClient,
    input: PreparedLeadCapture,
    context: {
      organizationId: string;
      widgetConfigId: string;
      visitorId?: string;
      metadata?: Record<string, unknown>;
      scoringPolicy?: LeadScoringPolicy;
      operationsPolicy?: LeadOperationsPolicy;
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
      const combinedQualification = matches.reduce<Record<string, unknown>>(
        (qualification, lead) => ({
          ...qualification,
          ...this.toRecord(lead.qualification),
          signals: [
            ...new Set([
              ...this.readSignals(qualification.signals),
              ...this.readSignals(this.toRecord(lead.qualification).signals),
            ]),
          ],
        }),
        {},
      );
      const mergedMetadata = {
        ...combinedMetadata,
        ...(context.metadata ?? {}),
      } as Prisma.InputJsonObject;
      const mergedFieldValues = {
        ...combinedFieldValues,
        ...input.fieldValues,
      } as Prisma.InputJsonObject;
      const scoreOverride = matches.find(
        (lead) => lead.scoreOverride !== null,
      )?.scoreOverride;
      const scoreSnapshot = this.calculateScore({
        status: matches[0].status,
        name: input.name ?? matches.find((lead) => lead.name)?.name,
        email: input.email ?? matches.find((lead) => lead.email)?.email,
        phone: input.phone ?? matches.find((lead) => lead.phone)?.phone,
        fieldValues: mergedFieldValues,
        metadata: mergedMetadata,
        qualification: combinedQualification,
        scoreOverride,
        policy: context.scoringPolicy,
        evaluatedAt: now,
      });

      if (mergedLeadIds.length) {
        await transaction.customerChatConversation.updateMany({
          where: { leadId: { in: mergedLeadIds } },
          data: { leadId: survivor.id },
        });
        await transaction.appointmentBooking.updateMany({
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
          fieldValues: mergedFieldValues,
          metadata: mergedMetadata,
          tags: combinedTags,
          notes: matches.find((lead) => lead.notes)?.notes,
          automaticScore: scoreSnapshot.automaticScore,
          score: scoreSnapshot.score,
          priority: scoreSnapshot.priority,
          qualification: scoreSnapshot.qualification,
          scoreUpdatedAt: now,
        },
      });
      await this.leadOperationsService?.emit(transaction, {
        organizationId: context.organizationId,
        leadId: lead.id,
        eventType: 'lead.updated',
        payload: { source: context.metadata?.source ?? 'capture' },
      });
      return {
        lead,
        action: mergedLeadIds.length ? 'merged' : 'updated',
        mergedLeadIds,
      };
    }

    const scoreSnapshot = this.calculateScore({
      status: LeadStatus.new,
      name: input.name,
      email: input.email,
      phone: input.phone,
      fieldValues: input.fieldValues,
      metadata: captureData.metadata,
      policy: context.scoringPolicy,
      evaluatedAt: now,
    });
    const operationalFields = this.leadOperationsService
      ? await this.leadOperationsService.prepareNewLead(
          transaction,
          context.organizationId,
          context.operationsPolicy ?? this.readOperationsPolicy(undefined),
          now,
        )
      : {};
    const lead = await transaction.lead.create({
      data: {
        organizationId: context.organizationId,
        ...captureData,
        ...operationalFields,
        automaticScore: scoreSnapshot.automaticScore,
        score: scoreSnapshot.score,
        priority: scoreSnapshot.priority,
        qualification: scoreSnapshot.qualification,
        scoreUpdatedAt: now,
      },
    });
    await this.leadOperationsService?.emit(transaction, {
      organizationId: context.organizationId,
      leadId: lead.id,
      eventType: 'lead.created',
      payload: {
        source: context.metadata?.source ?? 'widget',
        ownerId: lead.ownerId,
        score: lead.score,
        priority: lead.priority,
      },
    });
    await this.leadOperationsService?.recordPriorityTransition(transaction, {
      organizationId: context.organizationId,
      leadId: lead.id,
      previous: LeadPriority.low,
      next: lead.priority,
      score: lead.score,
      policy: context.operationsPolicy ?? this.readOperationsPolicy(undefined),
    });
    if (lead.ownerId) {
      await this.leadOperationsService?.emit(transaction, {
        organizationId: context.organizationId,
        leadId: lead.id,
        eventType: 'lead.assigned',
        payload: { ownerId: lead.ownerId, automatic: true },
      });
      await transaction.leadAlert.create({
        data: {
          organizationId: context.organizationId,
          leadId: lead.id,
          type: 'assignment',
          message: 'A new lead was automatically assigned',
          metadata: { ownerId: lead.ownerId },
        },
      });
    }
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
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.minScore !== undefined
        ? { score: { gte: input.minScore } }
        : {}),
      ...(input.widgetConfigId ? { widgetConfigId: input.widgetConfigId } : {}),
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.assignment === 'assigned'
        ? { ownerId: { not: null } }
        : input.assignment === 'unassigned'
          ? { ownerId: null }
          : {}),
      ...(input.sla === 'breached'
        ? { slaBreachedAt: { not: null } }
        : input.sla === 'due'
          ? {
              firstResponseDueAt: { lte: new Date() },
              firstRespondedAt: null,
            }
          : {}),
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
          owner: { select: { id: true, name: true, email: true } },
          _count: { select: { conversations: true, appointments: true } },
        },
        orderBy:
          input.sort === 'lastActivity'
            ? [{ lastActivityAt: 'desc' }, { id: 'desc' }]
            : [{ score: 'desc' }, { lastActivityAt: 'desc' }, { id: 'desc' }],
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
        owner: { select: { id: true, name: true, email: true } },
        lifecycleEvents: {
          orderBy: { createdAt: 'desc' },
          take: 100,
        },
        alerts: {
          orderBy: { createdAt: 'desc' },
          take: 25,
        },
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
        appointments: {
          select: {
            id: true,
            status: true,
            startAt: true,
            endAt: true,
            timezone: true,
            service: { select: { id: true, name: true } },
            staff: { select: { id: true, name: true } },
          },
          orderBy: { startAt: 'desc' },
          take: 25,
        },
        _count: { select: { conversations: true, appointments: true } },
      },
    });
    if (!lead || !this.canAccess(currentUser, lead.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    return this.toResponse(lead);
  }

  async getScoreHistory(currentUser: AuthenticatedUser, id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (!lead || !this.canAccess(currentUser, lead.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    const history = await this.prisma.auditLog.findMany({
      where: {
        organizationId: lead.organizationId,
        entityType: 'lead',
        entityId: id,
        action: 'lead.score_changed',
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return history.map((item) => ({
      ...item,
      metadata: this.toRecord(item.metadata),
    }));
  }

  async assign(
    currentUser: AuthenticatedUser,
    id: string,
    ownerId?: string | null,
  ) {
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing || !this.canAccess(currentUser, existing.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    const isManager = currentUser.roles.some((role) =>
      ['super_admin', 'org_admin', 'product_admin'].includes(role),
    );
    if (!isManager && ownerId !== currentUser.sub) {
      throw new ForbiddenException(
        'Agents can only claim leads for themselves',
      );
    }
    if (ownerId) {
      const owner = await this.prisma.user.findFirst({
        where: { id: ownerId, orgId: existing.organizationId, isActive: true },
        select: { id: true },
      });
      if (!owner) throw new BadRequestException('Lead owner is not assignable');
    }
    const lead = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.lead.update({
        where: { id },
        data: {
          ownerId: ownerId ?? null,
          assignedAt: ownerId ? new Date() : null,
        },
        include: {
          widgetConfig: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true, email: true } },
          _count: { select: { conversations: true, appointments: true } },
        },
      });
      await this.leadOperationsService?.emit(transaction, {
        organizationId: existing.organizationId,
        leadId: id,
        eventType: 'lead.assigned',
        actorUserId: currentUser.sub,
        payload: {
          previousOwnerId: existing.ownerId,
          ownerId: ownerId ?? null,
        },
      });
      if (ownerId) {
        await transaction.leadAlert.create({
          data: {
            organizationId: existing.organizationId,
            leadId: id,
            type: 'assignment',
            message: 'Lead assignment changed',
            metadata: { ownerId, assignedBy: currentUser.sub },
          },
        });
      }
      return updated;
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: existing.organizationId,
      action: 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      metadata: { previousOwnerId: existing.ownerId, ownerId: ownerId ?? null },
    });
    return this.toResponse(lead);
  }

  async updateConsent(
    currentUser: AuthenticatedUser,
    id: string,
    status: LeadConsentStatus,
    source: string,
  ) {
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing || !this.canAccess(currentUser, existing.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    const now = new Date();
    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        consentStatus: status,
        consentSource: source.trim(),
        consentedAt: status === LeadConsentStatus.granted ? now : null,
      },
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: existing.organizationId,
      action: 'lead.consent_updated',
      entityType: 'lead',
      entityId: id,
      metadata: { previous: existing.consentStatus, status, source },
    });
    return this.toResponse(lead);
  }

  async recordAgentResponse(
    transaction: Prisma.TransactionClient,
    input: {
      organizationId: string;
      leadId: string;
      actorUserId: string;
      at: Date;
    },
  ) {
    return this.leadOperationsService?.recordFirstResponse(transaction, input);
  }

  async deleteLead(currentUser: AuthenticatedUser, id: string) {
    if (
      !currentUser.roles.some((role) =>
        ['super_admin', 'org_admin', 'product_admin'].includes(role),
      )
    ) {
      throw new ForbiddenException('Lead deletion requires admin access');
    }
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing || !this.canAccess(currentUser, existing.organizationId)) {
      throw new NotFoundException('Lead not found');
    }
    await this.prisma.$transaction(async (transaction) => {
      await this.leadOperationsService?.emit(transaction, {
        organizationId: existing.organizationId,
        leadId: id,
        eventType: 'lead.deleted',
        actorUserId: currentUser.sub,
        payload: { reason: 'manual_privacy_or_admin_deletion' },
      });
      await transaction.lead.delete({ where: { id } });
    });
    await this.auditService.record({
      actor: currentUser,
      organizationId: existing.organizationId,
      action: 'lead.deleted',
      entityType: 'lead',
      entityId: id,
    });
    return { deleted: true };
  }

  async update(
    currentUser: AuthenticatedUser,
    id: string,
    input: UpdateLeadDto,
  ) {
    const existing = await this.prisma.lead.findUnique({
      where: { id },
      include: { widgetConfig: { select: { settings: true } } },
    });
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
    const scoreOverride =
      input.scoreOverride === undefined
        ? existing.scoreOverride
        : input.scoreOverride;
    const scoreChangeRequested =
      input.scoreOverride !== undefined ||
      input.manualScoreAdjustment !== undefined;
    const scoreChangeReason = input.scoreChangeReason?.trim();
    if (
      scoreChangeRequested &&
      (!scoreChangeReason || scoreChangeReason.length < 3)
    ) {
      throw new BadRequestException(
        'A score change reason of at least 3 characters is required',
      );
    }
    const existingQualification = this.toRecord(existing.qualification);
    const previousManualAdjustment = this.readBoundedNumber(
      existingQualification.manualScoreAdjustment,
      -100,
      100,
      0,
    );
    const manualScoreAdjustment =
      input.manualScoreAdjustment === undefined
        ? previousManualAdjustment
        : (input.manualScoreAdjustment ?? 0);
    const qualification = scoreChangeRequested
      ? {
          ...existingQualification,
          manualScoreAdjustment,
          manualScoreReason: scoreChangeReason,
          manualScoreChangedAt: new Date().toISOString(),
          manualScoreChangedBy: currentUser.sub,
        }
      : existingQualification;
    const scoringPolicy = this.readScoringPolicy(
      existing.widgetConfig?.settings,
    );
    const operationsPolicy = this.readOperationsPolicy(
      existing.widgetConfig?.settings,
    );
    const scoreSnapshot = this.calculateScore({
      status: input.status ?? existing.status,
      name:
        input.name === undefined ? existing.name : input.name?.trim() || null,
      email: email === undefined ? existing.email : email,
      phone: phone === undefined ? existing.phone : phone,
      fieldValues: existing.fieldValues,
      metadata: existing.metadata,
      qualification,
      scoreOverride,
      policy: scoringPolicy,
    });

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
        const updated = await transaction.lead.update({
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
            scoreOverride,
            automaticScore: scoreSnapshot.automaticScore,
            score: scoreSnapshot.score,
            priority: scoreSnapshot.priority,
            qualification: scoreSnapshot.qualification,
            scoreUpdatedAt: new Date(),
            lastActivityAt: new Date(),
          },
          include: {
            widgetConfig: { select: { id: true, name: true } },
            owner: { select: { id: true, name: true, email: true } },
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
        await this.leadOperationsService?.recordPriorityTransition(
          transaction,
          {
            organizationId: existing.organizationId,
            leadId: id,
            previous: existing.priority,
            next: updated.priority,
            score: updated.score,
            policy: operationsPolicy,
          },
        );
        await this.leadOperationsService?.emit(transaction, {
          organizationId: existing.organizationId,
          leadId: id,
          eventType:
            updated.status === LeadStatus.converted
              ? 'lead.converted'
              : 'lead.updated',
          actorUserId: currentUser.sub,
          payload: {
            previousStatus: existing.status,
            status: updated.status,
            score: updated.score,
            priority: updated.priority,
          },
        });
        return updated;
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
    if (scoreChangeRequested) {
      await this.auditService.record({
        actor: currentUser,
        organizationId: existing.organizationId,
        action: 'lead.score_changed',
        entityType: 'lead',
        entityId: id,
        metadata: {
          reason: scoreChangeReason,
          previous: {
            automaticScore: existing.automaticScore,
            score: existing.score,
            scoreOverride: existing.scoreOverride,
            manualScoreAdjustment: previousManualAdjustment,
          },
          next: {
            automaticScore: scoreSnapshot.automaticScore,
            score: scoreSnapshot.score,
            scoreOverride,
            manualScoreAdjustment,
          },
        },
      });
    }
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

  private detectConversationSignals(content: string): LeadSignal[] {
    const text = content.toLowerCase();
    const matches: Array<[LeadSignal, RegExp]> = [
      ['pricing_interest', /\b(price|pricing|cost|fee|fees|quote|quotation)\b/],
      ['demo_interest', /\b(demo|demonstration|walkthrough|trial)\b/],
      [
        'booking_intent',
        /\b(book|booking|appointment|schedule|meeting|call me)\b/,
      ],
      [
        'purchase_intent',
        /\b(buy|purchase|subscribe|sign up|enroll|admission|order)\b/,
      ],
      [
        'urgent_timeline',
        /\b(today|tomorrow|this week|urgent|immediately|asap|right away)\b/,
      ],
      [
        'budget_shared',
        /(?:[$€£₹]\s?\d|\b(?:budget|lakhs?|lacs?|crores?|thousand|million)\b)/,
      ],
      [
        'company_size_shared',
        /\b(?:team|company|employees?|staff)\s+(?:of\s+)?\d+\b/,
      ],
      [
        'decision_maker',
        /\b(owner|founder|director|decision maker|head of|vp|vice president)\b/,
      ],
      [
        'negative_intent',
        /\b(not interested|just browsing|no thanks|stop contacting)\b/,
      ],
    ];
    return matches
      .filter(([, pattern]) => pattern.test(text))
      .map(([signal]) => signal);
  }

  private readSignals(value: unknown): LeadSignal[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (signal): signal is LeadSignal =>
        typeof signal === 'string' && signal in SIGNAL_WEIGHTS,
    );
  }

  private readSignalEvidence(
    value: unknown,
    legacySignals: LeadSignal[],
    evaluatedAt: Date,
  ): LeadSignalEvidence[] {
    const evidence = Array.isArray(value)
      ? value.flatMap((item): LeadSignalEvidence[] => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return [];
          }
          const record = item as Record<string, unknown>;
          if (
            typeof record.signal !== 'string' ||
            !(record.signal in SIGNAL_WEIGHTS) ||
            (record.source !== 'rules' && record.source !== 'ai') ||
            typeof record.lastSeenAt !== 'string' ||
            !Number.isFinite(Date.parse(record.lastSeenAt))
          ) {
            return [];
          }
          const lastSeenAt = new Date(record.lastSeenAt).toISOString();
          const firstSeenAt =
            typeof record.firstSeenAt === 'string' &&
            Number.isFinite(Date.parse(record.firstSeenAt))
              ? new Date(record.firstSeenAt).toISOString()
              : lastSeenAt;
          return [
            {
              signal: record.signal as LeadSignal,
              source: record.source,
              confidence: this.readBoundedNumber(record.confidence, 0, 1, 1),
              ...(typeof record.evidence === 'string' && record.evidence.trim()
                ? { evidence: record.evidence.trim().slice(0, 240) }
                : {}),
              firstSeenAt,
              lastSeenAt,
            },
          ];
        })
      : [];
    const represented = new Set(evidence.map((item) => item.signal));
    const legacyAt = evaluatedAt.toISOString();
    for (const signal of legacySignals) {
      if (!represented.has(signal)) {
        evidence.push({
          signal,
          source: 'rules',
          confidence: 1,
          firstSeenAt: legacyAt,
          lastSeenAt: legacyAt,
        });
      }
    }
    return evidence;
  }

  private upsertSignalEvidence(
    existing: LeadSignalEvidence[],
    incoming: Array<{
      signal: LeadSignal;
      source: 'rules' | 'ai';
      confidence: number;
      evidence?: string;
    }>,
    observedAt: Date,
  ) {
    const next = existing.map((item) => ({ ...item }));
    const timestamp = observedAt.toISOString();
    for (const item of incoming) {
      const index = next.findIndex(
        (candidate) =>
          candidate.signal === item.signal && candidate.source === item.source,
      );
      const normalized = {
        signal: item.signal,
        source: item.source,
        confidence: this.readBoundedNumber(item.confidence, 0, 1, 1),
        ...(item.evidence?.trim()
          ? { evidence: item.evidence.trim().slice(0, 240) }
          : {}),
        firstSeenAt: index >= 0 ? next[index].firstSeenAt : timestamp,
        lastSeenAt: timestamp,
      } satisfies LeadSignalEvidence;
      if (index >= 0) next[index] = normalized;
      else next.push(normalized);
    }
    return next;
  }

  private signalDecayMultiplier(
    lastSeenAt: string,
    evaluatedAt: Date,
    decayDays: number,
  ) {
    const ageDays = Math.max(
      0,
      (evaluatedAt.getTime() - new Date(lastSeenAt).getTime()) / 86_400_000,
    );
    return Math.pow(0.5, ageDays / decayDays);
  }

  private readAttribution(metadata: Record<string, unknown>) {
    const pageUrl =
      typeof metadata.pageUrl === 'string'
        ? metadata.pageUrl.toLowerCase()
        : '';
    const campaignKeys = [
      'utmSource',
      'utmMedium',
      'utmCampaign',
      'gclid',
      'fbclid',
      'msclkid',
    ];
    return {
      hasCampaign: campaignKeys.some(
        (key) => typeof metadata[key] === 'string' && metadata[key],
      ),
      highIntentPage:
        /\/(pricing|demo|contact|book|checkout|plans)(?:[/?#]|$)/.test(pageUrl),
    };
  }

  private clampScore(value: number) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  private priorityForScore(
    score: number,
    policy: LeadScoringPolicy = DEFAULT_SCORING_POLICY,
  ): LeadPriority {
    if (score >= policy.thresholds.hot) return LeadPriority.hot;
    if (score >= policy.thresholds.high) return LeadPriority.high;
    if (score >= policy.thresholds.medium) return LeadPriority.medium;
    return LeadPriority.low;
  }

  private readBoolean(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
  }

  private readBoundedNumber(
    value: unknown,
    minimum: number,
    maximum: number,
    fallback: number,
  ) {
    const numberValue = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(numberValue) &&
      numberValue >= minimum &&
      numberValue <= maximum
      ? numberValue
      : fallback;
  }

  private assertScoringNumber(
    value: unknown,
    path: string,
    minimum: number,
    maximum: number,
    integer = false,
  ) {
    if (value === undefined) return;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum ||
      (integer && !Number.isInteger(value))
    ) {
      throw new BadRequestException(
        `${path} must be ${integer ? 'an integer' : 'a number'} between ${minimum} and ${maximum}`,
      );
    }
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
      // Advisory locks return PostgreSQL `void`, which Prisma cannot deserialize
      // through $queryRaw. Execute the statement without reading its result.
      await transaction.$executeRaw`
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

  private toRecord(
    value:
      | Prisma.JsonValue
      | Prisma.InputJsonValue
      | Record<string, unknown>
      | undefined,
  ): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private toResponse<
    T extends {
      fieldValues: Prisma.JsonValue;
      metadata: Prisma.JsonValue;
      qualification: Prisma.JsonValue;
    },
  >(lead: T) {
    return {
      ...lead,
      fieldValues: this.toRecord(lead.fieldValues),
      metadata: this.toRecord(lead.metadata),
      qualification: this.toRecord(lead.qualification),
    };
  }
}
