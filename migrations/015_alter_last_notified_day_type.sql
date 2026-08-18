-- 015_alter_last_notified_day_type.sql
-- Correção: last_notified_day guarda marcas de texto (ex: "aviso:3:2026-08-17")

ALTER TABLE subscriptions ALTER COLUMN last_notified_day TYPE TEXT USING last_notified_day::text;
