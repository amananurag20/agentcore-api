CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_one_time_tokens" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_one_time_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");
CREATE INDEX "auth_sessions_organization_id_idx" ON "auth_sessions"("organization_id");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

CREATE UNIQUE INDEX "auth_one_time_tokens_token_hash_key" ON "auth_one_time_tokens"("token_hash");
CREATE INDEX "auth_one_time_tokens_organization_id_type_idx" ON "auth_one_time_tokens"("organization_id", "type");
CREATE INDEX "auth_one_time_tokens_user_id_type_idx" ON "auth_one_time_tokens"("user_id", "type");
CREATE INDEX "auth_one_time_tokens_email_type_idx" ON "auth_one_time_tokens"("email", "type");
CREATE INDEX "auth_one_time_tokens_expires_at_idx" ON "auth_one_time_tokens"("expires_at");

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_one_time_tokens" ADD CONSTRAINT "auth_one_time_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_one_time_tokens" ADD CONSTRAINT "auth_one_time_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
