/**
 * Versioned application behavior that is the same in every deployment.
 *
 * Secrets, infrastructure addresses and public deployment URLs must not be
 * added here. Tenant/workspace settings belong in Postgres and are managed by
 * the corresponding settings APIs.
 */
export const APPLICATION_DEFAULTS = {
  server: {
    port: 5_000,
  },
  auth: {
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresDays: 30,
    inviteTokenExpiresHours: 72,
    passwordResetTokenExpiresMinutes: 30,
  },
  ai: {
    chatModel: 'gpt-4.1-mini',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1_536,
    transcriptionModel: 'whisper-1',
    providerTimeoutMs: 15_000,
    providerMaxRetries: 2,
    providerMaxOutputTokens: 1_024,
    chatMaxInputTokens: 12_000,
    ragContextMaxTokens: 6_000,
    chatHistoryMaxTokens: 2_000,
    providerTestRateLimit: 10,
    providerTestRateWindowSeconds: 60,
  },
  knowledge: {
    ocrMode: 'fallback' as const,
    nativeTextMinCharactersPerPage: 40,
    nativeTextMinAlphanumericRatio: 0.5,
    ocrMinConfidence: 0.75,
    ocrTimeoutMs: 60_000,
    ocrMaxRetries: 2,
    ocrPageConcurrency: 4,
    ocrRenderWidth: 1_800,
    maxPdfPages: 5_000,
    maxPdfBytes: 100 * 1_024 * 1_024,
    maxOcrPagesPerDocument: 500,
    maxEmptyOcrPageRatio: 0.25,
    maxExtractedCharacters: 25_000_000,
    embeddingConcurrency: 4,
    awsRegion: 'us-east-1',
  },
  appointments: {
    reminderOffsetsMinutes: [1_440, 60] as readonly number[],
  },
  email: {
    smtpPort: 587,
    smtpSecure: false,
  },
} as const;
