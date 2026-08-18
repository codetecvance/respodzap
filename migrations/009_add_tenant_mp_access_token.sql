-- 009_add_tenant_mp_access_token.sql
-- Mercado Pago OAuth por tenant

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_access_token TEXT;
