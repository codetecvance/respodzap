-- 004_add_tenant_segment_id.sql
-- Segmento de negócio por tenant (vendas/restaurante/delivery/padaria/estetica)

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS segment_id INTEGER REFERENCES segments(id);
