import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  WhatsAppAssistantConfig,
  WhatsAppMessage,
} from '@prisma/client';
import { createHash } from 'crypto';
import { ChatService } from '../ai/chat.service';
import { CryptoService } from '../crypto/crypto.service';
import { KnowledgeFileExtractorService } from '../knowledge-ingestion/knowledge-file-extractor.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileSecurityService } from '../storage/file-security.service';
import { S3StorageService } from '../storage/s3-storage.service';

const ALLOWED_MIME_TYPES = new Set([
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/amr',
  'audio/ogg',
  'text/plain',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/3gpp',
]);

@Injectable()
export class WhatsAppMediaService {
  private readonly maxBytes: number;

  constructor(
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly cryptoService: CryptoService,
    private readonly extractor: KnowledgeFileExtractorService,
    private readonly fileSecurity: FileSecurityService,
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
  ) {
    this.maxBytes = this.configService.get<number>(
      'WHATSAPP_MEDIA_MAX_BYTES',
      25 * 1024 * 1024,
    );
  }

  async downloadStoreAndDescribe(input: {
    config: WhatsAppAssistantConfig;
    message: WhatsAppMessage;
  }): Promise<string | null> {
    const metadata = this.toRecord(input.message.metadata);
    if (input.message.mediaStorageKey) {
      return this.readString(metadata.mediaAiContext) ?? null;
    }
    const mediaId = this.readString(metadata.mediaId);
    if (!mediaId) return null;
    if (!input.config.accessTokenEncrypted || !input.config.phoneNumberId) {
      throw new ServiceUnavailableException(
        'Meta media download credentials are missing',
      );
    }

    const accessToken = this.cryptoService.decrypt(
      input.config.accessTokenEncrypted,
    );
    const media = await this.downloadMetaMedia(
      mediaId,
      input.config.phoneNumberId,
      accessToken,
    );
    this.assertMimeType(media.mimeType, input.message.mediaMimeType);
    this.assertMagicBytes(media.buffer, media.mimeType);
    this.assertChecksum(media.buffer, input.message.mediaSha256);
    const malwareScan = await this.fileSecurity.scan(media.buffer);
    const fileName =
      this.readString(metadata.mediaFilename) ??
      `${mediaId}.${this.extensionForMime(media.mimeType)}`;
    const stored = await this.storage.uploadWhatsAppMedia({
      organizationId: input.message.organizationId,
      file: {
        buffer: media.buffer,
        mimetype: media.mimeType,
        originalname: fileName,
        size: media.buffer.length,
      },
    });
    const aiContext = await this.createAiContext(
      input.message,
      media.buffer,
      media.mimeType,
      fileName,
    );

    await this.prisma.whatsAppMessage.update({
      where: { id: input.message.id },
      data: {
        mediaMimeType: media.mimeType,
        mediaSha256: stored.checksumSha256,
        mediaStorageBucket: stored.bucket,
        mediaStorageKey: stored.key,
        mediaSizeBytes: stored.sizeBytes,
        metadata: this.toJsonObject({
          ...metadata,
          malwareScan,
          mediaAiContext: aiContext,
        }),
      },
    });

    return aiContext;
  }

  async getStoredMedia(message: WhatsAppMessage) {
    if (!message.mediaStorageKey) {
      throw new BadRequestException('This message has no stored media');
    }
    return {
      buffer: await this.storage.getStoredFile({
        bucket: message.mediaStorageBucket,
        key: message.mediaStorageKey,
      }),
      mimeType: message.mediaMimeType ?? 'application/octet-stream',
      fileName:
        this.readString(this.toRecord(message.metadata).mediaFilename) ??
        'whatsapp-media',
    };
  }

  private async downloadMetaMedia(
    mediaId: string,
    phoneNumberId: string,
    accessToken: string,
  ) {
    const graphVersion = this.configService.get<string>(
      'WHATSAPP_GRAPH_API_VERSION',
      'v20.0',
    );
    const metadataUrl = new URL(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(mediaId)}`,
    );
    metadataUrl.searchParams.set('phone_number_id', phoneNumberId);
    const metadataResponse = await this.fetchWithRetry(metadataUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const metadataBody = (await metadataResponse.json().catch(() => ({}))) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
      error?: { message?: string };
    };
    if (!metadataResponse.ok || !metadataBody.url) {
      throw new ServiceUnavailableException(
        metadataBody.error?.message ??
          `Meta media lookup failed with ${metadataResponse.status}`,
      );
    }
    if (metadataBody.file_size && metadataBody.file_size > this.maxBytes) {
      throw new BadRequestException('WhatsApp media exceeds the size limit');
    }

    const downloadUrl = new URL(metadataBody.url);
    this.assertMetaMediaHost(downloadUrl);
    const response = await this.fetchWithRetry(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Meta media download failed with ${response.status}`,
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      throw new BadRequestException('WhatsApp media exceeds the size limit');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException('WhatsApp media exceeds the size limit');
    }

    return {
      buffer,
      mimeType:
        response.headers.get('content-type')?.split(';')[0].trim() ||
        metadataBody.mime_type ||
        'application/octet-stream',
    };
  }

  private async createAiContext(
    message: WhatsAppMessage,
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<string | null> {
    if (mimeType.startsWith('image/') && mimeType !== 'image/webp') {
      return this.chatService.describeImage({
        organizationId: message.organizationId,
        buffer,
        mimeType,
        customerCaption: message.content,
      });
    }

    if (mimeType.startsWith('audio/')) {
      const transcript = await this.chatService.transcribeAudio({
        organizationId: message.organizationId,
        buffer,
        mimeType,
        fileName,
      });
      return transcript ? `Customer audio transcript:\n${transcript}` : null;
    }

    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/pdf' ||
      mimeType.includes('wordprocessingml') ||
      mimeType.includes('spreadsheetml')
    ) {
      try {
        const extracted = await this.extractor.extract({
          buffer,
          fileName,
          mimeType,
          organizationId: message.organizationId,
        });
        return `Customer attachment text:\n${extracted.text.slice(0, 4_000)}`;
      } catch {
        return null;
      }
    }

    return null;
  }

  private assertMimeType(actual: string, expected?: string | null) {
    if (!ALLOWED_MIME_TYPES.has(actual)) {
      throw new BadRequestException(
        `Unsupported WhatsApp media type: ${actual}`,
      );
    }
    if (expected && actual !== expected) {
      throw new BadRequestException('WhatsApp media MIME type mismatch');
    }
  }

  private assertChecksum(buffer: Buffer, expected?: string | null) {
    if (!expected) return;
    const hex = createHash('sha256').update(buffer).digest('hex');
    const base64 = createHash('sha256').update(buffer).digest('base64');
    if (expected !== hex && expected !== base64) {
      throw new BadRequestException('WhatsApp media checksum mismatch');
    }
  }

  private assertMagicBytes(buffer: Buffer, mimeType: string) {
    const ascii = buffer.subarray(0, 12).toString('ascii');
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isOle = buffer
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const valid =
      mimeType === 'image/jpeg'
        ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : mimeType === 'image/png'
          ? buffer
              .subarray(0, 8)
              .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              )
          : mimeType === 'image/webp'
            ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
            : mimeType === 'application/pdf'
              ? ascii.startsWith('%PDF-')
              : mimeType.includes('openxmlformats-officedocument')
                ? isZip
                : [
                      'application/msword',
                      'application/vnd.ms-excel',
                      'application/vnd.ms-powerpoint',
                    ].includes(mimeType)
                  ? isOle
                  : mimeType === 'video/mp4'
                    ? ascii.slice(4, 8) === 'ftyp'
                    : true;
    if (!valid) {
      throw new BadRequestException(
        'WhatsApp media content does not match its MIME type',
      );
    }
  }

  private assertMetaMediaHost(url: URL) {
    const allowedSuffixes = [
      '.facebook.com',
      '.fbcdn.net',
      '.fbsbx.com',
      '.whatsapp.net',
    ];
    if (
      url.protocol !== 'https:' ||
      !allowedSuffixes.some(
        (suffix) =>
          url.hostname.endsWith(suffix) || url.hostname === suffix.slice(1),
      )
    ) {
      throw new BadRequestException('Meta returned an invalid media URL');
    }
  }

  private async fetchWithRetry(url: URL, init: RequestInit) {
    const attempts = this.configService.get<number>(
      'WHATSAPP_PROVIDER_MAX_RETRIES',
      2,
    );
    let lastError: unknown;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(
            this.configService.get<number>(
              'WHATSAPP_PROVIDER_TIMEOUT_MS',
              10_000,
            ),
          ),
        });
        if (
          attempt < attempts &&
          [408, 425, 429, 500, 502, 503, 504].includes(response.status)
        ) {
          await this.sleep(this.retryDelay(response, attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
      }
    }
    throw new ServiceUnavailableException(
      `Meta media request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private retryDelay(response: Response, attempt: number) {
    const value = response.headers.get('retry-after');
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
      const dateDelay = Date.parse(value) - Date.now();
      if (Number.isFinite(dateDelay))
        return Math.min(Math.max(dateDelay, 0), 30_000);
    }
    return 250 * 2 ** attempt;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private extensionForMime(mimeType: string) {
    return (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
        'video/mp4': 'mp4',
      }[mimeType] ?? 'bin'
    );
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  private toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
    return value as Prisma.InputJsonObject;
  }
}
