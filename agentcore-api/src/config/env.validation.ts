import { plainToInstance, Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
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
  AI_CONFIG_ENCRYPTION_KEYS?: string;

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

  @Transform(({ value }) => Number(value ?? 12000))
  @IsInt()
  @Min(1000)
  @Max(200000)
  @IsOptional()
  AI_CHAT_MAX_INPUT_TOKENS = 12000;

  @Transform(({ value }) => Number(value ?? 6000))
  @IsInt()
  @Min(500)
  @Max(100000)
  @IsOptional()
  AI_RAG_CONTEXT_MAX_TOKENS = 6000;

  @Transform(({ value }) => Number(value ?? 2000))
  @IsInt()
  @Min(100)
  @Max(50000)
  @IsOptional()
  AI_CHAT_HISTORY_MAX_TOKENS = 2000;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  AI_PROVIDER_ALLOW_PRIVATE_NETWORKS = false;

  @IsString()
  @IsOptional()
  AI_PROVIDER_ALLOWED_HOSTS?: string;

  @Transform(({ value }) => Number(value ?? 10))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  AI_PROVIDER_TEST_RATE_LIMIT = 10;

  @Transform(({ value }) => Number(value ?? 60))
  @IsInt()
  @Min(1)
  @Max(3600)
  @IsOptional()
  AI_PROVIDER_TEST_RATE_WINDOW_SECONDS = 60;

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

  @Transform(({ value }) => Number(value ?? 2048))
  @IsInt()
  @Min(1)
  @Max(10240)
  @IsOptional()
  KNOWLEDGE_DIRECT_UPLOAD_MAX_MB = 2048;

  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  @IsString()
  @MinLength(32)
  @IsOptional()
  VOICE_RELAY_SIGNING_SECRET?: string;

  @Transform(({ value }) => Number(value ?? 120))
  @IsInt()
  @Min(30)
  @Max(600)
  @IsOptional()
  VOICE_RELAY_TICKET_TTL_SECONDS = 120;

  @Transform(({ value }) => Number(value ?? 250))
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  VOICE_WS_MAX_CONNECTIONS = 250;

  @Transform(({ value }) => Number(value ?? 50))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  VOICE_WS_MAX_CONNECTIONS_PER_CONFIG = 50;

  @Transform(({ value }) => Number(value ?? 32))
  @IsInt()
  @Min(4)
  @Max(256)
  @IsOptional()
  VOICE_WS_MAX_PENDING_MESSAGES = 32;

  @Transform(({ value }) => Number(value ?? 1048576))
  @IsInt()
  @Min(65536)
  @Max(16777216)
  @IsOptional()
  VOICE_WS_MAX_BUFFERED_BYTES = 1048576;

  @Transform(({ value }) => Number(value ?? 2000))
  @IsInt()
  @Min(100)
  @Max(30000)
  @IsOptional()
  VOICE_WS_BACKPRESSURE_TIMEOUT_MS = 2000;

  @Transform(({ value }) => Number(value ?? 0.35))
  @Min(0)
  @Max(1)
  @IsOptional()
  VOICE_RAG_MIN_SIMILARITY_SCORE = 0.35;

  @Transform(({ value }) => Number(value ?? 6000))
  @IsInt()
  @Min(500)
  @Max(50000)
  @IsOptional()
  VOICE_RAG_MAX_CONTEXT_CHARACTERS = 6000;

  @Transform(({ value }) => Number(value ?? 30))
  @IsInt()
  @Min(1)
  @Max(3650)
  @IsOptional()
  VOICE_RECORDING_RETENTION_DAYS = 30;

  @Transform(({ value }) => Number(value ?? 3600000))
  @IsInt()
  @Min(60000)
  @Max(86400000)
  @IsOptional()
  VOICE_RETENTION_SWEEP_INTERVAL_MS = 3600000;

  @Transform(({ value }) => Number(value ?? 800))
  @IsInt()
  @Min(200)
  @Max(5000)
  @IsOptional()
  VOICE_DTMF_INTER_DIGIT_TIMEOUT_MS = 800;

  @Transform(({ value }) => Number(value ?? 1200))
  @IsInt()
  @Min(100)
  @Max(5000)
  @IsOptional()
  VOICE_LANGUAGE_DETECTION_TIMEOUT_MS = 1200;

  @IsString()
  @IsOptional()
  QUEUE_PREFIX?: string;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  KNOWLEDGE_INGESTION_QUEUE_CONCURRENCY = 2;

  @Transform(({ value }) => Number(value ?? 32))
  @IsInt()
  @Min(1)
  @Max(256)
  @IsOptional()
  KNOWLEDGE_EMBEDDING_BATCH_SIZE = 32;

  @Transform(({ value }) => Number(value ?? 4))
  @IsInt()
  @Min(1)
  @Max(32)
  @IsOptional()
  KNOWLEDGE_EMBEDDING_CONCURRENCY = 4;

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
  APPOINTMENT_OPERATIONS_ALERT_WEBHOOK_URL?: string;

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
  TWILIO_API_KEY_SID?: string;

  @IsString()
  @IsOptional()
  TWILIO_API_KEY_SECRET?: string;

  @IsString()
  @IsOptional()
  TWILIO_TWIML_APP_SID?: string;

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

  @Transform(({ value }) => Number(value ?? 12))
  @IsInt()
  @Min(2)
  @Max(52)
  @IsOptional()
  APPOINTMENT_PUBLIC_MAX_RECURRENCE_COUNT = 12;

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

  @Transform(({ value }) => Number(value ?? 25000000))
  @IsInt()
  @Min(1000)
  @Max(50000000)
  @IsOptional()
  KNOWLEDGE_MAX_EXTRACTED_CHARACTERS = 25000000;

  @IsIn(['disabled', 'fallback', 'always'])
  @IsOptional()
  KNOWLEDGE_OCR_MODE: 'disabled' | 'fallback' | 'always' = 'fallback';

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_API_KEY?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_PRIMARY_PROVIDER?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_PRIMARY_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_PRIMARY_API_KEY?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_FALLBACK_PROVIDER?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_FALLBACK_ENDPOINT?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_FALLBACK_API_KEY?: string;

  @IsString()
  @IsOptional()
  KNOWLEDGE_OCR_ALLOWED_HOSTS?: string;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  KNOWLEDGE_OCR_ALLOW_PRIVATE_NETWORKS = false;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(1000)
  @Max(300000)
  @IsOptional()
  KNOWLEDGE_OCR_TIMEOUT_MS = 60000;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(0)
  @Max(5)
  @IsOptional()
  KNOWLEDGE_OCR_MAX_RETRIES = 2;

  @Transform(({ value }) => Number(value ?? 0.75))
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  KNOWLEDGE_OCR_MIN_CONFIDENCE = 0.75;

  @Transform(({ value }) => Number(value ?? 4))
  @IsInt()
  @Min(1)
  @Max(32)
  @IsOptional()
  KNOWLEDGE_OCR_PAGE_CONCURRENCY = 4;

  @Transform(({ value }) => Number(value ?? 1800))
  @IsInt()
  @Min(800)
  @Max(4000)
  @IsOptional()
  KNOWLEDGE_OCR_RENDER_WIDTH = 1800;

  @Transform(({ value }) => Number(value ?? 5000))
  @IsInt()
  @Min(1)
  @Max(20000)
  @IsOptional()
  KNOWLEDGE_PDF_MAX_PAGES = 5000;

  @Transform(({ value }) => Number(value ?? 104857600))
  @IsInt()
  @Min(1048576)
  @Max(2147483648)
  @IsOptional()
  KNOWLEDGE_PDF_MAX_BYTES = 104857600;

  @Transform(({ value }) => Number(value ?? 500))
  @IsInt()
  @Min(1)
  @Max(20000)
  @IsOptional()
  KNOWLEDGE_OCR_MAX_PAGES_PER_DOCUMENT = 500;

  @Transform(({ value }) => Number(value ?? 0.25))
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  KNOWLEDGE_OCR_MAX_EMPTY_PAGE_RATIO = 0.25;

  @Transform(({ value }) => Number(value ?? 40))
  @IsInt()
  @Min(0)
  @Max(1000)
  @IsOptional()
  KNOWLEDGE_PDF_NATIVE_TEXT_MIN_CHARACTERS_PER_PAGE = 40;

  @Transform(({ value }) => Number(value ?? 0.5))
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  KNOWLEDGE_PDF_NATIVE_TEXT_MIN_ALPHANUMERIC_RATIO = 0.5;

  @Transform(({ value }) => Number(value ?? 90))
  @IsInt()
  @Min(1)
  @Max(3650)
  @IsOptional()
  KNOWLEDGE_OCR_CACHE_RETENTION_DAYS = 90;

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
  MALWARE_SCAN_REQUIRED = true;

  @Transform(({ value }) => Number(value ?? 15000))
  @IsInt()
  @Min(1000)
  @Max(120000)
  @IsOptional()
  MALWARE_SCAN_TIMEOUT_MS = 15000;

  @IsString()
  @IsOptional()
  DEFAULT_CHAT_MODEL?: string;

  @IsString()
  @IsOptional()
  AI_TRANSCRIPTION_MODEL = 'whisper-1';

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

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  CUSTOMER_CHAT_MAX_CHUNKS_PER_DOCUMENT = 2;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  CUSTOMER_CHAT_AUTO_HANDOFF_ON_FAILURE = true;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  VOICE_WEBHOOK_SIGNATURE_REQUIRED = true;

  @IsString()
  @IsOptional()
  VOICE_WEBHOOK_PUBLIC_BASE_URL?: string;

  @IsString()
  @IsOptional()
  VOICE_CONVERSATION_RELAY_PUBLIC_BASE_URL?: string;

  @Transform(({ value }) => Number(value ?? 5000))
  @IsInt()
  @Min(1000)
  @Max(30000)
  @IsOptional()
  VOICE_PROVIDER_TIMEOUT_MS = 5000;

  @Transform(({ value }) => Number(value ?? 8000))
  @IsInt()
  @Min(1000)
  @Max(30000)
  @IsOptional()
  VOICE_AI_TIMEOUT_MS = 8000;

  @Transform(({ value }) => Number(value ?? 1800))
  @IsInt()
  @Min(60)
  @Max(14400)
  @IsOptional()
  VOICE_MAX_CALL_DURATION_SECONDS = 1800;

  @Transform(({ value }) => Number(value ?? 250))
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  VOICE_SSE_MAX_CONNECTIONS = 250;

  @Transform(({ value }) => Number(value ?? 3600))
  @IsInt()
  @Min(300)
  @Max(86400)
  @IsOptional()
  VOICE_AGENT_TOKEN_TTL_SECONDS = 3600;

  @Transform(({ value }) => Number(value ?? 90))
  @IsInt()
  @Min(30)
  @Max(600)
  @IsOptional()
  VOICE_AGENT_PRESENCE_TTL_SECONDS = 90;

  @IsString()
  @IsOptional()
  WHATSAPP_OUTBOUND_MODE?: 'mock' | 'live';

  @Transform(({ value }) => Number(value ?? 10000))
  @IsInt()
  @Min(1000)
  @Max(120000)
  @IsOptional()
  WHATSAPP_PROVIDER_TIMEOUT_MS = 10000;

  @Transform(({ value }) => Number(value ?? 2))
  @IsInt()
  @Min(0)
  @Max(5)
  @IsOptional()
  WHATSAPP_PROVIDER_MAX_RETRIES = 2;

  @IsString()
  @IsOptional()
  WHATSAPP_GRAPH_API_VERSION = 'v20.0';

  @IsString()
  @IsOptional()
  WHATSAPP_WEBHOOK_PUBLIC_BASE_URL?: string;

  @Transform(({ value }) => Number(value ?? 26214400))
  @IsInt()
  @Min(1024)
  @Max(104857600)
  @IsOptional()
  WHATSAPP_MEDIA_MAX_BYTES = 26214400;

  @Transform(({ value }) => Number(value ?? 60))
  @IsInt()
  @Min(1)
  @Max(3600)
  @IsOptional()
  WHATSAPP_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60;

  @Transform(({ value }) => Number(value ?? 300))
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  WHATSAPP_WEBHOOK_MAX_REQUESTS_PER_WINDOW = 300;

  @Transform(({ value }) => Number(value ?? 60))
  @IsInt()
  @Min(1)
  @Max(3600)
  @IsOptional()
  WHATSAPP_AGENT_RATE_LIMIT_WINDOW_SECONDS = 60;

  @Transform(({ value }) => Number(value ?? 30))
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  WHATSAPP_AGENT_MAX_SENDS_PER_WINDOW = 30;

  @Transform(({ value }) => Number(value ?? 1000))
  @IsInt()
  @Min(1)
  @Max(1000000)
  @IsOptional()
  WHATSAPP_ORG_MAX_SENDS_PER_WINDOW = 1000;

  @Transform(({ value }) => Number(value ?? 3600))
  @IsInt()
  @Min(1)
  @Max(86400)
  @IsOptional()
  WHATSAPP_AUTOMATED_RATE_LIMIT_WINDOW_SECONDS = 3600;

  @Transform(({ value }) => Number(value ?? 1000))
  @IsInt()
  @Min(1)
  @Max(1000000)
  @IsOptional()
  WHATSAPP_AUTOMATED_MAX_SENDS_PER_WINDOW = 1000;

  @Transform(({ value }) => Number(value ?? 5))
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  WHATSAPP_INBOUND_QUEUE_CONCURRENCY = 5;

  @Transform(({ value }) => Number(value ?? 60000))
  @IsInt()
  @Min(1000)
  @Max(300000)
  @IsOptional()
  WHATSAPP_CONVERSATION_LOCK_WAIT_MS = 60000;

  @Transform(({ value }) => Number(value ?? 180000))
  @IsInt()
  @Min(10000)
  @Max(900000)
  @IsOptional()
  WHATSAPP_CONVERSATION_LEASE_MS = 180000;

  @Transform(({ value }) => Number(value ?? 0.35))
  @Min(0)
  @Max(1)
  @IsOptional()
  WHATSAPP_MIN_SIMILARITY_SCORE = 0.35;

  @Transform(({ value }) => Number(value ?? 0.05))
  @Min(0)
  @Max(1)
  @IsOptional()
  WHATSAPP_LEXICAL_RESCUE_MARGIN = 0.05;

  @Transform(
    ({ value }) => value === undefined || value === 'true' || value === true,
  )
  @IsBoolean()
  @IsOptional()
  WHATSAPP_AUTO_HANDOFF_ON_FAILURE = true;

  @IsString()
  @IsOptional()
  WHATSAPP_PROCESSING_FAILURE_MESSAGE?: string;

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
