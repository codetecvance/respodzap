-- 003_add_subscription_period_days.sql
-- Período configurável da assinatura

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS period_days INTEGER;
