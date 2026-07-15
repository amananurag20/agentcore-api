import {
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { extname } from 'path';

export interface StoredObject {
  provider: 's3' | 'r2' | 'minio';
  bucket: string;
  key: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface StorageUploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

type S3Body = {
  transformToByteArray?: () => Promise<Uint8Array>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | Buffer | string>;
};

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket?: string;
  private readonly provider: 's3' | 'r2' | 'minio';
  private readonly prefix: string;
  private readonly maxFileSizeBytes: number;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('S3_BUCKET');
    this.provider =
      this.configService.get<'s3' | 'r2' | 'minio'>('S3_STORAGE_PROVIDER') ??
      's3';
    this.prefix =
      this.configService.get<string>('S3_UPLOAD_PREFIX') ?? 'knowledge';
    this.maxFileSizeBytes =
      (this.configService.get<number>('MAX_UPLOAD_FILE_SIZE_MB') ?? 25) *
      1024 *
      1024;

    const accessKeyId = this.configService.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'S3_SECRET_ACCESS_KEY',
    );

    if (!this.bucket || !accessKeyId || !secretAccessKey) {
      this.client = null;
      return;
    }

    this.client = new S3Client({
      region: this.configService.get<string>('S3_REGION') ?? 'us-east-1',
      endpoint: this.configService.get<string>('S3_ENDPOINT') || undefined,
      forcePathStyle:
        this.configService.get<boolean>('S3_FORCE_PATH_STYLE') ?? false,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async uploadKnowledgeFile(input: {
    organizationId: string;
    file: Express.Multer.File;
  }): Promise<StoredObject> {
    return this.uploadFile({ ...input, namespace: 'knowledge' });
  }

  async createKnowledgeUploadUrl(input: {
    organizationId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }) {
    this.assertConfigured();
    const maxBytes =
      (this.configService.get<number>('KNOWLEDGE_DIRECT_UPLOAD_MAX_MB') ??
        2048) *
      1024 *
      1024;
    if (input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
      throw new BadRequestException(
        `Direct upload exceeds the ${maxBytes} byte limit`,
      );
    }
    const key = this.buildObjectKey(
      input.organizationId,
      {
        buffer: Buffer.alloc(0),
        originalname: input.fileName,
        mimetype: input.mimeType,
        size: input.sizeBytes,
      },
      'knowledge',
    );
    const expiresIn = 15 * 60;
    const uploadUrl = await getSignedUrl(
      this.client!,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: input.mimeType,
        Metadata: {
          organizationId: input.organizationId,
          originalNameEncoded: this.encodeMetadataValue(input.fileName),
          expectedSize: String(input.sizeBytes),
        },
      }),
      { expiresIn },
    );
    return {
      uploadUrl,
      key,
      bucket: this.bucket!,
      provider: this.provider,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      requiredHeaders: { 'Content-Type': input.mimeType },
    };
  }

  async verifyKnowledgeUpload(input: {
    organizationId: string;
    key: string;
    expectedSizeBytes: number;
  }) {
    this.assertConfigured();
    const expectedPrefix = `${this.prefix}/${input.organizationId}/`;
    if (!input.key.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        'Uploaded object is outside this workspace',
      );
    }
    const object = await this.client!.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: input.key }),
    );
    if (Number(object.ContentLength ?? -1) !== input.expectedSizeBytes) {
      throw new BadRequestException(
        'Uploaded object size does not match the upload request',
      );
    }
    if (object.Metadata?.organizationid !== input.organizationId) {
      throw new BadRequestException(
        'Uploaded object workspace metadata is invalid',
      );
    }
    return {
      provider: this.provider,
      bucket: this.bucket!,
      key: input.key,
      sizeBytes: input.expectedSizeBytes,
      checksumSha256: object.ChecksumSHA256 ?? null,
      contentType: object.ContentType ?? null,
    };
  }

  async uploadWhatsAppMedia(input: {
    organizationId: string;
    file: StorageUploadFile;
  }): Promise<StoredObject> {
    return this.uploadFile({ ...input, namespace: 'whatsapp' });
  }

  private async uploadFile(input: {
    organizationId: string;
    file: StorageUploadFile;
    namespace: 'knowledge' | 'whatsapp';
  }): Promise<StoredObject> {
    this.assertConfigured();
    this.assertAllowedSize(input.file);

    const checksumSha256 = createHash('sha256')
      .update(input.file.buffer)
      .digest('hex');
    const key = this.buildObjectKey(
      input.organizationId,
      input.file,
      input.namespace,
    );

    try {
      await this.client!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.file.buffer,
          ContentType: input.file.mimetype,
          Metadata: {
            organizationId: input.organizationId,
            originalNameEncoded: this.encodeMetadataValue(
              input.file.originalname,
            ),
            checksumSha256,
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Knowledge file upload failed for bucket ${this.bucket} and key ${key}: ${this.toErrorMessage(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException(
        'File storage upload failed. Verify the object-storage configuration and try again.',
      );
    }

    return {
      provider: this.provider,
      bucket: this.bucket!,
      key,
      sizeBytes: input.file.size,
      checksumSha256,
    };
  }

  async getKnowledgeFile(input: {
    bucket?: string | null;
    key?: string | null;
  }) {
    return this.getStoredFile(input);
  }

  async getStoredFile(input: { bucket?: string | null; key?: string | null }) {
    this.assertConfigured();

    if (!input.key) {
      throw new ServiceUnavailableException('Stored file key is missing');
    }

    const response = await this.client!.send(
      new GetObjectCommand({
        Bucket: input.bucket ?? this.bucket,
        Key: input.key,
      }),
    );

    return this.bodyToBuffer(response.Body as S3Body | undefined);
  }

  async getHealth() {
    if (!this.client || !this.bucket) {
      return {
        status: 'disabled',
        provider: this.provider,
        bucketConfigured: Boolean(this.bucket),
      };
    }

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));

      return {
        status: 'ok',
        provider: this.provider,
        bucketConfigured: true,
      };
    } catch {
      return {
        status: 'error',
        provider: this.provider,
        bucketConfigured: true,
      };
    }
  }

  private assertConfigured() {
    if (this.client && this.bucket) {
      return;
    }

    throw new ServiceUnavailableException(
      'S3 storage is not configured for file uploads',
    );
  }

  private assertAllowedSize(file: StorageUploadFile) {
    if (file.size <= this.maxFileSizeBytes) {
      return;
    }

    throw new BadRequestException(
      `File exceeds upload limit of ${this.maxFileSizeBytes} bytes`,
    );
  }

  private async bodyToBuffer(body?: S3Body): Promise<Buffer> {
    if (!body) {
      return Buffer.alloc(0);
    }

    if (body.transformToByteArray) {
      return Buffer.from(await body.transformToByteArray());
    }

    if (!body[Symbol.asyncIterator]) {
      return Buffer.alloc(0);
    }

    const chunks: Buffer[] = [];

    for await (const chunk of body as AsyncIterable<
      Uint8Array | Buffer | string
    >) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  private buildObjectKey(
    organizationId: string,
    file: StorageUploadFile,
    namespace: 'knowledge' | 'whatsapp',
  ): string {
    const cleanName = file.originalname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const extension = extname(cleanName);
    const baseName = cleanName.replace(new RegExp(`${extension}$`), '');

    return [
      this.prefix,
      ...(namespace === 'whatsapp' ? ['whatsapp'] : []),
      organizationId,
      `${randomUUID()}-${baseName || 'upload'}${extension}`,
    ].join('/');
  }

  private encodeMetadataValue(value: string): string {
    return encodeURIComponent(value).slice(0, 1024);
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
