const fs = require('fs');
const path = require('path');
const repo = require('./repository');

const CACHE_TTL_MS = 15000;
const cache = new Map(); // tenantId -> { catalog, at }

const TEMPLATE_PATH = path.join(__dirname, 'catalog-template.json');

function defaultCatalog() {
  try {
    return JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
  } catch {
    return { company: {}, categories: [], store: {}, messages: {}, questionnaires: {} };
  }
}

/**
 * Carrega o catálogo do tenant (banco) com cache curto (15s).
 */
async function loadTenantCatalog(tenantId, force = false) {
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.catalog;
  let catalog = await repo.getTenantCatalog(tenantId);
  if (!catalog) catalog = defaultCatalog();
  cache.set(tenantId, { catalog, at: now });
  return catalog;
}

/**
 * Salva o catálogo do tenant no banco.
 */
async function saveTenantCatalog(tenantId, catalog) {
  cache.set(tenantId, { catalog, at: Date.now() });
  await repo.saveTenantCatalog(tenantId, catalog);
}

async function getCompanyInfo(tenantId) {
  return (await loadTenantCatalog(tenantId)).company;
}

async function getCategories(tenantId) {
  const data = await loadTenantCatalog(tenantId);
  return (data.categories || [])
    .map(c => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      count: (c.products || []).filter(p => p.available).length,
    }))
    .filter(c => c.count > 0);
}

async function getProductsByCategory(tenantId, categoryId) {
  const data = await loadTenantCatalog(tenantId);
  const cat = (data.categories || []).find(c => c.id === categoryId);
  if (!cat) return [];
  return (cat.products || []).filter(p => p.available);
}

async function findProduct(tenantId, productId) {
  const data = await loadTenantCatalog(tenantId);
  for (const cat of data.categories || []) {
    const product = (cat.products || []).find(p => p.id === productId && p.available);
    if (product) return product;
  }
  return null;
}

async function getStoreConfig(tenantId) {
  return (await loadTenantCatalog(tenantId)).store || {};
}

async function getMessages(tenantId) {
  return (await loadTenantCatalog(tenantId)).messages || {};
}

async function getQuestionnaire(tenantId, id) {
  const data = await loadTenantCatalog(tenantId);
  return data.questionnaires?.[id] || null;
}

async function msg(tenantId, key, vars = {}) {
  let text = (await getMessages(tenantId))[key] || '';
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{${k}}`).join(String(v ?? ''));
  }
  return text;
}

function formatPrice(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

/**
 * Identidade visual por ramo (painel + imagem do menu).
 * sidebar: [cor1, cor2] do gradiente do painel do cliente.
 */
const SEGMENT_THEMES = {
  vendas:       { headerBg: '#1e3a8a', priceColor: '#1d4ed8', sidebar: ['#0f172a', '#1e3a8a'], active: '#2563eb', name: 'Vendas' },
  restaurante:  { headerBg: '#991b1b', priceColor: '#b45309', sidebar: ['#450a0a', '#991b1b'], active: '#dc2626', name: 'Restaurante' },
  delivery:     { headerBg: '#b45309', priceColor: '#b91c1c', sidebar: ['#431407', '#b45309'], active: '#d97706', name: 'Delivery' },
  padaria:      { headerBg: '#92400e', priceColor: '#a16207', sidebar: ['#451a03', '#92400e'], active: '#b45309', name: 'Padaria & Confeitaria' },
  estetica:     { headerBg: '#9d174d', priceColor: '#db2777', sidebar: ['#500724', '#9d174d'], active: '#db2777', name: 'Beleza & Estética' },
  baterias:     { headerBg: '#1e3a8a', priceColor: '#3b82f6', sidebar: ['#1e3a8a', '#1e40af'], active: '#3b82f6', name: 'Baterias' },
};

function segmentTheme(segmentName) {
  return SEGMENT_THEMES[segmentName] || SEGMENT_THEMES.vendas;
}

/**
 * Nomes padrão de todos os botões do bot (editáveis no painel).
 */
const DEFAULT_BUTTONS = {
  menu_shop: 'Comprar',
  menu_support: 'Atendente',
  menu_track: 'Meus Pedidos',
  back: '← Voltar',
  buy: '🛒 Comprar',
  quote: '📞 Quero saber mais',
  add_product: '🛒 Adicionar ao carrinho',
  detail: '📋 Detalhes',
  add_to_cart: 'Continuar comprando',
  cart_show: 'Ver carrinho',
  cart_buy: 'Finalizar pedido',
  cart_clear: 'Esvaziar carrinho',
  add_more: '➕ Adicionar mais itens',
  confirm_order: '✅ Confirmar pedido',
  cancel: '❌ Cancelar',
  pay_pix: 'PIX (5% off)',
  pay_credit: 'Cartão Crédito',
  pay_debit: 'Cartão Débito',
  list_button: 'Ver opções',
};

/**
 * Nome do botão do tenant (com fallback para o padrão).
 */
async function getButton(tenantId, key) {
  if (!tenantId) return DEFAULT_BUTTONS[key] || key;
  const data = await loadTenantCatalog(tenantId);
  return (data.buttons && data.buttons[key]) || DEFAULT_BUTTONS[key] || key;
}

/**
 * Todos os botões do tenant (defaults mesclados com os personalizados).
 */
async function getButtons(tenantId) {
  const data = await loadTenantCatalog(tenantId);
  return { ...DEFAULT_BUTTONS, ...(data.buttons || {}) };
}

// ============================================================
//  BASE DE DADOS DE VEÍCULOS (marcas/modelos/baterias)
// ============================================================
const _VEHICLE_DB_RAW = require('./carros-baterias.json');

/**
 * Carrega a base de dados de veículos (carregada via require na inicialização).
 */
async function loadVehicleDatabase() {
  return _VEHICLE_DB_RAW;
}

/**
 * Busca a bateria recomendada para um veículo.
 * @returns {Object} { encontrado, marca, modelo, capacidade, tensao, polaridade, tecnologia, medidas, aviso }
 */
function findBatteryForVehicle(brand, model, year) {
  const db = _VEHICLE_DB_RAW || { marcas: [] };
  const marca = db.marcas?.find(m => m.marca.toLowerCase() === brand.toLowerCase());
  if (!marca) return { encontrado: false, bateria: 'Consultar' };

  // Busca exata por modelo
  let modelo = marca.modelos?.find(m => m.modelo.toLowerCase() === model.toLowerCase());
  if (!modelo) {
    // Busca parcial (contém)
    modelo = marca.modelos?.find(m =>
      model.toLowerCase().includes(m.modelo.toLowerCase()) ||
      m.modelo.toLowerCase().includes(model.toLowerCase()),
    );
  }
  if (!modelo) return { encontrado: false, bateria: 'Consultar', marca: marca.marca };

  const bat = modelo.bateria;
  const spec = bat && typeof bat === 'object' ? bat : { capacidade: bat };
  if (!spec.capacidade || spec.capacidade === 'Consultar') {
    return { encontrado: false, bateria: 'Consultar', marca: marca.marca, modelo: modelo.modelo };
  }

  const result = {
    encontrado: true,
    marca: marca.marca,
    modelo: modelo.modelo,
    capacidade: spec.capacidade,
    tensao: spec.tensao || '12V',
    polaridade: spec.polaridade || 'PD (polo positivo à direita)',
    tecnologia: spec.tecnologia || 'Convencional (livre de manutenção)',
    medidas: spec.medidas || '',
  };

  // Valida ano se fornecido
  if (year && typeof modelo.anos === 'string' && modelo.anos !== 'Qualquer') {
    const [ini, fim] = modelo.anos.split('-').map(Number);
    if (year < ini || year > fim) {
      result.aviso = `Ano fora da faixa ${modelo.anos}`;
    }
  }

  return result;
}

module.exports = {
  loadTenantCatalog, saveTenantCatalog, getCompanyInfo, getCategories,
  getProductsByCategory, findProduct, getStoreConfig, getMessages,
  getQuestionnaire, msg, formatPrice, segmentTheme, getButton, getButtons, DEFAULT_BUTTONS,
  loadVehicleDatabase, findBatteryForVehicle,
};