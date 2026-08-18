-- 012_add_tenant_mp_token_expires_at.sql
-- Expiração do token MP

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_token_expires_at TIMESTAMPTZ;
