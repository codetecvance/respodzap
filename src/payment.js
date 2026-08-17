const axios = require('axios');
const config = require('./config');
const repo = require('./repository');
const catalog = require('./catalog');

const MP_API = 'https://api.mercadopago.com';
const MP_AUTH = 'https://auth.mercadopago.com.br';
const TOKEN_SOON_MS = 5 * 60 * 1000;

/**
 * Token do Mercado Pago do tenant (renova via refresh_token se expirou).
 * Retorna null quando o tenant não conectou conta própria.
 */
async function getTenantMpToken(tenant) {
  if (!tenant?.mp_access_token) return null;
  const expires = tenant.mp_token_expires_at ? new Date(tenant.mp_token_expires_at).getTime() : 0;
  if (expires > Date.now() + TOKEN_SOON_MS) return tenant.mp_access_token;
  // Token expirou ou vai expirar: renova com refresh_token
  if (!tenant.mp_refresh_token || !config.mpClientId || !config.mpClientSecret) return tenant.mp_access_token;
  try {
    const { data } = await axios.post(`${MP_API}/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: config.mpClientId,
      client_secret: config.mpClientSecret,
      refresh_token: tenant.mp_refresh_token,
    });
    if (data?.access_token) {
      await repo.updateTenant(tenant.id, {
        mp_access_token: data.access_token,
        mp_refresh_token: data.refresh_token || tenant.mp_refresh_token,
        mp_token_expires_at: new Date(Date.now() + (Number(data.expires_in) || 15552000) * 1000),
      });
      return data.access_token;
    }
  } catch (e) {
    console.error('[MP] refresh token falhou:', e.response?.data || e.message);
  }
  return tenant.mp_access_token;
}

function mpHeaders(idempotencyKey) {
  const headers = { Authorization: `Bearer ${config.mpAccessToken}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * Headers com o token da conta do tenant (fallback: token global do SaaS).
 */
async function mpHeadersForTenant(tenant, idempotencyKey) {
  const token = (await getTenantMpToken(tenant)) || config.mpAccessToken;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * Cria cobrança PIX no Mercado Pago (conta do tenant ou global) e retorna copia-e-cola.
 */
async function criarPix(tenant, order, lead) {
  const token = (await getTenantMpToken(tenant)) || config.mpAccessToken;
  if (!token) throw new Error('Token Mercado Pago ausente');

  const storeConf = await catalog.getStoreConfig(tenant.id);
  const discountPercent = storeConf.pix_discount_percent || 0;
  // Base do cálculo: subtotal + entrega (independe de desconto já persistido —
  // evita aplicar desconto duplicado se o PIX for gerado novamente).
  const baseTotal = Math.round((Number(order.subtotal || 0) + Number(order.delivery_fee || 0)) * 100) / 100;
  const finalTotal = Math.round((baseTotal - (baseTotal * discountPercent) / 100) * 100) / 100;

  // Persiste o desconto no pedido para que todas as telas (confirmação ao cliente,
  // ticket impresso, notificações e relatórios) mostrem o valor realmente cobrado.
  if (finalTotal !== Number(order.total)) {
    await repo.updateOrderTotals(order.id, {
      discount: Math.round((baseTotal - finalTotal) * 100) / 100,
      total: finalTotal,
    });
  }

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
  let { data: payment } = await axios.post(`${MP_API}/v1/payments`, payload, { headers: await mpHeadersForTenant(tenant, idempotencyKey) });
  if (['expired', 'rejected', 'cancelled'].includes(payment.status)) {
    idempotencyKey = `${baseKey}-${Date.now()}`;
    ({ data: payment } = await axios.post(`${MP_API}/v1/payments`, payload, { headers: await mpHeadersForTenant(tenant, idempotencyKey) }));
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
  const token = (await getTenantMpToken(tenant)) || config.mpAccessToken;
  if (!token) throw new Error('Token Mercado Pago ausente');

  const storeConf = await catalog.getStoreConfig(tenant.id);
  // Cartão paga o valor cheio (subtotal + entrega) — limpa desconto PIX que
  // eventualmente tenha sido persistido no pedido e recalcula o total exato.
  const chargeTotal = Math.round((Number(order.subtotal || 0) + Number(order.delivery_fee || 0)) * 100) / 100;
  if (Number(order.discount) > 0 || Number(order.total) !== chargeTotal) {
    await repo.updateOrderTotals(order.id, { discount: 0, total: chargeTotal });
  }

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
    { headers: await mpHeadersForTenant(tenant, `pref-${order.external_id}`) }
  );

  await repo.createPayment(tenant.id, order.id, {
    mp_preference_id: preference.id,
    payment_method: tipo === 'credit' ? 'credit_card' : 'debit_card',
    status: 'pending',
    total: chargeTotal,
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

async function getPaymentStatus(paymentId, token = null) {
  const tk = token || config.mpAccessToken;
  if (!tk) return null;
  try {
    const { data } = await axios.get(`${MP_API}/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${tk}` } });
    return { status: data.status, total: data.transaction_amount };
  } catch {
    return null;
  }
}

async function getPaymentFull(paymentId, token = null) {
  const tk = token || config.mpAccessToken;
  if (!tk) return null;
  try {
    const { data } = await axios.get(`${MP_API}/v1/payments/${paymentId}`, { headers: { Authorization: `Bearer ${tk}` } });
    return data;
  } catch {
    return null;
  }
}

module.exports = { criarPix, criarCheckoutCartao, criarPixAssinatura, getPaymentStatus, getPaymentFull, getTenantMpToken, mpHeadersForTenant };