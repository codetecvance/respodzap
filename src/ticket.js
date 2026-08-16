// ============================================================
//  TICKET DE IMPRESSÃO (80mm) — impressora de pedidos
// ============================================================
const repo = require('./repository');
const catalog = require('./catalog');

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

const METODO_LABEL = {
  pix: '💠 PIX', credit_card: '💳 Cartão de Crédito', debit_card: '💳 Cartão de Débito',
};

/**
 * Monta o ticket de impressão de um pedido (dados + HTML 80mm).
 */
async function buildTicket(tenantId, orderId) {
  const tenant = await repo.getTenant(tenantId);
  const order = await repo.getOrder(orderId);
  if (!tenant || !order) return null;

  const [items, pay, lead, data] = await Promise.all([
    repo.getOrderItems(orderId),
    repo.getPaymentByOrderId(orderId),
    repo.getLead(order.lead_id),
    catalog.loadTenantCatalog(tenantId),
  ]);

  const company = data.company || {};
  const dt = new Date(order.created_at);
  const dataHora = `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;

  const itensHtml = items.map(it => {
    const extra = repo.formatAddons(it.addons);
    return `<div class="item"><div class="nome">${esc(it.product_name)}${extra ? ` <small>(${esc(extra)})</small>` : ''}</div>
      <div class="linha"><span class="qtd">${it.quantity}x</span><span class="val">${money(it.unit_price)}</span></div></div>`;
  }).join('');

  const endereco = lead?.delivery_address ? `<div class="bloco"><div class="rot">ENTREGA</div><div>${esc(lead.delivery_address)}</div></div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Pedido #${esc(order.external_id)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', monospace; width: 80mm; font-size: 12px; color: #000; padding: 4mm; }
  .center { text-align: center; }
  .empresa { font-size: 16px; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; }
  .sub { font-size: 11px; margin-bottom: 6px; }
  .div { border-top: 1px dashed #000; margin: 6px 0; }
  .bloco { margin: 4px 0; }
  .rot { font-weight: bold; font-size: 11px; }
  .pedido-num { font-size: 30px; font-weight: bold; text-align: center; margin: 6px 0; }
  .info { text-align: center; font-size: 12px; }
  .item { margin: 5px 0; }
  .nome { font-weight: bold; }
  .nome small { font-weight: normal; }
  .linha { display: flex; justify-content: space-between; font-size: 12px; }
  .total { font-size: 18px; font-weight: bold; text-align: center; margin: 6px 0; }
  .pago { text-align: center; font-weight: bold; font-size: 13px; margin: 4px 0; }
  .rodape { text-align: center; margin-top: 8px; font-size: 11px; }
</style></head><body>
  <div class="center"><div class="empresa">${esc(company.name || tenant.name)}</div>
  <div class="sub">${esc(company.business_hours || '')}</div></div>
  <div class="div"></div>
  <div class="pedido-num">${esc(order.external_id)}</div>
  <div class="info">${dataHora}</div>
  <div class="div"></div>
  ${itensHtml}
  <div class="div"></div>
  <div class="linha"><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
  ${Number(order.delivery_fee) > 0 ? `<div class="linha"><span>Entrega</span><span>${money(order.delivery_fee)}</span></div>` : ''}
  ${Number(order.discount) > 0 ? `<div class="linha"><span>Desconto</span><span>-${money(order.discount)}</span></div>` : ''}
  <div class="total">TOTAL ${money(order.total)}</div>
  <div class="pago">✅ ${esc(METODO_LABEL[pay?.payment_method] || '—')} — PAGO</div>
  <div class="div"></div>
  <div class="bloco"><div class="rot">CLIENTE</div><div>${esc(lead?.full_name || '—')}</div>
  <div>${esc(lead?.phone || '')}</div></div>
  ${endereco}
  ${order.observations ? `<div class="bloco"><div class="rot">OBSERVAÇÕES</div><div>${esc(order.observations)}</div></div>` : ''}
  <div class="div"></div>
  <div class="rodape">${esc(company.website || company.instagram || '')}</div>
</body></html>`;

  return { order, tenant, items, pay, lead, company, dataHora, html };
}

module.exports = { buildTicket, esc, money };
