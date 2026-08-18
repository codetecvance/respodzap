-- 006_add_order_items_addons.sql
-- Adicionais preservados nos itens do pedido

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS addons JSONB;
