# AgentCore Production Integrations Checklist

This document lists what we need from management/cloud owners to move the current MVP modules from mock/provider-placeholder mode to production-live integrations.

## Current MVP Status

Implemented in the codebase:

- Auth, organizations, users, product entitlements, audit logs, health checks.
- Prisma + Postgres schema with pgvector for knowledge/RAG.
- S3/R2/MinIO-compatible storage abstraction for knowledge uploads.
- Redis/BullMQ queues for ingestion, appointment reminders, and calendar event synchronization.
- Customer Chat backend with RAG, conversation history, handoff, public widget APIs, and rate limits.
- Appointment Booking with DST-safe IANA timezones, staff schedules/time off, shared resource capacity, conflict-safe booking, secure customer self-service, durable reminders, Google/Outlook OAuth sync, public rate limits, structured voice/WhatsApp/chat actions, and tests.
- WhatsApp Assistant backend/frontend MVP with config, inbound webhook, conversations, RAG reply, handoff, transcript/history, and mock outbound send.
- Voice Receptionist turn-based Twilio flow with signed callbacks, transcript history, RAG reply, handoff, transfer fallback, voicemail capture, and lifecycle tracking.
- Live outbound adapter switches for WhatsApp and Voice, disabled by default until provider credentials are configured.
- Observability summary endpoint for module-level operational counts and process memory/uptime.

Provider integrations still pending:

- Real WhatsApp outbound delivery via Meta/Twilio.
- Real WhatsApp webhook signature verification and media download.
- Real Voice telephony streaming/control via Twilio/SIP.
- Real STT/TTS providers for audio transcription/playback.
- Stripe/Razorpay payments if deposits are required.

## Required Access From Manager

Ask for these first:

```text
We need production/staging access for:
1. Postgres URL with pgvector support.
2. Redis URL, preferably managed Redis/ElastiCache/Upstash for queues and rate limits.
3. S3-compatible object storage credentials: bucket, region, endpoint if R2/MinIO, access key id, secret access key, and path-style setting.
4. OpenAI API key or approved model provider key for embeddings/chat testing.
5. WhatsApp provider access: Meta WhatsApp Cloud API or Twilio WhatsApp credentials, phone number id, business account id, app secret, webhook verify token.
6. Voice provider access: Twilio Voice or SIP provider credentials, phone number/SIP domain, webhook signing secret, transfer target numbers.
7. Reminder provider access: email/SMS/WhatsApp provider credentials.
8. Calendar provider access if needed: Google OAuth app or Microsoft Azure app credentials.
9. Payment provider access if needed: Stripe/Razorpay test keys and webhook secret.
```

## Core Infrastructure Env

Environment variables are reserved for secrets, infrastructure addresses,
public deployment URLs, network policy, and global integration switches.
Stable auth and AI/knowledge behavior defaults live in
`src/config/application-defaults.ts`; other bounded operational defaults remain
validated in `src/config/env.validation.ts`.
Workspace settings configured in the frontend live in Postgres; they must not
also be configured through environment variables.

Required for all modules:

| Env key                    | Needed for         | Notes                                                                                    |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `PORT`                     | API runtime        | Default `5000`.                                                                          |
| `DATABASE_URL`             | Postgres/Prisma    | Must support pgvector extension for RAG.                                                 |
| `JWT_ACCESS_SECRET`        | Auth               | Strong random secret, at least 32 chars.                                                 |
| `AI_CONFIG_ENCRYPTION_KEY` | Secret encryption  | Used to encrypt provider API keys/tokens in DB. Strong random secret, at least 32 chars. |
| `REDIS_URL`                | Queues/rate limits | Required for BullMQ workers and distributed rate limiting.                               |

## Workspace AI/RAG Configuration

Provider API keys, base URLs, chat/embedding/STT/TTS models and provider-specific
settings are stored through the AI provider APIs and encrypted using
`AI_CONFIG_ENCRYPTION_KEY`. The fixed pgvector index dimension and fallback
model names are application constants, not deployment configuration.

`AI_PROVIDER_ALLOWED_HOSTS` and `AI_PROVIDER_ALLOW_PRIVATE_NETWORKS` remain
environment variables because they are deployment-wide SSRF/network policy.

## Storage Env

| Env key                   | Needed for            | Notes                                               |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `S3_STORAGE_PROVIDER`     | Knowledge file upload | `s3`, `r2`, or `minio`.                             |
| `S3_REGION`               | Object storage        | Example `us-east-1`.                                |
| `S3_BUCKET`               | Object storage        | Bucket for knowledge/media uploads.                 |
| `S3_ENDPOINT`             | R2/MinIO/custom S3    | Empty for standard AWS S3.                          |
| `S3_FORCE_PATH_STYLE`     | R2/MinIO/custom S3    | Often `true` for MinIO, usually `false` for AWS S3. |
| `S3_ACCESS_KEY_ID`        | Object storage        | IAM/access key.                                     |
| `S3_SECRET_ACCESS_KEY`    | Object storage        | Secret key.                                         |

## Customer Chat Advanced Overrides

These bounded defaults are intentionally absent from `.env.example`. Override
them only for a measured operational need; they are not normal deployment
requirements.

| Env key                                                | Needed for                         | Notes                   |
| ------------------------------------------------------ | ---------------------------------- | ----------------------- |
| `PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS`                | Public widget rate limiting        | Current default `60`.   |
| `PUBLIC_CHAT_MAX_CONFIG_FETCHES_PER_WINDOW`            | Public widget config fetch limit   | Current default `120`.  |
| `PUBLIC_CHAT_MAX_CONVERSATIONS_PER_WINDOW`             | Public conversation creation limit | Current default `10`.   |
| `PUBLIC_CHAT_MAX_MESSAGES_PER_WINDOW`                  | Public message rate limit          | Current default `20`.   |
| `PUBLIC_CHAT_MAX_MESSAGES_PER_CONVERSATION_PER_WINDOW` | Per conversation limit             | Current default `10`.   |
| `PUBLIC_CHAT_MAX_MESSAGE_LENGTH`                       | Message validation                 | Current default `2000`. |
| `AI_CHAT_MAX_INPUT_TOKENS`                             | Total RAG prompt budget             | Includes instructions, history, knowledge, and the customer question. |
| `AI_RAG_CONTEXT_MAX_TOKENS`                            | Knowledge context budget            | Lowest-scoring chunks are removed first when the prompt is full. |
| `AI_CHAT_HISTORY_MAX_TOKENS`                           | Conversation memory budget          | Retains the newest messages that fit. |
| `CUSTOMER_CHAT_MAX_CHUNKS_PER_DOCUMENT`                | Retrieval diversity                 | Default `2`; prevents one document from filling every context slot. |

Public widget visitors intentionally use clearance level `0`. Only knowledge
chunks with `sensitivityLevel = 0` and `customer_chat` product visibility are
eligible for retrieval. Higher-sensitivity chunks remain available to suitably
authorized internal users, but are never exposed through the public widget.
Internal assistant-message metadata includes `effectiveClearance`,
`clearanceFilteredCount`, and `clearanceBlockedAll` for diagnosing an empty
public retrieval result without leaking those details to the visitor.

## Appointment Booking Configuration

Reminder offsets and booking policy are stored per workspace/service in
Postgres. Worker retry/concurrency/rate-limit values are application defaults.
Only provider credentials, verified sender identities, OAuth callback URLs and
public deployment URLs remain environment variables.

| Env key                                        | Needed for                        | Notes                                                                           |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `SMTP_HOST`                                    | Email reminders                   | SMTP server hostname.                                                           |
| `SMTP_PORT`                                    | Email reminders                   | Usually `587` for STARTTLS or `465` for implicit TLS.                            |
| `SMTP_SECURE`                                  | Email reminders                   | `true` for implicit TLS (normally port `465`); otherwise `false`.                |
| `SMTP_USER`                                    | Email reminders                   | SMTP login; may be omitted with a trusted internal relay.                        |
| `SMTP_PASSWORD`                                | Email reminders                   | SMTP password or provider-generated SMTP credential.                             |
| `APPOINTMENT_EMAIL_FROM`                       | Email reminders                   | Verified sender address.                                                        |
| `TWILIO_ACCOUNT_SID`                           | SMS reminders/Twilio integrations | Twilio account SID.                                                             |
| `TWILIO_AUTH_TOKEN`                            | SMS reminders                     | Twilio auth token.                                                              |
| `TWILIO_SMS_FROM`                              | SMS reminders                     | E.164 sender number.                                                            |
| `GOOGLE_CALENDAR_CLIENT_ID`                    | Google Calendar OAuth             | OAuth web client ID.                                                            |
| `GOOGLE_CALENDAR_CLIENT_SECRET`                | Google Calendar OAuth             | OAuth client secret.                                                            |
| `GOOGLE_CALENDAR_REDIRECT_URI`                 | Google Calendar OAuth             | Must exactly match the provider callback registration.                          |
| `MICROSOFT_CALENDAR_CLIENT_ID`                 | Microsoft Outlook OAuth           | Microsoft Entra application client ID.                                          |
| `MICROSOFT_CALENDAR_CLIENT_SECRET`             | Microsoft Outlook OAuth           | Microsoft Entra client secret.                                                  |
| `MICROSOFT_CALENDAR_REDIRECT_URI`              | Microsoft Outlook OAuth           | Must exactly match the provider callback registration.                          |
| `APPOINTMENT_CALENDAR_OAUTH_SUCCESS_URL`       | Calendar OAuth UI return          | Frontend appointment URL after authorization.                                   |

Provider configuration notes:

- Email uses Nodemailer with the deployment SMTP service; SMS uses Twilio; WhatsApp uses the organization's encrypted Meta/Twilio configuration.
- If a channel is enabled without usable customer contact details or credentials, the durable reminder record is marked `skipped` rather than falsely marked sent.
- Run `npm run start:worker` alongside the API whenever reminders or calendar sync are enabled.

Calendar provider setup is operational configuration, not remaining application
code. Register the exact callback URLs, enable Google Calendar API or Microsoft
Graph delegated `User.Read`/`Calendars.ReadWrite`, and configure the credentials
above. Stripe/Razorpay keys and webhook secrets remain future work if payments
are enabled.

## WhatsApp Assistant Provider Data

Stored per organization through `/api/v1/whatsapp-assistant/configs`, not as plain env:

| Config field         | Needed for                     | Notes                                     |
| -------------------- | ------------------------------ | ----------------------------------------- |
| `provider`           | Provider selection             | `meta`, `twilio`, or `custom`.            |
| `phoneNumberId`      | Meta WhatsApp Cloud            | Required for Meta send API.               |
| `businessAccountId`  | Meta WhatsApp Cloud            | Required for account/template operations. |
| `accessToken`        | Provider API calls             | Encrypted in DB.                          |
| `webhookVerifyToken` | Webhook verification           | Encrypted in DB.                          |
| `appSecret`          | Webhook signature verification | Encrypted in DB.                          |
| `defaultLocale`      | Multilingual flows             | Example `en`.                             |

Production work remaining:

- Implement real outbound `sendText` using Meta/Twilio.
- Verify provider webhook signatures.
- Download inbound media and store it using the storage service.
- Add template message management if outbound notifications need approved templates.

## Voice Receptionist Provider Data

Stored per organization through `/api/v1/voice-receptionist/configs`, not as plain env:

| Config field              | Needed for                  | Notes                                                                |
| ------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `provider`                | Provider selection          | `twilio`, `sip`, or `custom`.                                        |
| `phoneNumber`             | PSTN calls                  | Twilio or provider-owned number.                                     |
| `sipDomain`               | SIP calls                   | Required for SIP-based routing.                                      |
| `apiKey`                  | Provider API/signing secret | Encrypted in DB. For Twilio, use the Auth Token.                     |
| `webhookVerifyToken`      | Webhook setup verification  | Encrypted in DB.                                                     |
| `sttProvider`             | Speech to text              | Example `openai`, `deepgram`, `assemblyai`.                          |
| `sttModel`                | Speech to text model        | Provider-specific.                                                   |
| `ttsProvider`             | Text to speech              | Example `openai`, `elevenlabs`, `polly`.                             |
| `ttsVoice`                | Voice selection             | Provider-specific.                                                   |
| `transferPhoneNumber`     | Human transfer              | Default human fallback number.                                       |
| `voicemailEnabled`        | Voicemail fallback          | Boolean.                                                             |
| `settings.businessHours`  | Business-hours logic        | Supports IANA timezone, days, times, overnight ranges, and holidays. |
| `settings.greeting`       | Initial caller greeting     | Played immediately before the first speech/DTMF gather.              |
| `settings.dtmfRoutes`     | IVR routing                 | Maps digits to E.164 transfer targets.                               |
| `settings.*Notification*` | Handoff/voicemail alerts    | Optional email and E.164 SMS destinations.                           |

Voice env:

| Env key                            | Needed for                   | Notes                                                                       |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `VOICE_WEBHOOK_SIGNATURE_REQUIRED` | Webhook security             | Defaults to `true`; signed callbacks fail closed.                           |
| `VOICE_WEBHOOK_PUBLIC_BASE_URL`    | Twilio callback URLs         | Public HTTPS API origin used for signatures and generated callback URLs.    |
| `WHATSAPP_OUTBOUND_MODE`           | WhatsApp outbound delivery   | `mock` by default. Set `live` after Meta/Twilio credentials are configured. |
| `VOICE_OUTBOUND_MODE`              | Voice provider call control  | `mock` by default. Set `live` after Twilio/SIP credentials are configured.  |
| `TWILIO_ACCOUNT_SID`               | Twilio Voice fallback config | Optional global fallback. Prefer per-org config/settings where possible.    |

Twilio endpoints under `/api/v1/voice-receptionist/webhook/:configId/twilio`
provide incoming-call, gather, status, dial-result, and recording/transcription
callbacks. Configure the Twilio number's voice URL to `/incoming` and status
callback to `/status`; generated TwiML wires the other callbacks automatically.

Production work remaining:

- Add a bidirectional Media Streams or ConversationRelay WebSocket transport for streaming STT/TTS and true audio-level barge-in.
- Implement native SIP call control and provider callbacks.
- Optionally copy Twilio-hosted recordings into organization-owned object storage when independent retention is required.

## Deployment Notes

Recommended production deployment:

- API service: NestJS app.
- Worker service: `npm run start:worker`.
- Database: managed Postgres with pgvector enabled.
- Redis: managed Redis/ElastiCache/Upstash, not local Docker for production.
- Storage: AWS S3 or Cloudflare R2.
- Frontend: Next.js app deployed separately with `NEXT_PUBLIC_API_BASE_URL`.

Keep the mock provider adapters enabled for local development and staging until the provider credentials are available.
