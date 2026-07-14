import { plainToInstance, Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsString()
  @IsOptional()
  NODE_ENV?: string;

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

  @Transform(({ value }) => Number(value ?? 30))
  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  REFRESH_TOKEN_EXPIRES_DAYS = 30;

  @Transform(({ value }) => Number(value ?? 72))
  @IsInt()
  @Min(1)
  @Max(720)
  @IsOptional()
  AUTH_INVITE_TOKEN_EXPIRES_HOURS = 72;

  @Transform(({ value }) => Number(value ?? 30))
  @IsInt()
  @Min(5)
  @Max(1440)
  @IsOptional()
  AUTH_PASSWORD_RESET_TOKEN_EXPIRES_MINUTES = 30;

  @IsString()
  @MinLength(32)
  AI_CONFIG_ENCRYPTION_KEY: string;

  @IsString()
  @IsOptional()
  CORS_ORIGINS?: string;

  @Transform(({ value }) => Number(value ?? 15000))
  @IsInt()
  @Min(1000)
  @Max(120000)
  @IsOptional()
  AI_PROVIDER_TIMEOUT_MS = 15000;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(0)
  @Max(5)
  @IsOptional()
  AI_PROVIDER_MAX_RETRIES = 2;

  @Transform(({ value }) => Number(value ?? 1024))
  @IsInt()
  @Min(128)
  @Max(8192)
  @IsOptional()
  AI_PROVIDER_MAX_OUTPUT_TOKENS = 1024;

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

  @Transform(({ value }) => Number(value ?? 720))
  @IsInt()
  @Min(1)
  @Max(8760)
  @IsOptional()
  KNOWLEDGE_STALE_AFTER_HOURS = 720;

  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  KNOWLEDGE_SOURCE_VERSION_RETENTION = 20;

  @Transform(({ value }) => Number(value ?? 365))
  @IsInt()
  @Min(1)
  @Max(3650)
  @IsOptional()
  KNOWLEDGE_SOURCE_VERSION_RETENTION_DAYS = 365;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(10000)
  @Max(3600000)
  @IsOptional()
  KNOWLEDGE_LIFECYCLE_INTERVAL_MS = 60000;

  @IsString()
  @IsOptional()
  KNOWLEDGE_ALERT_WEBHOOK_URL?: string;

  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_MAX_PAGES = 5;

  @Transform(({ value }) => Number(value ?? 10000))
  @IsInt()
  @Min(1000)
  @Max(60000)
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_TIMEOUT_MS = 10000;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(0)
  @Max(5)
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_MAX_RETRIES = 2;

  @Transform(({ value }) => Number(value ?? 1000000))
  @IsInt()
  @Min(10000)
  @Max(10000000)
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_MAX_BYTES = 1000000;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_RESPECT_ROBOTS = true;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  KNOWLEDGE_URL_SCRAPER_SITEMAP_ENABLED = true;

  @IsString()
  @IsOptional()
  APPOINTMENT_REMINDER_OFFSETS_MINUTES?: string;

  @IsString()
  @IsOptional()
  APPOINTMENT_REMINDER_CHANNELS?: string;

  @IsString()
  @IsOptional()
  RESEND_API_KEY?: string;

  @IsString()
  @IsOptional()
  APPOINTMENT_EMAIL_FROM?: string;

  @IsString()
  @IsUrl({ require_tld: false })
  @IsOptional()
  APPOINTMENT_PUBLIC_URL?: string;

  @IsString()
  @IsOptional()
  TWILIO_ACCOUNT_SID?: string;

  @IsString()
  @IsOptional()
  TWILIO_AUTH_TOKEN?: string;

  @IsString()
  @IsOptional()
  TWILIO_SMS_FROM?: string;

  @IsString()
  @IsOptional()
  APPOINTMENT_WHATSAPP_TEMPLATE_NAME?: string;

  @Transform(({ value }) => Number(value ?? 60))
  @IsInt()
  @Min(1)
  @Max(3600)
  @IsOptional()
  PUBLIC_APPOINTMENT_RATE_LIMIT_WINDOW_SECONDS = 60;

  @Transform(({ value }) => Number(value ?? 120))
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  PUBLIC_APPOINTMENT_MAX_READS_PER_WINDOW = 120;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  PUBLIC_APPOINTMENT_MAX_WRITES_PER_WINDOW = 10;

  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  APPOINTMENT_REMINDER_QUEUE_CONCURRENCY = 5;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(5000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_REMINDER_RECOVERY_INTERVAL_MS = 60000;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  APPOINTMENT_REMINDER_MAX_ATTEMPTS = 10;

  @Transform(({ value }) => Number(value ?? 300000))
  @IsInt()
  @Min(30000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_REMINDER_PROCESSING_TIMEOUT_MS = 300000;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(5000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_NO_SHOW_SCAN_INTERVAL_MS = 60000;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(5000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_WAITLIST_RECOVERY_INTERVAL_MS = 60000;

  @Transform(({ value }) => Number(value ?? 10000))
  @IsInt()
  @Min(1000)
  @Max(120000)
  @IsOptional()
  APPOINTMENT_PROVIDER_TIMEOUT_MS = 10000;

  @Transform(({ value }) => Number(value ?? 0))
  @IsInt()
  @Min(0)
  @Max(43200)
  @IsOptional()
  APPOINTMENT_MIN_LEAD_TIME_MINUTES = 0;

  @Transform(({ value }) => Number(value ?? 365))
  @IsInt()
  @Min(1)
  @Max(3650)
  @IsOptional()
  APPOINTMENT_MAX_ADVANCE_DAYS = 365;

  @IsString()
  @IsOptional()
  GOOGLE_CALENDAR_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;

  @IsString()
  @IsOptional()
  GOOGLE_CALENDAR_REDIRECT_URI?: string;

  @IsString()
  @IsOptional()
  MICROSOFT_CALENDAR_CLIENT_ID?: string;

  @IsString()
  @IsOptional()
  MICROSOFT_CALENDAR_CLIENT_SECRET?: string;

  @IsString()
  @IsOptional()
  MICROSOFT_CALENDAR_REDIRECT_URI?: string;

  @IsString()
  @IsOptional()
  APPOINTMENT_CALENDAR_OAUTH_SUCCESS_URL?: string;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  APPOINTMENT_CALENDAR_FAIL_OPEN = true;

  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  APPOINTMENT_CALENDAR_SYNC_CONCURRENCY = 5;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(5000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_CALENDAR_RECOVERY_INTERVAL_MS = 60000;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  APPOINTMENT_CALENDAR_SYNC_MAX_ATTEMPTS = 10;

  @Transform(({ value }) => Number(value ?? 300000))
  @IsInt()
  @Min(30000)
  @Max(3600000)
  @IsOptional()
  APPOINTMENT_CALENDAR_SYNC_PROCESSING_TIMEOUT_MS = 300000;

  @IsString()
  @IsOptional()
  DEFAULT_EMBEDDING_MODEL?: string;

  @Transform(({ value }) => Number(value ?? 1536))
  @Equals(1536)
  @IsInt()
  @Min(1)
  @Max(4096)
  @IsOptional()
  DEFAULT_EMBEDDING_DIMENSIONS = 1536;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  ALLOW_LOCAL_EMBEDDINGS?: boolean;

  @IsString()
  @IsOptional()
  CUSTOMER_CHAT_PROCESSING_FAILURE_MESSAGE?: string;

  @Transform(({ value }) => Number(value ?? 5000000))
  @IsInt()
  @Min(1000)
  @Max(50000000)
  @IsOptional()
  KNOWLEDGE_MAX_EXTRACTED_CHARACTERS = 5000000;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_API_KEY?: string;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(1000)
  @Max(300000)
  @IsOptional()
  KNOWLEDGE_OCR_TIMEOUT_MS = 60000;

  @IsString()
  @IsOptional()
  CLAMAV_HOST?: string;

  @Transform(({ value }) => Number(value ?? 3310))
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  CLAMAV_PORT = 3310;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  MALWARE_SCAN_REQUIRED = false;

  @Transform(({ value }) => Number(value ?? 15000))
  @IsInt()
  @Min(1000)
  @Max(120000)
  @IsOptional()
  MALWARE_SCAN_TIMEOUT_MS = 15000;

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

  @Transform(({ value }) => Number(value ?? 1000))
  @IsInt()
  @Min(1)
  @Max(100000)
  @IsOptional()
  CUSTOMER_CHAT_SSE_MAX_CONNECTIONS = 1000;

  @Transform(({ value }) => Number(value ?? 25))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  CUSTOMER_CHAT_SSE_MAX_CONNECTIONS_PER_SCOPE = 25;

  @Transform(({ value }) => Number(value ?? 0))
  @IsInt()
  @Min(0)
  @Max(10)
  @IsOptional()
  TRUST_PROXY_HOPS = 0;

  @Transform(({ value }) =>
    value === undefined ? undefined : value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  RATE_LIMIT_FAIL_CLOSED?: boolean;

  @Transform(({ value }) =>
    value === undefined ? undefined : value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  ALLOW_UNRESTRICTED_WIDGET_ORIGINS?: boolean;

  @Transform(({ value }) => Number(value ?? 24))
  @IsInt()
  @Min(1)
  @Max(720)
  @IsOptional()
  CUSTOMER_CHAT_VISITOR_SESSION_HOURS = 24;

  @Transform(({ value }) => Number(value ?? 90))
  @IsInt()
  @Min(1)
  @Max(3650)
  @IsOptional()
  CUSTOMER_CHAT_RETENTION_DAYS = 90;

  @Transform(({ value }) => Number(value ?? 3600000))
  @IsInt()
  @Min(60000)
  @Max(86400000)
  @IsOptional()
  CUSTOMER_CHAT_RETENTION_SWEEP_INTERVAL_MS = 3600000;

  @Transform(({ value }) => Number(value ?? 0.35))
  @Min(0)
  @Max(1)
  @IsOptional()
  CUSTOMER_CHAT_MIN_SIMILARITY_SCORE = 0.35;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  CUSTOMER_CHAT_AUTO_HANDOFF_ON_FAILURE = true;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  VOICE_WEBHOOK_SIGNATURE_REQUIRED = false;

  @IsString()
  @IsOptional()
  WHATSAPP_OUTBOUND_MODE?: 'mock' | 'live';

  @IsString()
  @IsOptional()
  VOICE_OUTBOUND_MODE?: 'mock' | 'live';
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
