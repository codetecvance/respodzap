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
  return (data.categories || []).map(c => ({
    id: c.id,
    name: c.name,
    emoji: c.emoji,
    count: (c.products || []).filter(p => p.available).length,
  }));
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

module.exports = {
  loadTenantCatalog, saveTenantCatalog, getCompanyInfo, getCategories,
  getProductsByCategory, findProduct, getStoreConfig, getMessages,
  getQuestionnaire, msg, formatPrice,
};