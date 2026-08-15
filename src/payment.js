const axios = require('axios');
const config = require('./config');
const repo = require('./repository');
const catalog = require('./catalog');

const MP_API = 'https://api.mercadopago.com';

function mpHeaders(idempotencyKey) {
  const headers = { Authorization: `Bearer ${config.mpAccessToken}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * Cria cobrança PIX no Mercado Pago (conta do provedor) e retorna copia-e-cola.
 */
async function criarPix(tenant, order, lead) {
  if (!config.mpAccessToken) throw new Error('Token Mercado Pago ausente');

  const storeConf = await catalog.getStoreConfig(tenant.id);
  const discountPercent = storeConf.pix_discount_percent || 0;
  const total = Number(order.total || 0);
  const finalTotal = Math.round((total - (total * discountPercent) / 100) * 100) / 100;

  const payload = {
    transaction_amount: finalTotal,
    description: `Pedido #${order.external_id || order.id}`,
    payment_method_id: 'pix',
    external_reference: order.external_id,
    payer: {
      email: lead.email || `pix_${lead.phone}@respodzap.com`,
      first_name: (lead.full_name || 'Cliente').split(' ')[0] || 'Cliente',
      last_name: (lead.full_name || 'Cliente').split(' ').slice(1).join(' ') || '_',
    },
    notification_url: config.webhookUrl ? `${config.webhookUrl}/mercadopago/webhook` : undefined,
  };

  // Chave fixa por pedido (toque duplo não cria cobrança duplicada);
  // se a cobrança anterior expirou/rejeitou, gera uma nova.
  const baseKey = `pedido-${order.external_id || order.id}`;
  let idempotencyKey = baseKey;
  let { data: payment } = await axios.post(`${MP_API}/v1/payments`, payload, { headers: mpHeaders(idempotencyKey) });
  if (['expired', 'rejected', 'cancelled'].includes(payment.status)) {
    idempotencyKey = `${baseKey}-${Date.now()}`;
    ({ data: payment } = await axios.post(`${MP_API}/v1/payments`, payload, { headers: mpHeaders(idempotencyKey) }));
  }

  const pixData = payment.point_of_interaction?.transaction_data || {};

  await repo.createPayment(tenant.id, order.id, {
    mp_payment_id: String(payment.id),
    payment_method: 'pix',
    status: payment.status || 'pending',
    total: finalTotal,
    pix_qr_base64: pixData.qr_code_base64 || null,
    pix_copy_paste: pixData.qr_code || null,
  });

  return {
    payment_id: String(payment.id),
    status: payment.status || 'pending',
    total: finalTotal,
    pix_copy_paste: pixData.qr_code || '',
    pix_qr_base64: pixData.qr_code_base64 || '',
  };
}

/**
 * Cria checkout de cartão (crédito/débito) e retorna o link.
 */
async function criarCheckoutCartao(tenant, order, lead, tipo) {
  if (!config.mpAccessToken) throw new Error('Token Mercado Pago ausente');

  const storeConf = await catalog.getStoreConfig(tenant.id);
  const items = (await repo.getOrderItems(order.id)).map(it => ({
    title: it.product_name,
    unit_price: Number(it.unit_price),
    quantity: it.quantity || 1,
    currency_id: 'BRL',
  }));
  // Frete entra como item para o MP cobrar o total exato (itens + entrega)
  if (Number(order.delivery_fee) > 0) {
    items.push({ title: 'Frete (entrega)', unit_price: Number(order.delivery_fee), quantity: 1, currency_id: 'BRL' });
  }

  const excluded = tipo === 'credit'
    ? [{ id: 'debit_card' }, { id: 'ticket' }, { id: 'pix' }]
    : [{ id: 'credit_card' }, { id: 'ticket' }, { id: 'pix' }];

  const payload = {
    items,
    payer: {
      name: lead.full_name || 'Cliente',
      email: lead.email || `cliente_${lead.phone}@respodzap.com`,
      phone: { number: lead.phone },
    },
    payment_methods: {
      installments: storeConf.installments_max || 3,
      excluded_payment_types: excluded,
    },
    back_urls: {
      success: `${config.webhookUrl || 'https://w.app'}/pagamento/ok`,
      pending: `${config.webhookUrl || 'https://w.app'}/pagamento/pendente`,
      failure: `${config.webhookUrl || 'https://w.app'}/pagamento/erro`,
    },
    auto_return: 'approved',
    external_reference: order.external_id,
    statement_descriptor: 'RESPODZAP',
    notification_url: config.webhookUrl ? `${config.webhookUrl}/mercadopago/webhook` : undefined,
  };

  const { data: preference } = await axios.post(
    `${MP_API}/checkout/preferences`,
    payload,
    { headers: mpHeaders(`pref-${order.external_id}`) }
  );

  await repo.createPayment(tenant.id, order.id, {
    mp_preference_id: preference.id,
    payment_method: tipo === 'credit' ? 'credit_card' : 'debit_card',
    status: 'pending',
    total: order.total,
  });

  return { preference_id: preference.id, checkout_url: preference.init_point };
}

/**
 * Cria PIX de renovação de licença (external_reference = sub-{id}).
 */
async function criarPixAssinatura(subscription, tenant) {
  if (!config.mpAccessToken) throw new Error('Token Mercado Pago ausente');
  const total = Number(subscription.price || 299);

  const payload = {
    transaction_amount: total,
    description: `Renovação de assinatura — ${tenant.name}`,
    payment_method_id: 'pix',
    external_reference: `sub-${subscription.id}`,
    payer: {
      email: tenant.notify_email || `sub_${tenant.id}@respodzap.com`,
      first_name: (tenant.contact_name || tenant.name || 'Cliente').split(' ')[0],
      last_name: (tenant.contact_name || tenant.name || 'Cliente').split(' ').slice(1).join(' ') || '_',
    },
    notification_url: config.webhookUrl ? `${config.webhookUrl}/mercadopago/webhook` : undefined,
  };

  const idempotencyKey = `sub-${subscription.id}-${Date.now()}`;
  const { data: payment } = await axios.post(`${MP_API}/v1/payments`, payload, { headers: mpHeaders(idempotencyKey) });
  const pixData = payment.point_of_interaction?.transaction_data || {};

  return {
    payment_id: String(payment.id),
    status: payment.status || 'pending',
    total,
    pix_copy_paste: pixData.qr_code || '',
  };
}

async function getPaymentStatus(paymentId) {
  if (!config.mpAccessToken) return null;
  try {
    const { data } = await axios.get(`${MP_API}/v1/payments/${paymentId}`, { headers: mpHeaders() });
    return { status: data.status, total: data.transaction_amount };
  } catch {
    return null;
  }
}

async function getPaymentFull(paymentId) {
  if (!config.mpAccessToken) return null;
  try {
    const { data } = await axios.get(`${MP_API}/v1/payments/${paymentId}`, { headers: mpHeaders() });
    return data;
  } catch {
    return null;
  }
}

module.exports = { criarPix, criarCheckoutCartao, criarPixAssinatura, getPaymentStatus, getPaymentFull };