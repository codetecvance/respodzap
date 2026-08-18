-- 014_add_plan_product_limit.sql
-- Limite de produtos no plano

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS product_limit INTEGER;
