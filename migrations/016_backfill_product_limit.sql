-- 016_backfill_product_limit.sql
-- Backfill: clientes existentes recebem PRO (30 produtos)

UPDATE subscriptions SET product_limit = 30 WHERE product_limit IS NULL;
