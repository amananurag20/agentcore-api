import { BadRequestException } from '@nestjs/common';
import {
  WhatsAppInboundWebhookDto,
  WhatsAppMessageTypeDto,
} from './dto/whatsapp-assistant.dto';

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
    phoneNumberId?: string;
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
          phoneNumberId,
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
    'interactive',
    'button',
    'contacts',
    'reaction',
  ]);
  const type = !supportedTypes.has(rawType)
    ? 'unknown'
    : rawType === 'button' || rawType === 'interactive'
      ? 'interactive'
      : rawType === 'contacts'
        ? 'contact'
        : rawType;
  const typePayload = asObject(message[rawType]);
  const mediaId = asString(typePayload?.id);
  const structured = readStructuredContent(rawType, message, typePayload);
  const content = structured.content ?? readContent(type, typePayload);

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
      ...structured.metadata,
      contextMessageId: asString(asObject(message.context)?.id),
    },
  };
}

export function parseTwilioWebhook(payload: unknown): ParsedWhatsAppWebhook {
  const body = asObject(payload);
  if (!body) throw new BadRequestException('Invalid Twilio webhook payload');
  const providerMessageId =
    asString(body.MessageSid) ?? asString(body.SmsMessageSid);
  const status = asString(body.MessageStatus) ?? asString(body.SmsStatus);
  const from = stripTwilioAddress(asString(body.From));
  const to = stripTwilioAddress(asString(body.To));
  const phoneNumberIds = to ? [to] : [];
  const hasInboundContent = Boolean(
    asString(body.Body) ||
    asString(body.MediaUrl0) ||
    asString(body.ButtonText),
  );

  if (
    status &&
    providerMessageId &&
    !hasInboundContent &&
    status.toLocaleLowerCase() !== 'received'
  ) {
    return {
      messages: [],
      phoneNumberIds,
      statuses: [
        {
          providerMessageId,
          status,
          recipientWaId: to,
          errors: body.ErrorCode
            ? [{ code: body.ErrorCode, message: body.ErrorMessage }]
            : undefined,
          phoneNumberId: from,
        },
      ],
    };
  }
  if (!providerMessageId || !from) {
    throw new BadRequestException('Invalid Twilio WhatsApp webhook payload');
  }
  const mediaUrl = asString(body.MediaUrl0);
  const mediaMimeType = asString(body.MediaContentType0);
  const messageType = mediaUrl
    ? mediaTypeFromMime(mediaMimeType)
    : WhatsAppMessageTypeDto.text;
  const buttonText = asString(body.ButtonText);
  const buttonPayload = asString(body.ButtonPayload);
  return {
    phoneNumberIds,
    statuses: [],
    messages: [
      {
        contactWaId: from,
        contactPhone: `+${from.replace(/^\+/, '')}`,
        providerMessageId,
        type: buttonText ? WhatsAppMessageTypeDto.interactive : messageType,
        content: buttonText ?? asString(body.Body),
        mediaUrl,
        mediaMimeType,
        metadata: {
          provider: 'twilio',
          phoneNumberId: to,
          buttonPayload,
          numMedia: asString(body.NumMedia),
          profileName: asString(body.ProfileName),
          forwarded: asString(body.Forwarded),
          frequentlyForwarded: asString(body.FrequentlyForwarded),
        },
      },
    ],
  };
}

function readStructuredContent(
  rawType: string,
  message: JsonObject,
  payload?: JsonObject,
): { content?: string; metadata?: JsonObject } {
  if (rawType === 'button') {
    return {
      content: asString(payload?.text) ?? asString(payload?.payload),
      metadata: {
        interactiveType: 'template_button_reply',
        replyId: asString(payload?.payload),
        replyTitle: asString(payload?.text),
      },
    };
  }
  if (rawType === 'interactive') {
    const interactiveType = asString(payload?.type);
    const reply = asObject(
      interactiveType ? payload?.[interactiveType] : undefined,
    );
    if (
      interactiveType === 'button_reply' ||
      interactiveType === 'list_reply'
    ) {
      const title = asString(reply?.title);
      const description = asString(reply?.description);
      return {
        content:
          [title, description].filter(Boolean).join(' — ') ||
          asString(reply?.id),
        metadata: {
          interactiveType,
          replyId: asString(reply?.id),
          replyTitle: title,
          replyDescription: description,
        },
      };
    }
    if (interactiveType === 'nfm_reply') {
      const responseJson = asString(reply?.response_json)?.slice(0, 8_000);
      return {
        content:
          [asString(reply?.body), responseJson].filter(Boolean).join('\n') ||
          'Customer submitted a WhatsApp Flow response.',
        metadata: {
          interactiveType,
          flowName: asString(reply?.name),
          flowResponseJson: responseJson,
        },
      };
    }
    return {
      content: 'Customer sent an interactive WhatsApp response.',
      metadata: { interactiveType },
    };
  }
  if (rawType === 'reaction') {
    const emoji = asString(payload?.emoji);
    return {
      content: emoji
        ? `Customer reacted ${emoji} to a message.`
        : 'Customer removed a reaction from a message.',
      metadata: {
        reactionEmoji: emoji,
        reactionMessageId: asString(payload?.message_id),
      },
    };
  }
  if (rawType === 'contacts') {
    const contacts = asArray(message.contacts)
      .map(asObject)
      .filter((contact): contact is JsonObject => Boolean(contact));
    const summaries = contacts.map((contact) => {
      const name = asObject(contact.name);
      const displayName =
        asString(name?.formatted_name) ??
        [asString(name?.first_name), asString(name?.last_name)]
          .filter(Boolean)
          .join(' ');
      const phones = asArray(contact.phones)
        .map((phone) => asString(asObject(phone)?.phone))
        .filter(Boolean);
      const emails = asArray(contact.emails)
        .map((email) => asString(asObject(email)?.email))
        .filter(Boolean);
      return [displayName, phones.join(', '), emails.join(', ')]
        .filter(Boolean)
        .join(' — ');
    });
    return {
      content:
        summaries.filter(Boolean).join('\n') || 'Customer shared a contact.',
      metadata: { sharedContacts: contacts.slice(0, 20) },
    };
  }
  return {};
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

function stripTwilioAddress(value?: string): string | undefined {
  return value?.replace(/^whatsapp:/i, '').replace(/^\+/, '');
}

function mediaTypeFromMime(
  mimeType?: string,
): WhatsAppInboundWebhookDto['type'] {
  if (mimeType?.startsWith('image/')) return WhatsAppMessageTypeDto.image;
  if (mimeType?.startsWith('audio/')) return WhatsAppMessageTypeDto.audio;
  if (mimeType?.startsWith('video/')) return WhatsAppMessageTypeDto.video;
  return WhatsAppMessageTypeDto.document;
}
