import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @Transform(({ value }) => Number(value ?? 5000))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 5000;

  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(2)
  JWT_ACCESS_EXPIRES_IN: string;

  @IsString()
  @MinLength(32)
  AI_CONFIG_ENCRYPTION_KEY: string;

  @IsString()
  @IsOptional()
  S3_STORAGE_PROVIDER?: 's3' | 'r2' | 'minio';

  @IsString()
  @IsOptional()
  S3_REGION?: string;

  @IsString()
  @IsOptional()
  S3_BUCKET?: string;

  @IsString()
  @IsOptional()
  S3_ENDPOINT?: string;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  S3_FORCE_PATH_STYLE?: boolean;

  @IsString()
  @IsOptional()
  S3_ACCESS_KEY_ID?: string;

  @IsString()
  @IsOptional()
  S3_SECRET_ACCESS_KEY?: string;

  @IsString()
  @IsOptional()
  S3_UPLOAD_PREFIX?: string;

  @Transform(({ value }) => Number(value ?? 25))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  MAX_UPLOAD_FILE_SIZE_MB = 25;

  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  @IsString()
  @IsOptional()
  QUEUE_PREFIX?: string;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  KNOWLEDGE_INGESTION_QUEUE_CONCURRENCY = 2;

  @IsString()
  @IsOptional()
  APPOINTMENT_REMINDER_OFFSETS_MINUTES?: string;

  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  APPOINTMENT_REMINDER_QUEUE_CONCURRENCY = 5;

  @IsString()
  @IsOptional()
  DEFAULT_EMBEDDING_MODEL?: string;

  @Transform(({ value }) => Number(value ?? 1536))
  @IsInt()
  @Min(1)
  @Max(4096)
  @IsOptional()
  DEFAULT_EMBEDDING_DIMENSIONS = 1536;

  @IsString()
  @IsOptional()
  DEFAULT_CHAT_MODEL?: string;

  @Transform(({ value }) => Number(value ?? 60))
  @IsInt()
  @Min(1)
  @Max(3600)
  @IsOptional()
  PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS = 60;

  @Transform(({ value }) => Number(value ?? 120))
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  PUBLIC_CHAT_MAX_CONFIG_FETCHES_PER_WINDOW = 120;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  PUBLIC_CHAT_MAX_CONVERSATIONS_PER_WINDOW = 10;

  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  PUBLIC_CHAT_MAX_MESSAGES_PER_WINDOW = 20;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  PUBLIC_CHAT_MAX_MESSAGES_PER_CONVERSATION_PER_WINDOW = 10;

  @Transform(({ value }) => Number(value ?? 2000))
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  PUBLIC_CHAT_MAX_MESSAGE_LENGTH = 2000;
}

export function validateEnv(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  return validatedConfig;
}
