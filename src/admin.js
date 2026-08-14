const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const catalog = require('./catalog');
const repo = require('./repository');
const config = require('./config');

const router = express.Router();

// ======================================================
//  UPLOAD (local — dev; em produção usar Vercel Blob)
// ======================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'public', 'images')),
  filename: (req, file, cb) => {
    const base = path.basename(file.originalname, path.extname(file.originalname))
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-') || 'produto';
    cb(null, `${base}-${Date.now()}${path.extname(file.originalname).toLowerCase() || '.jpg'}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ======================================================
//  AUTENTICAÇÃO
// ======================================================
const SESSION_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function isAuthed(req) {
  const token = req.cookies?.rpz_admin;
  if (!token || !sessions.has(token)) return false;
  if (sessions.get(token) < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect('/admin/login');
}

// ======================================================
//  HELPERS
// ======================================================
function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

function statusBadge(status) {
  const map = {
    pending: ['wait', '⏳ Pendente'], approved: ['ok', '✅ Pago'], shipped: ['info', '🚚 Enviado'],
    delivered: ['done', '📦 Entregue'], cancelled: ['no', '❌ Cancelado'], failed: ['no', '❌ Falhou'],
    novo: ['info', '🆕 Novo'], contatado: ['wait', '📞 Contatado'], convertido: ['ok', '💰 Convertido'], fechado: ['done', '🔒 Fechado'],
    ativa: ['ok', '✅ Ativa'], vencida: ['no', '❌ Vencida'], cancelada: ['no', '🚫 Cancelada'],
    ativo: ['ok', '✅ Ativo'], inativo: ['no', '❌ Inativo'],
  };
  const [cls, label] = map[status] || ['wait', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function methodLabel(m) {
  return { pix: '💠 PIX', credit_card: '💳 Crédito', debit_card: '💳 Débito' }[m] || (m || '—');
}

async function tenantFromReq(req, res) {
  const id = Number(req.query.tenant || req.cookies?.rpz_tenant);
  const tenants = await repo.getTenants();
  let tenant = tenants.find(t => t.id === id) || tenants[0] || null;
  if (tenant) res.setHeader('Set-Cookie', `rpz_tenant=${tenant.id}; Path=/; Max-Age=2592000`);
  return { tenant, tenants };
}

function tenantSelector(activeTenantId, tenants) {
  const options = tenants.map(t =>
    `<option value="${t.id}" ${t.id === activeTenantId ? 'selected' : ''}>${esc(t.name)}${t.status !== 'ativo' ? ' (inativo)' : ''}</option>`
  ).join('');
  return `<div class="panel tenant-bar">
    <label style="margin:0;display:flex;align-items:center;gap:10px">🎛 <b>Cliente (tenant):</b>
      <select onchange="location.href='?tenant='+this.value" style="max-width:320px">
        ${options || '<option>— sem clientes —</option>'}
      </select>
    </label>
  </div>`;
}

// ======================================================
//  LAYOUT
// ======================================================
function layout(title, active, content, tenants = [], activeTenantId = null) {
  const nav = [
    ['/admin', '📊 Dashboard'],
    ['/admin/clientes', '👥 Clientes'],
    ['/admin/assinaturas', '📋 Assinaturas'],
    ['/admin/produtos', '🛍 Produtos'],
    ['/admin/pedidos', '🧾 Pedidos'],
    ['/admin/leads', '👤 Leads'],
    ['/admin/perguntas', '❓ Perguntas'],
    ['/admin/mensagens', '💬 Mensagens'],
    ['/admin/config', '⚙️ Configurações'],
  ].map(([href, label]) => {
    let h = href;
    if (activeTenantId && ['/admin/produtos', '/admin/pedidos', '/admin/leads', '/admin/perguntas', '/admin/mensagens', '/admin/config'].includes(href)) {
      h += `?tenant=${activeTenantId}`;
    }
    return `<a class="nav-item ${href === active ? 'active' : ''}" href="${h}">${label}</a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — RespVZap</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f1f5f9; color: #0f172a; display: flex; min-height: 100vh; }
  aside { width: 230px; background: linear-gradient(180deg,#0f172a,#1e293b); color: #e2e8f0; padding: 22px 14px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 10px 18px; border-bottom: 1px solid rgba(148,163,184,.15); margin-bottom: 14px; }
  .brand .logo { width: 38px; height: 38px; border-radius: 10px; background: linear-gradient(135deg,#38bdf8,#2563eb); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; }
  .brand b { font-size: 16px; } .brand span { display: block; font-size: 11px; color: #94a3b8; font-weight: 400; }
  .nav-item { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-radius: 10px; color: #cbd5e1; text-decoration: none; margin-bottom: 3px; font-size: 13.5px; }
  .nav-item:hover { background: rgba(148,163,184,.12); color: #fff; }
  .nav-item.active { background: linear-gradient(135deg,#2563eb,#3b82f6); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.35); }
  .nav-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(148,163,184,.15); }
  main { flex: 1; padding: 26px 30px; min-width: 0; }
  h1 { font-size: 22px; margin-bottom: 4px; } .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 14px; padding: 16px 18px; border: 1px solid #e2e8f0; }
  .card .ico { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 19px; margin-bottom: 10px; }
  .card .num { font-size: 24px; font-weight: 800; } .card .label { font-size: 12px; color: #64748b; margin-top: 2px; }
  .ico.blue { background: #dbeafe; } .ico.green { background: #dcfce7; } .ico.amber { background: #fef9c3; } .ico.violet { background: #ede9fe; } .ico.rose { background: #ffe4e6; }
  .num.blue { color: #1d4ed8; } .num.green { color: #15803d; } .num.amber { color: #a16207; } .num.violet { color: #6d28d9; } .num.rose { color: #be123c; }
  .panel { background: #fff; border-radius: 14px; padding: 20px; border: 1px solid #e2e8f0; margin-bottom: 18px; }
  .panel h2 { font-size: 15px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
  .panel h2 .right { margin-left: auto; font-weight: 400; }
  .tenant-bar { padding: 12px 20px; background: #f0f9ff; border-color: #bae6fd; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #eef2f7; vertical-align: middle; }
  th { background: #f8fafc; color: #475569; font-size: 11.5px; text-transform: uppercase; letter-spacing: .4px; }
  tbody tr:hover { background: #f8fafc; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .badge.ok { background: #dcfce7; color: #166534; } .badge.wait { background: #fef9c3; color: #854d0e; }
  .badge.no { background: #fee2e2; color: #991b1b; } .badge.info { background: #dbeafe; color: #1e40af; } .badge.done { background: #e0e7ff; color: #3730a3; }
  .btn { display: inline-flex; align-items: center; gap: 6px; background: #2563eb; color: #fff; border: 0; border-radius: 9px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; font-family: inherit; }
  .btn:hover { background: #1d4ed8; } .btn.gray { background: #64748b; } .btn.gray:hover { background: #475569; }
  .btn.red { background: #dc2626; } .btn.red:hover { background: #b91c1c; } .btn.green { background: #16a34a; } .btn.green:hover { background: #15803d; }
  .btn.amber { background: #d97706; } .btn.amber:hover { background: #b45309; } .btn.small { padding: 5px 10px; font-size: 12px; }
  input[type=text], input[type=number], input[type=password], input[type=email], textarea, select { width: 100%; padding: 8px 11px; border: 1px solid #cbd5e1; border-radius: 9px; font-size: 13px; font-family: inherit; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
  label { display: block; font-size: 11.5px; color: #475569; margin: 10px 0 4px; font-weight: 700; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; } .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 16px; }
  .flash { background: #dcfce7; color: #166534; border-radius: 10px; padding: 11px 16px; margin-bottom: 14px; font-size: 13px; border: 1px solid #bbf7d0; }
  .flash.err { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
  .prod-thumb { width: 52px; height: 52px; object-fit: cover; border-radius: 9px; background: #f1f5f9; }
  .img-list .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 9px; background: #f1f5f9; }
  .filters { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
  .search { flex: 1; min-width: 200px; position: relative; } .search input { padding-left: 34px; }
  .search::before { content: '🔍'; position: absolute; left: 11px; top: 8px; font-size: 13px; opacity: .6; }
  .chart-row { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; margin-bottom: 18px; }
  @media (max-width: 1100px) { .chart-row { grid-template-columns: 1fr; } }
  .bars { display: flex; align-items: flex-end; gap: 6px; height: 160px; padding-top: 10px; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
  .bar { width: 100%; max-width: 34px; border-radius: 6px 6px 2px 2px; background: linear-gradient(180deg,#3b82f6,#1d4ed8); min-height: 3px; }
  .bar-col .day { font-size: 9.5px; color: #94a3b8; } .bar-col .qtd { font-size: 9.5px; font-weight: 700; color: #334155; }
  .donut { width: 130px; height: 130px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto; }
  .donut .inner { width: 78px; height: 78px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; flex-direction: column; }
  .legend { margin-top: 12px; font-size: 12px; } .legend div { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .legend .dot { width: 10px; height: 10px; border-radius: 3px; }
  .rank { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px dashed #eef2f7; }
  .rank:last-child { border-bottom: 0; } .rank .pos { width: 26px; height: 26px; border-radius: 8px; background: #f1f5f9; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: #475569; }
  .rank .pos.top { background: linear-gradient(135deg,#f59e0b,#d97706); color: #fff; } .rank .name { flex: 1; font-size: 13px; }
  .rank .qtd { font-size: 12px; color: #64748b; } .rank .tot { font-weight: 700; font-size: 13px; }
  .modal-back { display: none; position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 50; align-items: center; justify-content: center; padding: 20px; }
  .modal-back.open { display: flex; } .modal { background: #fff; border-radius: 16px; max-width: 560px; width: 100%; max-height: 85vh; overflow-y: auto; padding: 24px; }
  .chat-line { display: flex; margin-bottom: 8px; } .chat-line .bubble { max-width: 80%; padding: 8px 12px; border-radius: 12px; font-size: 13px; }
  .chat-line.in { justify-content: flex-start; } .chat-line.in .bubble { background: #f1f5f9; }
  .chat-line.out { justify-content: flex-end; } .chat-line.out .bubble { background: #2563eb; color: #fff; }
  .chat-line .time { font-size: 9.5px; color: #94a3b8; margin-top: 3px; }
  .toast { position: fixed; bottom: 22px; right: 22px; background: #0f172a; color: #fff; padding: 12px 18px; border-radius: 12px; font-size: 13px; opacity: 0; transform: translateY(10px); transition: .25s; z-index: 100; max-width: 340px; }
  .toast.show { opacity: 1; transform: translateY(0); } .toast.ok { background: #15803d; } .toast.err { background: #b91c1c; }
  .kv { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px dashed #eef2f7; font-size: 13px; }
  .kv .k { color: #64748b; } .kv b { color: #0f172a; }
  .empty { text-align: center; padding: 30px; color: #94a3b8; font-size: 13px; }
  .inline-form { display: inline; }
  @media (max-width: 900px) { body { flex-direction: column; } aside { width: 100%; height: auto; position: static; } main { padding: 18px; } .grid2, .grid3 { grid-template-columns: 1fr; } }
</style></head>
<body>
<aside>
  <div class="brand"><div class="logo">RZ</div><div><b>RespVZap</b><span>Painel SaaS</span></div></div>
  ${nav}
  <div class="nav-foot"><a class="nav-item" href="/admin/logout">🚪 Sair</a></div>
</aside>
<main>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(pageSub(active))}</div>
  ${content}
</main>
<div class="modal-back" id="modalBack"><div class="modal" id="modalContent"></div></div>
<div class="toast" id="toast"></div>
<script>
  function showToast(msg, type='ok'){ const t=document.getElementById('toast'); t.textContent=msg; t.className='toast show '+type; setTimeout(()=>t.className='toast',3200); }
  window.addEventListener('DOMContentLoaded', ()=>{
    const f=document.getElementById('flashMsg'); if(f) showToast(f.textContent, f.dataset?.type||'ok');
    const q=new URLSearchParams(location.search); if(q.get('msg')) showToast(q.get('msg'), q.get('type')||'ok');
  });
  function openModal(html){ document.getElementById('modalContent').innerHTML=html; document.getElementById('modalBack').classList.add('open'); }
  function closeModal(){ document.getElementById('modalBack').classList.remove('open'); }
  document.getElementById('modalBack').addEventListener('click', e=>{ if(e.target.id==='modalBack') closeModal(); });
  function copyText(t, btn){ navigator.clipboard.writeText(t).then(()=>{ if(btn){ btn.textContent='✓ Copiado'; setTimeout(()=>btn.textContent='Copiar',1500); } }); }
  function filterTable(inputId, tableId){ const q=(document.getElementById(inputId).value||'').toLowerCase(); document.querySelectorAll('#'+tableId+' tbody tr').forEach(r=>{ r.style.display=r.textContent.toLowerCase().includes(q)?'':'none'; }); }
  async function loadConversas(leadId, nome){ const r=await fetch('/admin/api/conversacoes?lead_id='+leadId); const data=await r.json(); openModal('<h3>💬 Conversa com '+nome+'</h3>'+(data.length?data.map(m=>'<div class="chat-line '+m.direction+'"><div><div class="bubble">'+m.message.replace(/</g,'&lt;').replace(/\n/g,'<br>')+'</div><div class="time">'+m.created_at+'</div></div></div>').join(''):'<div class="empty">Nenhuma mensagem.</div>')); }
</script>
</body></html>`;
}

function pageSub(active) {
  return {
    '/admin': 'Visão geral de toda a operação',
    '/admin/clientes': 'Crie e gerencie os clientes do SaaS',
    '/admin/assinaturas': 'Licenças, renovações e vencimentos',
    '/admin/produtos': 'Catálogo do cliente selecionado',
    '/admin/pedidos': 'Pedidos do cliente selecionado',
    '/admin/leads': 'Leads do cliente selecionado',
    '/admin/perguntas': 'Questionários do cliente selecionado',
    '/admin/mensagens': 'Mensagens do cliente selecionado',
    '/admin/config': 'Configurações do cliente selecionado',
  }[active] || '';
}

function loginPage(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — RespVZap</title><style>
  * { box-sizing: border-box; } body { font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#0f172a,#1e3a8a); }
  .login-box { background: #fff; padding: 38px; border-radius: 18px; box-shadow: 0 25px 60px rgba(0,0,0,.35); width: 360px; }
  .logo { width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg,#38bdf8,#2563eb); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; font-size: 22px; margin: 0 auto 14px; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; } p.sub { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 22px; }
  input { width: 100%; padding: 11px; border: 1px solid #cbd5e1; border-radius: 10px; margin-bottom: 14px; }
  .btn { width: 100%; background: linear-gradient(135deg,#2563eb,#3b82f6); color: #fff; border: 0; border-radius: 10px; padding: 12px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .erro { background: #fee2e2; color: #991b1b; border-radius: 9px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; text-align: center; }
</style></head><body><div class="login-box">
<div class="logo">RZ</div><h1>RespVZap</h1><p class="sub">Painel de controle do SaaS</p>
${erro ? `<div class="erro">${esc(erro)}</div>` : ''}
<form method="POST" action="/admin/login"><input type="password" name="senha" placeholder="Senha de administrador" autofocus><button class="btn" type="submit">Entrar</button></form>
</div></body></html>`;
}

// ======================================================
//  AUTENTICAÇÃO
// ======================================================
router.get('/admin/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/admin');
  res.send(loginPage(null));
});

router.post('/admin/login', (req, res) => {
  const senha = String(req.body?.senha || '');
  const expected = config.adminPassword;
  if (!expected || senha !== expected) return res.send(loginPage('Senha incorreta. Tente novamente.'));
  const token = createSession();
  res.setHeader('Set-Cookie', `rpz_admin=${token}; Path=/; HttpOnly; Max-Age=${SESSION_TTL / 1000}`);
  res.redirect('/admin');
});

router.get('/admin/logout', (req, res) => {
  const token = req.cookies?.rpz_admin;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'rpz_admin=; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

// ======================================================
//  API INTERNA
// ======================================================
router.get('/admin/api/conversacoes', requireAuth, async (req, res) => {
  const leadId = Number(req.query.lead_id);
  if (!leadId) return res.json([]);
  res.json(await repo.getConversationsByLead(leadId, 40));
});

// ======================================================
//  DASHBOARD (global + por tenant)
// ======================================================
router.get('/admin', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  const orders = tenant ? await repo.getOrders(tenant.id) : [];
  const leads = tenant ? await repo.listLeads(tenant.id) : [];
  const subs = await repo.getSubscriptions();
  const approved = orders.filter(o => o.status === 'approved');
  const revenue = approved.reduce((s, o) => s + Number(o.total), 0);
  const activeSubs = subs.filter(s => s.status === 'ativa' && (!s.expires_at || new Date(s.expires_at) > new Date()));
  const expiringSoon = subs.filter(s => s.status === 'ativa' && s.expires_at && new Date(s.expires_at) > new Date() && new Date(s.expires_at) < new Date(Date.now() + 7 * 86400000));
  const expired = subs.filter(s => s.status === 'ativa' && s.expires_at && new Date(s.expires_at) <= new Date());

  const byDay = tenant ? await repo.getOrdersByDay(tenant.id, 14) : [];
  const maxDay = Math.max(1, ...byDay.map(d => Number(d.qtd)));
  const bars = byDay.map(d => {
    const h = Math.max(3, Math.round((Number(d.qtd) / maxDay) * 130));
    return `<div class="bar-col" title="${esc(d.dia)} — ${d.qtd} pedido(s)"><div class="qtd">${d.qtd}</div><div class="bar" style="height:${h}px"></div><div class="day">${esc(d.dia.slice(5))}</div></div>`;
  }).join('');

  const recent = orders.slice(0, 5).map(async o => {
    const lead = await repo.getLead(o.lead_id);
    return `<tr><td><b>#${esc(o.external_id)}</b></td><td>${esc(lead?.full_name || '—')}</td><td>${money(o.total)}</td><td>${statusBadge(o.status)}</td><td>${esc(String(o.created_at).slice(0, 16))}</td></tr>`;
  });
  const recentHtml = (await Promise.all(recent)).join('');

  const subRows = subs.slice(0, 6).map(s => `<tr>
    <td><b>${esc(s.tenant_name)}</b></td>
    <td>${esc(s.plan_name || '—')}</td>
    <td>${money(s.price)}</td>
    <td>${statusBadge(s.status)}</td>
    <td>${s.expires_at ? esc(String(s.expires_at).slice(0, 10)) : '—'}</td>
    <td><a class="btn small" href="/admin/assinaturas?tenant=${s.tenant_id}">Ver</a></td>
  </tr>`).join('');

  res.send(layout('Dashboard', '/admin', `
    <div class="cards">
      <div class="card"><div class="ico blue">👥</div><div class="num blue">${tenants.length}</div><div class="label">Clientes (tenants)</div></div>
      <div class="card"><div class="ico green">✅</div><div class="num green">${activeSubs.length}</div><div class="label">Licenças ativas</div></div>
      <div class="card"><div class="ico amber">⏳</div><div class="num amber">${expiringSoon.length}</div><div class="label">Vencem em 7 dias</div></div>
      <div class="card"><div class="ico rose">❌</div><div class="num rose">${expired.length}</div><div class="label">Licenças vencidas</div></div>
      <div class="card"><div class="ico violet">💰</div><div class="num violet">${money(revenue)}</div><div class="label">Faturamento (${esc(tenant?.name || '—')})</div></div>
      <div class="card"><div class="ico cyan" style="background:#cffafe">🧾</div><div class="num" style="color:#0e7490">${orders.length}</div><div class="label">Pedidos (${esc(tenant?.name || '—')})</div></div>
    </div>
    ${tenantSelector(tenant?.id, tenants)}
    <div class="chart-row">
      <div class="panel"><h2>📅 Pedidos 14 dias — ${esc(tenant?.name || 'sem cliente')}</h2><div class="bars">${bars || '<div class="empty">Sem pedidos no período.</div>'}</div></div>
      <div class="panel"><h2>🕒 Últimos pedidos</h2><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Status</th><th>Data</th></tr></thead><tbody>${recentHtml || '<tr><td colspan="5"><div class="empty">Nenhum pedido.</div></td></tr>'}</tbody></table></div>
      <div class="panel"><h2>📋 Licenças recentes</h2><table><thead><tr><th>Cliente</th><th>Plano</th><th>Valor</th><th>Status</th><th>Vence</th><th></th></tr></thead><tbody>${subRows || '<tr><td colspan="6"><div class="empty">Sem licenças.</div></td></tr>'}</tbody></table></div>
    </div>`));
});

// ======================================================
//  CLIENTES
// ======================================================
router.get('/admin/clientes', requireAuth, async (req, res) => {
  const tenants = await repo.getTenants();
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';
  const rows = tenants.map(async t => {
    const subs = await repo.getSubscriptionsByTenant(t.id);
    const active = subs.find(s => s.status === 'ativa');
    return `<tr>
      <td><b>${esc(t.name)}</b><br><small style="color:#94a3b8">#${t.id}</small></td>
      <td>${esc(t.contact_name || '—')}<br><small style="color:#94a3b8">${esc(t.contact_phone || '')}</small></td>
      <td>${esc(t.phone_number_id || '—')}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${active ? `${money(active.price)} · vence ${esc(String(active.expires_at || '').slice(0, 10))}` : '<span style="color:#94a3b8">sem licença</span>'}</td>
      <td style="white-space:nowrap">
        <a class="btn small" href="/admin/clientes/editar?tenant=${t.id}">Editar</a>
        <a class="btn small" href="/admin/assinaturas?tenant=${t.id}">Licença</a>
      </td>
    </tr>`;
  });
  const rowsHtml = (await Promise.all(rows)).join('');
  res.send(layout('Clientes', '/admin/clientes', `${flash}
    <div class="panel"><h2>➕ Novo cliente</h2>
      <form method="POST" action="/admin/clientes/novo" class="grid3">
        <div><label>NOME DO CLIENTE</label><input type="text" name="name" required placeholder="Ex: Loja do João"></div>
        <div><label>CONTATO</label><input type="text" name="contact_name" placeholder="Nome do responsável"></div>
        <div><label>WHATSAPP DO CONTATO</label><input type="text" name="contact_phone" placeholder="5548999999999"></div>
        <div><label>PHONE NUMBER ID (WhatsApp do bot dele)</label><input type="text" name="phone_number_id" placeholder="Ex: 1234567890123456"></div>
        <div><label>ACCESS TOKEN (do WhatsApp dele)</label><input type="text" name="access_token" placeholder="EAA..."></div>
        <div><label>WABA ID (opcional)</label><input type="text" name="waba_id" placeholder="Ex: 1234567890123456"></div>
        <div><label>WHATSAPP QUE RECEBE NOTIFICAÇÕES</label><input type="text" name="notify_phone" placeholder="5548999999999"></div>
        <div><label>E-MAIL DE NOTIFICAÇÕES</label><input type="email" name="notify_email" placeholder="cliente@empresa.com"></div>
        <div style="display:flex;align-items:end"><button class="btn green" type="submit">+ Criar cliente</button></div>
      </form>
    </div>
    <div class="panel"><table>
      <thead><tr><th>Cliente</th><th>Contato</th><th>Phone Number ID</th><th>Status</th><th>Licença</th><th>Ações</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="6"><div class="empty">Nenhum cliente ainda.</div></td></tr>'}</tbody>
    </table></div>`));
});

router.post('/admin/clientes/novo', requireAuth, async (req, res) => {
  const b = req.body;
  const tenant = await repo.createTenant({
    name: b.name, contact_name: b.contact_name, contact_phone: b.contact_phone,
    phone_number_id: b.phone_number_id, access_token: b.access_token, waba_id: b.waba_id,
    notify_phone: b.notify_phone, notify_email: b.notify_email, status: 'ativo',
  });
  await repo.saveTenantCatalog(tenant.id, JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf-8')));
  res.redirect('/admin/clientes?msg=' + encodeURIComponent(`Cliente "${b.name}" criado! Configure a licença e o conteúdo.`));
});

router.get('/admin/clientes/editar', requireAuth, async (req, res) => {
  const tenant = await repo.getTenant(Number(req.query.tenant));
  if (!tenant) return res.redirect('/admin/clientes');
  res.send(layout('Editar cliente', '/admin/clientes', `
    <form method="POST" action="/admin/clientes/salvar" class="grid2">
      <input type="hidden" name="id" value="${tenant.id}">
      <div><label>NOME</label><input type="text" name="name" value="${esc(tenant.name)}" required></div>
      <div><label>CONTATO</label><input type="text" name="contact_name" value="${esc(tenant.contact_name || '')}"></div>
      <div><label>WHATSAPP DO CONTATO</label><input type="text" name="contact_phone" value="${esc(tenant.contact_phone || '')}"></div>
      <div><label>PHONE NUMBER ID</label><input type="text" name="phone_number_id" value="${esc(tenant.phone_number_id || '')}"></div>
      <div><label>ACCESS TOKEN</label><input type="text" name="access_token" value="${esc(tenant.access_token || '')}"></div>
      <div><label>WABA ID</label><input type="text" name="waba_id" value="${esc(tenant.waba_id || '')}"></div>
      <div><label>WHATSAPP DE NOTIFICAÇÕES</label><input type="text" name="notify_phone" value="${esc(tenant.notify_phone || '')}"></div>
      <div><label>E-MAIL DE NOTIFICAÇÕES</label><input type="email" name="notify_email" value="${esc(tenant.notify_email || '')}"></div>
      <div><label>STATUS</label><select name="status">
        <option value="ativo" ${tenant.status === 'ativo' ? 'selected' : ''}>Ativo</option>
        <option value="inativo" ${tenant.status === 'inativo' ? 'selected' : ''}>Inativo</option>
      </select></div>
      <div style="grid-column:1/-1;display:flex;gap:8px"><button class="btn" type="submit">💾 Salvar</button>
      <button class="btn red" type="submit" formaction="/admin/clientes/excluir" formnovalidate>🗑 Excluir</button></div>
    </form>`));
});

router.post('/admin/clientes/salvar', requireAuth, async (req, res) => {
  const b = req.body;
  await repo.updateTenant(Number(b.id), {
    name: b.name, contact_name: b.contact_name, contact_phone: b.contact_phone,
    phone_number_id: b.phone_number_id, access_token: b.access_token, waba_id: b.waba_id,
    notify_phone: b.notify_phone, notify_email: b.notify_email, status: b.status,
  });
  res.redirect('/admin/clientes?msg=' + encodeURIComponent('Cliente atualizado!'));
});

router.post('/admin/clientes/excluir', requireAuth, async (req, res) => {
  await repo.deleteTenant(Number(req.body.id));
  res.redirect('/admin/clientes?msg=' + encodeURIComponent('Cliente excluído.'));
});

// ======================================================
//  ASSINATURAS
// ======================================================
router.get('/admin/assinaturas', requireAuth, async (req, res) => {
  const tenants = await repo.getTenants();
  const plans = await repo.getPlans();
  const subs = await repo.getSubscriptions();
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';

  const rows = subs.map(s => `<tr>
    <td><b>${esc(s.tenant_name)}</b></td>
    <td>${esc(s.plan_name || '—')}</td>
    <td>${money(s.price)}</td>
    <td>${statusBadge(s.status)}</td>
    <td>${s.expires_at ? esc(String(s.expires_at).slice(0, 10)) : '—'}</td>
    <td style="white-space:nowrap">
      <form class="inline-form" method="POST" action="/admin/assinaturas/renovar"><input type="hidden" name="id" value="${s.id}"><input type="hidden" name="days" value="${s.plan_id ? (plans.find(p => p.id === s.plan_id)?.period_days || 30) : 30}"><button class="btn green small">Renovar</button></form>
      <form class="inline-form" method="POST" action="/admin/assinaturas/pix"><input type="hidden" name="id" value="${s.id}"><button class="btn amber small">Gerar PIX</button></form>
      ${s.status === 'ativa' ? `<form class="inline-form" method="POST" action="/admin/assinaturas/cancelar"><input type="hidden" name="id" value="${s.id}"><button class="btn red small">Cancelar</button></form>` : ''}
    </td>
  </tr>`).join('');

  const tenantOptions = tenants.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  const planOptions = plans.map(p => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}/${p.period_days} dias</option>`).join('');

  res.send(layout('Assinaturas', '/admin/assinaturas', `${flash}
    <div class="panel"><h2>➕ Nova licença</h2>
      <form method="POST" action="/admin/assinaturas/nova" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div style="min-width:200px"><label>CLIENTE</label><select name="tenant_id" required>${tenantOptions}</select></div>
        <div style="min-width:200px"><label>PLANO</label><select name="plan_id" required>${planOptions}</select></div>
        <button class="btn green" type="submit">+ Criar licença</button>
      </form>
      <p style="font-size:12px;color:#64748b;margin-top:8px">O padrão é <b>Mensal R$ 299</b>. A licença vence em N dias; o bot envia o PIX de renovação automaticamente 3 dias antes.</p>
    </div>
    <div class="panel"><table>
      <thead><tr><th>Cliente</th><th>Plano</th><th>Valor</th><th>Status</th><th>Vencimento</th><th>Ações</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty">Nenhuma assinatura ainda.</div></td></tr>'}</tbody>
    </table></div>`));
});

router.post('/admin/assinaturas/nova', requireAuth, async (req, res) => {
  const b = req.body;
  const plan = (await repo.getPlans()).find(p => p.id === Number(b.plan_id));
  if (!plan) return res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Plano inválido.') + '&type=err');
  await repo.createSubscription(Number(b.tenant_id), plan.id, plan.price, plan.period_days);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Licença criada: ${plan.name} — vence em ${plan.period_days} dias.`));
});

router.post('/admin/assinaturas/renovar', requireAuth, async (req, res) => {
  const days = Number(req.body.days) || 30;
  await repo.renewSubscription(Number(req.body.id), days);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Licença renovada por +${days} dias.`));
});

router.post('/admin/assinaturas/pix', requireAuth, async (req, res) => {
  try {
    const subs = await repo.getSubscriptions();
    const sub = subs.find(s => s.id === Number(req.body.id));
    if (!sub) return res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Assinatura não encontrada.') + '&type=err');
    const tenant = await repo.getTenant(sub.tenant_id);
    const { criarPixAssinatura } = require('./payment');
    const pix = await criarPixAssinatura(sub, tenant);
    const { notifyTenant } = require('./notify');
    if (tenant?.notify_phone) {
      await notifyTenant(tenant, 'RENOVAÇÃO DE ASSINATURA', `Sua assinatura ${sub.plan_name || ''} vence em breve.\n\nPague com o PIX abaixo:\n\n${pix.pix_copy_paste}\n\nValor: R$ ${pix.total.toFixed(2)}`);
    }
    res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`PIX de renovação enviado ao cliente! Código: ${pix.pix_copy_paste.slice(0, 40)}...`));
  } catch (e) {
    console.error('[ADMIN] Erro PIX assinatura:', e.message);
    res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Erro ao gerar PIX: ' + e.message) + '&type=err');
  }
});

router.post('/admin/assinaturas/cancelar', requireAuth, async (req, res) => {
  await repo.cancelSubscription(Number(req.body.id));
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Licença cancelada.'));
});

// ======================================================
//  PRODUTOS (por tenant)
// ======================================================
router.get('/admin/produtos', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Produtos', '/admin/produtos', '<div class="panel"><div class="empty">Crie um cliente primeiro.</div></div>', tenants));
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';
  const data = await catalog.loadTenantCatalog(tenant.id);
  const imagesDir = path.join(__dirname, '..', 'public', 'images');
  let imgs = '';
  try {
    imgs = fs.readdirSync(imagesDir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).map(f =>
      `<div style="text-align:center"><img class="thumb" src="/images/${esc(f)}"><div style="font-size:11px;color:#64748b;word-break:break-all;margin:4px 0">${esc(f)}</div><button class="btn gray small" onclick="copyText('${esc(f)}', this)">Copiar</button></div>`
    ).join('');
  } catch (_) {}

  const catsHtml = data.categories.map((cat, ci) => {
    const prods = cat.products.map((p, pi) => {
      const plans = (p.plans || []).map((pl, k) => `
      <tr>
        <td><input type="hidden" name="plans[${k}][id]" value="${esc(pl.id || '')}"><input type="text" name="plans[${k}][name]" value="${esc(pl.name || '')}" placeholder="Ex: Mensal"></td>
        <td><input type="text" name="plans[${k}][price]" value="${pl.price ?? ''}" placeholder="Ex: 299,00"></td>
        <td><input type="text" name="plans[${k}][period]" value="${esc(pl.period || '')}" placeholder="mês / ano"></td>
        <td style="text-align:center"><input type="checkbox" name="plans[${k}][popular]" ${pl.popular ? 'checked' : ''}></td>
        <td><input type="text" name="plans[${k}][payment_link]" value="${esc(pl.payment_link || '')}" placeholder="https://mpago.li/..." style="min-width:130px"></td>
        <td><input type="text" name="plans[${k}][redirect_link]" value="${esc(pl.redirect_link || '')}" placeholder="https://wa.me/55..." style="min-width:130px"></td>
        <td><textarea name="plans[${k}][features]" rows="3">${esc(pl.features || '')}</textarea></td>
        <td style="text-align:center"><button class="btn red small" type="submit" formaction="/admin/produtos/excluir-plano?tenant=${tenant.id}&ci=${ci}&pi=${pi}&plan_i=${k}" formnovalidate>🗑</button></td>
      </tr>`).join('') || '<tr><td colspan="8" style="color:#94a3b8;font-size:12px">Sem planos — adicione abaixo.</td></tr>';

      return `
      <div class="panel" style="margin-bottom:14px"><h2>✏️ ${esc(p.name)} ${p.plans?.length ? `<span class="badge info">${p.plans.length} plano(s)</span>` : ''} ${statusBadge(p.available ? 'ok' : 'no')}</h2>
      <form method="POST" action="/admin/produtos/salvar" class="grid2">
        <input type="hidden" name="tenant" value="${tenant.id}"><input type="hidden" name="ci" value="${ci}"><input type="hidden" name="pi" value="${pi}">
        <div>
          <label>NOME</label><input type="text" name="name" value="${esc(p.name)}" required>
          <label>PREÇO (R$)</label><input type="text" name="price" value="${p.price}">
          <div class="grid2"><div><label>UNIDADE</label><input type="text" name="unit" value="${esc(p.unit || '')}"></div><div><label>ESTOQUE</label><input type="number" name="stock" value="${p.stock ?? ''}"></div></div>
          <label>IMAGEM (nome ou URL)</label>
          <div style="display:flex;gap:8px;align-items:center"><input type="text" name="image" value="${esc(p.image || '')}">${p.image ? `<img class="prod-thumb" src="${productImgSrc(p.image)}" alt="">` : ''}</div>
          <label style="margin-top:12px"><input type="checkbox" name="digital" ${p.digital ? 'checked' : ''} style="width:auto"> Produto digital (sem frete)</label>
          <label><input type="checkbox" name="sob_consulta" ${p.sob_consulta ? 'checked' : ''} style="width:auto"> Sob consulta (orçamento)</label>
          <label><input type="checkbox" name="available" ${p.available ? 'checked' : ''} style="width:auto"> Produto ativo</label>
        </div>
        <div><label>RESUMO (1 linha)</label><input type="text" name="short_description" value="${esc(p.short_description || '')}">
          <label>DESCRIÇÃO COMPLETA</label><textarea name="long_description" style="min-height:110px">${esc(p.long_description || '')}</textarea></div>
        <div style="grid-column:1/-1">
          <h3 style="font-size:13px;margin:4px 0 8px">📋 PLANOS DE ASSINATURA <small style="font-weight:400;color:#94a3b8">(opcional)</small></h3>
          <table><thead><tr><th>Nome</th><th>Preço</th><th>Período</th><th>★</th><th>Link pagamento</th><th>Link redirecionamento</th><th>Recursos</th><th></th></tr></thead>
          <tbody>${plans}</tbody></table>
          <button class="btn gray small" type="submit" formaction="/admin/produtos/novo-plano?tenant=${tenant.id}&ci=${ci}&pi=${pi}" formnovalidate style="margin-top:8px">+ Adicionar plano</button>
          <p style="font-size:11.5px;color:#94a3b8;margin-top:6px">💳 Link de pagamento = botão "Assinar Agora". 🔗 Link de redirecionamento (ex: wa.me/55...) = link clicável "Falar com a equipe".</p>
        </div>
        <div style="grid-column:1/-1;display:flex;gap:8px;margin-top:6px">
          <button class="btn" type="submit">💾 Salvar</button>
          <button class="btn red" type="submit" formaction="/admin/produtos/excluir?tenant=${tenant.id}" formnovalidate>🗑 Excluir produto</button>
        </div>
      </form></div>`;
    });
    return `<div class="panel"><h2>${esc(cat.emoji || '')} ${esc(cat.name)} <span class="right badge info">${cat.products.length} produto(s)</span></h2>
      ${prods.join('')}
      <details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:#2563eb;font-weight:600">+ Adicionar novo produto</summary>
      <form method="POST" action="/admin/produtos/novo" class="grid2" style="margin-top:12px">
        <input type="hidden" name="tenant" value="${tenant.id}"><input type="hidden" name="ci" value="${ci}">
        <div><label>ID ÚNICO</label><input type="text" name="id" required><label>NOME</label><input type="text" name="name" required><label>PREÇO (R$)</label><input type="text" name="price" required>
          <label><input type="checkbox" name="digital" style="width:auto"> Produto digital</label></div>
        <div><label>RESUMO</label><input type="text" name="short_description"><label>DESCRIÇÃO</label><textarea name="long_description"></textarea></div>
        <div style="grid-column:1/-1"><button class="btn green" type="submit">+ Criar produto</button></div>
      </form></details></div>`;
  }).join('');

  res.send(layout('Produtos', '/admin/produtos', `${tenantSelector(tenant.id, tenants)}${flash}
    <div class="panel"><h2>📤 Enviar foto (armazenamento local — dev)</h2>
      <form method="POST" action="/admin/upload" enctype="multipart/form-data"><input type="file" name="foto" accept="image/*" required style="margin-bottom:8px"><button class="btn" type="submit">Enviar</button></form>
      <div class="img-list" style="display:flex;flex-wrap:wrap;gap:14px;margin-top:14px">${imgs || '<span style="font-size:13px;color:#64748b">Nenhuma foto local. Em produção use URL do Vercel Blob.</span>'}</div>
    </div>
    ${catsHtml}`, tenants, tenant.id));
});

function productImgSrc(image) {
  if (/^https?:\/\//.test(image)) return image;
  return `/images/${image}`;
}

router.post('/admin/upload', requireAuth, upload.single('foto'), (req, res) => {
  if (!req.file) return res.redirect('/admin/produtos?msg=' + encodeURIComponent('Nenhum arquivo.'));
  res.redirect('/admin/produtos?msg=' + encodeURIComponent(`Foto enviada: ${req.file.filename}`));
});

router.post('/admin/produtos/novo', requireAuth, async (req, res) => {
  const b = req.body;
  const tenantId = Number(b.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  if (!cat) return res.redirect('/admin/produtos?tenant=' + tenantId);
  if (cat.products.some(p => p.id === b.id)) return res.redirect(`/admin/produtos?tenant=${tenantId}&msg=` + encodeURIComponent('ID já existe.'));
  cat.products.push({
    id: b.id, name: b.name, short_description: b.short_description || '', long_description: b.long_description || '',
    price: parseFloat(String(b.price).replace(',', '.')) || 0, image: 'placeholder.png', available: true,
    digital: b.digital === 'on',
  });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/produtos?tenant=${tenantId}&msg=` + encodeURIComponent(`Produto "${b.name}" criado!`));
});

router.post('/admin/produtos/salvar', requireAuth, async (req, res) => {
  const b = req.body;
  const tenantId = Number(b.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  const p = cat?.products?.[Number(b.pi)];
  if (!cat || !p) return res.redirect(`/admin/produtos?tenant=${tenantId}`);
  p.name = b.name;
  p.short_description = b.short_description || '';
  p.long_description = b.long_description || '';
  p.price = parseFloat(String(b.price).replace(',', '.')) || 0;
  p.unit = b.unit || '';
  p.image = b.image || 'placeholder.png';
  p.stock = b.stock !== '' ? Number(b.stock) : undefined;
  p.available = b.available === 'on';
  p.digital = b.digital === 'on';
  p.sob_consulta = b.sob_consulta === 'on';

  const plans = [];
  if (b.plans) {
    const arr = Array.isArray(b.plans) ? b.plans : [b.plans];
    for (const pl of arr) {
      if (!pl.name && !pl.price && !pl.payment_link && !pl.redirect_link) continue;
      plans.push({
        id: (pl.id || '').trim() || `plano-${plans.length + 1}`,
        name: pl.name || '',
        price: pl.price !== '' && pl.price !== undefined && pl.price !== null ? parseFloat(String(pl.price).replace(',', '.')) : null,
        period: pl.period || '',
        popular: pl.popular === 'on',
        payment_link: pl.payment_link || '',
        redirect_link: pl.redirect_link || '',
        features: pl.features || '',
      });
    }
  }
  p.plans = plans.length ? plans : undefined;
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/produtos?tenant=${tenantId}&msg=` + encodeURIComponent(`Produto "${p.name}" atualizado!`));
});

router.post('/admin/produtos/excluir', requireAuth, async (req, res) => {
  const b = req.body;
  const tenantId = Number(b.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  const p = cat?.products?.[Number(b.pi)];
  if (p) {
    cat.products.splice(Number(b.pi), 1);
    await catalog.saveTenantCatalog(tenantId, data);
  }
  res.redirect(`/admin/produtos?tenant=${tenantId}`);
});

router.post('/admin/produtos/novo-plano', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const p = data.categories[Number(req.query.ci)]?.products[Number(req.query.pi)];
  if (!p) return res.redirect(`/admin/produtos?tenant=${tenantId}`);
  if (!p.plans) p.plans = [];
  p.plans.push({ id: '', name: '', price: null, period: 'mês', popular: false, payment_link: '', redirect_link: '', features: '' });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/produtos?tenant=${tenantId}`);
});

router.post('/admin/produtos/excluir-plano', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const p = data.categories[Number(req.query.ci)]?.products[Number(req.query.pi)];
  const plan_i = Number(req.query.plan_i);
  if (p?.plans && Number.isInteger(plan_i)) {
    p.plans.splice(plan_i, 1);
    if (!p.plans.length) p.plans = undefined;
    await catalog.saveTenantCatalog(tenantId, data);
  }
  res.redirect(`/admin/produtos?tenant=${tenantId}`);
});

// ======================================================
//  PEDIDOS E LEADS (por tenant)
// ======================================================
router.get('/admin/pedidos', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Pedidos', '/admin/pedidos', '<div class="empty">Crie um cliente.</div>', tenants));
  const filter = req.query.status || 'todos';
  const orders = (await repo.getOrders(tenant.id)).filter(o => filter === 'todos' || o.status === filter);
  const statusFilter = ['todos', 'pending', 'approved', 'shipped', 'delivered', 'cancelled'].map(s =>
    `<a class="btn ${filter === s ? '' : 'gray'} small" href="/admin/pedidos?tenant=${tenant.id}&status=${s}">${s === 'todos' ? 'Todos' : s}</a>`).join(' ');

  const rows = orders.map(async o => {
    const items = (await repo.getOrderItems(o.id)).map(it => `${it.quantity}x ${esc(it.product_name)}`).join('<br>');
    const pay = await repo.getPaymentByOrderId(o.id);
    const lead = await repo.getLead(o.lead_id);
    return `<tr id="pedido-${o.id}">
      <td><b>#${esc(o.external_id)}</b><br><small style="color:#94a3b8">${esc(String(o.created_at).slice(0, 16))}</small></td>
      <td>${esc(lead?.full_name || '—')}<br><small style="color:#94a3b8">${esc(lead?.phone || '')}</small></td>
      <td>${items}</td><td>${money(o.total)}</td><td>${statusBadge(o.status)}</td>
      <td>${methodLabel(pay?.payment_method)}<br><small style="color:#94a3b8">${esc(pay?.mp_payment_id || '')}</small></td>
      <td>${o.status === 'pending' ? `<form class="inline-form" method="POST" action="/admin/pedidos/status?tenant=${tenant.id}"><input type="hidden" name="id" value="${o.id}"><input type="hidden" name="status" value="approved"><button class="btn green small">Pago</button></form>` : ''}</td>
    </tr>`;
  });
  const rowsHtml = (await Promise.all(rows)).join('');

  res.send(layout('Pedidos', '/admin/pedidos', `${tenantSelector(tenant.id, tenants)}
    <div class="filters">${statusFilter}</div>
    <div class="panel"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Itens</th><th>Total</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="7"><div class="empty">Nenhum pedido com esse filtro.</div></td></tr>'}</tbody></table></div>`, tenants, tenant.id));
});

router.post('/admin/pedidos/status', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  await repo.updateOrderStatus(Number(req.body.id), String(req.body.status));
  res.redirect(`/admin/pedidos?tenant=${tenantId}`);
});

router.get('/admin/leads', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Leads', '/admin/leads', '<div class="empty">Crie um cliente.</div>', tenants));
  const leads = await repo.listLeads(tenant.id);
  const rows = leads.map(l => `<tr>
    <td><b>${esc(l.full_name || '—')}</b><br><small style="color:#94a3b8">${esc(l.phone)}</small></td>
    <td>${esc(l.delivery_address || '—')}</td>
    <td>${statusBadge(l.status)}</td>
    <td><form class="inline-form" method="POST" action="/admin/leads/status?tenant=${tenant.id}"><input type="hidden" name="id" value="${l.id}">
      <select name="status" onchange="this.form.submit()">${['novo', 'contatado', 'convertido', 'fechado'].map(s => `<option value="${s}" ${l.status === s || l.status?.startsWith('pausado') && s === 'novo' ? 'selected' : ''}>${s}</option>`).join('')}</select></form></td>
    <td>${esc(String(l.created_at).slice(0, 16))}</td>
    <td><button class="btn small" onclick="loadConversas(${l.id}, '${esc((l.full_name || l.phone).replace(/'/g, ''))}')">💬 Conversa</button></td>
  </tr>`).join('');
  res.send(layout('Leads', '/admin/leads', `${tenantSelector(tenant.id, tenants)}
    <div class="panel"><table id="tblLeads"><thead><tr><th>Cliente</th><th>Endereço</th><th>Status</th><th>Alterar</th><th>Contato</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6"><div class="empty">Nenhum lead.</div></td></tr>'}</tbody></table></div>`, tenants, tenant.id));
});

router.post('/admin/leads/status', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  await repo.updateLeadStatus(Number(req.body.id), String(req.body.status));
  res.redirect(`/admin/leads?tenant=${tenantId}`);
});

// ======================================================
//  PERGUNTAS (por tenant)
// ======================================================
router.get('/admin/perguntas', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Perguntas', '/admin/perguntas', '<div class="empty">Crie um cliente.</div>', tenants));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const qs = Object.entries(data.questionnaires || {}).map(([qid, q]) => {
    const rows = (q.questions || []).map((question, qi) => `
      <tr><td><input type="text" name="q[${esc(qid)}][${qi}][key]" value="${esc(question.key)}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][field]" value="${esc(question.field || '')}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][question]" value="${esc(question.question)}" style="min-width:240px"></td>
      <td style="text-align:center"><input type="checkbox" name="q[${esc(qid)}][${qi}][optional]" ${question.optional ? 'checked' : ''}></td>
      <td style="text-align:center"><button class="btn red small" type="submit" formaction="/admin/perguntas/remover?tenant=${tenant.id}&qid=${esc(qid)}&qi=${qi}" formnovalidate>🗑</button></td></tr>`).join('') || '<tr><td colspan="5" style="color:#64748b">Sem perguntas.</td></tr>';
    return `<div class="panel"><h2>${esc(q.label || qid)} <span class="badge info">${esc(qid)}</span></h2>
      <form method="POST" action="/admin/perguntas/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
        <table><thead><tr><th>Chave</th><th>Campo do lead</th><th>Pergunta</th><th>Opcional</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" type="submit">💾 Salvar</button>
        <button class="btn gray" type="submit" formaction="/admin/perguntas/nova?tenant=${tenant.id}&qid=${esc(qid)}" formnovalidate>+ Nova pergunta</button></div>
      </form></div>`;
  }).join('') || '<div class="panel">Nenhum questionário.</div>';
  res.send(layout('Perguntas', '/admin/perguntas', `${tenantSelector(tenant.id, tenants)}${qs}`, tenants, tenant.id));
});

router.post('/admin/perguntas/nova', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const qid = String(req.query.qid || '');
  if (!data.questionnaires?.[qid]) return res.redirect(`/admin/perguntas?tenant=${tenantId}`);
  data.questionnaires[qid].questions.push({ key: '', field: '', question: '', optional: false });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/perguntas?tenant=${tenantId}`);
});

router.post('/admin/perguntas/remover', requireAuth, async (req, res) => {
  const tenantId = Number(req.query.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const qid = String(req.query.qid || '');
  const qi = Number(req.query.qi);
  if (data.questionnaires?.[qid] && Number.isInteger(qi)) data.questionnaires[qid].questions.splice(qi, 1);
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/perguntas?tenant=${tenantId}`);
});

router.post('/admin/perguntas/salvar', requireAuth, async (req, res) => {
  const tenantId = Number(req.body.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const incoming = req.body.q || {};
  for (const [qid, qArr] of Object.entries(incoming)) {
    if (!data.questionnaires[qid]) continue;
    const questions = [];
    for (const q of Object.values(qArr)) {
      if (!q.question) continue;
      questions.push({ key: (q.key || '').trim() || `p${questions.length + 1}`, field: (q.field || '').trim(), question: q.question.trim(), optional: q.optional === 'on' });
    }
    data.questionnaires[qid].questions = questions;
  }
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/perguntas?tenant=${tenantId}`);
});

// ======================================================
//  MENSAGENS (por tenant)
// ======================================================
router.get('/admin/mensagens', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Mensagens', '/admin/mensagens', '<div class="empty">Crie um cliente.</div>', tenants));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const fields = Object.entries(data.messages || {}).map(([key, value]) => `
    <div class="panel"><h2>${esc(key)}</h2><textarea name="msgs[${esc(key)}]" style="min-height:80px">${esc(value)}</textarea></div>`).join('');
  res.send(layout('Mensagens', '/admin/mensagens', `${tenantSelector(tenant.id, tenants)}
    <form method="POST" action="/admin/mensagens/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      ${fields}<button class="btn" type="submit">💾 Salvar mensagens</button></form>`, tenants, tenant.id));
});

router.post('/admin/mensagens/salvar', requireAuth, async (req, res) => {
  const tenantId = Number(req.body.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const msgs = req.body.msgs || {};
  for (const key of Object.keys(data.messages || {})) {
    if (msgs[key] !== undefined) data.messages[key] = msgs[key];
  }
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/mensagens?tenant=${tenantId}`);
});

// ======================================================
//  CONFIGURAÇÕES (por tenant)
// ======================================================
router.get('/admin/config', requireAuth, async (req, res) => {
  const { tenant, tenants } = await tenantFromReq(req, res);
  if (!tenant) return res.send(layout('Configurações', '/admin/config', '<div class="empty">Crie um cliente.</div>', tenants));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const s = data.store || {};
  const c = data.company || {};
  const addr = c.address || {};
  res.send(layout('Configurações', '/admin/config', `${tenantSelector(tenant.id, tenants)}
    <form method="POST" action="/admin/config/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      <div class="panel"><h2>🏪 Loja</h2><div class="grid3">
        <div><label>FRETE (R$)</label><input type="text" name="store[delivery_fee]" value="${s.delivery_fee ?? 0}"></div>
        <div><label>FRETE GRÁTIS ACIMA (R$)</label><input type="text" name="store[delivery_free_full]" value="${s.delivery_free_full ?? 0}"></div>
        <div><label>DESCONTO PIX (%)</label><input type="text" name="store[pix_discount_percent]" value="${s.pix_discount_percent ?? 0}"></div>
      </div></div>
      <div class="panel"><h2>🏢 Empresa</h2><div class="grid2">
        <div><label>NOME DA EMPRESA</label><input type="text" name="company[name]" value="${esc(c.name || '')}"></div>
        <div><label>WHATSAPP DE NOTIFICAÇÕES</label><input type="text" name="company[notify_phone]" value="${esc(tenant.notify_phone || '')}" disabled></div>
        <div><label>HORÁRIO</label><input type="text" name="company[business_hours]" value="${esc(c.business_hours || '')}"></div>
        <div><label>ENDEREÇO (rua, n°)</label><input type="text" name="company[address][street]" value="${esc(addr.street || '')}"></div>
      </div>
      <p style="font-size:12px;color:#64748b;margin-top:8px">WhatsApp e e-mail de notificação são definidos na aba <b>Clientes</b> (editar).</p></div>
      <button class="btn" type="submit">💾 Salvar</button>
    </form>`, tenants, tenant.id));
});

router.post('/admin/config/salvar', requireAuth, async (req, res) => {
  const tenantId = Number(req.body.tenant);
  const data = await catalog.loadTenantCatalog(tenantId);
  const s = req.body.store || {};
  if (s.delivery_fee !== undefined) data.store.delivery_fee = parseFloat(String(s.delivery_fee).replace(',', '.')) || 0;
  if (s.delivery_free_full !== undefined) data.store.delivery_free_full = parseFloat(String(s.delivery_free_full).replace(',', '.')) || 0;
  if (s.pix_discount_percent !== undefined) data.store.pix_discount_percent = parseFloat(String(s.pix_discount_percent).replace(',', '.')) || 0;
  const c = req.body.company || {};
  if (c.name !== undefined) data.company.name = c.name;
  if (c.business_hours !== undefined) data.company.business_hours = c.business_hours;
  const addr = c.address || {};
  for (const k of ['street', 'neighborhood', 'city', 'state', 'zip']) {
    if (addr[k] !== undefined) {
      if (!data.company.address) data.company.address = {};
      data.company.address[k] = addr[k];
    }
  }
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`/admin/config?tenant=${tenantId}`);
});

module.exports = router;