const { query } = require('./db');
const { v4: _uuidv4 } = require('uuid');

// ============================================================
//  UTILITÁRIOS
// ============================================================
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

const crypto = require('crypto');

/**
 * Gera hash scrypt + salt para senha.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifica senha contra o hash armazenado.
 */
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function _today() {
  return new Date().toISOString();
}

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

// ============================================================
//  IMAGENS DO TENANT (registro no banco — fonte da verdade)
// ============================================================
async function addTenantImage(tenantId, url) {
  const name = String(url).split('/').pop().split('?')[0];
  await query(
    `INSERT INTO tenant_images (tenant_id, url, name) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, url, name],
  );
}

async function listTenantImagesDb(tenantId) {
  const r = await query(
    'SELECT url, name FROM tenant_images WHERE tenant_id = $1 ORDER BY id DESC',
    [tenantId],
  );
  return r.rows;
}

async function deleteTenantImageDb(tenantId, url) {
  await query('DELETE FROM tenant_images WHERE tenant_id = $1 AND url = $2', [tenantId, url]);
}

// ============================================================
//  SEGMENTOS (ramos de negócio)
// ============================================================
async function createSegment(name, emoji, template) {
  const r = await query(
    'INSERT INTO segments (name, emoji, template_json) VALUES ($1,$2,$3) RETURNING *',
    [name, emoji, JSON.stringify(template)],
  );
  return r.rows[0];
}

async function getSegments() {
  const r = await query('SELECT * FROM segments ORDER BY id');
  return r.rows.map(s => ({ ...s, template_json: s.template_json }));
}

async function getSegment(id) {
  const r = await query('SELECT * FROM segments WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function updateSegment(id, name, emoji, template) {
  const sets = [];
  const params = [id];
  if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
  if (emoji !== undefined) { params.push(emoji); sets.push(`emoji = $${params.length}`); }
  if (template !== undefined) { params.push(JSON.stringify(template)); sets.push(`template_json = $${params.length}`); }
  if (!sets.length) return;
  await query(`UPDATE segments SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function deleteSegment(id) {
  await query('DELETE FROM segments WHERE id = $1', [id]);
}

async function countTenantsBySegment(segmentId) {
  const r = await query('SELECT COUNT(*) AS c FROM tenants WHERE segment_id = $1', [segmentId]);
  return Number(r.rows[0].c);
}

async function getTenantSegment(tenantId) {
  const r = await query(
    'SELECT s.id, s.name, s.emoji FROM tenants t JOIN segments s ON s.id = t.segment_id WHERE t.id = $1',
    [tenantId],
  );
  return r.rows[0] || null;
}

/**
 * Garante os segmentos base com seus templates.
 * Idempotente — roda na inicialização.
 */
async function seedSegments() {
  const templates = [
    { name: 'vendas', emoji: '🛍️', tpl: () => require('./catalog-template.json') },
    { name: 'restaurante', emoji: '🍽️', tpl: () => require('./catalog-template-restaurante.json') },
    { name: 'delivery', emoji: '🛵', tpl: () => require('./catalog-template-delivery.json') },
    { name: 'padaria', emoji: '🥐', tpl: () => require('./catalog-template-padaria.json') },
    { name: 'estetica', emoji: '💆‍♀️', tpl: () => require('./catalog-template-estetica.json') },
    { name: 'baterias', emoji: '🔋', tpl: () => require('./catalog-template-baterias.json') },
  ];
  for (const t of templates) {
    const exists = await query('SELECT id FROM segments WHERE name = $1', [t.name]);
    if (exists.rows[0]) {
      await query('UPDATE segments SET template_json = $1 WHERE id = $2', [JSON.stringify(t.tpl()), exists.rows[0].id]);
      continue;
    }
    await createSegment(t.name, t.emoji, t.tpl());
    console.log('[SEED] segmento criado:', t.name);
  }
  // Backfill: tenants existentes sem ramo → segmento "vendas"
  const vendas = await query("SELECT id FROM segments WHERE name = 'vendas'");
  if (vendas.rows[0]) {
    await query('UPDATE tenants SET segment_id = $1 WHERE segment_id IS NULL', [vendas.rows[0].id]);
  }
}

// ============================================================
//  TENANTS (clientes)
// ============================================================
async function createTenant(data) {
  const r = await query(
    `INSERT INTO tenants (name, contact_name, contact_phone, phone_number_id, access_token, waba_id, notify_phone, notify_email, status, panel_password, segment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.name, data.contact_name || null, data.contact_phone || null, data.phone_number_id || null,
     data.access_token || null, data.waba_id || null, data.notify_phone || null, data.notify_email || null,
     data.status || 'ativo', data.panel_password || null, data.segment_id || null],
  );
  return r.rows[0];
}

async function getTenants() {
  const r = await query(
    'SELECT t.*, s.name AS segment_name, s.emoji AS segment_emoji FROM tenants t LEFT JOIN segments s ON s.id = t.segment_id ORDER BY t.id',
  );
  return r.rows;
}

async function getTenant(id) {
  const r = await query(
    'SELECT t.*, s.name AS segment_name, s.emoji AS segment_emoji FROM tenants t LEFT JOIN segments s ON s.id = t.segment_id WHERE t.id = $1',
    [id],
  );
  return r.rows[0] || null;
}

async function getTenantByNumberId(phoneNumberId) {
  const r = await query(
    'SELECT t.*, s.name AS segment_name, s.emoji AS segment_emoji FROM tenants t LEFT JOIN segments s ON s.id = t.segment_id WHERE t.phone_number_id = $1',
    [String(phoneNumberId)],
  );
  return r.rows[0] || null;
}

/**
 * Busca tenant pelo WhatsApp de login do painel (contact_phone normalizado,
 * aceitando com ou sem o DDI 55).
 */
async function getTenantByPanelLogin(phone) {
  const digits = normalizePhone(phone);
  const candidates = [digits];
  if (digits.length === 10 || digits.length === 11) candidates.unshift('55' + digits);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) candidates.push(digits.slice(2));
  for (const cand of candidates) {
    const r = await query('SELECT * FROM tenants WHERE contact_phone = $1', [cand]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

/**
 * Normaliza telefone brasileiro com DDI (55 + 10/11 dígitos).
 */
function normalizePhoneBr(phone) {
  const digits = normalizePhone(phone);
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

async function updateTenant(id, fields) {
  const allowed = ['name', 'contact_name', 'contact_phone', 'phone_number_id', 'access_token', 'waba_id', 'notify_phone', 'notify_email', 'status', 'panel_password', 'segment_id',
    'mp_access_token', 'mp_refresh_token', 'mp_user_id', 'mp_token_expires_at'];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!entries.length) return getTenant(id);
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
  const values = entries.map(([, v]) => v ?? null);
  await query(`UPDATE tenants SET ${sets}, updated_at = NOW() WHERE id = $${values.length + 1}`, [...values, id]);
  return getTenant(id);
}

async function deleteTenant(id) {
  // payments não têm CASCADE via orders — exclui primeiro
  await query(`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = $1)`, [id]);
  await query('DELETE FROM tenants WHERE id = $1', [id]);
}

// ============================================================
//  PLANOS DE ASSINATURA
// ============================================================
async function getPlans() {
  const r = await query('SELECT * FROM subscription_plans ORDER BY price');
  return r.rows.map(p => ({ ...p, price: num(p.price) }));
}

async function createPlan(name, price, periodDays) {
  const r = await query(
    'INSERT INTO subscription_plans (name, price, period_days) VALUES ($1,$2,$3) RETURNING *',
    [name, price, periodDays],
  );
  return r.rows[0];
}

async function deletePlan(id) {
  await query('DELETE FROM subscription_plans WHERE id = $1', [id]);
}

async function updatePlan(id, name, price, periodDays) {
  await query(
    'UPDATE subscription_plans SET name = $2, price = $3, period_days = $4 WHERE id = $1',
    [id, name, price, periodDays],
  );
}

async function countSubscriptionsByPlan(planId) {
  const r = await query('SELECT COUNT(*) AS c FROM subscriptions WHERE plan_id = $1', [planId]);
  return Number(r.rows[0].c);
}

// ============================================================
//  ASSINATURAS (licenças)
// ============================================================
async function getSubscriptions() {
  const r = await query(
    `SELECT s.*, t.name AS tenant_name, t.notify_phone, t.notify_email, p.name AS plan_name
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     ORDER BY s.expires_at`,
  );
  return r.rows.map(s => ({ ...s, price: num(s.price) }));
}

async function getSubscriptionsByTenant(tenantId) {
  const r = await query(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.tenant_id = $1 ORDER BY s.created_at DESC`,
    [tenantId],
  );
  return r.rows.map(s => ({ ...s, price: num(s.price) }));
}

async function getActiveSubscription(tenantId) {
  const r = await query(
    `SELECT * FROM subscriptions WHERE tenant_id = $1 AND status = 'ativa' ORDER BY expires_at DESC NULLS LAST LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ? { ...r.rows[0], price: num(r.rows[0].price) } : null;
}

async function createSubscription(tenantId, planId, price, periodDays, productLimit = 30) {
  const r = await query(
    `INSERT INTO subscriptions (tenant_id, plan_id, price, period_days, status, expires_at, product_limit)
     VALUES ($1,$2,$3,$4,'ativa', NOW() + make_interval(days => $4), $5) RETURNING *`,
    [tenantId, planId, price, periodDays, productLimit],
  );
  return r.rows[0];
}

/**
 * Troca o limite de produtos da licença (Starter/Pro) sem mexer na validade.
 */
async function updateSubscriptionLimit(id, productLimit) {
  await query(`UPDATE subscriptions SET product_limit = $2, updated_at = NOW() WHERE id = $1`, [id, productLimit]);
}

async function renewSubscription(id, days) {
  const r = await query(
    `UPDATE subscriptions
     SET expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + ($2 || ' days')::interval,
         status = 'ativa', last_notified_day = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, days],
  );
  return r.rows[0];
}

async function renewSubscriptionMark(id, mark) {
  await query(`UPDATE subscriptions SET last_notified_day = $2, updated_at = NOW() WHERE id = $1`, [id, mark]);
}

async function cancelSubscription(id) {
  await query(`UPDATE subscriptions SET status = 'cancelada', updated_at = NOW() WHERE id = $1`, [id]);
}

async function deleteSubscription(id) {
  await query('DELETE FROM subscriptions WHERE id = $1', [id]);
}

async function getExpiringSubscriptions(days) {
  const r = await query(
    `SELECT s.*, t.name AS tenant_name, t.notify_phone, t.notify_email
     FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
     WHERE s.status = 'ativa' AND s.expires_at <= NOW() + ($1 || ' days')::interval
     ORDER BY s.expires_at`,
    [days],
  );
  return r.rows.map(s => ({ ...s, price: num(s.price) }));
}

// ============================================================
//  CATÁLOGOS POR TENANT
// ============================================================
async function getTenantCatalog(tenantId) {
  const r = await query('SELECT catalog_json FROM tenant_catalogs WHERE tenant_id = $1', [tenantId]);
  return r.rows[0] ? r.rows[0].catalog_json : null;
}

async function saveTenantCatalog(tenantId, catalog) {
  await query(
    `INSERT INTO tenant_catalogs (tenant_id, catalog_json, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET catalog_json = EXCLUDED.catalog_json, updated_at = NOW()`,
    [tenantId, JSON.stringify(catalog)],
  );
}

// ============================================================
//  LEADS
// ============================================================
async function getLead(id) {
  const r = await query('SELECT * FROM leads WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function getLeadByPhone(tenantId, phone) {
  const r = await query('SELECT * FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, normalizePhone(phone)]);
  return r.rows[0] || null;
}

async function getOrCreateLead(tenantId, phone) {
  const normalized = normalizePhone(phone);
  let r = await query('SELECT * FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, normalized]);
  if (!r.rows[0]) {
    r = await query('INSERT INTO leads (tenant_id, phone) VALUES ($1,$2) ON CONFLICT (tenant_id, phone) DO NOTHING RETURNING *', [tenantId, normalized]);
  }
  if (!r.rows[0]) {
    r = await query('SELECT * FROM leads WHERE tenant_id = $1 AND phone = $2', [tenantId, normalized]);
  }
  return r.rows[0];
}

async function updateLead(id, fields) {
  const allowed = ['full_name', 'email', 'delivery_address', 'status', 'flow_state', 'last_number_id'];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
  const values = entries.map(([, v]) => v ?? null);
  await query(`UPDATE leads SET ${sets}, updated_at = NOW() WHERE id = $${values.length + 1}`, [...values, id]);
}

async function setFlowState(leadId, state) {
  await query(`UPDATE leads SET flow_state = $2, updated_at = NOW() WHERE id = $1`, [leadId, state]);
}

async function updateLeadStatus(leadId, status) {
  await query(`UPDATE leads SET status = $2, updated_at = NOW() WHERE id = $1`, [leadId, status]);
}

async function listLeads(tenantId) {
  const r = await query(
    'SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return r.rows;
}

// ============================================================
//  QUESTIONÁRIOS
// ============================================================
async function getSurvey(leadId) {
  const r = await query('SELECT survey_data FROM leads WHERE id = $1', [leadId]);
  const raw = r.rows[0]?.survey_data;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setSurvey(leadId, data) {
  await query(`UPDATE leads SET survey_data = $2, updated_at = NOW() WHERE id = $1`, [leadId, data ? JSON.stringify(data) : null]);
}

// ============================================================
//  CONVERSAS
// ============================================================
async function addMessage(tenantId, phone, direction, message, type = null) {
  const lead = await getOrCreateLead(tenantId, phone);
  await query(
    'INSERT INTO conversations (tenant_id, lead_id, direction, message, message_type) VALUES ($1,$2,$3,$4,$5)',
    [tenantId, lead.id, direction, String(message || '').slice(0, 8000), type],
  );
}

async function getConversationsByLead(leadId, limit = 100) {
  const r = await query(
    'SELECT direction, message, created_at FROM conversations WHERE lead_id = $1 ORDER BY id DESC LIMIT $2',
    [leadId, limit],
  );
  return r.rows.reverse();
}

// ============================================================
//  CARRINHO
// ============================================================
/**
 * Soma os preços dos adicionais de um item.
 */
function addonsTotal(addons) {
  return (addons || []).reduce((s, g) => s + (g.opcoes || []).reduce((s2, o) => s2 + (Number(o.preco) || 0), 0), 0);
}

/**
 * Texto amigável dos adicionais: "Bacon, Cheddar".
 */
function formatAddons(addons) {
  const parts = [];
  for (const g of addons || []) {
    const nomes = (g.opcoes || []).map(o => o.nome).filter(Boolean);
    if (nomes.length) parts.push(nomes.join(', '));
  }
  return parts.join('; ');
}

function addonsKey(addons) {
  return JSON.stringify((addons || []).map(g => ({ grupo: g.grupo, opcoes: (g.opcoes || []).map(o => o.nome) })));
}

async function getCart(leadId) {
  const r = await query('SELECT * FROM cart_items WHERE lead_id = $1 ORDER BY added_at', [leadId]);
  return r.rows.map(i => ({ ...i, unit_price: num(i.unit_price), total_price: num(i.total_price), addons: parseAddons(i.addons) }));
}

function parseAddons(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) && raw.length ? raw : null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Adiciona produto (com adicionais opcionais) ao carrinho.
 * Item com mesmos adicionais incrementa a quantidade.
 */
async function addToCart(tenantId, leadId, product, addons = null) {
  const key = addonsKey(addons);
  const unitPrice = num(product.price) + addonsTotal(addons);
  const r = await query('SELECT id, quantity, addons FROM cart_items WHERE lead_id = $1 AND product_id = $2', [leadId, product.id]);
  const match = r.rows.find(i => addonsKey(parseAddons(i.addons)) === key);
  if (match) {
    await query('UPDATE cart_items SET quantity = quantity + 1, total_price = total_price + $2 WHERE id = $1', [match.id, unitPrice]);
  } else {
    await query(
      'INSERT INTO cart_items (tenant_id, lead_id, product_id, product_name, unit_price, quantity, total_price, image, addons) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)',
      [tenantId, leadId, product.id, product.name, unitPrice, unitPrice, product.image || null, addons ? JSON.stringify(addons) : null],
    );
  }
}

async function removeFromCart(leadId, productId) {
  await query('DELETE FROM cart_items WHERE lead_id = $1 AND product_id = $2', [leadId, productId]);
}

async function clearCart(leadId) {
  await query('DELETE FROM cart_items WHERE lead_id = $1', [leadId]);
}

async function updateCartItemQuantity(leadId, productId, qty) {
  if (qty <= 0) return removeFromCart(leadId, productId);
  const r = await query('SELECT id, unit_price FROM cart_items WHERE lead_id = $1 AND product_id = $2', [leadId, productId]);
  if (!r.rows[0]) return;
  await query('UPDATE cart_items SET quantity = $2, total_price = $3 WHERE id = $1', [r.rows[0].id, qty, num(r.rows[0].unit_price) * qty]);
}

async function cartTotal(leadId) {
  const r = await query('SELECT COALESCE(SUM(total_price), 0) AS total FROM cart_items WHERE lead_id = $1', [leadId]);
  return num(r.rows[0].total);
}

async function cartCount(leadId) {
  const r = await query('SELECT COUNT(*) AS c FROM cart_items WHERE lead_id = $1', [leadId]);
  return Number(r.rows[0].c);
}

// ============================================================
//  PEDIDOS
// ============================================================
async function createOrder(tenantId, leadId, cartItems, subtotal, discount, deliveryFee, total) {
  const externalId = 'RPZP-' + Date.now().toString(36).toUpperCase();
  const r = await query(
    `INSERT INTO orders (tenant_id, external_id, lead_id, subtotal, discount, delivery_fee, total, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [tenantId, externalId, leadId, subtotal, discount, deliveryFee, total],
  );
  const orderId = r.rows[0].id;

  for (const item of cartItems) {
    await query(
      `INSERT INTO order_items (tenant_id, order_id, product_id, product_name, unit_price, quantity, total_price, product_image, addons)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, orderId, item.product_id, item.product_name, item.unit_price, item.quantity,
       num(item.unit_price) * item.quantity, item.image || null, item.addons ? JSON.stringify(item.addons) : null],
    );
  }
  return getOrder(orderId);
}

async function getOrder(id) {
  const r = await query('SELECT * FROM orders WHERE id = $1', [id]);
  if (!r.rows[0]) return null;
  const o = r.rows[0];
  return { ...o, subtotal: num(o.subtotal), delivery_fee: num(o.delivery_fee), discount: num(o.discount), total: num(o.total) };
}

async function getOrderByExternal(tenantId, externalId) {
  const r = await query('SELECT * FROM orders WHERE tenant_id = $1 AND external_id = $2', [tenantId, externalId]);
  return r.rows[0] ? { ...r.rows[0], total: num(r.rows[0].total) } : null;
}

async function getOrderItems(orderId) {
  const r = await query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
  return r.rows.map(i => ({ ...i, unit_price: num(i.unit_price), total_price: num(i.total_price), addons: parseAddons(i.addons) }));
}

async function updateOrderStatus(orderId, status) {
  await query(`UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1`, [orderId, status]);
}

/**
 * Atualiza desconto e total do pedido (ex: desconto PIX aplicado na hora do pagamento).
 */
async function updateOrderTotals(orderId, { discount, total }) {
  await query(`UPDATE orders SET discount = $2, total = $3, updated_at = NOW() WHERE id = $1`, [orderId, discount, total]);
}

async function updateOrderObservations(orderId, observations) {
  await query(`UPDATE orders SET observations = $2, updated_at = NOW() WHERE id = $1`, [orderId, observations]);
}

async function getLeadOrders(tenantId, leadId) {
  const r = await query(
    'SELECT * FROM orders WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC',
    [tenantId, leadId],
  );
  return r.rows.map(o => ({ ...o, total: num(o.total) }));
}

async function getOrders(tenantId) {
  const r = await query('SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
  return r.rows.map(o => ({ ...o, subtotal: num(o.subtotal), delivery_fee: num(o.delivery_fee), total: num(o.total) }));
}

/**
 * Pedidos aprovados ainda não impressos (fila da impressora), do mais antigo.
 */
/**
 * Pedidos pendentes com cobrança MP registrada (para verificação de pagamento).
 */
async function getPendingOrdersWithPayments(tenantId = null) {
  const params = tenantId ? [tenantId] : [];
  const r = await query(
    `SELECT o.id, o.external_id, o.tenant_id, o.total, p.mp_payment_id, p.payment_method
     FROM orders o JOIN payments p ON p.order_id = o.id
     WHERE o.status = 'pending' AND p.mp_payment_id IS NOT NULL
     ${tenantId ? 'AND o.tenant_id = $1' : ''}
     ORDER BY o.created_at ASC`,
    params,
  );
  return r.rows.map(x => ({ ...x, total: num(x.total) }));
}

async function getOrdersToPrint(tenantId, limit = 30) {
  const r = await query(
    `SELECT * FROM orders WHERE tenant_id = $1 AND status = 'approved' AND printed_at IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map(o => ({ ...o, subtotal: num(o.subtotal), delivery_fee: num(o.delivery_fee), total: num(o.total) }));
}

async function markOrderPrinted(orderId) {
  await query(`UPDATE orders SET printed_at = NOW(), updated_at = NOW() WHERE id = $1`, [orderId]);
}

/**
 * Exclui pedido com itens e pagamentos vinculados.
 */
async function deleteOrder(orderId) {
  await query(`DELETE FROM payments WHERE order_id = $1`, [orderId]);
  await query(`DELETE FROM order_items WHERE order_id = $1`, [orderId]);
  await query(`DELETE FROM orders WHERE id = $1`, [orderId]);
}

/**
 * Exclui pedidos pendentes antigos (mais de X dias) — limpeza automática.
 * Retorna quantos foram excluídos.
 */
async function deletePendingOrdersOlderThan(days) {
  const r = await query(
    `SELECT id FROM orders WHERE status = 'pending' AND created_at < NOW() - ($1 || ' days')::interval`,
    [days],
  );
  for (const row of r.rows) await deleteOrder(row.id);
  return r.rows.length;
}

/**
 * Exclui lead com tudo que depende dele (conversas, carrinho, pedidos e pagamentos).
 */
async function deleteLeadCompleto(leadId) {
  await query(`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE lead_id = $1)`, [leadId]);
  await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE lead_id = $1)`, [leadId]);
  await query(`DELETE FROM orders WHERE lead_id = $1`, [leadId]);
  await query(`DELETE FROM cart_items WHERE lead_id = $1`, [leadId]);
  await query(`DELETE FROM conversations WHERE lead_id = $1`, [leadId]);
  await query(`DELETE FROM leads WHERE id = $1`, [leadId]);
}

// ============================================================
//  PAGAMENTOS
// ============================================================
async function createPayment(tenantId, orderId, paymentData) {
  await query('DELETE FROM payments WHERE order_id = $1', [orderId]);
  const r = await query(
    `INSERT INTO payments (tenant_id, order_id, mp_payment_id, mp_preference_id, payment_method, status, total, pix_qr_base64, pix_copy_paste)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tenantId, orderId, paymentData.mp_payment_id || null, paymentData.mp_preference_id || null,
     paymentData.payment_method || 'pix', paymentData.status || 'pending', paymentData.total || 0,
     paymentData.pix_qr_base64 || null, paymentData.pix_copy_paste || null],
  );
  return r.rows[0].id;
}

async function getPaymentByMpId(mpPaymentId) {
  const r = await query('SELECT * FROM payments WHERE mp_payment_id = $1', [String(mpPaymentId)]);
  return r.rows[0] ? { ...r.rows[0], total: num(r.rows[0].total) } : null;
}

async function getPaymentByOrderId(orderId) {
  const r = await query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
  return r.rows[0] ? { ...r.rows[0], total: num(r.rows[0].total) } : null;
}

async function updatePaymentStatusByMpId(mpPaymentId, status) {
  await query(`UPDATE payments SET status = $2, updated_at = NOW() WHERE mp_payment_id = $1`, [String(mpPaymentId), status]);
}

async function updatePaymentStatusByOrderId(orderId, status) {
  await query(`UPDATE payments SET status = $2, updated_at = NOW() WHERE order_id = $1`, [orderId, status]);
}

// ============================================================
//  ESTATÍSTICAS
// ============================================================
async function getOrdersByDay(tenantId, days = 14) {
  const r = await query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS dia, COUNT(*) AS qtd, SUM(total) AS total
     FROM orders
     WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
     GROUP BY dia ORDER BY dia`,
    [tenantId, days],
  );
  return r.rows.map(d => ({ ...d, qtd: Number(d.qtd), total: num(d.total) }));
}

async function getPaymentsByMethod(tenantId) {
  const r = await query(
    `SELECT p.payment_method AS metodo, COUNT(*) AS qtd
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.tenant_id = $1 AND o.status = 'approved' AND p.payment_method IS NOT NULL
     GROUP BY metodo ORDER BY qtd DESC`,
    [tenantId],
  );
  return r.rows.map(m => ({ ...m, qtd: Number(m.qtd) }));
}

async function getTopProducts(tenantId, limit = 5) {
  const r = await query(
    `SELECT product_name AS nome, SUM(quantity) AS qtd, SUM(total_price) AS total
     FROM order_items WHERE tenant_id = $1
     GROUP BY product_name ORDER BY qtd DESC LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map(p => ({ ...p, qtd: Number(p.qtd), total: num(p.total) }));
}

module.exports = {
  // utilitários internos (exportados para testes)
  normalizePhone, num, addonsKey, parseAddons,
  // tenants
  createTenant, getTenants, getTenant, getTenantByNumberId, getTenantByPanelLogin, updateTenant, deleteTenant,
  hashPassword, verifyPassword, normalizePhoneBr,
  // segmentos
  createSegment, getSegments, getSegment, updateSegment, deleteSegment, countTenantsBySegment, getTenantSegment, seedSegments,
  // planos e assinaturas
  getPlans, createPlan, updatePlan, deletePlan, countSubscriptionsByPlan,
  getSubscriptions, getSubscriptionsByTenant, getActiveSubscription, createSubscription,
  renewSubscription, renewSubscriptionMark, cancelSubscription, deleteSubscription, updateSubscriptionLimit, getExpiringSubscriptions,
  // catálogos
  getTenantCatalog, saveTenantCatalog,
  // imagens
  addTenantImage, listTenantImagesDb, deleteTenantImageDb,
  // leads
  getLead, getLeadByPhone, getOrCreateLead, updateLead, setFlowState, updateLeadStatus, listLeads,
  // questionários
  getSurvey, setSurvey,
  // conversas
  addMessage, getConversationsByLead,
  // carrinho
  getCart, addToCart, removeFromCart, clearCart, updateCartItemQuantity, cartTotal, cartCount,
  formatAddons, addonsTotal,
  // pedidos
  createOrder, getOrder, getOrderByExternal, getOrderItems, updateOrderStatus, updateOrderTotals, updateOrderObservations, getLeadOrders, getOrders,
  getOrdersToPrint, markOrderPrinted, getPendingOrdersWithPayments, deleteOrder, deletePendingOrdersOlderThan, deleteLeadCompleto,
  // pagamentos
  createPayment, getPaymentByMpId, getPaymentByOrderId, updatePaymentStatusByMpId, updatePaymentStatusByOrderId,
  // estatísticas
  getOrdersByDay, getPaymentsByMethod, getTopProducts,
};