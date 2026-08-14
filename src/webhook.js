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
  } catch (_) {}
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

    const { getPaymentStatus, getPaymentFull } = require('./payment');
    const status = await getPaymentStatus(paymentId);
    if (!status) return;

    // --- RENOVAÇÃO DE LICENÇA (external_reference = sub-{id}) ---
    const full = await getPaymentFull(paymentId);
    const extRef = full?.external_reference || '';
    if (extRef.startsWith('sub-')) {
      const subId = Number(extRef.slice(4));
      const subs = await repo.getSubscriptions();
      const sub = subs.find(s => s.id === subId);
      if (sub && status.status === 'approved') {
        const plan = await repo.getPlans();
        const planInfo = plan.find(p => p.id === sub.plan_id);
        const days = planInfo?.period_days || 30;
        await repo.renewSubscription(subId, days);
        const { notifyAdmin, notifyTenant } = require('./notify');
        await notifyAdmin('LICENÇA RENOVADA', `Cliente: ${sub.tenant_name}\nPlano: ${planInfo?.name || '—'}\nValor: R$ ${sub.price}\nRenovado por ${days} dias via PIX.`);
        const tenant = await repo.getTenant(sub.tenant_id);
        if (tenant) {
          await notifyTenant(tenant, '✅ PAGAMENTO RECEBIDO', `Sua assinatura foi renovada com sucesso por mais ${days} dias. Obrigado!`);
        }
        console.log('[MP-Webhook] Licença renovada:', subId);
      }
      return;
    }

    // --- PEDIDO NORMAL ---
    let paymentRecord = await repo.getPaymentByMpId(paymentId);
    let order = null;
    if (paymentRecord) {
      order = await repo.getOrder(paymentRecord.order_id);
    } else if (extRef) {
      const allTenants = await repo.getTenants();
      for (const t of allTenants) {
        order = await repo.getOrderByExternal(t.id, extRef);
        if (order) break;
      }
    }
    if (!order) {
      console.warn('[MP-Webhook] Pedido não encontrado para o pagamento', paymentId);
      return;
    }

    if (paymentRecord) await repo.updatePaymentStatusByMpId(paymentId, status.status);
    await repo.updateOrderStatus(order.id, status.status === 'approved' ? 'approved' : 'failed');

    if (status.status === 'approved') {
      const tenant = await repo.getTenant(order.tenant_id);
      const lead = await repo.getLead(order.lead_id);
      if (!lead || !tenant) return;
      const { sendText } = require('./whatsapp');
      const catalog = require('./catalog');
      const resumo = `Pedido #${order.external_id}\nTotal: R$ ${order.total.toFixed(2)}`;
      await sendText(lead.phone, await catalog.msg(tenant.id, 'payment_confirmed', { resumo }), tenant);

      const items = await repo.getOrderItems(order.id);
      const itensTxt = items.map(it => `${it.quantity}x ${it.product_name}`).join(', ');
      const pay = await repo.getPaymentByOrderId(order.id);
      const metodo = { pix: 'PIX', credit_card: 'Cartão de Crédito', debit_card: 'Cartão de Débito' }[pay?.payment_method] || pay?.payment_method || '—';
      const { notifyTenant } = require('./notify');
      await notifyTenant(
        tenant,
        '✅ PAGAMENTO RECEBIDO',
        `Pedido: #${order.external_id}\nCliente: ${lead.full_name || '—'}\nWhatsApp: ${lead.phone}\nItens: ${itensTxt}\nMétodo: ${metodo}\nValor: R$ ${order.total.toFixed(2)}\nStatus: pagamento confirmado`,
        lead.phone
      );
      console.log('[MP-Webhook] Pagamento aprovado para o pedido', order.external_id);
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

module.exports = router;