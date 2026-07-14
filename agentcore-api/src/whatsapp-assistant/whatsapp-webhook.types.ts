import { BadRequestException } from '@nestjs/common';
import { WhatsAppInboundWebhookDto } from './dto/whatsapp-assistant.dto';

type JsonObject = Record<string, unknown>;

export type ParsedWhatsAppWebhook = {
  messages: WhatsAppInboundWebhookDto[];
  phoneNumberIds: string[];
  statuses: Array<{
    providerMessageId: string;
    status: string;
    timestamp?: string;
    recipientWaId?: string;
    errors?: unknown[];
  }>;
};

export function parseMetaWebhook(payload: unknown): ParsedWhatsAppWebhook {
  const root = asObject(payload);
  if (!root || root.object !== 'whatsapp_business_account') {
    throw new BadRequestException('Invalid Meta WhatsApp webhook payload');
  }

  const normalized: WhatsAppInboundWebhookDto[] = [];
  const statuses: ParsedWhatsAppWebhook['statuses'] = [];
  const phoneNumberIds = new Set<string>();

  for (const entry of asArray(root.entry)) {
    const entryObject = asObject(entry);
    for (const change of asArray(entryObject?.changes)) {
      const changeObject = asObject(change);
      if (changeObject?.field !== 'messages') continue;
      const value = asObject(changeObject.value);
      if (!value) continue;

      const metadata = asObject(value.metadata);
      const phoneNumberId = asString(metadata?.phone_number_id);
      if (phoneNumberId) phoneNumberIds.add(phoneNumberId);

      const contactNames = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        const contactObject = asObject(contact);
        const waId = asString(contactObject?.wa_id);
        const name = asString(asObject(contactObject?.profile)?.name);
        if (waId && name) contactNames.set(waId, name);
      }

      for (const message of asArray(value.messages)) {
        const parsed = parseMessage(message, contactNames, phoneNumberId);
        if (parsed) normalized.push(parsed);
      }
      for (const status of asArray(value.statuses)) {
        const statusObject = asObject(status);
        const providerMessageId = asString(statusObject?.id);
        const statusName = asString(statusObject?.status);
        if (!providerMessageId || !statusName) continue;
        statuses.push({
          providerMessageId,
          status: statusName,
          timestamp: asString(statusObject?.timestamp),
          recipientWaId: asString(statusObject?.recipient_id),
          errors: Array.isArray(statusObject?.errors)
            ? statusObject.errors
            : undefined,
        });
      }
    }
  }

  return {
    messages: normalized,
    phoneNumberIds: [...phoneNumberIds],
    statuses,
  };
}

export function isLegacyWebhookPayload(
  payload: unknown,
): payload is WhatsAppInboundWebhookDto {
  return Boolean(asString(asObject(payload)?.contactWaId));
}

function parseMessage(
  value: unknown,
  contactNames: Map<string, string>,
  phoneNumberId?: string,
): WhatsAppInboundWebhookDto | null {
  const message = asObject(value);
  const contactWaId = asString(message?.from);
  const providerMessageId = asString(message?.id);
  if (!message || !contactWaId || !providerMessageId) return null;

  const rawType = asString(message.type) ?? 'unknown';
  const supportedTypes = new Set([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'sticker',
    'location',
  ]);
  const type = supportedTypes.has(rawType) ? rawType : 'unknown';
  const typePayload = asObject(message[rawType]);
  const mediaId = asString(typePayload?.id);
  const content = readContent(type, typePayload);

  return {
    contactWaId,
    contactName: contactNames.get(contactWaId),
    contactPhone: `+${contactWaId}`,
    providerMessageId,
    type: type as WhatsAppInboundWebhookDto['type'],
    content,
    mediaMimeType: asString(typePayload?.mime_type),
    mediaSha256: asString(typePayload?.sha256),
    metadata: {
      provider: 'meta',
      providerTimestamp: asString(message.timestamp),
      phoneNumberId,
      mediaId,
      mediaFilename: asString(typePayload?.filename),
      rawMessageType: rawType,
    },
  };
}

function readContent(type: string, payload?: JsonObject): string | undefined {
  if (type === 'text') return asString(payload?.body);
  if (['image', 'video', 'document'].includes(type)) {
    return asString(payload?.caption);
  }
  if (type === 'location') {
    const latitude = asNumber(payload?.latitude);
    const longitude = asNumber(payload?.longitude);
    if (latitude === undefined || longitude === undefined) return undefined;
    const label = asString(payload?.name) ?? asString(payload?.address);
    return label
      ? `${label} (${latitude}, ${longitude})`
      : `${latitude}, ${longitude}`;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
