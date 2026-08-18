-- 010_add_tenant_mp_refresh_token.sql
-- Refresh token do Mercado Pago

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT;
