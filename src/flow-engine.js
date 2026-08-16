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
  CHECKOUT_BAIRRO: 'CHECKOUT_BAIRRO',
  CHECKOUT_CONFIRM: 'CHECKOUT_CONFIRM',
  CHECKOUT_OBS: 'CHECKOUT_OBS',
  CHECKOUT_PAYMENT: 'CHECKOUT_PAYMENT',
  SURVEY: 'SURVEY',
  SOB_CONSULTA_NAME: 'SOB_CONSULTA_NAME',
  SUPPORT_NAME: 'SUPPORT_NAME',
  SUPPORT_REASON: 'SUPPORT_REASON',
  ADDONS: 'ADDONS',
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
  // Lista interativa (até 10 categorias) + fallback numérico
  const rows = cats.slice(0, 10).map(c => ({
    id: `CAT_${c.id}`,
    title: `${c.emoji || ''} ${c.name}`.slice(0, 24),
    description: `${c.count} produto(s)`,
  }));
  await ws.sendList(lead.phone, await catalog.msg(tenant.id, 'categories_title'), rows, 'Categorias', 'Toque na categoria desejada', tenant);
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

  // Imagem-menu: visão geral da categoria (gerada por /api/menu-image)
  const menuEnabled = data.store?.menu_image?.enabled !== false;
  if (menuEnabled && config.webhookUrl) {
    const sig = Buffer.from(products.map(p => `${p.id}|${p.price}|${p.image}|${p.name}`).join('#')).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    const menuUrl = `${config.webhookUrl}/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(categoryId)}&sig=${sig}`;
    await ws.sendImage(lead.phone, menuUrl, `${cat?.emoji || ''} ${cat?.name || 'Produtos'}`, tenant);
  }

  // Um card por produto: imagem compacta (miniatura à esquerda + textos à direita)
  // + mensagem de botões logo abaixo (o WhatsApp corta imagens de cards interativos)
  for (const p of products) {
    const hash = Buffer.from(`${p.id}|${p.price}|${p.image}|${p.name}`).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const bannerUrl = `${config.webhookUrl || ''}/api/product-image?tenant=${tenant.id}&pid=${encodeURIComponent(p.id)}&v=${hash}`;
    await ws.sendImage(lead.phone, bannerUrl, '', tenant);
    const preco = p.sob_consulta ? 'Sob consulta' : catalog.formatPrice(p.price);
    await ws.sendButtons(lead.phone, `*${p.name}* — ${preco}${p.unit ? ` (por ${p.unit})` : ''}`, [
      { id: `BUY_${p.id}`, title: String(await catalog.getButton(tenant.id, 'add_product')).slice(0, 20) },
      { id: `DETAIL_${p.id}`, title: String(await catalog.getButton(tenant.id, 'detail')).slice(0, 20) },
    ], tenant);
  }

  await ws.sendButtons(lead.phone, `Fim de *${cat?.name || 'Produtos'}* — escolha outro item ou volte.`, [
    { id: 'MENU_SHOP', title: String(await catalog.getButton(tenant.id, 'back')).slice(0, 20) },
    { id: 'CART_SHOW', title: String(await catalog.getButton(tenant.id, 'cart_show')).slice(0, 20) },
  ], tenant);
  await repo.setFlowState(lead.id, ST.PRODUCTS);
}

/**
 * Exibe preço formatado ou "Sob consulta".
 */
async function precoExibicao(tenantId, product) {
  if (product.sob_consulta) return 'Sob consulta';
  return catalog.formatPrice(product.price);
}

// ================================================================
//  HORÁRIO DE FUNCIONAMENTO (ramos de operação — bloqueio de pedidos)
// ================================================================
const DIAS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function minutos(h) {
  const [a, b] = String(h || '').split(':').map(Number);
  if (Number.isNaN(a)) return undefined;
  return a * 60 + (Number.isNaN(b) ? 0 : b);
}

/**
 * Verifica se a loja está aberta agora.
 * store.hours: { "0": {open, close}, ... } — chave = dia (0=domingo..6=sábado); ausente = fechado.
 * Sem store.hours → sempre aberto.
 */
function estaAberto(store) {
  const hours = store?.hours;
  if (!hours || typeof hours !== 'object') return { aberto: true };
  const cfg = hours[String(new Date().getDay())];
  if (!cfg) return { aberto: false };
  const min = new Date().getHours() * 60 + new Date().getMinutes();
  const open = minutos(cfg.open);
  const close = minutos(cfg.close);
  if (open === undefined || close === undefined) return { aberto: false };
  const aberto = open <= close ? (min >= open && min <= close) : (min >= open || min <= close);
  return { aberto, open: cfg.open, close: cfg.close };
}

/**
 * Bloqueia pedidos fora do horário (exceto ramo vendas). Retorna true se pode prosseguir.
 */
async function _checaHorario(tenant, lead) {
  let seg = tenant.segment_name;
  if (!seg) {
    const s = await repo.getTenantSegment(tenant.id);
    seg = s?.name;
  }
  if (!seg || seg === 'vendas') return true;
  const store = await catalog.getStoreConfig(tenant.id);
  const s = estaAberto(store);
  if (s.aberto) return true;
  const diaNome = DIAS_PT[new Date().getDay()];
  const horario = s.open ? `hoje das *${s.open}* às *${s.close}*` : `hoje (*${diaNome}* fechado)`;
  let texto = await catalog.msg(tenant.id, 'store_closed', { horario, dia: diaNome });
  if (!texto) texto = `😔 Estamos fechados agora — ${horario}.\n\nVolte mais tarde!`;
  await ws.sendText(lead.phone, texto, tenant);
  await repo.setFlowState(lead.id, ST.MENU);
  return false;
}

// ================================================================
//  ADICIONAIS (grupos de opções com preço — restaurante/delivery)
// ================================================================

function temAdicionais(product) {
  return Array.isArray(product.adicionais) && product.adicionais.length > 0;
}

function opcaoPreco(opcao) {
  const preco = Number(opcao.preco || 0);
  return preco > 0 ? ` (+R$ ${preco.toFixed(2)})` : '';
}

function formatarOpcoesSelecionadas(selections) {
  return (selections || []).map(g => ({
    grupo: g.grupo,
    opcoes: (g.opcoes || []).map(o => ({ nome: o.nome, preco: Number(o.preco || 0) })),
  }));
}

async function _askAddonGroup(tenant, lead, product, grupoIdx) {
  const grupo = product.adicionais[grupoIdx];
  const lines = grupo.opcoes.map((o, i) => `${i + 1}. ${o.nome}${opcaoPreco(o)}`).join('\n');
  const limite = grupo.unico ? 'Escolha *1* opção' : (grupo.max ? `Escolha até *${grupo.max}* opções` : 'Escolha quantas quiser');
  const txt = `*${product.name}* — escolha o *${grupo.grupo}*:\n\n${lines}\n\n${limite}\n\nResponda com o(s) número(s), ex: *1,3*`;
  await ws.sendText(lead.phone, txt, tenant);
}

async function _startAddons(tenant, lead, product) {
  const survey = (await repo.getSurvey(lead.id)) || {};
  survey.addons = { productId: product.id, grupoIdx: 0, selections: [] };
  await repo.setSurvey(lead.id, survey);
  await repo.setFlowState(lead.id, ST.ADDONS);
  await _askAddonGroup(tenant, lead, product, 0);
}

async function _finishAddons(tenant, lead, product, selections) {
  await repo.setSurvey(lead.id, null);
  await repo.addToCart(tenant.id, lead.id, product, formatarOpcoesSelecionadas(selections));
  const count = await repo.cartCount(lead.id);
  const extra = repo.formatAddons(formatarOpcoesSelecionadas(selections));
  await ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'added_to_cart', { produto: extra ? `${product.name} (${extra})` : product.name, total: count }), [
    { id: 'MENU_SHOP', title: await catalog.getButton(tenant.id, 'add_to_cart') },
    { id: 'CART_SHOW', title: await catalog.getButton(tenant.id, 'cart_show') },
  ], tenant);
  await repo.setFlowState(lead.id, ST.MENU);
}

async function _handleAddonsAnswer(tenant, lead, text) {
  const survey = await repo.getSurvey(lead.id);
  const state = survey?.addons;
  if (!state) return _menu(tenant, lead);
  const product = await catalog.findProduct(tenant.id, state.productId);
  if (!product) return _menu(tenant, lead);
  const grupo = product.adicionais[state.grupoIdx];
  if (!grupo) return _finishAddons(tenant, lead, product, state.selections);

  const nums = String(text || '').trim().split(/[\s,;/]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= grupo.opcoes.length);
  const unicos = [...new Set(nums)];
  const limite = grupo.unico ? 1 : (grupo.max || grupo.opcoes.length);
  const valido = unicos.length > 0 && unicos.length <= limite && unicos.length === nums.length;
  if (!valido) {
    await ws.sendText(lead.phone, `Hmm, resposta inválida para *${grupo.grupo}*.\n\n${grupo.unico ? 'Escolha apenas 1 opção' : `Escolha até ${grupo.max || grupo.opcoes.length} opções`}, ex: *1,3*`, tenant);
    return _askAddonGroup(tenant, lead, product, state.grupoIdx);
  }

  state.selections.push({
    grupo: grupo.grupo,
    opcoes: unicos.map(n => ({ nome: grupo.opcoes[n - 1].nome, preco: Number(grupo.opcoes[n - 1].preco || 0) })),
  });
  state.grupoIdx++;
  await repo.setSurvey(lead.id, survey);

  const proximo = product.adicionais[state.grupoIdx];
  if (proximo) return _askAddonGroup(tenant, lead, product, state.grupoIdx);
  await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'addon_done'), tenant);
  return _finishAddons(tenant, lead, product, state.selections);
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
  await repo.addToCart(tenant.id, lead.id, product);
  const count = await repo.cartCount(lead.id);
  await ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'added_to_cart', { produto: product.name, total: count }), [
    { id: 'MENU_SHOP', title: await catalog.getButton(tenant.id, 'add_to_cart') },
    { id: 'CART_SHOW', title: await catalog.getButton(tenant.id, 'cart_show') },
  ], tenant);
  await repo.setFlowState(lead.id, ST.MENU);
}

/**
 * Calcula frete: produtos digitais (SaaS) não têm frete.
 * Com bairro selecionado, usa a taxa da área de entrega.
 */
function calcularFrete(items, store, bairro = null) {
  const allDigital = items.length > 0 && items.every(it => it.digital);
  if (allDigital) return 0;
  const sub = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  if (sub >= (store.delivery_free_full || 9999999)) return 0;
  if (bairro) {
    const area = (store.delivery_areas || []).find(a => a.bairro === bairro);
    if (area) return Number(area.taxa) || 0;
  }
  return store.delivery_fee || 0;
}

/**
 * Deve perguntar o bairro? Sim, quando há áreas de entrega
 * e o carrinho não é 100% digital.
 */
function precisaBairro(store, items) {
  const allDigital = items.length > 0 && items.every(it => it.digital);
  return !allDigital && Array.isArray(store.delivery_areas) && store.delivery_areas.length > 0;
}

function normTxt(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Pergunta o bairro de entrega (lista + opção de retirada no local).
 */
async function _askBairro(tenant, lead, answers) {
  const store = await catalog.getStoreConfig(tenant.id);
  // Reserva o último slot da lista para "Retirar no local"
  const rows = (store.delivery_areas || []).slice(0, 9).map((a, i) => ({
    id: `BAIRRO_${encodeURIComponent(a.bairro)}`,
    title: `${i + 1}. ${a.bairro}`,
    description: a.taxa > 0 ? `Taxa de entrega: R$ ${Number(a.taxa).toFixed(2)}` : 'Entrega grátis',
  }));
  rows.push({ id: 'BAIRRO_RETIRADA', title: 'Retirar no local', description: 'Sem taxa de entrega' });

  const survey = await repo.getSurvey(lead.id);
  const pending = { id: 'checkout', answers: answers || {}, idx: survey?.id === 'checkout' ? survey.idx : 0, pendingBairro: true };
  await repo.setSurvey(lead.id, pending);
  await repo.setFlowState(lead.id, ST.CHECKOUT_BAIRRO);

  await ws.sendList(
    lead.phone,
    '🛵 Qual o *bairro de entrega*?',
    rows,
    'Bairro de entrega',
    'Toque no bairro ou digite o nome',
    tenant
  );
}

/**
 * Trata a escolha do bairro (payload da lista ou texto digitado).
 */
async function _handleBairro(tenant, lead, text, payload) {
  const survey = await repo.getSurvey(lead.id);
  if (survey?.id !== 'checkout' || !survey.pendingBairro) return _menu(tenant, lead);
  const store = await catalog.getStoreConfig(tenant.id);
  const areas = store.delivery_areas || [];

  let bairro = null;
  if (payload?.startsWith('BAIRRO_')) {
    const raw = decodeURIComponent(payload.slice(7));
    if (raw !== 'RETIRADA') bairro = raw;
  } else {
    const t = normTxt(text);
    if (!t) {
      return ws.sendText(lead.phone, 'Digite o nome do seu bairro ou toque em *Retirar no local*:', tenant);
    }
    if (['retirar', 'retirada', 'buscar', 'balcao', 'balcão'].includes(t) || t.includes('retirar no local')) {
      bairro = null;
    } else {
      const match = areas.find(a => normTxt(a.bairro) === t);
      if (!match) {
        // Fora da área: bloqueia com aviso + sugestão de contato
        const wa = (tenant.contact_phone || '').replace(/[^\d]/g, '');
        const link = wa ? `https://wa.me/${wa}?text=${encodeURIComponent('Olá! Quero fazer um pedido mas meu bairro está fora da área de entrega.')}` : null;
        await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'out_of_area'), tenant);
        if (link) await ws.sendText(lead.phone, `🔗 Fale conosco para retirada no local:\n\n${link}`, tenant);
        await repo.setFlowState(lead.id, ST.MENU);
        return _menu(tenant, lead);
      }
      bairro = match.bairro;
    }
  }

  survey.checkoutBairro = { bairro, taxa: bairro ? calcularFrete([], store, bairro) : 0 };
  delete survey.pendingBairro;
  await repo.setSurvey(lead.id, survey);
  return _checkoutConfirm(tenant, lead, survey.answers || {});
}

/**
 * Frete final do pedido: usa a taxa do bairro escolhido (ou 0 na retirada)
 * quando o bairro foi perguntado; senão, a regra padrão.
 */
function freteDoPedido(items, store, checkoutBairro) {
  if (checkoutBairro) return Number(checkoutBairro.taxa) || 0;
  return calcularFrete(items, store, null);
}

/**
 * Lista formatada dos itens do carrinho (com adicionais e quantidades).
 */
function resumoItens(items) {
  const linhas = items.map((it, i) => `${i + 1}. ${it.product_name}${repo.formatAddons(it.addons) ? ` (${repo.formatAddons(it.addons)})` : ''} — ${it.quantity}x R$ ${Number(it.unit_price).toFixed(2)}`);
  return `*Seu pedido:*\n${linhas.join('\n')}`;
}

async function _cart(tenant, lead) {
  const items = await repo.getCart(lead.id);
  if (!items.length) {
    await ws.sendText(lead.phone, await catalog.msg(tenant.id, 'cart_empty'), tenant);
    return _categories(tenant, lead);
  }
  let txt = resumoItens(items) + '\n\n';
  let total = 0;
  items.forEach(it => {
    total += Number(it.unit_price) * it.quantity;
  });
  txt += '\n' + (await catalog.msg(tenant.id, 'cart_total', { total: total.toFixed(2) }));

  await ws.sendButtons(lead.phone, txt, [
    { id: 'CART_BUY', title: await catalog.getButton(tenant.id, 'cart_buy') },
    { id: 'CART_CLEAR', title: await catalog.getButton(tenant.id, 'cart_clear') },
    { id: 'MENU_SHOP', title: await catalog.getButton(tenant.id, 'add_more') },
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
    return _afterCheckoutSurvey(tenant, lead, {});
  }

  if (step === 'confirm') {
    const items = await repo.getCart(lead.id);
    if (!items.length) return _menu(tenant, lead);
    const subtotal = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
    const store = await catalog.getStoreConfig(tenant.id);
    const survey = await repo.getSurvey(lead.id);
    const frete = freteDoPedido(items, store, survey?.checkoutBairro);
    const total = subtotal + frete;

    const order = await repo.createOrder(tenant.id, lead.id, items, subtotal, 0, frete, total);
    await repo.clearCart(lead.id);

    // Último passo antes do pagamento: observação/alteração
    await repo.setSurvey(lead.id, { orderId: order.id, answers: survey?.answers || {}, checkoutBairro: survey?.checkoutBairro || null });
    await repo.setFlowState(lead.id, ST.CHECKOUT_OBS);
    let q = await catalog.msg(tenant.id, 'ask_observations');
    if (!q) q = 'Alguma observação ou alteração no pedido? (ex: sem cebola, ponto da carne) — responda *nenhuma* para continuar.';
    return ws.sendText(lead.phone, q, tenant);
  }

  return _menu(tenant, lead);
}

/**
 * Trata a resposta de observação e vai para o pagamento.
 */
async function _handleObservations(tenant, lead, text) {
  const survey = await repo.getSurvey(lead.id);
  if (!survey?.orderId) return _menu(tenant, lead);
  const order = await repo.getOrder(survey.orderId);
  if (!order) return _menu(tenant, lead);

  const t = String(text || '').trim();
  const obs = (!t || /^(nenhuma|nao|não|sem obs|sem observacao|sem observação|-|x)$/i.test(t)) ? '' : t.slice(0, 500);
  if (obs) await repo.updateOrderObservations(order.id, obs);

  const answers = survey.answers || {};
  const bairro = survey.checkoutBairro?.bairro || null;
  await repo.setSurvey(lead.id, null);

  await _notifyOrderCreated(tenant, lead, order, answers, bairro, obs);
  return _sendPaymentButtons(tenant, lead, order);
}

/**
 * Notifica o dono do novo pedido (itens, bairro, observações, total).
 */
async function _notifyOrderCreated(tenant, lead, order, answers, bairro, obs) {
  const items = await repo.getOrderItems(order.id);
  const surveyLines = Object.entries(answers).map(([k, v]) => `• ${k}: ${v}`).join('\n');
  const itensTxt = items.map(it => `${it.quantity}x ${it.product_name}${repo.formatAddons(it.addons) ? ` (${repo.formatAddons(it.addons)})` : ''}`).join(', ');
  const { notifyTenant } = require('./notify');
  await notifyTenant(
    tenant,
    'NOVO PEDIDO',
    `Pedido: #${order.external_id}\nCliente: ${lead.full_name || '—'}\nItens: ${itensTxt}\n${bairro ? `Bairro: ${bairro}\n` : ''}Entrega: R$ ${Number(order.delivery_fee || 0).toFixed(2)}\nTotal: R$ ${Number(order.total || 0).toFixed(2)}\nStatus: aguardando pagamento${obs ? `\n📝 Observações: ${obs}` : ''}${surveyLines ? '\nRespostas:\n' + surveyLines : ''}`,
    lead.phone
  );
}

/**
 * Botões de pagamento do pedido recém-criado.
 */
async function _sendPaymentButtons(tenant, lead, order) {
  await repo.setFlowState(lead.id, ST.CHECKOUT_PAYMENT);
  return ws.sendButtons(lead.phone, await catalog.msg(tenant.id, 'order_created_payment', {
    pedido: order.external_id, total: Number(order.total || 0).toFixed(2),
  }), [
    { id: 'PAY_PIX', title: await catalog.getButton(tenant.id, 'pay_pix') },
    { id: 'PAY_CREDIT', title: await catalog.getButton(tenant.id, 'pay_credit') },
    { id: 'PAY_DEBIT', title: await catalog.getButton(tenant.id, 'pay_debit') },
  ], tenant);
}

/**
 * Depois do nome/questionário: pergunta o bairro (se a loja tem áreas)
 * ou vai direto para a confirmação.
 */
async function _afterCheckoutSurvey(tenant, lead, answers) {
  const items = await repo.getCart(lead.id);
  const store = await catalog.getStoreConfig(tenant.id);
  if (precisaBairro(store, items)) return _askBairro(tenant, lead, answers);
  return _checkoutConfirm(tenant, lead, answers);
}

async function _checkoutConfirm(tenant, lead, answers) {
  const items = await repo.getCart(lead.id);
  if (!items.length) return _menu(tenant, lead);
  const sub = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  const store = await catalog.getStoreConfig(tenant.id);
  const survey = await repo.getSurvey(lead.id);
  const frete = freteDoPedido(items, store, survey?.checkoutBairro);
  const bairro = survey?.checkoutBairro?.bairro || null;
  const total = sub + frete;

  let resumo = resumoItens(items) + '\n\n';
  resumo += await catalog.msg(tenant.id, 'checkout_confirm', {
    nome: lead.full_name,
    subtotal: sub.toFixed(2),
    frete: frete.toFixed(2),
    total: total.toFixed(2),
  });
  if (bairro) resumo += `\n\n🛵 Bairro: *${bairro}* (entrega R$ ${frete.toFixed(2)})`;
  const extras = Object.entries(answers).filter(([, v]) => v);
  if (extras.length) resumo += '\n\n' + extras.map(([k, v]) => `• ${k}: ${v}`).join('\n');

  await repo.setFlowState(lead.id, ST.CHECKOUT_CONFIRM);
  return ws.sendButtons(lead.phone, resumo, [
    { id: 'ORDER_FINAL', title: await catalog.getButton(tenant.id, 'confirm_order') },
    { id: 'MENU_SHOP', title: await catalog.getButton(tenant.id, 'add_more') },
    { id: 'MENU_BACK', title: await catalog.getButton(tenant.id, 'cancel') },
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
    return _afterCheckoutSurvey(tenant, lead, data.answers);
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
      const storeConf = await catalog.getStoreConfig(tenant.id);
      const desc = Number(storeConf.pix_discount_percent || 0);
      const pix = await payment.criarPix(tenant, order, lead);
      let texto = await catalog.msg(tenant.id, 'payment_pix', {
        pedido: order.external_id, total: pix.total.toFixed(2), qr: pix.pix_copy_paste,
        desconto_info: desc > 0 ? ` (desconto de ${desc}% aplicado)` : '',
      });
      if (!texto) texto = `✅ *Pedido ${order.external_id}*\n\n💵 Pagamento via *PIX*\n💰 Total: R$ ${pix.total.toFixed(2)}${desc > 0 ? ` (desconto de ${desc}% aplicado)` : ''}\n\n*1️⃣* Escaneie o QR Code abaixo, ou\n*2️⃣* Use o *PIX copia e cola*:\n\n\`\`\`\n${pix.pix_copy_paste}\n\`\`\`\n\n⏳ Assim que o pagamento for aprovado, você recebe a confirmação automática aqui.`;
      await ws.sendText(lead.phone, texto, tenant);
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
    const titulo = (await catalog.msg(tenant.id, 'support_notify_title')) || 'ATENDIMENTO SOLICITADO';
    let corpo = await catalog.msg(tenant.id, 'support_notify_body', { nome: name, telefone: lead.phone, motivo: answer });
    if (!corpo) corpo = `Nome: ${name}\nWhatsApp: ${lead.phone}\nMotivo: ${answer}`;
    await notifyTenant(tenant, titulo, corpo, lead.phone);
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
      { id: `QUOTE_${product.id}`, title: await catalog.getButton(tenant.id, 'quote') },
      { id: 'MENU_BACK', title: await catalog.getButton(tenant.id, 'back') },
    ], tenant);
    return;
  }

  if (product.plans?.length) {
    await ws.sendText(lead.phone, `*${product.name}*\n\n${product.long_description || product.short_description || ''}`, tenant);
    await sendPlanList(tenant, lead, product);
  } else {
    await ws.sendText(lead.phone, `*${product.name}*\n\n${product.long_description || product.short_description || ''}\n\n💰 ${catalog.formatPrice(product.price)}`, tenant);
    await ws.sendButtons(lead.phone, 'O que deseja fazer?', [
      { id: `BUY_${product.id}`, title: await catalog.getButton(tenant.id, 'buy') },
      { id: 'MENU_BACK', title: await catalog.getButton(tenant.id, 'back') },
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
    if (payload.startsWith('BUY_'))   { if (!(await _checaHorario(tenant, lead))) return; const pid = payload.slice(4); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.plans?.length) return sendPlanList(tenant, lead, prod); if (prod && temAdicionais(prod)) return _startAddons(tenant, lead, prod); return _addToCart(tenant, lead, pid); }
    if (payload.startsWith('PLANS_')) { const pid = payload.slice(6); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.plans?.length) return sendPlanList(tenant, lead, prod); return _addToCart(tenant, lead, pid); }
    if (payload.startsWith('PLAN_'))  { const parts = payload.split('_'); const pid = parts.slice(1, -1).join('_'); const planId = parts[parts.length - 1]; return showPlanDetail(tenant, lead, pid, planId); }
    if (payload.startsWith('PROD_'))  { const pid = payload.slice(5); await showProductDetail(tenant, lead, pid); return; }
    if (payload.startsWith('DETAIL_')){ const pid = payload.slice(7); await showProductDetail(tenant, lead, pid); return; }
    if (payload === 'CART_SHOW')      return _cart(tenant, lead);
    if (payload.startsWith('BAIRRO_')) return _handleBairro(tenant, lead, '', payload);
    if (payload === 'CART_BUY')       { if (!(await _checaHorario(tenant, lead))) return; await repo.setFlowState(lead.id, ST.CHECKOUT_NAME); return ws.sendText(phone, await catalog.msg(tenant.id, 'checkout_ask_name'), tenant); }
    if (payload === 'CART_CLEAR')     { await repo.clearCart(lead.id); await ws.sendText(phone, await catalog.msg(tenant.id, 'cart_cleared'), tenant); return _menu(tenant, lead); }
    if (payload === 'ORDER_FINAL')    return _checkout(tenant, lead, 'confirm', '');
    if (payload === 'PAY_PIX')        return _processPayment(tenant, lead, 'pix');
    if (payload === 'PAY_CREDIT')     return _processPayment(tenant, lead, 'credit');
    if (payload === 'PAY_DEBIT')      return _processPayment(tenant, lead, 'debit');
    if (payload.startsWith('QUOTE_')) { const pid = payload.slice(6); const prod = await catalog.findProduct(tenant.id, pid); if (prod?.sob_consulta) { const s = (await repo.getSurvey(lead.id)) || {}; s.quote = pid; await repo.setSurvey(lead.id, s); await repo.setFlowState(lead.id, ST.SOB_CONSULTA_NAME); return ws.sendText(phone, 'Ótimo! Qual é o seu nome?', tenant); } return _menu(tenant, lead); }
    return _menu(tenant, lead);
  }

  const state = lead.flow_state;
  if (state === ST.ADDONS)            return _handleAddonsAnswer(tenant, lead, text);
  if (state === ST.CHECKOUT_BAIRRO)   return _handleBairro(tenant, lead, text, null);
  if (state === ST.CHECKOUT_OBS)      return _handleObservations(tenant, lead, text);
  if (state === ST.CHECKOUT_NAME)     return _checkout(tenant, lead, 'name', text);
  if (state === ST.SURVEY)            return _handleSurveyAnswer(tenant, lead, text);
  if (state === ST.SOB_CONSULTA_NAME) return _handleSobConsulta(tenant, lead, text);
  if (state === ST.SUPPORT_NAME)      return _support(tenant, lead, 'name', text);
  if (state === ST.SUPPORT_REASON)    return _support(tenant, lead, 'reason', text);

  // Número da categoria (fallback) dentro da listagem
  if (state === ST.CATEGORIES && /^\d{1,2}$/.test((text || '').trim())) {
    const cats = await catalog.getCategories(tenant.id);
    const cat = cats[parseInt(text.trim(), 10) - 1];
    if (cat) return _products(tenant, lead, cat.id);
  }

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