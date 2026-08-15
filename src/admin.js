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
const upload = process.env.BLOB_READ_WRITE_TOKEN
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
  : multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ======================================================
//  UPLOAD DE IMAGENS (Vercel Blob em produção; disco local em dev)
// ======================================================
async function saveUploadedImage(tenantId, file) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const { put } = require('@vercel/blob');
    const buf = file.buffer || require('fs').readFileSync(file.path);
    const result = await put(`tenant-${tenantId}/${file.originalname}`, buf, {
      access: 'public',
      contentType: file.mimetype,
      token,
      addRandomSuffix: true,
    });
    try { if (file.path) require('fs').unlinkSync(file.path); } catch (_) {}
    return result.url;
  }
  // Local: move para a subpasta do tenant (isolamento por cliente)
  const tenantDir = path.join(__dirname, '..', 'public', 'images', `tenant-${tenantId}`);
  if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
  const dest = path.join(tenantDir, file.filename);
  fs.renameSync(file.path, dest);
  return `/images/tenant-${tenantId}/${file.filename}`;
}

/**
 * Lista as imagens do tenant (registro no banco — fonte da verdade).
 */
async function listTenantImages(tenantId) {
  return repo.listTenantImagesDb(tenantId);
}

/**
 * Exclui a imagem do Blob (best-effort) ou do disco local.
 * O registro no banco é a fonte da verdade da galeria.
 */
async function deleteBlobImage(tenantId, url) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      const { del } = require('@vercel/blob');
      const pathname = new URL(url).pathname;
      if (pathname.startsWith(`/tenant-${tenantId}/`)) {
        await del(pathname, { token });
      }
    } catch (e) {
      console.warn('[IMAGES] blob del (best-effort):', e.message);
    }
    return;
  }
  // Modo local: remove o arquivo da pasta do tenant
  try {
    const name = path.basename(String(url));
    const dir = path.join(__dirname, '..', 'public', 'images', `tenant-${tenantId}`);
    const file = path.join(dir, name);
    if (file.startsWith(dir + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    console.warn('[IMAGES] local del (best-effort):', e.message);
  }
}

/**
 * Galeria de imagens (usada nas páginas Produtos e Listas).
 */
function galleryHtml(images, tenantId, base) {
  return `<div class="panel"><h2>📸 Suas imagens <span class="right badge info">${images.length}</span></h2>
    <div style="display:flex;flex-wrap:wrap;gap:14px">
      ${images.map(img => `<div style="text-align:center">
        <img class="thumb" src="${esc(img.url)}" style="width:64px;height:64px;object-fit:cover;border-radius:9px;background:#f1f5f9">
        <div style="font-size:10px;color:#64748b;word-break:break-all;max-width:120px;margin:3px 0">${esc(img.name)}</div>
        <div style="display:flex;gap:4px;justify-content:center">
          <button class="btn gray small" onclick="copyText('${esc(img.url)}', this)">Copiar URL</button>
          <form method="POST" action="${base}/imagens/excluir" onsubmit="return confirm('Excluir esta imagem?')">
            <input type="hidden" name="tenant" value="${tenantId}">
            <input type="hidden" name="url" value="${esc(img.url)}">
            <button class="btn red small" title="Excluir">🗑</button>
          </form>
        </div>
      </div>`).join('') || '<span style="font-size:13px;color:#64748b">Nenhuma imagem ainda.</span>'}
    </div>
  </div>`;
}

// ======================================================
//  AUTENTICAÇÃO (cookies ASSINADOS — funcionam no serverless/Vercel,
//  onde a memória não persiste entre requisições)
// ======================================================
const SESSION_TTL = 12 * 60 * 60 * 1000;
const TENANT_SESSION_TTL = 12 * 60 * 60 * 1000;
const SESSION_SECRET = config.appSecret || config.adminPassword || 'respodzap-session-secret';

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSession() {
  return signSession({ role: 'admin', exp: Date.now() + SESSION_TTL });
}

function isAuthed(req) {
  const p = verifySession(req.cookies?.rpz_admin);
  return p?.role === 'admin';
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect('/admin/login');
}

// ======================================================
//  AUTENTICAÇÃO DO CLIENTE (tenant)
// ======================================================
function createTenantSession(tenantId) {
  return signSession({ role: 'tenant', tid: tenantId, exp: Date.now() + TENANT_SESSION_TTL });
}

function getTenantSession(req) {
  const p = verifySession(req.cookies?.rpz_tenant_auth);
  if (p?.role !== 'tenant') return null;
  return { tenantId: p.tid, expiresAt: p.exp };
}

/**
 * Middleware do painel do cliente: valida sessão + licença ativa.
 * Define req.clientMode = true e req.tenantSession = tenant.
 */
async function clientPanelAuth(req, res, next) {
  const session = getTenantSession(req);
  if (!session) return res.redirect('/painel/login');
  const tenant = await repo.getTenant(session.tenantId);
  if (!tenant) return res.redirect('/painel/login');

  // Licença vencida → bloqueia o painel do cliente
  const sub = await repo.getActiveSubscription(tenant.id);
  const active = sub && (!sub.expires_at || new Date(sub.expires_at).getTime() > Date.now());
  if (!active) return res.redirect('/painel/bloqueado');

  req.clientMode = true;
  req.tenantSession = tenant;
  next();
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

/**
 * Resolve o tenant da requisição:
 * - painel do cliente → tenant da sessão (travado)
 * - admin → seletor (?tenant= ou cookie)
 */
async function resolveTenant(req, res) {
  if (req.clientMode) return { tenant: req.tenantSession, tenants: [req.tenantSession] };
  return tenantFromReq(req, res);
}

async function tenantFromReq(req, res) {
  const id = Number(req.query.tenant || req.cookies?.rpz_tenant);
  const tenants = await repo.getTenants();
  let tenant = tenants.find(t => t.id === id) || tenants[0] || null;
  if (tenant) res.setHeader('Set-Cookie', `rpz_tenant=${tenant.id}; Path=/; Max-Age=2592000`);
  return { tenant, tenants };
}

function tenantSelector(activeTenantId, tenants, clientMode) {
  if (clientMode) return '';
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

function tenantIdFromReq(req, fallback) {
  if (req.clientMode) return req.tenantSession.id;
  const v = Number(fallback);
  if (Number.isFinite(v) && v > 0) return v;
  const cookie = Number(req.cookies?.rpz_tenant);
  return Number.isFinite(cookie) && cookie > 0 ? cookie : NaN;
}

// ======================================================
//  LAYOUT
// ======================================================
function layout(title, active, content, tenants = [], activeTenantId = null, clientMode = false) {
  const items = clientMode ? [
    ['/painel', '📊 Dashboard'],
    ['/painel/produtos', '🛍 Produtos'],
    ['/painel/listas', '📋 Listas'],
    ['/painel/pedidos', '🧾 Pedidos'],
    ['/painel/leads', '👤 Leads'],
    ['/painel/perguntas', '❓ Perguntas'],
    ['/painel/mensagens', '💬 Mensagens'],
    ['/painel/config', '⚙️ Configurações'],
    ['/painel/senha', '🔑 Trocar senha'],
  ] : [
    ['/admin', '📊 Dashboard'],
    ['/admin/clientes', '👥 Clientes'],
    ['/admin/segmentos', '🏷️ Segmentos'],
    ['/admin/assinaturas', '📋 Assinaturas'],
    ['/admin/produtos', '🛍 Produtos'],
    ['/admin/listas', '📋 Listas'],
    ['/admin/pedidos', '🧾 Pedidos'],
    ['/admin/leads', '👤 Leads'],
    ['/admin/perguntas', '❓ Perguntas'],
    ['/admin/mensagens', '💬 Mensagens'],
    ['/admin/config', '⚙️ Configurações'],
  ];

  const nav = items.map(([href, label]) => {
    let h = href;
    if (!clientMode && activeTenantId && ['/admin/produtos', '/admin/pedidos', '/admin/leads', '/admin/perguntas', '/admin/mensagens', '/admin/config'].includes(href)) {
      h += `?tenant=${activeTenantId}`;
    }
    return `<a class="nav-item ${href === active ? 'active' : ''}" href="${h}">${label}</a>`;
  }).join('');

  const brand = clientMode
    ? `<div class="brand"><div class="logo">${esc((activeTenantId?.name || 'Cliente').slice(0, 2).toUpperCase())}</div><div><b>${esc(activeTenantId?.name || 'Painel')}</b><span>${activeTenantId?.segment_emoji ? `${esc(activeTenantId.segment_emoji)} ${esc(activeTenantId.segment_name)}` : 'Painel do cliente'}</span></div></div>`
    : `<div class="brand"><div class="logo">RZ</div><div><b>RespVZap</b><span>Painel SaaS</span></div></div>`;

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
  .empty { text-align: center; padding: 30px; color: #94a3b8; font-size: 13px; }
  .inline-form { display: inline; }
  @media (max-width: 900px) { body { flex-direction: column; } aside { width: 100%; height: auto; position: static; } main { padding: 18px; } .grid2, .grid3 { grid-template-columns: 1fr; } }
</style></head>
<body>
<aside>
  ${brand}
  ${nav}
  <div class="nav-foot"><a class="nav-item" href="${clientMode ? '/painel/logout' : '/admin/logout'}">🚪 Sair</a></div>
</aside>
<main>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(pageSub(active))}</div>
  ${content}
</main>
<script>
  function showToast(msg, type='ok'){ const t=document.createElement('div'); t.className='toast '+type; t.textContent=msg; t.style.cssText='position:fixed;bottom:22px;right:22px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:12px;font-size:13px;z-index:100'; document.body.appendChild(t); setTimeout(()=>t.remove(),3200); }
  window.addEventListener('DOMContentLoaded', ()=>{ const f=document.getElementById('flashMsg'); if(f) showToast(f.textContent, f.dataset?.type||'ok'); });
  function copyText(t, btn){ navigator.clipboard.writeText(t).then(()=>{ if(btn){ btn.textContent='✓ Copiado'; setTimeout(()=>btn.textContent='Copiar',1500); } }); }
  function filterTable(inputId, tableId){ const q=(document.getElementById(inputId).value||'').toLowerCase(); document.querySelectorAll('#'+tableId+' tbody tr').forEach(r=>{ r.style.display=r.textContent.toLowerCase().includes(q)?'':'none'; }); }
</script>
</body></html>`;
}

function pageSub(active) {
  const map = {
    '/admin': 'Visão geral de toda a operação', '/admin/clientes': 'Crie e gerencie os clientes do SaaS',
    '/admin/assinaturas': 'Licenças, renovações e vencimentos', '/admin/segmentos': 'Ramos de negócio e seus templates', '/painel': 'Visão geral do seu negócio',
    '/painel/produtos': 'Seu catálogo', '/painel/listas': 'Textos dos blocos de seleção do bot',
    '/admin/listas': 'Textos dos blocos de seleção de cada cliente',
    '/painel/pedidos': 'Seus pedidos', '/painel/leads': 'Seus clientes',
    '/painel/perguntas': 'Seus questionários', '/painel/mensagens': 'Seus textos do bot',
    '/painel/config': 'Suas configurações', '/painel/senha': 'Altere sua senha de acesso',
  };
  return map[active] || '';
}

// ======================================================
//  LOGIN DO ADMIN
// ======================================================
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
  res.setHeader('Set-Cookie', 'rpz_admin=; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

// ======================================================
//  LOGIN DO CLIENTE (tenant)
// ======================================================
function clientLoginPage(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel do Cliente — RespVZap</title><style>
  * { box-sizing: border-box; } body { font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#14532d,#166534); }
  .login-box { background: #fff; padding: 38px; border-radius: 18px; box-shadow: 0 25px 60px rgba(0,0,0,.35); width: 360px; }
  .logo { width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg,#22c55e,#15803d); display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; font-size: 20px; margin: 0 auto 14px; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; } p.sub { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 22px; }
  input { width: 100%; padding: 11px; border: 1px solid #cbd5e1; border-radius: 10px; margin-bottom: 14px; }
  .btn { width: 100%; background: linear-gradient(135deg,#16a34a,#15803d); color: #fff; border: 0; border-radius: 10px; padding: 12px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .erro { background: #fee2e2; color: #991b1b; border-radius: 9px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; text-align: center; }
</style></head><body><div class="login-box">
<div class="logo">✓</div><h1>Painel do Cliente</h1><p class="sub">Acesse com seu WhatsApp e senha</p>
${erro ? `<div class="erro">${esc(erro)}</div>` : ''}
<form method="POST" action="/painel/login">
  <input type="text" name="telefone" placeholder="WhatsApp (ex: 5548999999999)" autofocus>
  <input type="password" name="senha" placeholder="Senha">
  <button class="btn" type="submit">Entrar</button>
</form>
</div></body></html>`;
}

router.get('/painel/login', (req, res) => {
  if (getTenantSession(req)) return res.redirect('/painel');
  res.send(clientLoginPage(null));
});

router.post('/painel/login', async (req, res) => {
  const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
  const senha = String(req.body?.senha || '');
  const tenant = await repo.getTenantByPanelLogin(telefone);
  if (!tenant || !repo.verifyPassword(senha, tenant.panel_password)) {
    await new Promise(r => setTimeout(r, 1000)); // anti força bruta
    return res.send(clientLoginPage('WhatsApp ou senha incorretos.'));
  }
  const token = createTenantSession(tenant.id);
  res.setHeader('Set-Cookie', `rpz_tenant_auth=${token}; Path=/; HttpOnly; Max-Age=${TENANT_SESSION_TTL / 1000}`);
  res.redirect('/painel');
});

router.get('/painel/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rpz_tenant_auth=; Path=/; Max-Age=0');
  res.redirect('/painel/login');
});

// Licença vencida → tela de bloqueio
router.get('/painel/bloqueado', clientPanelAuthForBlockedPage, (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Licença expirada</title>
  <style>body{font-family:'Segoe UI',sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:16px;padding:40px;max-width:440px;text-align:center;border:1px solid #e2e8f0}.btn{display:inline-block;margin-top:16px;background:#2563eb;color:#fff;padding:10px 18px;border-radius:9px;text-decoration:none}</style>
  </head><body><div class="box">
  <h2>🚫 Licença expirada</h2>
  <p style="color:#64748b;margin-top:10px">Sua assinatura venceu e o painel está bloqueado.<br>Entre em contato com o suporte para renovar.</p>
  <a class="btn" href="/painel/logout">Voltar ao login</a>
  </div></body></html>`);
});

async function clientPanelAuthForBlockedPage(req, res, next) { next(); }

// ======================================================
//  API INTERNA
// ======================================================
router.get('/admin/api/conversacoes', requireAuth, async (req, res) => {
  const leadId = Number(req.query.lead_id);
  if (!leadId) return res.json([]);
  res.json(await repo.getConversationsByLead(leadId, 40));
});

router.get('/painel/api/conversacoes', clientPanelAuth, async (req, res) => {
  const leadId = Number(req.query.lead_id);
  if (!leadId) return res.json([]);
  res.json(await repo.getConversationsByLead(leadId, 40));
});

// ======================================================
//  DASHBOARD (admin global + painel do cliente)
// ======================================================
async function pageDashboard(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Dashboard', clientMode ? '/painel' : '/admin', '<div class="empty">Crie um cliente primeiro.</div>', tenants, null, clientMode));

  const orders = await repo.getOrders(tenant.id);
  const leads = await repo.listLeads(tenant.id);
  const subs = await repo.getSubscriptions();
  const approved = orders.filter(o => o.status === 'approved');
  const revenue = approved.reduce((s, o) => s + Number(o.total), 0);
  const activeSubs = subs.filter(s => s.status === 'ativa' && (!s.expires_at || new Date(s.expires_at) > new Date()));
  const expiringSoon = subs.filter(s => s.status === 'ativa' && s.expires_at && new Date(s.expires_at) > new Date() && new Date(s.expires_at) < new Date(Date.now() + 7 * 86400000));
  const expired = subs.filter(s => s.status === 'ativa' && s.expires_at && new Date(s.expires_at) <= new Date());

  const byDay = await repo.getOrdersByDay(tenant.id, 14);
  const maxDay = Math.max(1, ...byDay.map(d => Number(d.qtd)));
  const bars = byDay.map(d => {
    const h = Math.max(3, Math.round((Number(d.qtd) / maxDay) * 130));
    return `<div class="bar-col" title="${esc(d.dia)} — ${d.qtd} pedido(s)"><div class="qtd">${d.qtd}</div><div class="bar" style="height:${h}px"></div><div class="day">${esc(d.dia.slice(5))}</div></div>`;
  }).join('');

  // Guia de boas-vindas para cliente novo (catálogo vazio)
  let onboarding = '';
  if (clientMode) {
    const catData = await catalog.loadTenantCatalog(tenant.id);
    const totalProducts = (catData.categories || []).reduce((s, c) => s + (c.products || []).length, 0);
    const hasCompanyName = !!catData.company?.name;
    if (!totalProducts || !hasCompanyName) {
      onboarding = `<div class="panel" style="background:#fffbeb;border-color:#fde68a">
        <h2 style="color:#92400e">🚀 Boas-vindas, ${esc(tenant.name)}! Configure seu painel em 3 passos</h2>
        <ol style="font-size:13px;color:#78350f;line-height:2;padding-left:20px">
          ${!hasCompanyName ? `<li><b>Nome da empresa</b> — <a href="/painel/config">Configurações</a> (aparece nas mensagens do bot)</li>` : ''}
          ${!totalProducts ? `<li><b>Adicione seus produtos</b> — <a href="/painel/produtos">Produtos</a> (com foto, preço e descrição)</li>` : ''}
          <li><b>Personalize as mensagens</b> — <a href="/painel/mensagens">Mensagens</a></li>
        </ol>
      </div>`;
    }
  }

  const recentRows = await Promise.all(orders.slice(0, 5).map(async o => {
    const lead = await repo.getLead(o.lead_id);
    return `<tr><td><b>#${esc(o.external_id)}</b></td><td>${esc(lead?.full_name || '—')}</td><td>${money(o.total)}</td><td>${statusBadge(o.status)}</td><td>${esc(String(o.created_at).slice(0, 16))}</td></tr>`;
  }));

  const cards = clientMode
    ? `<div class="cards">
        <div class="card"><div class="ico blue">${esc(tenant.segment_emoji || '🏷️')}</div><div class="num blue" style="font-size:19px">${esc(tenant.segment_name || '—')}</div><div class="label">Ramo do negócio</div></div>
        <div class="card"><div class="ico cyan" style="background:#cffafe">👥</div><div class="num" style="color:#0e7490">${leads.length}</div><div class="label">Leads</div></div>
        <div class="card"><div class="ico green">🧾</div><div class="num green">${orders.length}</div><div class="label">Pedidos</div></div>
        <div class="card"><div class="ico violet">💰</div><div class="num violet">${money(revenue)}</div><div class="label">Faturamento</div></div>
      </div>`
    : `<div class="cards">
        <div class="card"><div class="ico blue">👥</div><div class="num blue">${tenants.length}</div><div class="label">Clientes (tenants)</div></div>
        <div class="card"><div class="ico green">✅</div><div class="num green">${activeSubs.length}</div><div class="label">Licenças ativas</div></div>
        <div class="card"><div class="ico amber">⏳</div><div class="num amber">${expiringSoon.length}</div><div class="label">Vencem em 7 dias</div></div>
        <div class="card"><div class="ico rose">❌</div><div class="num rose">${expired.length}</div><div class="label">Licenças vencidas</div></div>
        <div class="card"><div class="ico violet">💰</div><div class="num violet">${money(revenue)}</div><div class="label">Faturamento (${esc(tenant?.name || '—')})</div></div>
        <div class="card"><div class="ico cyan" style="background:#cffafe">🧾</div><div class="num" style="color:#0e7490">${orders.length}</div><div class="label">Pedidos (${esc(tenant?.name || '—')})</div></div>
      </div>`;

  const quickActions = clientMode ? '' : `<div class="panel" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <a class="btn" href="/admin/clientes">👥 Página de clientes</a>
    <a class="btn green" href="/painel/login" target="_blank">🔗 Login do painel do cliente</a>
    <button class="btn amber" onclick="copyText('${config.webhookUrl || 'https://respodzap.vercel.app'}/painel/login', this)">📋 Copiar link do login</button>
  </div>`;

  res.send(layout('Dashboard', clientMode ? '/painel' : '/admin', `
    ${cards}
    ${quickActions}
    ${onboarding}
    ${clientMode ? `<div class="panel" style="background:#f0fdf4;border-color:#bbf7d0"><h2 style="color:#166534">👋 Olá, ${esc(tenant.name)}!</h2><p style="font-size:13px;color:#166534">Este é o painel do seu negócio. Gerencie seus produtos, veja seus pedidos e clientes.</p></div>` : tenantSelector(tenant.id, tenants, clientMode)}
    <div class="panel"><h2>📅 Pedidos dos últimos 14 dias</h2><div class="bars">${bars || '<div class="empty">Sem pedidos no período.</div>'}</div></div>
    <div class="panel"><h2>🕒 Últimos pedidos</h2><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Status</th><th>Data</th></tr></thead><tbody>${recentRows.join('') || '<tr><td colspan="5"><div class="empty">Nenhum pedido.</div></td></tr>'}</tbody></table></div>
  `, tenants, tenant, clientMode));
}

router.get('/admin', requireAuth, pageDashboard);
router.get('/painel', clientPanelAuth, pageDashboard);

// ======================================================
//  CLIENTES (somente admin)
// ======================================================
router.get('/admin/clientes', requireAuth, async (req, res) => {
  const tenants = await repo.getTenants();
  const segments = await repo.getSegments();
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';
  const rowsHtml = (await Promise.all(tenants.map(async t => {
    const subs = await repo.getSubscriptionsByTenant(t.id);
    const active = subs.find(s => s.status === 'ativa');
    const seg = segments.find(s => s.id === t.segment_id);
    return `<tr>
      <td><b>${esc(t.name)}</b><br><small style="color:#94a3b8">#${t.id}</small></td>
      <td>${esc(t.contact_name || '—')}<br><small style="color:#94a3b8">${esc(t.contact_phone || '')}</small></td>
      <td>${seg ? `${esc(seg.emoji)} ${esc(seg.name)}` : '—'}</td>
      <td>${esc(t.phone_number_id || '—')}</td>
      <td>${statusBadge(t.status)}</td>
      <td>${t.panel_password ? '<span class="badge ok">painel ativo</span>' : '<span style="color:#94a3b8">sem login</span>'}</td>
      <td>${active ? `${money(active.price)} · vence ${esc(String(active.expires_at || '').slice(0, 10))}` : '<span style="color:#94a3b8">sem licença</span>'}</td>
      <td style="white-space:nowrap">
        <a class="btn small" href="/admin/clientes/editar?tenant=${t.id}">Editar</a>
        <a class="btn small" href="/admin/assinaturas?tenant=${t.id}">Licença</a>
      </td>
    </tr>`;
  }))).join('');

  const segmentOptions = segments.map(sg => `<option value="${sg.id}">${esc(sg.emoji)} ${esc(sg.name)}</option>`).join('');

  res.send(layout('Clientes', '/admin/clientes', `${flash}
    <div class="panel"><h2>➕ Novo cliente</h2>
      <form method="POST" action="/admin/clientes/novo" class="grid3">
        <div><label>NOME DO CLIENTE</label><input type="text" name="name" required placeholder="Ex: Loja do João"></div>
        <div><label>RAMO (segmento)</label><select name="segment_id" required>${segmentOptions}</select></div>
        <div><label>CONTATO (nome)</label><input type="text" name="contact_name" placeholder="Nome do responsável"></div>
        <div><label>WHATSAPP (login do painel dele)</label><input type="text" name="contact_phone" placeholder="5548999999999"></div>
        <div><label>PHONE NUMBER ID (bot)</label><input type="text" name="phone_number_id" placeholder="Ex: 1234567890123456"></div>
        <div><label>ACCESS TOKEN (bot)</label><input type="text" name="access_token" placeholder="EAA..."></div>
        <div><label>WABA ID (opcional)</label><input type="text" name="waba_id"></div>
        <div><label>WHATSAPP DE NOTIFICAÇÕES</label><input type="text" name="notify_phone" placeholder="5548999999999"></div>
        <div><label>E-MAIL DE NOTIFICAÇÕES</label><input type="email" name="notify_email"></div>
        <div><label>SENHA DO PAINEL</label><input type="text" name="panel_password" placeholder="Defina a senha do cliente"></div>
        <div style="display:flex;align-items:end"><button class="btn green" type="submit">+ Criar cliente</button></div>
      </form>
      <p style="font-size:12px;color:#64748b;margin-top:8px">O ramo define o template inicial (cardápio, mensagens e configurações do bot).</p>
    </div>
    <div class="panel"><table>
      <thead><tr><th>Cliente</th><th>Contato</th><th>Ramo</th><th>Phone Number ID</th><th>Status</th><th>Painel</th><th>Licença</th><th>Ações</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="8"><div class="empty">Nenhum cliente ainda.</div></td></tr>'}</tbody>
    </table></div>`));
});

router.post('/admin/clientes/novo', requireAuth, async (req, res) => {
  const b = req.body;
  const segment = await repo.getSegment(Number(b.segment_id));
  if (!segment) return res.redirect('/admin/clientes?msg=' + encodeURIComponent('Ramo inválido.') + '&type=err');
  const tenant = await repo.createTenant({
    name: b.name, contact_name: b.contact_name, contact_phone: repo.normalizePhoneBr(b.contact_phone),
    phone_number_id: b.phone_number_id, access_token: b.access_token, waba_id: b.waba_id,
    notify_phone: repo.normalizePhoneBr(b.notify_phone), notify_email: b.notify_email, status: 'ativo',
    panel_password: b.panel_password ? repo.hashPassword(b.panel_password) : null,
    segment_id: segment.id,
  });
  // Catálogo inicial = template do ramo escolhido
  await repo.saveTenantCatalog(tenant.id, segment.template_json);
  res.redirect('/admin/clientes?msg=' + encodeURIComponent(`Cliente "${b.name}" criado no ramo ${segment.emoji} ${segment.name}! Configure a licença e a senha do painel.`));
});

router.get('/admin/clientes/editar', requireAuth, async (req, res) => {
  const tenant = await repo.getTenant(Number(req.query.tenant));
  if (!tenant) return res.redirect('/admin/clientes');
  const segments = await repo.getSegments();
  const segmentOptions = segments.map(sg => `<option value="${sg.id}" ${sg.id === tenant.segment_id ? 'selected' : ''}>${esc(sg.emoji)} ${esc(sg.name)}</option>`).join('');
  res.send(layout('Editar cliente', '/admin/clientes', `
    <form method="POST" action="/admin/clientes/salvar" class="grid2">
      <input type="hidden" name="id" value="${tenant.id}">
      <div><label>NOME</label><input type="text" name="name" value="${esc(tenant.name)}" required></div>
      <div><label>RAMO (segmento)</label><select name="segment_id">${segmentOptions}</select></div>
      <div><label>CONTATO</label><input type="text" name="contact_name" value="${esc(tenant.contact_name || '')}"></div>
      <div><label>WHATSAPP (login do painel)</label><input type="text" name="contact_phone" value="${esc(tenant.contact_phone || '')}"></div>
      <div><label>PHONE NUMBER ID</label><input type="text" name="phone_number_id" value="${esc(tenant.phone_number_id || '')}"></div>
      <div><label>ACCESS TOKEN</label><input type="text" name="access_token" value="${esc(tenant.access_token || '')}"></div>
      <div><label>WABA ID</label><input type="text" name="waba_id" value="${esc(tenant.waba_id || '')}"></div>
      <div><label>WHATSAPP DE NOTIFICAÇÕES</label><input type="text" name="notify_phone" value="${esc(tenant.notify_phone || '')}"></div>
      <div><label>E-MAIL DE NOTIFICAÇÕES</label><input type="email" name="notify_email" value="${esc(tenant.notify_email || '')}"></div>
      <div><label>SENHA DO PAINEL ${tenant.panel_password ? '(já definida — deixe vazio para manter)' : ''}</label><input type="text" name="panel_password" placeholder="${tenant.panel_password ? 'Nova senha (opcional)' : 'Defina a senha do painel'}"></div>
      <div><label>STATUS</label><select name="status">
        <option value="ativo" ${tenant.status === 'ativo' ? 'selected' : ''}>Ativo</option>
        <option value="inativo" ${tenant.status === 'inativo' ? 'selected' : ''}>Inativo</option>
      </select></div>
      <div style="grid-column:1/-1;display:flex;gap:8px"><button class="btn" type="submit">💾 Salvar</button>
      <button class="btn red" type="submit" formaction="/admin/clientes/excluir" formnovalidate>🗑 Excluir</button></div>
      <p style="grid-column:1/-1;font-size:12px;color:#64748b">Trocar o ramo não substitui o catálogo já personalizado do cliente — apenas o selo/identidade.</p>
    </form>`));
});

router.post('/admin/clientes/salvar', requireAuth, async (req, res) => {
  const b = req.body;
  const fields = {
    name: b.name, contact_name: b.contact_name, contact_phone: repo.normalizePhoneBr(b.contact_phone),
    phone_number_id: b.phone_number_id, access_token: b.access_token, waba_id: b.waba_id,
    notify_phone: repo.normalizePhoneBr(b.notify_phone), notify_email: b.notify_email, status: b.status,
    segment_id: b.segment_id ? Number(b.segment_id) : null,
  };
  if (b.panel_password) fields.panel_password = repo.hashPassword(b.panel_password);
  await repo.updateTenant(Number(b.id), fields);
  res.redirect('/admin/clientes?msg=' + encodeURIComponent('Cliente atualizado!'));
});

router.post('/admin/clientes/excluir', requireAuth, async (req, res) => {
  await repo.deleteTenant(Number(req.body.id));
  res.redirect('/admin/clientes?msg=' + encodeURIComponent('Cliente excluído.'));
});

// ======================================================
//  SEGMENTOS (ramos de negócio — somente admin)
// ======================================================
router.get('/admin/segmentos', requireAuth, async (req, res) => {
  const segments = await repo.getSegments();
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';

  const rows = (await Promise.all(segments.map(async sg => {
    const emUso = await repo.countTenantsBySegment(sg.id);
    return `<form id="seg-${sg.id}" method="POST" action="/admin/segmentos/salvar"><input type="hidden" name="id" value="${sg.id}"></form>
    <tr>
      <td><input form="seg-${sg.id}" type="text" name="emoji" value="${esc(sg.emoji)}" style="width:60px"></td>
      <td><input form="seg-${sg.id}" type="text" name="name" value="${esc(sg.name)}" required style="min-width:140px"></td>
      <td>${emUso} cliente(s)</td>
      <td style="white-space:nowrap">
        <button form="seg-${sg.id}" class="btn green small" type="submit">Salvar</button>
        <a class="btn small" href="/admin/segmentos/editar?segment=${sg.id}">Template</a>
        ${emUso > 0
          ? `<button class="btn red small" type="button" disabled title="Ramo em uso">🗑 (em uso)</button>`
          : `<button form="seg-${sg.id}" class="btn red small" type="submit" formaction="/admin/segmentos/excluir?segment=${sg.id}" formnovalidate>🗑 Excluir</button>`}
      </td>
    </tr>`;
  }))).join('');

  const copyOptions = segments.map(sg => `<option value="${sg.id}">${esc(sg.emoji)} ${esc(sg.name)}</option>`).join('');

  res.send(layout('Segmentos', '/admin/segmentos', `${flash}
    <div class="panel"><h2>🏷️ Ramos de negócio (segmentos)</h2>
      <p style="font-size:13px;color:#64748b;margin-bottom:10px">Cada ramo tem um template inicial de cardápio, mensagens e configurações — escolhido na criação do cliente.</p>
      <table>
        <thead><tr><th>Emoji</th><th>Nome</th><th>Uso</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4"><div class="empty">Nenhum segmento ainda.</div></td></tr>'}</tbody>
      </table>
    </div>
    <div class="panel"><h2>➕ Novo segmento</h2>
      <form method="POST" action="/admin/segmentos/novo" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div><label>EMOJI</label><input type="text" name="emoji" value="🏷️" style="width:70px"></div>
        <div><label>NOME DO RAMO</label><input type="text" name="name" required placeholder="Ex: Padaria"></div>
        <div style="min-width:200px"><label>COPIAR TEMPLATE DE</label><select name="copy_from">${copyOptions}</select></div>
        <button class="btn green" type="submit">+ Criar segmento</button>
      </form>
    </div>`));
});

router.post('/admin/segmentos/novo', requireAuth, async (req, res) => {
  const b = req.body;
  let template = {};
  const copyFrom = Number(b.copy_from);
  if (copyFrom) {
    const src = await repo.getSegment(copyFrom);
    if (src) template = src.template_json;
  }
  await repo.createSegment(b.name, b.emoji || '🏷️', template);
  res.redirect('/admin/segmentos?msg=' + encodeURIComponent(`Segmento "${b.name}" criado! Edite o template dele.`));
});

router.post('/admin/segmentos/salvar', requireAuth, async (req, res) => {
  const b = req.body;
  await repo.updateSegment(Number(b.id), b.name, b.emoji || '🏷️', undefined);
  res.redirect('/admin/segmentos?msg=' + encodeURIComponent('Segmento atualizado!'));
});

router.post('/admin/segmentos/excluir', requireAuth, async (req, res) => {
  const segmentId = Number(req.query.segment);
  const emUso = await repo.countTenantsBySegment(segmentId);
  if (emUso > 0) {
    return res.redirect('/admin/segmentos?msg=' + encodeURIComponent(`Não é possível excluir: ramo em uso por ${emUso} cliente(s).`) + '&type=err');
  }
  await repo.deleteSegment(segmentId);
  res.redirect('/admin/segmentos?msg=' + encodeURIComponent('Segmento excluído.'));
});

router.get('/admin/segmentos/editar', requireAuth, async (req, res) => {
  const segment = await repo.getSegment(Number(req.query.segment));
  if (!segment) return res.redirect('/admin/segmentos');
  const templateJson = JSON.stringify(segment.template_json, null, 2);
  res.send(layout('Template do segmento', '/admin/segmentos', `
    <div class="panel"><h2>${esc(segment.emoji)} Template do segmento — ${esc(segment.name)}</h2>
      <p style="font-size:12px;color:#64748b;margin-bottom:10px">Este JSON é o catálogo inicial dos clientes criados neste ramo. Edite categorias, produtos, mensagens, adicionais e áreas de entrega.</p>
      <form method="POST" action="/admin/segmentos/template">
        <input type="hidden" name="id" value="${segment.id}">
        <textarea name="template" style="min-height:500px;font-family:Consolas,monospace;font-size:12px">${esc(templateJson)}</textarea>
        <div style="margin-top:10px"><button class="btn" type="submit">💾 Salvar template</button></div>
      </form>
    </div>`));
});

router.post('/admin/segmentos/template', requireAuth, async (req, res) => {
  const b = req.body;
  try {
    const template = JSON.parse(b.template);
    await repo.updateSegment(Number(b.id), undefined, undefined, template);
    res.redirect('/admin/segmentos?msg=' + encodeURIComponent('Template salvo!'));
  } catch (e) {
    res.redirect('/admin/segmentos?msg=' + encodeURIComponent('JSON inválido: ' + e.message) + '&type=err');
  }
});

// ======================================================
//  ASSINATURAS (somente admin)
// ======================================================
router.get('/admin/assinaturas', requireAuth, async (req, res) => {
  const tenants = await repo.getTenants();
  const plans = await repo.getPlans();
  const subs = await repo.getSubscriptions();
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';

  const rows = subs.map(s => {
    const plan = plans.find(p => p.id === s.plan_id);
    const custom = plan && (Number(s.price) !== Number(plan.price) || Number(s.period_days) !== Number(plan.period_days));
    const days = s.period_days || plan?.period_days || 30;
    return `<tr>
      <td><b>${esc(s.tenant_name)}</b></td>
      <td>${esc(s.plan_name || '—')} ${custom ? '<span class="badge wait">personalizado</span>' : ''}</td>
      <td>${money(s.price)}<br><small style="color:#94a3b8">${days} dias</small></td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.expires_at ? esc(String(s.expires_at).slice(0, 10)) : '—'}</td>
      <td style="white-space:nowrap">
        <form class="inline-form" method="POST" action="/admin/assinaturas/renovar"><input type="hidden" name="id" value="${s.id}"><input type="hidden" name="days" value="${days}"><button class="btn green small">Renovar</button></form>
        <form class="inline-form" method="POST" action="/admin/assinaturas/pix"><input type="hidden" name="id" value="${s.id}"><button class="btn amber small">Gerar PIX</button></form>
        ${s.status === 'ativa' ? `<form class="inline-form" method="POST" action="/admin/assinaturas/cancelar"><input type="hidden" name="id" value="${s.id}"><button class="btn red small">Cancelar</button></form>` : ''}
      </td>
    </tr>`;
  }).join('');

  const tenantOptions = tenants.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  const planOptions = plans.map(p => `<option value="${p.id}">${esc(p.name)} — ${money(p.price)}/${p.period_days} dias</option>`).join('');

  // Seção de planos (editar / novo / excluir)
  const plansRows = plans.map(async p => {
    const emUso = await repo.countSubscriptionsByPlan(p.id);
    return `<form id="plano-${p.id}" method="POST" action="/admin/planos/salvar"><input type="hidden" name="id" value="${p.id}"></form>
    <tr>
      <td><input form="plano-${p.id}" type="text" name="name" value="${esc(p.name)}" required style="min-width:140px"></td>
      <td><input form="plano-${p.id}" type="text" name="price" value="${p.price}" style="width:100px"></td>
      <td><input form="plano-${p.id}" type="number" name="period_days" value="${p.period_days}" style="width:90px"></td>
      <td style="white-space:nowrap">
        <button form="plano-${p.id}" class="btn green small" type="submit">Salvar</button>
        ${emUso > 0
          ? `<button class="btn red small" type="button" title="Plano em uso por ${emUso} cliente(s)" disabled>🗑 (em uso)</button>`
          : `<button form="plano-${p.id}" class="btn red small" type="submit" formaction="/admin/planos/excluir?plan=${p.id}" formnovalidate>🗑 Excluir</button>`}
      </td>
    </tr>`;
  });
  const plansHtml = (await Promise.all(plansRows)).join('');

  res.send(layout('Assinaturas', '/admin/assinaturas', `${flash}
    <div class="panel"><h2>➕ Nova licença</h2>
      <form method="POST" action="/admin/assinaturas/nova" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
        <div style="min-width:200px"><label>CLIENTE</label><select name="tenant_id" required>${tenantOptions}</select></div>
        <div style="min-width:200px"><label>PLANO</label><select name="plan_id" required>${planOptions}</select></div>
        <div style="min-width:130px"><label>PREÇO (R$) — vazio = do plano</label><input type="text" name="preco_custom" placeholder="Ex: 250,00"></div>
        <div style="min-width:120px"><label>PERÍODO (dias) — vazio = do plano</label><input type="number" name="dias_custom" placeholder="Ex: 45"></div>
        <button class="btn green" type="submit">+ Criar licença</button>
      </form>
      <p style="font-size:12px;color:#64748b;margin-top:8px">Preencha preço/período para personalizar o valor desse cliente. O bot envia o PIX de renovação automaticamente 3 dias antes do vencimento.</p>
    </div>
    <div class="panel"><h2>🏷️ Planos de assinatura <span class="right"><small style="font-weight:400;color:#94a3b8">edite os valores que aparecem no select acima</small></span></h2>
      <table>
        <thead><tr><th>Nome</th><th>Preço (R$)</th><th>Período (dias)</th><th>Ações</th></tr></thead>
        <tbody>${plansHtml || '<tr><td colspan="4"><div class="empty">Nenhum plano ainda.</div></td></tr>'}</tbody>
      </table>
      <details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:#2563eb;font-weight:600">+ Adicionar novo plano</summary>
        <form method="POST" action="/admin/planos/novo" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-top:10px">
          <div><label>NOME</label><input type="text" name="name" required placeholder="Ex: Promocional"></div>
          <div><label>PREÇO (R$)</label><input type="text" name="price" required placeholder="Ex: 199,00"></div>
          <div><label>PERÍODO (dias)</label><input type="number" name="period_days" required placeholder="Ex: 30" value="30"></div>
          <button class="btn green" type="submit">+ Criar plano</button>
        </form>
      </details>
    </div>
    <div class="panel"><h2>📋 Licenças ativas</h2><table>
      <thead><tr><th>Cliente</th><th>Plano</th><th>Valor</th><th>Status</th><th>Vencimento</th><th>Ações</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty">Nenhuma assinatura ainda.</div></td></tr>'}</tbody>
    </table></div>`));
});

router.post('/admin/planos/novo', requireAuth, async (req, res) => {
  const b = req.body;
  await repo.createPlan(b.name, parseFloat(String(b.price).replace(',', '.')) || 0, Number(b.period_days) || 30);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Plano "${b.name}" criado!`));
});

router.post('/admin/planos/salvar', requireAuth, async (req, res) => {
  const b = req.body;
  await repo.updatePlan(Number(b.id), b.name, parseFloat(String(b.price).replace(',', '.')) || 0, Number(b.period_days) || 30);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Plano atualizado!'));
});

router.post('/admin/planos/excluir', requireAuth, async (req, res) => {
  const planId = Number(req.query.plan);
  const emUso = await repo.countSubscriptionsByPlan(planId);
  if (emUso > 0) {
    return res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Não é possível excluir: plano em uso por ${emUso} cliente(s).`) + '&type=err');
  }
  await repo.deletePlan(planId);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Plano excluído.'));
});

router.post('/admin/assinaturas/nova', requireAuth, async (req, res) => {
  const b = req.body;
  const plan = (await repo.getPlans()).find(p => p.id === Number(b.plan_id));
  if (!plan) return res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Plano inválido.') + '&type=err');

  const precoCustom = String(b.preco_custom || '').trim();
  const diasCustom = String(b.dias_custom || '').trim();
  const price = precoCustom !== '' ? parseFloat(precoCustom.replace(',', '.')) : Number(plan.price);
  const days = diasCustom !== '' ? Number(diasCustom) : Number(plan.period_days);

  await repo.createSubscription(Number(b.tenant_id), plan.id, price, days);
  const nota = (precoCustom !== '' || diasCustom !== '') ? ` (personalizado: R$ ${price} / ${days} dias)` : '';
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Licença criada: ${plan.name} — vence em ${days} dias.${nota}`));
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
//  CONTEÚDO DO TENANT (telas compartilhadas admin/cliente)
// ======================================================
function productImgSrc(image) {
  if (/^https?:\/\//.test(image)) return image;
  return `/images/${image}`;
}

async function pageProdutos(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Produtos', clientMode ? '/painel/produtos' : '/admin/produtos', '<div class="empty">Crie um cliente primeiro.</div>', tenants, null, clientMode));
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';
  const data = await catalog.loadTenantCatalog(tenant.id);
  const images = await listTenantImages(tenant.id);
  const base = clientMode ? '/painel' : '/admin';
  const gallery = galleryHtml(images, tenant.id, base);

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
        <td style="text-align:center"><button class="btn red small" type="submit" formaction="/admin/produtos/excluir-plano?ci=${ci}&pi=${pi}&plan_i=${k}" formnovalidate>🗑</button></td>
      </tr>`).join('') || '<tr><td colspan="8" style="color:#94a3b8;font-size:12px">Sem planos — adicione abaixo.</td></tr>';

      const base = clientMode ? '/painel' : '/admin';
      return `
      <div class="panel" style="margin-bottom:14px"><h2>✏️ ${esc(p.name)} ${p.plans?.length ? `<span class="badge info">${p.plans.length} plano(s)</span>` : ''} ${statusBadge(p.available ? 'ok' : 'no')}</h2>
      <form method="POST" action="${base}/produtos/salvar" class="grid2">
        <input type="hidden" name="tenant" value="${tenant.id}"><input type="hidden" name="ci" value="${ci}"><input type="hidden" name="pi" value="${pi}">
        <div>
          <label>NOME</label><input type="text" name="name" value="${esc(p.name)}" required>
          <label>PREÇO (R$)</label><input type="text" name="price" value="${p.price}">
          <div class="grid2"><div><label>UNIDADE</label><input type="text" name="unit" value="${esc(p.unit || '')}"></div><div><label>ESTOQUE</label><input type="number" name="stock" value="${p.stock ?? ''}"></div></div>
          <label>IMAGEM (nome ou URL)</label>
          <div style="display:flex;gap:8px;align-items:center"><input type="text" id="img-${ci}-${pi}" name="image" value="${esc(p.image || '')}">${p.image ? `<img class="prod-thumb" src="${productImgSrc(p.image)}" alt="">` : ''}</div>
          ${images.length ? `<div style="margin-top:8px">
            <small style="color:#64748b">Clique numa foto para usar:</small>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
              ${images.map(img => `<img src="${esc(img.url)}" onclick="document.getElementById('img-${ci}-${pi}').value='${esc(img.url)}'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid #e2e8f0" title="Usar esta imagem">`).join('')}
            </div>
          </div>` : ''}
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
          <button class="btn gray small" type="submit" formaction="${base}/produtos/novo-plano?ci=${ci}&pi=${pi}" formnovalidate style="margin-top:8px">+ Adicionar plano</button>
        </div>
        <div style="grid-column:1/-1;display:flex;gap:8px;margin-top:6px">
          <button class="btn" type="submit">💾 Salvar</button>
          <button class="btn red" type="submit" formaction="${base}/produtos/excluir" formnovalidate>🗑 Excluir produto</button>
        </div>
      </form></div>`;
    });
    return `<div class="panel"><h2>${esc(cat.emoji || '')} ${esc(cat.name)} <span class="right badge info">${cat.products.length} produto(s)</span></h2>
      ${prods.join('')}
      <details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:#2563eb;font-weight:600">+ Adicionar novo produto</summary>
      <form method="POST" action="${clientMode ? '/painel' : '/admin'}/produtos/novo" class="grid2" style="margin-top:12px">
        <input type="hidden" name="tenant" value="${tenant.id}">
        <input type="hidden" name="ci" value="${ci}">
        <div><label>ID ÚNICO</label><input type="text" name="id" required><label>NOME</label><input type="text" name="name" required><label>PREÇO (R$)</label><input type="text" name="price" required>
          <label><input type="checkbox" name="digital" style="width:auto"> Produto digital</label></div>
        <div><label>RESUMO</label><input type="text" name="short_description"><label>DESCRIÇÃO</label><textarea name="long_description"></textarea></div>
        <div style="grid-column:1/-1"><button class="btn green" type="submit">+ Criar produto</button></div>
      </form></details></div>`;
  }).join('');

  res.send(layout('Produtos', clientMode ? '/painel/produtos' : '/admin/produtos', `${tenantSelector(tenant.id, tenants, clientMode)}${flash}
    <div class="panel"><h2>📤 Enviar foto de produto <span class="right"><button class="btn small" onclick="document.getElementById('fileInput').click()">Escolher arquivo</button></span></h2>
      <form method="POST" action="${base}/upload" enctype="multipart/form-data">
        <input type="file" id="fileInput" name="foto" accept="image/*" required style="display:none" onchange="this.form.submit()">
      </form>
      <p style="font-size:12px;color:#64748b">Depois de enviar, a foto aparece na galeria abaixo — <b>clique nela</b> (nos produtos) para usar, ou copie a URL.</p>
    </div>
    ${gallery}
    ${catsHtml}`, tenants, tenant, clientMode));
}

router.get('/admin/produtos', requireAuth, pageProdutos);
router.get('/painel/produtos', clientPanelAuth, pageProdutos);

async function postProdutosNovo(req, res) {
  const b = req.body;
  const tenantId = tenantIdFromReq(req, b.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  if (!cat) return res.redirect(`${base}/produtos`);
  if (cat.products.some(p => p.id === b.id)) return res.redirect(`${base}/produtos?msg=` + encodeURIComponent('ID já existe.') + '&type=err');
  cat.products.push({
    id: b.id, name: b.name, short_description: b.short_description || '', long_description: b.long_description || '',
    price: parseFloat(String(b.price).replace(',', '.')) || 0, image: 'placeholder.png', available: true,
    digital: b.digital === 'on',
  });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/produtos?msg=` + encodeURIComponent(`Produto "${b.name}" criado!`));
}

router.post('/admin/produtos/novo', requireAuth, postProdutosNovo);
router.post('/painel/produtos/novo', clientPanelAuth, postProdutosNovo);

async function postProdutosSalvar(req, res) {
  const b = req.body;
  const tenantId = tenantIdFromReq(req, b.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  const p = cat?.products?.[Number(b.pi)];
  if (!cat || !p) return res.redirect(`${base}/produtos`);
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
  res.redirect(`${base}/produtos?msg=` + encodeURIComponent(`Produto "${p.name}" atualizado!`));
}

router.post('/admin/produtos/salvar', requireAuth, postProdutosSalvar);
router.post('/painel/produtos/salvar', clientPanelAuth, postProdutosSalvar);

async function postProdutosExcluir(req, res) {
  const b = req.body;
  const tenantId = tenantIdFromReq(req, b.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const cat = data.categories[Number(b.ci)];
  const p = cat?.products?.[Number(b.pi)];
  if (p) {
    cat.products.splice(Number(b.pi), 1);
    await catalog.saveTenantCatalog(tenantId, data);
  }
  res.redirect(`${base}/produtos`);
}

router.post('/admin/produtos/excluir', requireAuth, postProdutosExcluir);
router.post('/painel/produtos/excluir', clientPanelAuth, postProdutosExcluir);

async function postProdutosNovoPlano(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const p = data.categories[Number(req.query.ci)]?.products[Number(req.query.pi)];
  if (!p) return res.redirect(`${base}/produtos`);
  if (!p.plans) p.plans = [];
  p.plans.push({ id: '', name: '', price: null, period: 'mês', popular: false, payment_link: '', redirect_link: '', features: '' });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/produtos`);
}

router.post('/admin/produtos/novo-plano', requireAuth, postProdutosNovoPlano);
router.post('/painel/produtos/novo-plano', clientPanelAuth, postProdutosNovoPlano);

async function postProdutosExcluirPlano(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const p = data.categories[Number(req.query.ci)]?.products[Number(req.query.pi)];
  const plan_i = Number(req.query.plan_i);
  if (p?.plans && Number.isInteger(plan_i)) {
    p.plans.splice(plan_i, 1);
    if (!p.plans.length) p.plans = undefined;
    await catalog.saveTenantCatalog(tenantId, data);
  }
  res.redirect(`${base}/produtos`);
}

router.post('/admin/produtos/excluir-plano', requireAuth, postProdutosExcluirPlano);
router.post('/painel/produtos/excluir-plano', clientPanelAuth, postProdutosExcluirPlano);

// ----- UPLOAD DE IMAGENS -----
router.post('/admin/upload', requireAuth, upload.single('foto'), async (req, res) => {
  if (!req.file) return res.redirect('/admin/produtos?msg=' + encodeURIComponent('Nenhum arquivo recebido.') + '&type=err');
  let tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant || req.cookies?.rpz_tenant);
  if (!Number.isFinite(tenantId)) tenantId = 0;
  try {
    const url = await saveUploadedImage(tenantId, req.file);
    await repo.addTenantImage(tenantId, url);
    res.redirect(`${req.clientMode ? '/painel' : '/admin'}/produtos?msg=` + encodeURIComponent(`Imagem enviada! Copie a URL: ${url}`));
  } catch (e) {
    console.error('[UPLOAD]', e.message);
    res.redirect(`/admin/produtos?msg=` + encodeURIComponent('Erro no upload: ' + e.message) + '&type=err');
  }
});

router.post('/painel/upload', clientPanelAuth, upload.single('foto'), async (req, res) => {
  if (!req.file) return res.redirect('/painel/produtos?msg=' + encodeURIComponent('Nenhum arquivo recebido.') + '&type=err');
  const tenantId = req.tenantSession.id;
  try {
    const url = await saveUploadedImage(tenantId, req.file);
    await repo.addTenantImage(tenantId, url);
    res.redirect('/painel/produtos?msg=' + encodeURIComponent(`Imagem enviada! Copie a URL: ${url}`));
  } catch (e) {
    console.error('[UPLOAD]', e.message);
    res.redirect('/painel/produtos?msg=' + encodeURIComponent('Erro no upload: ' + e.message) + '&type=err');
  }
});

// ======================================================
//  LISTAS (textos dos blocos de seleção — admin e cliente)
// ======================================================
function previewProduto(p) {
  if (p.list_description) return p.list_description;
  const preco = p.sob_consulta ? 'Sob consulta' : catalog.formatPrice(p.price);
  return `${preco} — ${p.short_description || ''}`;
}

function previewPlano(pl) {
  if (pl.list_description) return pl.list_description;
  return `${pl.price ? catalog.formatPrice(pl.price) : 'Sob medida'}/${pl.period} — ${(pl.features || '').split('\n')[0]}`;
}

async function pageListas(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Listas', clientMode ? '/painel/listas' : '/admin/listas', '<div class="empty">Crie um cliente primeiro.</div>', tenants, null, clientMode));
  const flash = req.query.msg ? `<div id="flashMsg">${esc(req.query.msg)}</div>` : '';
  const data = await catalog.loadTenantCatalog(tenant.id);
  const base = clientMode ? '/painel' : '/admin';
  const images = await listTenantImages(tenant.id);
  const gallery = galleryHtml(images, tenant.id, base);

  const catsHtml = data.categories.map((cat, ci) => `
    <div class="panel"><h2>${esc(cat.emoji || '')} ${esc(cat.name)}</h2>
      ${cat.products.map((p, pi) => {
        const plansHtml = (p.plans || []).map((pl, ki) => `
          <div style="margin:10px 0 10px 28px;padding:10px 14px;background:#f8fafc;border-radius:9px">
            <label style="margin-top:0">💠 Plano ${esc(pl.name)}${pl.popular ? ' ★' : ''} — descrição da lista</label>
            <textarea name="pld[${ci}][${pi}][${ki}]" placeholder="Vazio = ${esc(previewPlano(pl))}">${esc(pl.list_description || '')}</textarea>
            <div style="font-size:11.5px;color:#64748b;margin-top:4px">Fallback: ${esc(previewPlano(pl))}</div>
          </div>`).join('');
        return `
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:12px">
          <h3 style="font-size:14px;margin-bottom:8px">${pi + 1}. ${esc(p.name)}</h3>
          <label>DESCRIÇÃO DA LISTA (bloco de seleção no WhatsApp)</label>
          <textarea name="ld[${ci}][${pi}]" placeholder="Vazio = ${esc(previewProduto(p))}">${esc(p.list_description || '')}</textarea>
          <div style="font-size:11.5px;color:#64748b;margin-top:4px">Se vazio, usa: <b>${esc(previewProduto(p))}</b></div>
          ${plansHtml}
        </div>`;
      }).join('') || '<div class="empty">Nenhum produto nesta categoria.</div>'}
    </div>`).join('') || '<div class="empty">Nenhuma categoria ainda — adicione produtos primeiro.</div>';

  res.send(layout('Listas', clientMode ? '/painel/listas' : '/admin/listas', `${tenantSelector(tenant.id, tenants, clientMode)}${flash}
    <div class="flash">✏️ Preencha o texto exato de cada bloco (sem preço automático). <b>Deixe vazio</b> para voltar ao padrão (preço — resumo).</div>
    ${gallery}
    <form method="POST" action="${base}/listas/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      ${catsHtml}
      <button class="btn" type="submit">💾 Salvar todas as listas</button>
    </form>`, tenants, tenant, clientMode));
}

async function postListasSalvar(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);

  const ld = req.body.ld || {};
  for (const [ci, prods] of Object.entries(ld)) {
    for (const [pi, val] of Object.entries(prods)) {
      const p = data.categories[Number(ci)]?.products[Number(pi)];
      if (!p) continue;
      const v = String(val).trim();
      if (v) p.list_description = v; else delete p.list_description;
    }
  }

  const pld = req.body.pld || {};
  for (const [ci, prods] of Object.entries(pld)) {
    for (const [pi, plans] of Object.entries(prods)) {
      const p = data.categories[Number(ci)]?.products[Number(pi)];
      if (!p) continue;
      for (const [ki, val] of Object.entries(plans)) {
        const pl = p.plans?.[Number(ki)];
        if (!pl) continue;
        const v = String(val).trim();
        if (v) pl.list_description = v; else delete pl.list_description;
      }
    }
  }

  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/listas?msg=` + encodeURIComponent('Listas salvas!'));
}

router.get('/admin/listas', requireAuth, pageListas);
router.get('/painel/listas', clientPanelAuth, pageListas);
router.post('/admin/listas/salvar', requireAuth, postListasSalvar);
router.post('/painel/listas/salvar', clientPanelAuth, postListasSalvar);

// ----- EXCLUSÃO DE IMAGENS -----
async function postImagensExcluir(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const url = String(req.body.url || '');
  if (!url) return res.redirect(`${base}/produtos?msg=` + encodeURIComponent('URL inválida.') + '&type=err');
  try {
    // Remove do registro (galeria some na hora) e tenta limpar o Blob
    await repo.deleteTenantImageDb(tenantId, url);
    deleteBlobImage(tenantId, url).catch(() => {});
    res.redirect(`${base}/produtos?msg=` + encodeURIComponent('Imagem excluída.'));
  } catch (e) {
    console.error('[IMAGES] excluir:', e.message);
    res.redirect(`${base}/produtos?msg=` + encodeURIComponent('Erro ao excluir: ' + e.message) + '&type=err');
  }
}

router.post('/admin/imagens/excluir', requireAuth, postImagensExcluir);
router.post('/painel/imagens/excluir', clientPanelAuth, postImagensExcluir);

// ----- PEDIDOS -----
async function pagePedidos(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Pedidos', clientMode ? '/painel/pedidos' : '/admin/pedidos', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const filter = req.query.status || 'todos';
  const orders = (await repo.getOrders(tenant.id)).filter(o => filter === 'todos' || o.status === filter);
  const statusFilter = ['todos', 'pending', 'approved', 'shipped', 'delivered', 'cancelled'].map(s =>
    `<a class="btn ${filter === s ? '' : 'gray'} small" href="${clientMode ? '/painel' : '/admin'}/pedidos?status=${s}">${s === 'todos' ? 'Todos' : s}</a>`).join(' ');

  const rowsHtml = (await Promise.all(orders.map(async o => {
    const items = (await repo.getOrderItems(o.id)).map(it => `${it.quantity}x ${esc(it.product_name)}`).join('<br>');
    const pay = await repo.getPaymentByOrderId(o.id);
    const lead = await repo.getLead(o.lead_id);
    return `<tr>
      <td><b>#${esc(o.external_id)}</b><br><small style="color:#94a3b8">${esc(String(o.created_at).slice(0, 16))}</small></td>
      <td>${esc(lead?.full_name || '—')}<br><small style="color:#94a3b8">${esc(lead?.phone || '')}</small></td>
      <td>${items}</td><td>${money(o.total)}</td><td>${statusBadge(o.status)}</td>
      <td>${methodLabel(pay?.payment_method)}<br><small style="color:#94a3b8">${esc(pay?.mp_payment_id || '')}</small></td>
      <td>${o.status === 'pending' ? `<form class="inline-form" method="POST" action="${clientMode ? '/painel' : '/admin'}/pedidos/status"><input type="hidden" name="id" value="${o.id}"><input type="hidden" name="status" value="approved"><button class="btn green small">Pago</button></form>` : ''}</td>
    </tr>`;
  }))).join('');

  res.send(layout('Pedidos', clientMode ? '/painel/pedidos' : '/admin/pedidos', `${tenantSelector(tenant.id, tenants, clientMode)}
    <div class="filters">${statusFilter}</div>
    <div class="panel"><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Itens</th><th>Total</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="7"><div class="empty">Nenhum pedido com esse filtro.</div></td></tr>'}</tbody></table></div>`, tenants, tenant, clientMode));
}

router.get('/admin/pedidos', requireAuth, pagePedidos);
router.get('/painel/pedidos', clientPanelAuth, pagePedidos);

async function postPedidosStatus(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  await repo.updateOrderStatus(Number(req.body.id), String(req.body.status));
  res.redirect(`${base}/pedidos`);
}

router.post('/admin/pedidos/status', requireAuth, postPedidosStatus);
router.post('/painel/pedidos/status', clientPanelAuth, postPedidosStatus);

// ----- LEADS -----
async function pageLeads(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Leads', clientMode ? '/painel/leads' : '/admin/leads', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const leads = await repo.listLeads(tenant.id);
  const rows = leads.map(l => `<tr>
    <td><b>${esc(l.full_name || '—')}</b><br><small style="color:#94a3b8">${esc(l.phone)}</small></td>
    <td>${esc(l.delivery_address || '—')}</td>
    <td>${statusBadge(l.status)}</td>
    <td><form class="inline-form" method="POST" action="${clientMode ? '/painel' : '/admin'}/leads/status"><input type="hidden" name="id" value="${l.id}">
      <select name="status" onchange="this.form.submit()">${['novo', 'contatado', 'convertido', 'fechado'].map(s => `<option value="${s}" ${(l.status === s || (l.status?.startsWith('pausado') && s === 'novo')) ? 'selected' : ''}>${s}</option>`).join('')}</select></form></td>
    <td>${esc(String(l.created_at).slice(0, 16))}</td>
    <td><button class="btn small" onclick="copyText('${esc(l.phone)}', this)">📋 Número</button></td>
  </tr>`).join('');
  res.send(layout('Leads', clientMode ? '/painel/leads' : '/admin/leads', `${tenantSelector(tenant.id, tenants, clientMode)}
    <div class="panel"><table id="tblLeads"><thead><tr><th>Cliente</th><th>Endereço</th><th>Status</th><th>Alterar</th><th>Contato</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6"><div class="empty">Nenhum lead.</div></td></tr>'}</tbody></table></div>`, tenants, tenant, clientMode));
}

router.get('/admin/leads', requireAuth, pageLeads);
router.get('/painel/leads', clientPanelAuth, pageLeads);

async function postLeadsStatus(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  await repo.updateLeadStatus(Number(req.body.id), String(req.body.status));
  res.redirect(`${base}/leads`);
}

router.post('/admin/leads/status', requireAuth, postLeadsStatus);
router.post('/painel/leads/status', clientPanelAuth, postLeadsStatus);

// ----- PERGUNTAS -----
async function pagePerguntas(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Perguntas', clientMode ? '/painel/perguntas' : '/admin/perguntas', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const base = clientMode ? '/painel' : '/admin';
  const qs = Object.entries(data.questionnaires || {}).map(([qid, q]) => {
    const rows = (q.questions || []).map((question, qi) => `
      <tr><td><input type="text" name="q[${esc(qid)}][${qi}][key]" value="${esc(question.key)}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][field]" value="${esc(question.field || '')}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][question]" value="${esc(question.question)}" style="min-width:240px"></td>
      <td style="text-align:center"><input type="checkbox" name="q[${esc(qid)}][${qi}][optional]" ${question.optional ? 'checked' : ''}></td>
      <td style="text-align:center"><button class="btn red small" type="submit" formaction="${base}/perguntas/remover?qid=${esc(qid)}&qi=${qi}" formnovalidate>🗑</button></td></tr>`).join('') || '<tr><td colspan="5" style="color:#64748b">Sem perguntas.</td></tr>';
    return `<div class="panel"><h2>${esc(q.label || qid)} <span class="badge info">${esc(qid)}</span></h2>
      <form method="POST" action="${base}/perguntas/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
        <table><thead><tr><th>Chave</th><th>Campo do lead</th><th>Pergunta</th><th>Opcional</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn" type="submit">💾 Salvar</button>
        <button class="btn gray" type="submit" formaction="${base}/perguntas/nova?qid=${esc(qid)}" formnovalidate>+ Nova pergunta</button></div>
      </form></div>`;
  }).join('') || '<div class="panel">Nenhum questionário.</div>';
  res.send(layout('Perguntas', clientMode ? '/painel/perguntas' : '/admin/perguntas', `${tenantSelector(tenant.id, tenants, clientMode)}${qs}`, tenants, tenant, clientMode));
}

router.get('/admin/perguntas', requireAuth, pagePerguntas);
router.get('/painel/perguntas', clientPanelAuth, pagePerguntas);

async function postPerguntasNova(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const qid = String(req.query.qid || '');
  if (!data.questionnaires?.[qid]) return res.redirect(`${base}/perguntas`);
  data.questionnaires[qid].questions.push({ key: '', field: '', question: '', optional: false });
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/perguntas`);
}

router.post('/admin/perguntas/nova', requireAuth, postPerguntasNova);
router.post('/painel/perguntas/nova', clientPanelAuth, postPerguntasNova);

async function postPerguntasRemover(req, res) {
  const tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const qid = String(req.query.qid || '');
  const qi = Number(req.query.qi);
  if (data.questionnaires?.[qid] && Number.isInteger(qi)) data.questionnaires[qid].questions.splice(qi, 1);
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/perguntas`);
}

router.post('/admin/perguntas/remover', requireAuth, postPerguntasRemover);
router.post('/painel/perguntas/remover', clientPanelAuth, postPerguntasRemover);

async function postPerguntasSalvar(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
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
  res.redirect(`${base}/perguntas`);
}

router.post('/admin/perguntas/salvar', requireAuth, postPerguntasSalvar);
router.post('/painel/perguntas/salvar', clientPanelAuth, postPerguntasSalvar);

// ----- MENSAGENS -----
async function pageMensagens(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Mensagens', clientMode ? '/painel/mensagens' : '/admin/mensagens', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const fields = Object.entries(data.messages || {}).map(([key, value]) => `
    <div class="panel"><h2>${esc(key)}</h2><textarea name="msgs[${esc(key)}]" style="min-height:80px">${esc(value)}</textarea></div>`).join('');
  res.send(layout('Mensagens', clientMode ? '/painel/mensagens' : '/admin/mensagens', `${tenantSelector(tenant.id, tenants, clientMode)}
    <form method="POST" action="${clientMode ? '/painel' : '/admin'}/mensagens/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      ${fields}<button class="btn" type="submit">💾 Salvar mensagens</button></form>`, tenants, tenant, clientMode));
}

router.get('/admin/mensagens', requireAuth, pageMensagens);
router.get('/painel/mensagens', clientPanelAuth, pageMensagens);

async function postMensagensSalvar(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const msgs = req.body.msgs || {};
  for (const key of Object.keys(data.messages || {})) {
    if (msgs[key] !== undefined) data.messages[key] = msgs[key];
  }
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/mensagens`);
}

router.post('/admin/mensagens/salvar', requireAuth, postMensagensSalvar);
router.post('/painel/mensagens/salvar', clientPanelAuth, postMensagensSalvar);

// ----- CONFIG -----
async function pageConfig(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Configurações', clientMode ? '/painel/config' : '/admin/config', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const s = data.store || {};
  const c = data.company || {};
  const addr = c.address || {};
  const mi = s.menu_image || {};
  const base = clientMode ? '/painel' : '/admin';
  const firstCat = (data.categories || []).find(cat => (cat.products || []).some(p => p.available)) || data.categories?.[0];

  const previewCat = firstCat?.id || '';
  const logoUrl = c.logo_url || '';
  const logoThumb = logoUrl ? `<div style="margin-top:8px"><img src="${esc(logoUrl)}" style="max-height:56px;border-radius:8px"><button class="btn red small" style="margin-left:8px" onclick="document.getElementById('logoUrlField').value=''">Remover</button></div>` : '';

  res.send(layout('Configurações', clientMode ? '/painel/config' : '/admin/config', `${tenantSelector(tenant.id, tenants, clientMode)}
    <form method="POST" action="${base}/config/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      <div class="panel"><h2>🏪 Loja</h2><div class="grid3">
        <div><label>FRETE (R$)</label><input type="text" name="store[delivery_fee]" value="${s.delivery_fee ?? 0}"></div>
        <div><label>FRETE GRÁTIS ACIMA (R$)</label><input type="text" name="store[delivery_free_full]" value="${s.delivery_free_full ?? 0}"></div>
        <div><label>DESCONTO PIX (%)</label><input type="text" name="store[pix_discount_percent]" value="${s.pix_discount_percent ?? 0}"></div>
      </div></div>
      <div class="panel"><h2>🏢 Empresa</h2><div class="grid2">
        <div><label>NOME DA EMPRESA</label><input type="text" name="company[name]" value="${esc(c.name || '')}"></div>
        <div><label>HORÁRIO</label><input type="text" name="company[business_hours]" value="${esc(c.business_hours || '')}"></div>
        <div><label>ENDEREÇO (rua, n°)</label><input type="text" name="company[address][street]" value="${esc(addr.street || '')}"></div>
        <div><label>CIDADE</label><input type="text" name="company[address][city]" value="${esc(addr.city || '')}"></div>
      </div></div>
      <div class="panel"><h2>🖼️ Imagem do menu (lista de produtos)</h2>
        <div class="grid3">
          <div><label>COR DO CABEÇALHO</label><input type="color" id="miHeaderBg" name="store[menu_image][header_bg]" value="${esc(mi.header_bg || '#1e3a8a')}" oninput="previewMenu()"></div>
          <div><label>COR DOS PREÇOS</label><input type="color" id="miPriceColor" name="store[menu_image][price_color]" value="${esc(mi.price_color || '#1d4ed8')}" oninput="previewMenu()"></div>
          <div><label>TEXTO DO RODAPÉ (opcional)</label><input type="text" id="miFooter" name="store[menu_image][footer_text]" value="${esc(mi.footer_text || '')}" placeholder="Ex: Toque no produto abaixo" oninput="previewMenu()"></div>
        </div>
        <div style="margin-top:10px">
          <label style="display:inline-flex;align-items:center;gap:6px;margin-right:18px"><input type="hidden" name="store[menu_image][enabled]" value="off"><input type="checkbox" id="miEnabled" name="store[menu_image][enabled]" value="on" ${mi.enabled !== false ? 'checked' : ''} onchange="previewMenu()"> Mostrar imagem do menu</label>
          <label style="display:inline-flex;align-items:center;gap:6px;margin-right:18px"><input type="hidden" name="store[menu_image][show_price]" value="off"><input type="checkbox" id="miShowPrice" name="store[menu_image][show_price]" value="on" ${mi.show_price !== false ? 'checked' : ''} onchange="previewMenu()"> Mostrar preços</label>
          <label style="display:inline-flex;align-items:center;gap:6px"><input type="hidden" name="store[menu_image][show_numbers]" value="off"><input type="checkbox" id="miShowNums" name="store[menu_image][show_numbers]" value="on" ${mi.show_numbers !== false ? 'checked' : ''} onchange="previewMenu()"> Mostrar números (1., 2., 3.)</label>
        </div>
        <div style="margin-top:14px;border-top:1px dashed #e2e8f0;padding-top:12px">
          <label>LOGO DO CLIENTE (aparece no topo da imagem)</label>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <input type="text" id="logoUrlField" name="company[logo_url]" value="${esc(logoUrl)}" placeholder="URL da logo ou envie abaixo">
          </div>
          ${logoThumb}
        </div>
      </div>
      <button class="btn" type="submit">💾 Salvar</button>
    </form>
    <div class="panel"><h2>🖼️ Enviar logo do cliente</h2>
      <form method="POST" action="${base}/config/logo" enctype="multipart/form-data" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
        <input type="hidden" name="tenant" value="${tenant.id}">
        <input type="file" name="logo" accept="image/*">
        <button class="btn" type="submit">Enviar logo</button>
      </form>
      <p style="font-size:12px;color:#64748b;margin-top:8px">Depois de enviar, a URL aparece no campo acima. Clique em <b>Salvar</b> para aplicar.</p>
    </div>
    <div class="panel"><h2>👁 Preview da imagem do menu</h2>
      <img id="menuPreview" src="/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(previewCat)}&refresh=1&v=1" style="max-width:360px;width:100%;border:1px solid #e2e8f0;border-radius:10px" alt="Preview">
      <p style="font-size:12px;color:#64748b;margin-top:8px">Atualiza conforme você muda as cores/acima. Salve para aplicar no bot (em até 15s).</p>
    </div>
    <script>
      function previewMenu(){
        const v = Date.now();
        const sp = document.getElementById('miShowPrice').checked ? '1' : '0';
        const sn = document.getElementById('miShowNums').checked ? '1' : '0';
        const url = '/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(previewCat)}&refresh=1&v=' + v +
          '&header_bg=' + encodeURIComponent(document.getElementById('miHeaderBg').value) +
          '&price_color=' + encodeURIComponent(document.getElementById('miPriceColor').value) +
          '&show_price=' + sp + '&show_numbers=' + sn +
          '&footer_text=' + encodeURIComponent(document.getElementById('miFooter').value);
        document.getElementById('menuPreview').src = url;
      }
    </script>`, tenants, tenant, clientMode));
}

router.get('/admin/config', requireAuth, pageConfig);
router.get('/painel/config', clientPanelAuth, pageConfig);

async function postConfigSalvar(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const s = req.body.store || {};
  if (s.delivery_fee !== undefined) data.store.delivery_fee = parseFloat(String(s.delivery_fee).replace(',', '.')) || 0;
  if (s.delivery_free_full !== undefined) data.store.delivery_free_full = parseFloat(String(s.delivery_free_full).replace(',', '.')) || 0;
  if (s.pix_discount_percent !== undefined) data.store.pix_discount_percent = parseFloat(String(s.pix_discount_percent).replace(',', '.')) || 0;

  // Imagem do menu
  const mi = s.menu_image || {};
  const checkboxVal = (v) => (Array.isArray(v) ? v[v.length - 1] : v) === 'on';
  if (!data.store.menu_image) data.store.menu_image = {};
  if (mi.header_bg !== undefined) data.store.menu_image.header_bg = mi.header_bg || '#1e3a8a';
  if (mi.price_color !== undefined) data.store.menu_image.price_color = mi.price_color || '#1d4ed8';
  if (mi.show_price !== undefined) data.store.menu_image.show_price = checkboxVal(mi.show_price);
  if (mi.show_numbers !== undefined) data.store.menu_image.show_numbers = checkboxVal(mi.show_numbers);
  if (mi.enabled !== undefined) data.store.menu_image.enabled = checkboxVal(mi.enabled);
  if (mi.footer_text !== undefined) data.store.menu_image.footer_text = mi.footer_text || '';

  const c = req.body.company || {};
  if (c.name !== undefined) data.company.name = c.name;
  if (c.business_hours !== undefined) data.company.business_hours = c.business_hours;
  if (c.logo_url !== undefined) data.company.logo_url = c.logo_url || '';
  const addr = c.address || {};
  for (const k of ['street', 'neighborhood', 'city', 'state', 'zip']) {
    if (addr[k] !== undefined) {
      if (!data.company.address) data.company.address = {};
      data.company.address[k] = addr[k];
    }
  }
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/config`);
}

router.post('/admin/config/salvar', requireAuth, postConfigSalvar);
router.post('/painel/config/salvar', clientPanelAuth, postConfigSalvar);

// ----- UPLOAD DE LOGO (config) -----
async function postConfigLogo(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  if (!req.file) return res.redirect(`${base}/config?msg=` + encodeURIComponent('Nenhum arquivo recebido.') + '&type=err');
  try {
    const url = await saveUploadedImage(tenantId, req.file);
    await repo.addTenantImage(tenantId, url);
    const data = await catalog.loadTenantCatalog(tenantId);
    data.company.logo_url = url;
    await catalog.saveTenantCatalog(tenantId, data);
    res.redirect(`${base}/config?msg=` + encodeURIComponent('Logo salvo!'));
  } catch (e) {
    console.error('[UPLOAD LOGO]', e.message);
    res.redirect(`${base}/config?msg=` + encodeURIComponent('Erro ao enviar logo: ' + e.message) + '&type=err');
  }
}

router.post('/admin/config/logo', requireAuth, upload.single('logo'), postConfigLogo);
router.post('/painel/config/logo', clientPanelAuth, upload.single('logo'), postConfigLogo);

// ----- TROCA DE SENHA (cliente) -----
router.get('/painel/senha', clientPanelAuth, (req, res) => {
  const tenant = req.tenantSession;
  res.send(layout('Trocar senha', '/painel/senha', `
    <div class="panel"><h2>🔑 Trocar senha</h2>
      <form method="POST" action="/painel/senha" style="max-width:420px">
        <label>SENHA ATUAL</label><input type="password" name="atual" required>
        <label>NOVA SENHA</label><input type="password" name="nova" required minlength="6">
        <label>CONFIRMAR NOVA SENHA</label><input type="password" name="confirma" required minlength="6">
        <div style="margin-top:14px"><button class="btn" type="submit">💾 Alterar senha</button></div>
      </form>
    </div>`, [tenant], tenant, true));
});

router.post('/painel/senha', clientPanelAuth, async (req, res) => {
  const tenant = req.tenantSession;
  const { atual, nova, confirma } = req.body;
  if (nova !== confirma) return res.redirect('/painel/senha?msg=' + encodeURIComponent('Confirmação não confere.') + '&type=err');
  if (!repo.verifyPassword(atual, tenant.panel_password)) return res.redirect('/painel/senha?msg=' + encodeURIComponent('Senha atual incorreta.') + '&type=err');
  await repo.updateTenant(tenant.id, { panel_password: repo.hashPassword(nova) });
  res.redirect('/painel/senha?msg=' + encodeURIComponent('Senha alterada com sucesso!'));
});

module.exports = router;