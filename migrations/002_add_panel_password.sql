-- 002_add_panel_password.sql
-- Login do painel cliente por WhatsApp+senha

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS panel_password TEXT;
