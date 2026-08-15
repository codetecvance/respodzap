// ============================================================
//  RELATÓRIOS — agregações por período
//  days: número de dias; 0 = hoje (desde 00:00)
// ============================================================
const { query } = require('./db');

function num(v) {
  return Number(v || 0);
}

/**
 * Monta o filtro de intervalo + args.
 * @param {number} days 0 = hoje
 * @param {number} idx  posição do parâmetro days na query ($idx)
 */
function range(days, idx) {
  if (days === 0) return { sql: "date_trunc('day', NOW())", args: [] };
  return { sql: `NOW() - ($${idx}::int || ' days')::interval`, args: [days] };
}

/**
 * Visão geral do período:
 * { pedidos, receita, aprovados, ticket_medio, por_status, por_metodo }
 */
async function orderStats(tenantId, days) {
  const r1 = range(days, 2);
  const r2 = range(days, 3);
  const [pedidos, receita, aprovados, porStatus, porMetodo] = await Promise.all([
    query('SELECT COUNT(*) AS c FROM orders WHERE tenant_id = $1 AND created_at >= ' + r1.sql, [tenantId, ...r1.args]),
    query('SELECT COALESCE(SUM(total),0) AS t FROM orders WHERE tenant_id = $1 AND status = $2 AND created_at >= ' + r2.sql, [tenantId, 'approved', ...r2.args]),
    query('SELECT COUNT(*) AS c FROM orders WHERE tenant_id = $1 AND status = $2 AND created_at >= ' + r2.sql, [tenantId, 'approved', ...r2.args]),
    query('SELECT status, COUNT(*) AS c FROM orders WHERE tenant_id = $1 AND created_at >= ' + r1.sql + ' GROUP BY status', [tenantId, ...r1.args]),
    query(
      `SELECT COALESCE(p.payment_method, 'n/a') AS metodo, COUNT(*) AS c, COALESCE(SUM(p.total),0) AS total
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.tenant_id = $1 AND o.status = 'approved' AND o.created_at >= ` + r1.sql + `
       GROUP BY p.payment_method ORDER BY total DESC`,
      [tenantId, ...r1.args]
    ),
  ]);
  const totalReceita = num(receita.rows[0].t);
  const totalAprovados = Number(aprovados.rows[0].c);
  return {
    pedidos: Number(pedidos.rows[0].c),
    receita: totalReceita,
    aprovados: totalAprovados,
    ticket_medio: totalAprovados ? totalReceita / totalAprovados : 0,
    por_status: porStatus.rows.map(r => ({ status: r.status, qtd: Number(r.c) })),
    por_metodo: porMetodo.rows.map(r => ({ metodo: r.metodo, qtd: Number(r.c), total: num(r.total) })),
  };
}

/**
 * Série diária do período: [{ dia, qtd, receita }] — receita = pedidos aprovados.
 */
async function ordersByDay(tenantId, days) {
  const r = range(days, 2);
  const res = await query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS dia,
            COUNT(*) AS qtd,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN total END), 0) AS receita
     FROM orders
     WHERE tenant_id = $1 AND created_at >= ` + r.sql + `
     GROUP BY dia ORDER BY dia`,
    [tenantId, ...r.args]
  );
  return res.rows.map(d => ({ dia: d.dia, qtd: Number(d.qtd), receita: num(d.receita) }));
}

/**
 * Top produtos/planos vendidos (pedidos aprovados).
 * [{ nome, qtd, receita }]
 */
async function topProducts(tenantId, days, limit = 10) {
  const r = range(days, 2);
  const args = [tenantId, ...r.args, limit];
  const res = await query(
    `SELECT oi.product_name AS nome, SUM(oi.quantity) AS qtd, COALESCE(SUM(oi.total_price),0) AS receita
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.tenant_id = $1 AND o.status = 'approved' AND o.created_at >= ` + r.sql + `
     GROUP BY oi.product_name ORDER BY receita DESC LIMIT $${args.length}`,
    args
  );
  return res.rows.map(x => ({ ...x, qtd: Number(x.qtd), receita: num(x.receita) }));
}

/**
 * Novos leads no período + conversão (com pedido aprovado).
 */
async function leadStats(tenantId, days) {
  const r = range(days, 2);
  const [novos, convertidos, totalLeads] = await Promise.all([
    query('SELECT COUNT(*) AS c FROM leads WHERE tenant_id = $1 AND created_at >= ' + r.sql, [tenantId, ...r.args]),
    query(
      `SELECT COUNT(DISTINCT o.lead_id) AS c FROM orders o
       WHERE o.tenant_id = $1 AND o.status = 'approved' AND o.created_at >= ` + r.sql,
      [tenantId, ...r.args]
    ),
    query('SELECT COUNT(*) AS c FROM leads WHERE tenant_id = $1', [tenantId]),
  ]);
  const novosQtd = Number(novos.rows[0].c);
  const convertidosQtd = Number(convertidos.rows[0].c);
  return {
    novos: novosQtd,
    convertidos: convertidosQtd,
    total_leads: Number(totalLeads.rows[0].c),
    conversao: novosQtd ? (convertidosQtd / novosQtd) * 100 : 0,
  };
}

/**
 * Melhores clientes por gasto (pedidos aprovados).
 * [{ nome, qtd_pedidos, gasto }]
 */
async function topLeads(tenantId, days, limit = 5) {
  const r = range(days, 2);
  const args = [tenantId, ...r.args, limit];
  const res = await query(
    `SELECT COALESCE(l.full_name, 'Anônimo') AS nome, COUNT(*) AS qtd_pedidos, COALESCE(SUM(o.total),0) AS gasto
     FROM orders o LEFT JOIN leads l ON l.id = o.lead_id
     WHERE o.tenant_id = $1 AND o.status = 'approved' AND o.created_at >= ` + r.sql + `
     GROUP BY nome ORDER BY gasto DESC LIMIT $${args.length}`,
    args
  );
  return res.rows.map(x => ({ ...x, qtd_pedidos: Number(x.qtd_pedidos), gasto: num(x.gasto) }));
}

/**
 * Receita por segmento (admin, visão geral SaaS).
 * [{ nome, emoji, clientes, pedidos, receita }]
 */
async function revenueBySegment(days) {
  const r = range(days, 1);
  const res = await query(
    `SELECT COALESCE(s.name, 'sem-ramo') AS nome, COALESCE(s.emoji, '🏷️') AS emoji,
            COUNT(DISTINCT t.id) AS clientes,
            COUNT(o.id) AS pedidos,
            COALESCE(SUM(CASE WHEN o.status = 'approved' THEN o.total END), 0) AS receita
     FROM tenants t
     LEFT JOIN segments s ON s.id = t.segment_id
     LEFT JOIN orders o ON o.tenant_id = t.id AND o.created_at >= ` + r.sql + `
     GROUP BY s.name, s.emoji ORDER BY receita DESC`,
    r.args
  );
  return res.rows.map(x => ({ ...x, clientes: Number(x.clientes), pedidos: Number(x.pedidos), receita: num(x.receita) }));
}

module.exports = { orderStats, ordersByDay, topProducts, leadStats, topLeads, revenueBySegment, num };
