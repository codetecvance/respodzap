const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 10000,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id              SERIAL PRIMARY KEY,
      name            TEXT NOT NULL,
      contact_name    TEXT,
      contact_phone   TEXT,
      phone_number_id TEXT,
      access_token    TEXT,
      waba_id         TEXT,
      notify_phone    TEXT,
      notify_email    TEXT,
      status          TEXT NOT NULL DEFAULT 'ativo',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS subscription_plans (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      price       NUMERIC NOT NULL DEFAULT 299,
      period_days INTEGER NOT NULL DEFAULT 30,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id                SERIAL PRIMARY KEY,
      tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_id           INTEGER REFERENCES subscription_plans(id),
      price             NUMERIC NOT NULL DEFAULT 299,
      status            TEXT NOT NULL DEFAULT 'ativa',
      expires_at        TIMESTAMPTZ,
      last_notified_day INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS tenant_catalogs (
      tenant_id    INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      catalog_json JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone            TEXT NOT NULL,
      full_name        TEXT,
      email            TEXT,
      delivery_address TEXT,
      status           TEXT NOT NULL DEFAULT 'novo',
      flow_state       TEXT NOT NULL DEFAULT 'MENU',
      cart_data        TEXT,
      last_number_id   TEXT,
      survey_data      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ,
      UNIQUE (tenant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      message      TEXT,
      message_type TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      external_id  TEXT NOT NULL,
      lead_id      INTEGER NOT NULL REFERENCES leads(id),
      status       TEXT NOT NULL DEFAULT 'pending',
      subtotal     NUMERIC NOT NULL DEFAULT 0,
      delivery_fee NUMERIC NOT NULL DEFAULT 0,
      discount     NUMERIC NOT NULL DEFAULT 0,
      total        NUMERIC NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ,
      UNIQUE (tenant_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id    TEXT NOT NULL,
      product_name  TEXT NOT NULL,
      unit_price    NUMERIC NOT NULL,
      quantity      INTEGER NOT NULL DEFAULT 1,
      total_price   NUMERIC NOT NULL,
      product_image TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      order_id        INTEGER NOT NULL REFERENCES orders(id),
      mp_payment_id   TEXT,
      mp_preference_id TEXT,
      payment_method  TEXT NOT NULL DEFAULT 'pix',
      status          TEXT NOT NULL DEFAULT 'pending',
      total           NUMERIC,
      pix_qr_base64   TEXT,
      pix_copy_paste  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      product_id   TEXT NOT NULL,
      product_name TEXT NOT NULL,
      unit_price   NUMERIC NOT NULL,
      quantity     INTEGER NOT NULL DEFAULT 1,
      total_price  NUMERIC NOT NULL DEFAULT 0,
      image        TEXT,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tenant_images (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tenant_images_tenant ON tenant_images (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads (tenant_id, phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations (lead_id);
    CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_cart_lead ON cart_items (lead_id);
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
  `);

  // Migrações leves (rodam a cada inicialização)
  await query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS panel_password TEXT`);
}

module.exports = { pool, query, initDb };