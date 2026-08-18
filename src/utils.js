/**
 * Funções utilitárias puras extraídas de flow-engine.js para facilitar testes.
 */

const DIAS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function minutos(h) {
  const [a, b] = String(h || '').split(':').map(Number);
  if (Number.isNaN(a)) return undefined;
  return a * 60 + (Number.isNaN(b) ? 0 : b);
}

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

function calcularFrete(items, store, bairro = null) {
  const allDigital = items.length > 0 && items.every((it) => it.digital);
  if (allDigital) return 0;
  const sub = items.reduce((s, it) => s + Number(it.unit_price) * it.quantity, 0);
  if (sub >= (store.delivery_free_full || 9999999)) return 0;
  if (bairro) {
    const area = (store.delivery_areas || []).find((a) => a.bairro === bairro);
    if (area) return Number(area.taxa) || 0;
  }
  return store.delivery_fee || 0;
}

function precisaBairro(store, items) {
  const allDigital = items.length > 0 && items.every((it) => it.digital);
  return !allDigital && Array.isArray(store.delivery_areas) && store.delivery_areas.length > 0;
}

function normTxt(v) {
  return String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function temAdicionais(product) {
  return Array.isArray(product.adicionais) && product.adicionais.length > 0;
}

function opcaoPreco(opcao) {
  const preco = Number(opcao.preco || 0);
  return preco > 0 ? ` (+R$ ${preco.toFixed(2)})` : '';
}

function formatarOpcoesSelecionadas(selections) {
  return (selections || []).map((g) => ({
    grupo: g.grupo,
    opcoes: (g.opcoes || []).map((o) => ({ nome: o.nome, preco: Number(o.preco || 0) })),
  }));
}

function productImageUrl(product, webhookUrl) {
  const image = product.image || '';
  if (/^https?:\/\//.test(image)) return image;
  return `${webhookUrl || ''}/images/${image || 'placeholder.png'}`;
}

module.exports = {
  DIAS_PT,
  minutos,
  estaAberto,
  calcularFrete,
  precisaBairro,
  normTxt,
  temAdicionais,
  opcaoPreco,
  formatarOpcoesSelecionadas,
  productImageUrl,
};
