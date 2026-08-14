const axios = require('axios');
const config = require('./config');
const repo = require('./repository');
const catalog = require('./catalog');

/**
 * Resolve credenciais: prioriza o tenant, senão as globais (admin).
 */
function tenantApi(tenant) {
  return {
    phoneNumberId: tenant?.phone_number_id || config.phoneNumberId,
    accessToken: tenant?.access_token || config.accessToken,
  };
}

async function callApi(payload, api) {
  const url = `https://graph.facebook.com/${config.graphVersion}/${api.phoneNumberId}/messages`;
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${api.accessToken}` },
  });
  return data;
}

function logError(tag, err) {
  console.error(`[WHATSAPP] ${tag}:`, err.response?.data || err.message);
}

/**
 * Envia texto simples (opcionalmente pelo número do tenant).
 */
async function sendText(to, text, tenant = null) {
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: String(text), preview_url: false },
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', text, 'text');
    return data;
  } catch (err) {
    logError('sendText', err);
  }
}

/**
 * Envia botões interativos.
 */
async function sendButtons(to, bodyText, buttons, tenant = null) {
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(bodyText) },
        action: {
          buttons: buttons.map(b => ({
            type: 'reply',
            reply: { id: String(b.id), title: String(b.title).slice(0, 20) },
          })),
        },
      },
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', bodyText, 'buttons');
    return data;
  } catch (err) {
    logError('sendButtons', err);
  }
}

/**
 * Envia card de produto com imagem.
 */
async function sendProductCard(to, product, imageUrl, buttons = null, tenant = null) {
  const priceFormatted = `R$ ${Number(product.price).toFixed(2).replace('.', ',')}`;
  const bodyText = `*${product.name}*\n${product.short_description || ''}\n\n💰 ${priceFormatted}`;
  const actionButtons = buttons || [
    { type: 'reply', reply: { id: `BUY_${product.id}`, title: '🛒 Comprar' } },
    { type: 'reply', reply: { id: `DETAIL_${product.id}`, title: '📋 Detalhes' } },
  ];
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { link: imageUrl } },
        body: { text: bodyText },
        footer: { text: product.unit ? `por ${product.unit}` : 'Clique para comprar' },
        action: { buttons: actionButtons },
      },
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', `[Produto] ${product.name}`, 'product_card');
    return data;
  } catch (err) {
    logError('sendProductCard', err);
  }
}

/**
 * Envia imagem simples.
 */
async function sendImage(to, imageUrl, caption = '', tenant = null) {
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image',
      image: { link: imageUrl },
      caption: caption || undefined,
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', caption || '[Imagem]', 'image');
    return data;
  } catch (err) {
    logError('sendImage', err);
  }
}

/**
 * Trunca texto com reticências respeitando palavras (limite da Meta).
 */
function smartCut(text, max) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Envia lista interativa (janela de seleção).
 */
async function sendList(to, bodyText, rows, headerText = '', footerText = '', tenant = null) {
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: {
        type: 'list',
        header: headerText ? { type: 'text', text: smartCut(headerText, 60) } : undefined,
        body: { text: String(bodyText).slice(0, 1024) },
        footer: footerText ? { text: smartCut(footerText, 60) } : undefined,
        action: {
          button: 'Ver opções',
          sections: [{
            title: 'Produtos',
            rows: rows.slice(0, 10).map(r => ({
              id: String(r.id),
              title: smartCut(r.title, 24),
              description: smartCut(r.description, 72),
            })),
          }],
        },
      },
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', bodyText, 'list');
    return data;
  } catch (err) {
    logError('sendList', err);
  }
}

/**
 * Botão de link (CTA) — abre URL externa. Sem botão de resposta junto (a Meta bloqueia a entrega).
 */
async function sendCtaButton(to, bodyText, buttonTitle, url, tenant = null) {
  try {
    const api = tenantApi(tenant);
    const data = await callApi({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: [{ type: 'cta_url', cta_url: { display_text: String(buttonTitle).slice(0, 20), url: String(url) } }],
        },
      },
    }, api);
    if (tenant?.id) await repo.addMessage(tenant.id, to, 'out', bodyText, 'cta_button');
    return data;
  } catch (err) {
    logError('sendCtaButton', err);
  }
}

async function markRead(messageId) {
  try {
    await callApi({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }, tenantApi(null));
  } catch (_) {}
}

/**
 * Menu de boas-vindas do tenant.
 */
async function sendWelcomeMenu(to, nome = '', tenant = null) {
  const company = await catalog.getCompanyInfo(tenant.id);
  const texto = await catalog.msg(tenant.id, 'welcome', {
    nome: nome || 'cliente',
    empresa: config.businessName || company.name || 'RespVZap',
  });
  await sendButtons(to, texto, [
    { id: 'MENU_SHOP', title: 'Comprar' },
    { id: 'MENU_SUPPORT', title: 'Atendente' },
    { id: 'MENU_TRACK', title: 'Meus Pedidos' },
  ], tenant);
}

module.exports = {
  sendText, sendButtons, sendProductCard, sendImage, sendList, sendCtaButton, markRead,
  sendWelcomeMenu,
};