-- 005_add_cart_addons.sql
-- Adicionais (toppings/extras) no carrinho

ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS addons JSONB;
