-- 013_add_subscription_product_limit.sql
-- Limite de produtos por assinatura (Starter=20, Pro=30)

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS product_limit INTEGER;
