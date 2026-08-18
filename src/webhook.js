const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const repo = require('./repository');
const { processIncoming } = require('./flow-engine');

const router = express.Router();

function logWebhook(entry) {
  try {
    const logPath = path.join(__dirname, '..', 'data', 'webhook.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${JSON.stringify(entry)}\n`);
  } catch (_err) {}
}

// =================================================
//  WHATSAPP WEBHOOK (GET handshake + POST messages)
// =================================================

router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === config.verifyToken) {
    return res.status(200).type('text/plain').send(challenge);
  }
  res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  try {
    logWebhook({ type: 'request', body: req.body });
    if (!verificarAssinatura(req.rawBody, req.get('x-hub-signature-256'))) {
      console.warn('[WEBHOOK] Assinatura inválida — payload ignorado');
      return res.sendStatus(200);
    }
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};

        // Status de entrega (log apenas)
        for (const status of value.statuses || []) {
          if (status.status === 'failed' && status.errors) {
            console.error('[WEBHOOK] ERRO DE ENTREGA:', JSON.stringify(status.errors));
          }
        }

        // Mensagens recebidas — roteia pelo phone_number_id → tenant
        const numberId = value.metadata?.phone_number_id;
        const tenant = numberId ? await repo.getTenantByNumberId(numberId) : null;
        if (!tenant) {
          console.warn('[WEBHOOK] Nenhum tenant para o número', numberId);
          continue;
        }
        for (const msg of value.messages || []) {
          if (msg.type === 'text') {
            await processIncoming(tenant, msg.from, msg.text?.body, null, msg.id, numberId).catch(e => console.error('[FLOW]', e.message));
          } else if (msg.type === 'interactive') {
            const payload = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
            if (payload) await processIncoming(tenant, msg.from, null, payload, msg.id, numberId).catch(e => console.error('[FLOW]', e.message));
          }
        }
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Erro ao processar payload:', err);
  } finally {
    // Sempre responde 200 ao final (processamento síncrono — exigência do Vercel)
    if (!res.headersSent) res.sendStatus(200);
  }
});

// ===================================================
//  MERCADO PAGO WEBHOOK (pedidos + renovação de licença)
// ===================================================
router.post('/mercadopago/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    logWebhook({ type: 'mp', body: req.body });
    const { type, data } = req.body;
    if (type !== 'payment') return;
    const paymentId = data?.id;
    if (!paymentId) return;

    const { getPaymentStatus, getPaymentFull, getTenantMpToken } = require('./payment');

    // Descobre o pedido/pagamento registrado para usar o token da conta correta
    const paymentRecord = await repo.getPaymentByMpId(paymentId);
    let order = null;
    if (paymentRecord) order = await repo.getOrder(paymentRecord.order_id);

    // Renovação de licença usa a conta GLOBAL do SaaS (token padrão)
    let mpToken = null;
    if (order) {
      const tenant = await repo.getTenant(order.tenant_id);
      if (tenant) mpToken = await getTenantMpToken(tenant);
    }

    const status = await getPaymentStatus(paymentId, mpToken);
    if (!status) return;

    // --- RENOVAÇÃO DE LICENÇA (external_reference = sub-{id}) ---
    const full = await getPaymentFull(paymentId, null);
    const extRef = full?.external_reference || '';
    if (extRef.startsWith('sub-')) {
      const subId = Number(extRef.slice(4));
      const subs = await repo.getSubscriptions();
      const sub = subs.find(s => s.id === subId);
      if (sub && status.status === 'approved') {
        const days = sub.period_days || 30;
        await repo.renewSubscription(subId, days);
        const { notifyAdmin, notifyTenant } = require('./notify');
        await notifyAdmin('LICENÇA RENOVADA', `Cliente: ${sub.tenant_name}\nPlano: ${sub.plan_name || '—'}\nValor: R$ ${sub.price}\nRenovado por ${days} dias via PIX.`);
        const tenant = await repo.getTenant(sub.tenant_id);
        if (tenant) {
          await notifyTenant(tenant, '✅ PAGAMENTO RECEBIDO', `Sua assinatura foi renovada com sucesso por mais ${days} dias. Obrigado!`);
        }
        console.log('[MP-Webhook] Licença renovada:', subId);
      }
      return;
    }

    // --- PEDIDO NORMAL ---
    if (!order && extRef) {
      const allTenants = await repo.getTenants();
      for (const t of allTenants) {
        order = await repo.getOrderByExternal(t.id, extRef);
        if (order) break;
      }
      // Token da conta do dono do pedido (se encontrado agora)
      if (order) {
        const tenant = await repo.getTenant(order.tenant_id);
        if (tenant) mpToken = await getTenantMpToken(tenant);
      }
    }
    if (!order) {
      console.warn('[MP-Webhook] Pedido não encontrado para o pagamento', paymentId);
      return;
    }

    const mpStatus = status.status;
    if (paymentRecord) await repo.updatePaymentStatusByMpId(paymentId, mpStatus);

    if (mpStatus === 'approved') {
      await repo.updateOrderStatus(order.id, 'approved');
    } else if (mpStatus === 'rejected' || mpStatus === 'cancelled') {
      await repo.updateOrderStatus(order.id, 'failed');
    } else {
      // pending / in_process (ex: cartão processando) — aguarda o próximo webhook
      return;
    }

    if (mpStatus === 'approved') {
      const tenant = await repo.getTenant(order.tenant_id);
      if (!tenant) return;
      await confirmarPagamentoAprovado(tenant, order);
    }
  } catch (e) {
    console.error('[MP-Webhook]', e.message);
  }
});

// ===================================================
//  UTILITÁRIOS INTERNOS
// ===================================================
function verificarAssinatura(rawBody, signature) {
  if (!config.appSecret) {
    console.warn('[WEBHOOK] APP_SECRET ausente — pulando verificação de assinatura');
    return true;
  }
  if (!signature) return false;
  const sig = signature.split('=')[1];
  if (!sig) return false;
  const expected = crypto
    .createHmac('sha256', config.appSecret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ===================================================
//  CONFIRMAÇÃO DE PAGAMENTO (compartilhada: webhook, cron e botão)
// ===================================================

/**
 * Notifica cliente + dono quando um pedido é aprovado.
 */
async function confirmarPagamentoAprovado(tenant, order) {
  const lead = await repo.getLead(order.lead_id);
  if (!lead) return;
  const { sendText } = require('./whatsapp');
  const catalog = require('./catalog');
  const resumo = `Pedido #${order.external_id}\nTotal: R$ ${Number(order.total || 0).toFixed(2)}`;
  await sendText(lead.phone, await catalog.msg(tenant.id, 'payment_confirmed', { resumo }), tenant);

  const items = await repo.getOrderItems(order.id);
  const itensTxt = items.map(it => `${it.quantity}x ${it.product_name}`).join(', ');
  const pay = await repo.getPaymentByOrderId(order.id);
  const metodo = { pix: 'PIX', credit_card: 'Cartão de Crédito', debit_card: 'Cartão de Débito' }[pay?.payment_method] || pay?.payment_method || '—';
  const { notifyTenant } = require('./notify');
  await notifyTenant(
    tenant,
    '✅ PAGAMENTO RECEBIDO',
    `Pedido: #${order.external_id}\nCliente: ${lead.full_name || '—'}\nWhatsApp: ${lead.phone}\nItens: ${itensTxt}\nMétodo: ${metodo}\nValor: R$ ${Number(order.total || 0).toFixed(2)}\nStatus: pagamento confirmado`,
    lead.phone,
  );
  console.log('[MP-Webhook] Pagamento aprovado para o pedido', order.external_id);
}

/**
 * Verifica pedidos pendentes no Mercado Pago e confirma os pagos.
 * Rede de segurança caso o webhook não chegue. Retorna quantos foram aprovados.
 */
async function verificarPagamentosPendentes(tenantId = null) {
  const pendentes = await repo.getPendingOrdersWithPayments(tenantId);
  let aprovados = 0;
  for (const row of pendentes) {
    try {
      const tenant = await repo.getTenant(row.tenant_id);
      if (!tenant) continue;
      const { getTenantMpToken, getPaymentStatus } = require('./payment');
      const token = await getTenantMpToken(tenant);
      const st = await getPaymentStatus(row.mp_payment_id, token);
      if (!st) continue;
      if (st.status === 'approved') {
        await repo.updateOrderStatus(row.id, 'approved');
        await repo.updatePaymentStatusByMpId(row.mp_payment_id, 'approved');
        await confirmarPagamentoAprovado(tenant, await repo.getOrder(row.id));
        aprovados++;
      } else if (st.status === 'rejected' || st.status === 'cancelled') {
        await repo.updateOrderStatus(row.id, 'failed');
        await repo.updatePaymentStatusByMpId(row.mp_payment_id, st.status);
      }
    } catch (e) {
      console.error('[VERIF-PAG]', e.message);
    }
  }
  return aprovados;
}

// ===================================================
//  CONEXÃO DO MERCADO PAGO (OAuth por tenant)
// ===================================================
const MP_AUTH_URL = 'https://auth.mercadopago.com.br';

/**
 * Inicia a conexão: redireciona o cliente para autorizar no MP.
 */
router.get('/mercadopago/connect', async (req, res) => {
  const tenantId = Number(req.query.tenant);
  if (!tenantId || !config.mpClientId || !config.mpClientSecret) {
    return res.redirect('/painel/config?msg=' + encodeURIComponent('Credenciais do Mercado Pago não configuradas no sistema.') + '&type=err');
  }
  const redirectUri = `${config.webhookUrl || 'https://respodzap.vercel.app'}/mercadopago/oauth`;
  const url = `${MP_AUTH_URL}/authorization?client_id=${config.mpClientId}&response_type=code&platform_id=mp&redirect_uri=${encodeURIComponent(redirectUri)}&state=${tenantId}`;
  res.redirect(url);
});

/**
 * Callback do MP: troca o code por token e salva no tenant (state = tenantId).
 */
router.get('/mercadopago/oauth', async (req, res) => {
  const code = String(req.query.code || '');
  const state = Number(req.query.state);
  const redirectUri = `${config.webhookUrl || 'https://respodzap.vercel.app'}/mercadopago/oauth`;
  if (!code || !state || !config.mpClientId || !config.mpClientSecret) {
    return res.status(400).send('Falha na conexão com o Mercado Pago (parâmetros inválidos).');
  }
  try {
    const axios = require('axios');
    const { data } = await axios.post('https://api.mercadopago.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: config.mpClientId,
      client_secret: config.mpClientSecret,
      code,
      redirect_uri: redirectUri,
    });
    await repo.updateTenant(state, {
      mp_access_token: data.access_token,
      mp_refresh_token: data.refresh_token || null,
      mp_user_id: String(data.user_id || ''),
      mp_token_expires_at: new Date(Date.now() + (Number(data.expires_in) || 15552000) * 1000),
    });
    return res.redirect('/painel/config?msg=' + encodeURIComponent('Conta do Mercado Pago conectada com sucesso!'));
  } catch (e) {
    console.error('[MP-OAUTH]', e.response?.data || e.message);
    return res.status(500).send('Falha ao conectar com o Mercado Pago: ' + (e.response?.data?.message || e.message));
  }
});

/**
 * Desconecta a conta do MP do tenant.
 */
router.get('/mercadopago/desconectar', async (req, res) => {
  const tenantId = Number(req.query.tenant);
  if (!tenantId) return res.redirect('/painel/config');
  await repo.updateTenant(tenantId, { mp_access_token: null, mp_refresh_token: null, mp_user_id: null, mp_token_expires_at: null });
  res.redirect('/painel/config?msg=' + encodeURIComponent('Mercado Pago desconectado.'));
});

module.exports = router;
router.verificarPagamentosPendentes = verificarPagamentosPendentes;
router.confirmarPagamentoAprovado = confirmarPagamentoAprovado;