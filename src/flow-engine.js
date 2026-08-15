const repo = require('./repository');
const ws = require('./whatsapp');
const catalog = require('./catalog');
const payment = require('./payment');
const config = require('./config');

// ================================================================
//  ESTADOS DA CONVERSA
// ================================================================
const ST = {
  MENU: 'MENU',
  CATEGORIES: 'CATEGORIES',
  PRODUCTS: 'PRODUCTS',
  PRODUCT_DETAIL: 'PRODUCT_DETAIL',
  CART: 'CART',
  CHECKOUT_NAME: 'CHECKOUT_NAME',
  CHECKOUT_CONFIRM: 'CHECKOUT_CONFIRM',
  CHECKOUT_PAYMENT: 'CHECKOUT_PAYMENT',
  SURVEY: 'SURVEY',
  SOB_CONSULTA_NAME: 'SOB_CONSULTA_NAME',
  SUPPORT_NAME: 'SUPPORT_NAME',
  SUPPORT_REASON: 'SUPPORT_REASON',
};

// ================================================================
//  HANDLERS DE ESTADO
// ================================================================

async function _menu(tenant, lead) {
  await repo.setSurvey(lead.id, null);
  await ws.sendWelcomeMenu(lead.phone, lead.full_name, tenant);
  await repo.setFlowState(lead.id, ST.MENU);
}

async function _categories(tenant, lead) {
  const cats = await catalog.getCategories(tenant.id);
  if (!cats.length) {
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'no_categories'), tenant);
    return _menu(tenant, lead);
  }
  const btns = cats.slice(0, 2).map(c => ({ id: `CAT_${c.id}`, title: `${c.emoji || ''} ${c.name}`.slice(0, 20) }));
  btns.push({ id: 'MENU_BACK', title: 'Voltar' });
  await ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'categories_title'), btns, tenant);
  await repo.setFlowState(lead.id, ST.CATEGORIES);
}

async function _products(tenant, lead, categoryId) {
  const products = await catalog.getProductsByCategory(tenant.id, categoryId);
  if (!products.length) {
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'no_products'), tenant);
    return _categories(tenant, lead);
  }

  const data = await catalog.loadTenantCatalog(tenant.id);
  const cat = (data.categories || []).find(c => c.id === categoryId);
  await repo.setSurvey(lead.id, { cat: categoryId });

  // Imagem-menu: lista vertical com miniaturas (gerada por /api/menu-image)
  const menuEnabled = data.store?.menu_image?.enabled !== false;
  if (menuEnabled && config.webhookUrl) {
    const sig = Buffer.from(products.map(p => `${p.id}|${p.price}|${p.image}|${p.name}`).join('#')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const menuUrl = `${config.webhookUrl}/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(categoryId)}&sig=${sig}`;
    await ws.sendImage(lead.phone, menuUrl, `${cat?.emoji || ''} ${cat?.name || 'Produtos'}`, tenant);
  }

  // Janela de seleção: toque no produto
  const rows = await Promise.all(products.map(async (p, i) => ({
    id: `PROD_${p.id}`,
    title: `${i + 1}. ${p.name}`,
    description: p.list_description
      ? p.list_description
      : `${await precoExibicao(tenant.id, p)} — ${p.short_description || ''}`,
  })));
  await ws.sendList(
    lead.phone,
    `${cat?.emoji || ''} *${cat?.name || 'Produtos'}* — toque no produto:`,
    rows,
    cat?.name || 'Produtos',
    'Toque em um dos produtos abaixo',
    tenant
  );
  await repo.setFlowState(lead.id, ST.PRODUCTS);
}

/**
 * Exibe preço formatado ou "Sob consulta".
 */
async function precoExibicao(tenantId, product) {
  if (product.sob_consulta) return 'Sob consulta';
  return catalog.formatPrice(product.price);
}

function productImageUrl(product) {
  const image = product.image || '';
  if (/^https?:\/\//.test(image)) return image;
  return `${config.webhookUrl || ''}/images/${image || 'placeholder.png'}`;
}

async function _addToCart(tenant, lead, productId) {
  const product = await catalog.findProduct(tenant.id, productId);
  if (!product) {
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'product_not_found'), tenant);
    return _menu(tenant, lead);
  }
  await repo.addToCart(lead.id, product);
  const count = await repo.cartCount(lead.id);
  await ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'added_to_cart', { produto: product.name, total: count }), [
    { id: 'MENU_SHOP', title: 'Continuar comprando' },
    { id: 'CART_SHOW', title: 'Ver carrinho' },
  ], tenant);
  await repo.setFlowState(lead.id, ST.MENU);
}

/**
 * Calcula frete: produtos digitais (SaaS) não têm frete.
 */
function calcularFrete(items, store) {
  const allDigital = items.length > 0 && items.every(it => it.digital);
  if (allDigital) return 0;
  const sub = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  return sub >= (store.delivery_free_full || 9999999) ? 0 : store.delivery_fee || 0;
}

async function _cart(tenant, lead) {
  const items = await repo.getCart(lead.id);
  if (!items.length) {
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'cart_empty'), tenant);
    return _categories(tenant, lead);
  }
  let txt = (await catalog.msg(tenant.id, 'cart_title')) + '\n\n';
  let total = 0;
  items.forEach((it, i) => {
    total += Number(it.unit_price) * it.quantity;
    txt += `${i + 1}. ${it.product_name} — ${it.quantity}x R$ ${Number(it.unit_price).toFixed(2)}\n`;
  });
  txt += '\n' + (await catalog.msg(tenant.id, 'cart_total', { total: total.toFixed(2) }));

  await ws.sendButtons(lead.phone, txt, [
    { id: 'CART_BUY', title: 'Finalizar pedido' },
    { id: 'CART_CLEAR', title: 'Esvaziar carrinho' },
    { id: 'MENU_BACK', title: 'Continuar comprando' },
  ], tenant);
  await repo.setFlowState(lead.id, ST.CART);
}

async function _checkout(tenant, lead, step, answer) {
  if (step === 'name') {
    await repo.updateLead(lead.id, { full_name: answer });
    const q = await catalog.getQuestionnaire(tenant.id, 'checkout');
    if (q && q.questions?.length) {
      await repo.setSurvey(lead.id, { id: 'checkout', idx: 0, answers: {} });
      await repo.setFlowState(lead.id, ST.SURVEY);
      return ws.sendText(lead.phone, q.questions[0].question, tenant);
    }
    return _checkoutConfirm(tenant, lead, {});
  }

  if (step === 'confirm') {
    const items = await repo.getCart(lead.id);
    if (!items.length) return _menu(tenant, lead);
    const subtotal = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
    const store = await catalog.getStoreConfig(tenant.id);
    const frete = calcularFrete(items, store);
    const total = subtotal + frete;

    const order = await repo.createOrder(tenant.id, lead.id, items, subtotal, 0, frete, total);
    await repo.clearCart(lead.id);
    await repo.setFlowState(lead.id, ST.CHECKOUT_PAYMENT);

    // Notifica o contato do tenant
    const survey = await repo.getSurvey(lead.id);
    const answers = survey?.answers || {};
    await repo.setSurvey(lead.id, null);
    const surveyLines = Object.entries(answers).map(([k, v]) => `• ${k}: ${v}`).join('\n');
    const itensTxt = items.map(it => `${it.quantity}x ${it.product_name}`).join(', ');
    const { notifyTenant } = require('./notify');
    await notifyTenant(
      tenant,
      'NOVO PEDIDO',
      `Pedido: #${order.external_id}\nCliente: ${lead.full_name || '—'}\nItens: ${itensTxt}\nTotal: R$ ${total.toFixed(2)}\nStatus: aguardando pagamento${surveyLines ? '\nRespostas:\n' + surveyLines : ''}`,
      lead.phone
    );

    return ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'order_created_payment', {
      pedido: order.external_id, total: total.toFixed(2),
    }), [
      { id: 'PAY_PIX', title: 'PIX (5% off)' },
      { id: 'PAY_CREDIT', title: 'Cartão Crédito' },
      { id: 'PAY_DEBIT', title: 'Cartão Débito' },
    ], tenant);
  }

  return _menu(tenant, lead);
}

async function _checkoutConfirm(tenant, lead, answers) {
  const items = await repo.getCart(lead.id);
  if (!items.length) return _menu(tenant, lead);
  const sub = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  const store = await catalog.getStoreConfig(tenant.id);
  const frete = calcularFrete(items, store);
  const total = sub + frete;

  let resumo = await catalog.msg(tenant.id, 'checkout_confirm', {
    nome: lead.full_name,
    subtotal: sub.toFixed(2),
    frete: frete.toFixed(2),
    total: total.toFixed(2),
  });
  const extras = Object.entries(answers).filter(([, v]) => v);
  if (extras.length) resumo += '\n\n' + extras.map(([k, v]) => `• ${k}: ${v}`).join('\n');

  await repo.setFlowState(lead.id, ST.CHECKOUT_CONFIRM);
  return ws.sendButtons(lead.phone, resumo, [
    { id: 'ORDER_FINAL', title: 'Confirmar pedido' },
    { id: 'MENU_BACK', title: 'Cancelar' },
  ], tenant);
}

async function _handleSurveyAnswer(tenant, lead, text) {
  const data = await repo.getSurvey(lead.id);
  if (!data) return _menu(tenant, lead);
  const q = await catalog.getQuestionnaire(tenant.id, data.id);
  const question = q?.questions?.[data.idx];
  if (!question) return finishSurvey(tenant, lead, data);

  const answer = (text || '').trim();
  if (!answer && !question.optional) {
    return ws.sendText(lead.phone, 'Por favor, responda: ' + question.question, tenant);
  }
  data.answers[question.key] = answer;
  data.idx++;
  await repo.setSurvey(lead.id, data);

  const next = q.questions[data.idx];
  if (next) return ws.sendText(lead.phone, next.question, tenant);
  return finishSurvey(tenant, lead, data);
}

async function finishSurvey(tenant, lead, data) {
  const q = await catalog.getQuestionnaire(tenant.id, data.id);
  if (q) {
    const leadFields = {};
    for (const question of q.questions) {
      if (question.field && data.answers[question.key]) {
        leadFields[question.field] = data.answers[question.key];
      }
    }
    if (Object.keys(leadFields).length) await repo.updateLead(lead.id, leadFields);
  }
  if (data.id === 'checkout') {
    return _checkoutConfirm(tenant, lead, data.answers);
  }
  await repo.setSurvey(lead.id, null);
  return _menu(tenant, lead);
}

async function _processPayment(tenant, lead, method) {
  const orders = await repo.getLeadOrders(tenant.id, lead.id);
  const order = orders.find(o => o.status === 'pending');
  if (!order) return _menu(tenant, lead);
  await repo.setFlowState(lead.id, ST.MENU);

  try {
    if (method === 'pix') {
      const pix = await payment.criarPix(tenant, order, lead);
      await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'payment_pix', {
        pedido: order.external_id, total: pix.total.toFixed(2), qr: pix.pix_copy_paste,
      }), tenant);
    } else {
      const tipo = method === 'credit' ? 'credit' : 'debit';
      const checkout = await payment.criarCheckoutCartao(tenant, order, lead, tipo);
      const nome = tipo === 'credit' ? 'Cartão de Crédito' : 'Cartão de Débito';
      await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'payment_card', {
        pedido: order.external_id, tipo: nome, total: order.total.toFixed(2), link: checkout.checkout_url,
      }), tenant);
    }
  } catch (e) {
    console.error('[FLOW] Erro ao gerar pagamento:', e.message);
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'payment_error'), tenant);
  }
  return _menu(tenant, lead);
}

async function _support(tenant, lead, step, answer) {
  if (step === 'name') {
    await repo.updateLead(lead.id, { full_name: answer });
    await repo.setFlowState(lead.id, ST.SUPPORT_REASON);
    return ws.sendText(lead.phone, await catalog.msg(tenant.id, 'ask_support_reason'), tenant);
  }
  if (step === 'reason') {
    const name = lead.full_name || 'Cliente';
    const { notifyTenant } = require('./notify');
    await notifyTenant(
      tenant,
      'ATENDIMENTO SOLICITADO',
      `Nome: ${name}\nWhatsApp: ${lead.phone}\nMotivo: ${answer}`,
      lead.phone
    );
    await repo.setFlowState(lead.id, ST.MENU);
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'support_escalation'), tenant);
    return _menu(tenant, lead);
  }
}

async function _handleSobConsulta(tenant, lead, text) {
  const name = (text || '').trim();
  if (!name) return ws.sendText(lead.phone, 'Por favor, digite seu nome:', tenant);
  await repo.updateLead(lead.id, { full_name: name });

  const survey = await repo.getSurvey(lead.id) || {};
  const product = await catalog.findProduct(tenant.id, survey.quote);
  await repo.setSurvey(lead.id, null);

  const { notifyTenant } = require('./notify');
  await notifyTenant(
    tenant,
    'INTERESSE SOB CONSULTA',
    `Produto: ${product?.name || survey.quote || '—'}\nNome: ${name}\nWhatsApp: ${lead.phone}`,
    lead.phone
  );

  await repo.setFlowState(lead.id, ST.MENU);
  await ws.sendText(lead.phone, `Obrigado, ${name}! Um dos nossos consultores vai entrar em contato em breve.`, tenant);
  return _menu(tenant, lead);
}

async function showProductDetail(tenant, lead, productId) {
  const product = await catalog.findProduct(tenant.id, productId);
  if (!product) return ws.sendText(lead.phone, await catalog.msg(tenant.id, 'product_not_found'), tenant);

  const survey = (await repo.getSurvey(lead.id)) || {};
  survey.product = productId;
  await repo.setSurvey(lead.id, survey);

  await repo.setFlowState(lead.id, ST.PRODUCT_DETAIL);

  if (product.sob_consulta) {
    await ws.sendText(lead.phone, `*${product.name}*\n\n${product.long_description || product.short_description || ''}\n\n💬 *Preço sob consulta*`, tenant);
    await ws.sendButtons(lead.phone, 'Fale conosco para receber uma proposta:', [
      { id: `QUOTE_${product.id}`, title: '📞 Quero saber mais' },
      { id: 'MENU_BACK', title: '← Voltar' },
    ], tenant);
    return;
  }

  if (product.plans?.length) {
    await ws.sendText(lead.phone, `*${product.name}*\n\n${product.long_description || product.short_description || ''}`, tenant);
    await sendPlanList(tenant, lead, product);
  } else {
    await ws.sendText(lead.phone, `*${product.name}*\n\n${product.long_description || product.short_description || ''}\n\n💰 ${catalog.formatPrice(product.price)}`, tenant);
    await ws.sendButtons(lead.phone, 'O que deseja fazer?', [
      { id: `BUY_${product.id}`, title: '🛒 Comprar' },
      { id: 'MENU_BACK', title: '← Voltar' },
    ], tenant);
  }
}

async function sendPlanList(tenant, lead, product) {
  const rows = product.plans.map((pl, i) => ({
    id: `PLAN_${product.id}_${pl.id}`,
    title: `${i + 1}. ${pl.name}${pl.popular ? ' ★' : ''}`,
    description: pl.list_description
      ? pl.list_description
      : `${pl.price ? catalog.formatPrice(pl.price) : 'Sob medida'}/${pl.period} — ${(pl.features || '').split('\n')[0]}`,
  }));
  await ws.sendList(
    lead.phone,
    await catalog.msg(tenant.id, 'plans_title', { produto: product.name }),
    rows,
    'Planos disponíveis',
    'Toque no plano desejado',
    tenant
  );
}

async function showPlanDetail(tenant, lead, productId, planId) {
  const product = await catalog.findProduct(tenant.id, productId);
  const plan = product?.plans?.find(pl => pl.id === planId);
  if (!product || !plan) return _menu(tenant, lead);

  const redirectLink = plan.redirect_link || '';
  const paymentLink = plan.payment_link || '';
  const isRedirect = !!redirectLink || String(paymentLink).includes('wa.me');
  const link = redirectLink || paymentLink;

  const preco = plan.price ? `${catalog.formatPrice(plan.price)}/${plan.period}` : 'Sob medida';
  const texto = await catalog.msg(tenant.id, 'plan_detail', {
    produto: product.name,
    plano: plan.popular ? `${plan.name} ★` : plan.name,
    preco,
    recursos: plan.features || '',
  });

  await repo.setFlowState(lead.id, ST.PRODUCT_DETAIL);

  if (isRedirect) {
    await ws.sendText(lead.phone, `${texto}\n\nPara falar com a equipe, toque no link:\n\n🔗 ${link}`, tenant);
  } else {
    await ws.sendCtaButton(lead.phone, `${texto}\n\nPagamento seguro via Mercado Pago:`, 'Assinar Agora', paymentLink, tenant);
  }
}

// =============================================================
//  LICENÇA
// =============================================================
async function checkLicense(tenant) {
  const sub = await repo.getActiveSubscription(tenant.id);
  if (!sub) return false;
  if (!sub.expires_at) return true;
  return new Date(sub.expires_at).getTime() > Date.now();
}

// =============================================================
//  ENTRY POINT (chamado pelo webhook)
// =============================================================
async function processIncoming(tenant, phone, text, payload, messageId, numberId) {
  // Licença vencida → serviço pausado (1 aviso por dia ao admin)
  const active = await checkLicense(tenant);
  if (!active) {
    const lead = await repo.getOrCreateLead(tenant.id, phone);
    const todayKey = new Date().toISOString().slice(0, 10);
    if (lead.status !== `pausado:${todayKey}`) {
      await ws.sendText(phone, '🚫 *Serviço temporariamente pausado.*\n\nEntre em contato com a empresa para renovar.', tenant);
      await repo.updateLead(lead.id, { status: `pausado:${todayKey}` });
    }
    return;
  }

  const lead = await repo.getOrCreateLead(tenant.id, phone);
  if (numberId) await repo.updateLead(lead.id, { last_number_id: numberId });
  await repo.addMessage(tenant.id, phone, 'in', text || `[botão:${payload}]`);

  if (!payload && text) {
    const t = text.toLowerCase().trim();
    if (t === 'menu' || t === 'voltar' || t === 'inicio') return _menu(tenant, lead);
  }

  if (payload) {
    if (payload === 'MENU_SHOP')      return _categories(tenant, lead);
    if (payload === 'MENU_SUPPORT')   { await repo.setFlowState(lead.id, ST.SUPPORT_NAME); return ws.sendText(phone, await catalog.msg(tenant.id, 'ask_support_name'), tenant); }
    if (payload === 'MENU_TRACK')     {
      const orders = await repo.getLeadOrders(tenant.id, lead.id);
      if (!orders.length) await ws.sendText(phone, await catalog.msg(tenant.id, 'no_orders'), tenant);
      else await ws.sendText(phone, await catalog.msg(tenant.id, 'order_status', { pedido: orders[0].external_id, status: orders[0].status }), tenant);
      return _menu(tenant, lead);
    }
    if (payload === 'MENU_BACK')      return _menu(tenant, lead);
    if (payload.startsWith('CAT_'))   { const catId = payload.slice(4); return _products(tenant, lead, catId); }
    if (payload.startsWith('BUY_'))   { const pid = payload.slice(4); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.plans?.length) return sendPlanList(tenant, lead, prod); return _addToCart(tenant, lead, pid); }
    if (payload.startsWith('PLANS_')) { const pid = payload.slice(6); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.plans?.length) return sendPlanList(tenant, lead, prod); return _addToCart(tenant, lead, pid); }
    if (payload.startsWith('PLAN_'))  { const parts = payload.split('_'); const pid = parts.slice(1, -1).join('_'); const planId = parts[parts.length - 1]; return showPlanDetail(tenant, lead, pid, planId); }
    if (payload.startsWith('PROD_'))  { const pid = payload.slice(5); await showProductDetail(tenant, lead, pid); return; }
    if (payload.startsWith('DETAIL_')){ const pid = payload.slice(7); await showProductDetail(tenant, lead, pid); return; }
    if (payload === 'CART_SHOW')      return _cart(tenant, lead);
    if (payload === 'CART_BUY')       { await repo.setFlowState(lead.id, ST.CHECKOUT_NAME); return ws.sendText(phone, await catalog.msg(tenant.id, 'checkout_ask_name'), tenant); }
    if (payload === 'CART_CLEAR')     { await repo.clearCart(lead.id); await ws.sendText(phone, await catalog.msg(tenant.id, 'cart_cleared'), tenant); return _menu(tenant, lead); }
    if (payload === 'ORDER_FINAL')    return _checkout(tenant, lead, 'confirm', '');
    if (payload === 'PAY_PIX')        return _processPayment(tenant, lead, 'pix');
    if (payload === 'PAY_CREDIT')     return _processPayment(tenant, lead, 'credit');
    if (payload === 'PAY_DEBIT')      return _processPayment(tenant, lead, 'debit');
    if (payload.startsWith('QUOTE_')) { const pid = payload.slice(6); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.sob_consulta) { const s = (await repo.getSurvey(lead.id)) || {}; s.quote = pid; await repo.setSurvey(lead.id, s); await repo.setFlowState(lead.id, ST.SOB_CONSULTA_NAME); return ws.sendText(phone, 'Ótimo! Qual é o seu nome?', tenant); } return _menu(tenant, lead); }
    return _menu(tenant, lead);
  }

  const state = lead.flow_state;
  if (state === ST.CHECKOUT_NAME)     return _checkout(tenant, lead, 'name', text);
  if (state === ST.SURVEY)            return _handleSurveyAnswer(tenant, lead, text);
  if (state === ST.SOB_CONSULTA_NAME) return _handleSobConsulta(tenant, lead, text);
  if (state === ST.SUPPORT_NAME)      return _support(tenant, lead, 'name', text);
  if (state === ST.SUPPORT_REASON)    return _support(tenant, lead, 'reason', text);

  // Número do produto (fallback) dentro da listagem
  if (state === ST.PRODUCTS && /^\d{1,2}$/.test((text || '').trim())) {
    const survey = await repo.getSurvey(lead.id);
    const products = await catalog.getProductsByCategory(tenant.id, survey?.cat);
    const product = products[parseInt(text.trim(), 10) - 1];
    if (product) return showProductDetail(tenant, lead, product.id);
  }

  // Número do plano (fallback)
  if (state === ST.PRODUCT_DETAIL && /^\d{1,2}$/.test((text || '').trim())) {
    const survey = await repo.getSurvey(lead.id);
    const product = await catalog.findProduct(tenant.id, survey?.product);
    if (product?.plans?.length) {
      const plan = product.plans[parseInt(text.trim(), 10) - 1];
      if (plan) return showPlanDetail(tenant, lead, product.id, plan.id);
    }
  }

  return _menu(tenant, lead);
}

module.exports = { processIncoming, checkLicense };