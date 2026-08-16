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

// Cache de media_id (válido ~30 dias na Meta) — evita re-upload e o
// problema de "Failed to resolve host" ao baixar imagem de link externo.
const mediaCache = new Map();
const MEDIA_TTL = 25 * 24 * 3600 * 1000;

/**
 * Faz upload da imagem para o WhatsApp e retorna o media_id (ou null).
 * O envio passa a usar o media_id — o WhatsApp não baixa mais de link.
 */
async function uploadMedia(imageUrl, api) {
  if (!imageUrl) return null;
  const hit = mediaCache.get(imageUrl);
  if (hit && Date.now() - hit.at < MEDIA_TTL) return hit.id;
  try {
    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
    const buf = Buffer.from(resp.data);
    const mime = String(resp.headers['content-type'] || 'image/jpeg').split(';')[0];
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buf], { type: mime }), `media.${ext}`);
    const { data } = await axios.post(
      `https://graph.facebook.com/${config.graphVersion}/${api.phoneNumberId}/media`,
      form,
      { headers: { Authorization: `Bearer ${api.accessToken}` } }
    );
    if (data?.id) {
      mediaCache.set(imageUrl, { id: data.id, at: Date.now() });
      return data.id;
    }
  } catch (err) {
    console.error('[MEDIA] upload falhou:', err.response?.data || err.message);
  }
  return null;
}

/**
 * Monta o header de imagem do interactive: usa media_id quando possível.
 */
async function imageHeader(imageUrl, api) {
  if (!imageUrl) return undefined;
  const id = await uploadMedia(imageUrl, api);
  return id ? { type: 'image', image: { id } } : { type: 'image', image: { link: imageUrl } };
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
        body: { text: smartCut(String(bodyText), 1024) },
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
 * Envia card de produto com imagem (bloco: foto + nome + preço + botões).
 * Sob consulta → botão "Quero saber mais". Com planos → "Ver planos" via BUY_.
 */
async function sendProductCard(to, product, imageUrl, buttons = null, tenant = null) {
  const priceFormatted = product.sob_consulta ? 'Sob consulta' : `R$ ${Number(product.price).toFixed(2).replace('.', ',')}`;
  const bodyText = `*${product.name}*\n${product.short_description || ''}\n\n💰 ${priceFormatted}`;
  let actionButtons = buttons;
  if (!actionButtons) {
    if (product.sob_consulta) {
      actionButtons = [{ type: 'reply', reply: { id: `QUOTE_${product.id}`, title: String(await catalog.getButton(tenant?.id, 'quote')).slice(0, 20) } }];
    } else {
      actionButtons = [
        { type: 'reply', reply: { id: `BUY_${product.id}`, title: String(await catalog.getButton(tenant?.id, 'add_product')).slice(0, 20) } },
        { type: 'reply', reply: { id: `DETAIL_${product.id}`, title: String(await catalog.getButton(tenant?.id, 'detail')).slice(0, 20) } },
      ];
    }
  }
  try {
    const api = tenantApi(tenant);
    const header = await imageHeader(imageUrl, api);
    const data = await callApi({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: {
        type: 'button',
        header,
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
    const payload = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image',
      caption: caption || undefined,
    };
    const id = await uploadMedia(imageUrl, api);
    if (id) payload.image = { id };
    else payload.image = { link: imageUrl };
    const data = await callApi(payload, api);
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
          button: await catalog.getButton(tenant?.id, 'list_button'),
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
    { id: 'MENU_SHOP', title: await catalog.getButton(tenant.id, 'menu_shop') },
    { id: 'MENU_SUPPORT', title: await catalog.getButton(tenant.id, 'menu_support') },
    { id: 'MENU_TRACK', title: await catalog.getButton(tenant.id, 'menu_track') },
  ], tenant);
}

module.exports = {
  sendText, sendButtons, sendProductCard, sendImage, sendList, sendCtaButton, markRead,
  sendWelcomeMenu, uploadMedia,
};