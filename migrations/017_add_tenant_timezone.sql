-- 017_add_tenant_timezone.sql
-- Adicionar campo timezone à tabela tenants

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Sao_Paulo';

-- Backfill: tenants existentes recebem timezone padrão
UPDATE tenants SET timezone = 'America/Sao_Paulo' WHERE timezone IS NULL;