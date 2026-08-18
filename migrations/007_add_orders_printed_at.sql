-- 007_add_orders_printed_at.sql
-- Controle de impressão do pedido

ALTER TABLE orders ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
