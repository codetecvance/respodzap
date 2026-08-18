-- 011_add_tenant_mp_user_id.sql
-- ID do usuário Mercado Pago

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mp_user_id TEXT;
