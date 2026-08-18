-- 008_add_orders_observations.sql
-- Observações do pedido

ALTER TABLE orders ADD COLUMN IF NOT EXISTS observations TEXT;
