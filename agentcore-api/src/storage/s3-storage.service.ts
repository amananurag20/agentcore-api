import {
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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

@Injectable()
export class S3StorageService {
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
    this.assertConfigured();
    this.assertAllowedSize(input.file);

    const checksumSha256 = createHash('sha256')
      .update(input.file.buffer)
      .digest('hex');
    const key = this.buildObjectKey(input.organizationId, input.file);

    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.file.buffer,
        ContentType: input.file.mimetype,
        Metadata: {
          organizationId: input.organizationId,
          originalName: input.file.originalname,
          checksumSha256,
        },
      }),
    );

    return {
      provider: this.provider,
      bucket: this.bucket!,
      key,
      sizeBytes: input.file.size,
      checksumSha256,
    };
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

  private assertAllowedSize(file: Express.Multer.File) {
    if (file.size <= this.maxFileSizeBytes) {
      return;
    }

    throw new ServiceUnavailableException(
      `File exceeds upload limit of ${this.maxFileSizeBytes} bytes`,
    );
  }

  private buildObjectKey(
    organizationId: string,
    file: Express.Multer.File,
  ): string {
    const cleanName = file.originalname
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const extension = extname(cleanName);
    const baseName = cleanName.replace(new RegExp(`${extension}$`), '');

    return [
      this.prefix,
      organizationId,
      `${randomUUID()}-${baseName || 'upload'}${extension}`,
    ].join('/');
  }
}
