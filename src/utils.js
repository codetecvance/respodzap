/**
 * Funções utilitárias puras extraídas de flow-engine.js para facilitar testes.
 */

const DIAS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function minutos(h) {
  const [a, b] = String(h || '').split(':').map(Number);
  if (Number.isNaN(a)) return undefined;
  return a * 60 + (Number.isNaN(b) ? 0 : b);
}

function getCurrentTimeInTimezone(timezone) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const parts = formatter.formatToParts(now);
    let hour = 0, minute = 0, weekday = 0;
    for (const part of parts) {
      if (part.type === 'hour') hour = parseInt(part.value, 10);
      else if (part.type === 'minute') minute = parseInt(part.value, 10);
      else if (part.type === 'weekday') {
        const weekdayMap = {
          dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sáb: 6, sábado: 6,
          'dom.': 0, 'seg.': 1, 'ter.': 2, 'qua.': 3, 'qui.': 4, 'sex.': 5, 'sáb.': 6,
          mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
        };
        weekday = weekdayMap[part.value.toLowerCase()] ?? 0;
      }
    }
    // Se weekday não foi mapeado (0 mas não é domingo), usa fallback UTC
    const nowUtc = new Date();
    if (weekday === 0 && nowUtc.getUTCDay() !== 0) {
      weekday = nowUtc.getUTCDay();
    }
    return { hour, minute, weekday };
  } catch (_err) {
    // Fallback para UTC se timezone inválido
    const now = new Date();
    return {
      hour: now.getUTCHours(),
      minute: now.getUTCMinutes(),
      weekday: now.getUTCDay(),
    };
  }
}

function estaAberto(store) {
  const hours = store?.hours;
  if (!hours || typeof hours !== 'object') return { aberto: true };
  const timezone = store?.timezone || 'America/Sao_Paulo';
  const { weekday } = getCurrentTimeInTimezone(timezone);
  const cfg = hours[String(weekday)];
  if (!cfg) return { aberto: true };
  const { hour, minute } = getCurrentTimeInTimezone(timezone);
  const min = hour * 60 + minute;
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
