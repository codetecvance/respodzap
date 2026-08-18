const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const catalog = require('./catalog');
const repo = require('./repository');
const config = require('./config');
const ticket = require('./ticket');

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
  ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })
  : multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

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
    try { if (file.path) require('fs').unlinkSync(file.path); } catch (_err) {}
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
  if (!tenant) {
    // Cliente excluído com sessão aberta → limpa o cookie (evita loop)
    res.setHeader('Set-Cookie', 'rpz_tenant_auth=; Path=/; Max-Age=0');
    return res.redirect('/painel/login');
  }

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
  const tenant = tenants.find(t => t.id === id) || tenants[0] || null;
  if (tenant) res.setHeader('Set-Cookie', `rpz_tenant=${tenant.id}; Path=/; Max-Age=2592000`);
  return { tenant, tenants };
}

function tenantSelector(activeTenantId, tenants, clientMode) {
  if (clientMode) return '';
  const options = tenants.map(t =>
    `<option value="${t.id}" ${t.id === activeTenantId ? 'selected' : ''}>${esc(t.name)}${t.status !== 'ativo' ? ' (inativo)' : ''}</option>`,
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
function layout(title, active, content, _tenants = [], activeTenantId = null, clientMode = false) {
  const items = clientMode ? [
    ['/painel', '📊 Dashboard'],
    ['/painel/relatorios', '📈 Relatórios'],
    ['/painel/produtos', '🛍 Produtos'],
    ['/painel/listas', '📋 Listas'],
    ['/painel/pedidos', '🧾 Pedidos'],
    ['/painel/leads', '👤 Leads'],
    ['/painel/perguntas', '❓ Perguntas'],
    ['/painel/mensagens', '💬 Mensagens'],
    ['/painel/botoes', '🔘 Botões e Atendente'],
    ['/painel/config', '⚙️ Configurações'],
    ['/painel/senha', '🔑 Trocar senha'],
  ] : [
    ['/admin', '📊 Dashboard'],
    ['/admin/clientes', '👥 Clientes'],
    ['/admin/segmentos', '🏷️ Segmentos'],
    ['/admin/assinaturas', '📋 Assinaturas'],
    ['/admin/relatorios', '📈 Relatórios'],
    ['/admin/produtos', '🛍 Produtos'],
    ['/admin/listas', '📋 Listas'],
    ['/admin/pedidos', '🧾 Pedidos'],
    ['/admin/leads', '👤 Leads'],
    ['/admin/perguntas', '❓ Perguntas'],
    ['/admin/mensagens', '💬 Mensagens'],
    ['/admin/botoes', '🔘 Botões e Atendente'],
    ['/admin/config', '⚙️ Configurações'],
  ];

  const nav = items.map(([href, label]) => {
    let h = href;
    if (!clientMode && activeTenantId && ['/admin/produtos', '/admin/pedidos', '/admin/leads', '/admin/perguntas', '/admin/mensagens', '/admin/botoes', '/admin/config'].includes(href)) {
      h += `?tenant=${activeTenantId?.id ?? activeTenantId}`;
    }
    return `<a class="nav-item ${href === active ? 'active' : ''}" href="${h}">${label}</a>`;
  }).join('');

  const brand = clientMode
    ? `<div class="brand"><div class="logo">${esc((activeTenantId?.name || 'Cliente').slice(0, 2).toUpperCase())}</div><div><b>${esc(activeTenantId?.name || 'Painel')}</b><span>${activeTenantId?.segment_emoji ? `${esc(activeTenantId.segment_emoji)} ${esc(activeTenantId.segment_name)}` : 'Painel do cliente'}</span></div></div>`
    : `<div class="brand"><div class="logo">RZ</div><div><b>RespVZap</b><span>Painel SaaS</span></div></div>`;

  // Identidade visual por ramo (painel do cliente)
  const theme = catalog.segmentTheme(activeTenantId?.segment_name);
  const asideBg = clientMode ? `linear-gradient(180deg,${theme.sidebar[0]},${theme.sidebar[1]})` : 'linear-gradient(180deg,#0f172a,#1e293b)';
  const activeColor = clientMode ? theme.active : '#3b82f6';
  const activeBg = clientMode ? theme.active : '#2563eb';
  const logoGrad = clientMode ? `linear-gradient(135deg,${theme.sidebar[1]},${theme.active})` : 'linear-gradient(135deg,#38bdf8,#2563eb)';

  // Impressão automática de pedidos pagos (painel do cliente e admin — todos os ramos)
  // Modos: Bluetooth (térmica ESC/POS via Web Bluetooth) ou impressora do sistema.
  const impTid = activeTenantId?.id || 0;
  const printScript = `
  <script>
    const IMP_IS_ADMIN = ${clientMode ? 'false' : 'true'};
    const IMP_TID = ${impTid};
    function impBase(){ return IMP_IS_ADMIN ? '/admin/api/impressao?tenant=' + IMP_TID : '/painel/api/impressao'; }
    function impMarcar(){ return IMP_IS_ADMIN ? '/admin/api/impressao/marcar' : '/painel/api/impressao/marcar'; }
    function impTeste(){ return IMP_IS_ADMIN ? '/admin/api/impressao/teste?tenant=' + IMP_TID : '/painel/api/impressao/teste'; }
    function impReimprimir(id){ return IMP_IS_ADMIN ? '/admin/api/impressao/reimprimir?id=' + id + '&tenant=' + IMP_TID : '/painel/api/impressao/reimprimir?id=' + id; }
  </script><script>
    let imprimindo = false;
    let btDevice = null, btChar = null;
    const btPrefs = { modo: localStorage.getItem('rpz_imp_modo') || 'sistema', largura: localStorage.getItem('rpz_imp_largura') || '80' };

    // ---------- ESC/POS ----------
    const SIMPLES_ACENTO = { á:'a',à:'a',â:'a',ã:'a',ä:'a',é:'e',è:'e',ê:'e',í:'i',î:'i',ó:'o',ô:'o',õ:'o',ö:'o',ú:'u',û:'u',ü:'u',ç:'c',Ã:'A',Á:'A',À:'A',Â:'A',Õ:'O',Ó:'O',Ô:'O',É:'E',È:'E',Ê:'E',Í:'I',Ú:'U',Û:'U',Ü:'U',Ç:'C','—':'-','–':'-','…':'...','✅':'','💠':'','💳':'','🚚':'','📦':'','❌':'','⏳':'' };
    function escposTxt(s){ return String(s ?? '').replace(/[áàâãäéèêíîóôõöúûüçÃÁÀÂÕÓÔÉÈÊÍÚÛÜÇ—–…✅💠💳🚚📦❌⏳]/g, ch => SIMPLES_ACENTO[ch] || ''); }
    function escposBuffer(texto, largura){
      const W = largura === '58' ? 32 : 42;
      const out = [];
      const push = (...b) => out.push(...b);
      push(0x1b, 0x40);                       // ESC @ reset
      push(0x1b, 0x74, 0x11);                 // codepage Windows-1252
      for (const linhaRaw of String(texto || '').split('\\n')) {
        let l = escposTxt(linhaRaw);
        const w = Math.min(W, l.length);
        push(0x1b, 0x21, 0x00);               // fonte normal
        const bytes = [];
        for (let i = 0; i < w; i++) {
          const c = l.charCodeAt(i);
          bytes.push(c <= 0xff ? c : 0x3f);
        }
        push(...bytes);
        push(0x0a);
      }
      push(0x1d, 0x56, 0x42);                 // GS V B corte
      return new Uint8Array(out);
    }

    // ---------- Bluetooth (Web Bluetooth — Chrome/Android) ----------
    function btStatus(txt){ const el = document.getElementById('impStatus'); if (el) el.textContent = txt; }
    async function acharCaracteristicaEscrita(device){
      const srv = await device.gatt.connect();
      const services = await srv.getPrimaryServices();
      for (const service of services) {
        try {
          const chars = await service.getCharacteristics();
          for (const ch of chars) {
            if (ch.properties.write || ch.properties.writeWithoutResponse) return ch;
          }
        } catch(e){}
      }
      return null;
    }
    async function conectarImpressora(){
      if (!navigator.bluetooth) { alert('Web Bluetooth não suportado neste navegador. Use o Chrome no Android.'); return; }
      try {
        btStatus('Aguardando seleção da impressora…');
        const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
        const ch = await acharCaracteristicaEscrita(device);
        if (!ch) throw new Error('impressora sem porta de escrita');
        btDevice = device; btChar = ch;
        localStorage.setItem('rpz_bt_device', device.id);
        btStatus('Conectada: ' + (device.name || device.id));
        device.addEventListener('gattserverdisconnected', function(){ btDevice = null; btChar = null; btStatus('Desconectada — toque em Conectar.'); });
      } catch(e){
        btStatus('');
        alert('Não foi possível conectar: ' + e.message);
      }
    }
    async function reconectarImpressora(){
      const saved = localStorage.getItem('rpz_bt_device');
      if (!saved || !navigator.bluetooth || !navigator.bluetooth.getDevices) return;
      try {
        const devices = await navigator.bluetooth.getDevices();
        const dev = devices.find(d => d.id === saved);
        if (!dev) return;
        btDevice = dev;
        const ch = await acharCaracteristicaEscrita(dev);
        if (ch) { btChar = ch; btStatus('Conectada: ' + (dev.name || dev.id)); }
      } catch(e){}
    }
    async function enviarTicketBluetooth(texto){
      if (!btChar) { await reconectarImpressora(); }
      if (!btChar) throw new Error('impressora desconectada');
      const buf = escposBuffer(texto, btPrefs.largura);
      if (btChar.writeValueWithoutResponse) await btChar.writeValueWithoutResponse(buf);
      else await btChar.writeValue(buf);
    }

    // ---------- Preferências ----------
    function aplicarPrefsImp(){
      const modoEl = document.getElementById('impModo');
      const larEl = document.getElementById('impLargura');
      if (modoEl) modoEl.value = btPrefs.modo;
      if (larEl) larEl.value = btPrefs.largura;
      const box = document.getElementById('impBtBox');
      if (box) box.style.display = btPrefs.modo === 'bluetooth' ? 'block' : 'none';
      if (btPrefs.modo === 'bluetooth' && !btChar) reconectarImpressora();
    }
    window.salvarPrefImp = function(){
      const modoEl = document.getElementById('impModo');
      const larEl = document.getElementById('impLargura');
      btPrefs.modo = modoEl ? modoEl.value : 'sistema';
      btPrefs.largura = larEl ? larEl.value : '80';
      localStorage.setItem('rpz_imp_modo', btPrefs.modo);
      localStorage.setItem('rpz_imp_largura', btPrefs.largura);
      const box = document.getElementById('impBtBox');
      if (box) box.style.display = btPrefs.modo === 'bluetooth' ? 'block' : 'none';
      if (btPrefs.modo === 'bluetooth' && !btChar) reconectarImpressora();
    };

    // ---------- Impressão ----------
    function printTicket(html){
      return new Promise(function(resolve){
        const f = document.createElement('iframe');
        f.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:220mm;border:0;visibility:hidden';
        document.body.appendChild(f);
        f.onload = function(){
          try { f.contentWindow.focus(); f.contentWindow.print(); } catch(e){}
          setTimeout(function(){ f.remove(); resolve(); }, 600);
        };
        f.srcdoc = html;
      });
    }
    async function imprimirTicket(t){
      if (btPrefs.modo === 'bluetooth') {
        await enviarTicketBluetooth(t.texto || '');
      } else {
        await printTicket(t.html || '');
      }
    }
    async function checarImpressao(){
      if (imprimindo) return;
      try {
        const r = await fetch(impBase());
        const lista = await r.json();
        for (const t of lista || []) {
          imprimindo = true;
          try {
            await imprimirTicket(t);
            await fetch(impMarcar(), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: t.id }) });
          } catch(e){}
          imprimindo = false;
        }
      } catch(e){}
    }
    setInterval(checarImpressao, 4000);
    checarImpressao();
    aplicarPrefsImp();
    window.conectarImpressora = conectarImpressora;
    window.testarImpressora = async function(){
      try {
        const r = await fetch(impTeste());
        const t = await r.json();
        if (btPrefs.modo === 'bluetooth' && btChar) {
          await enviarTicketBluetooth(t.texto || '');
        } else if (btPrefs.modo === 'bluetooth') {
          await conectarImpressora();
          if (btChar) await enviarTicketBluetooth(t.texto || '');
        } else {
          await printTicket(t.html || '');
        }
      } catch(e){ alert('Erro ao gerar teste de impressão'); }
    };
    window.reimprimirPedido = async function(id){
      try {
        const r = await fetch(impReimprimir(id));
        if (!r.ok) { alert('Pedido não encontrado'); return; }
        const t = await r.json();
        await imprimirTicket(t);
      } catch(e){ alert('Erro ao gerar ticket'); }
    };
  </script>`;

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — RespVZap</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Ctext x='16' y='22' font-size='16' font-family='sans-serif' font-weight='bold' fill='%23fff' text-anchor='middle'%3ERZ%3C/text%3E%3C/svg%3E">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f1f5f9; color: #0f172a; display: flex; min-height: 100vh; }
  aside { width: 230px; background: ${asideBg}; color: #e2e8f0; padding: 22px 14px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 0 10px 18px; border-bottom: 1px solid rgba(148,163,184,.15); margin-bottom: 14px; }
  .brand .logo { width: 38px; height: 38px; border-radius: 10px; background: ${logoGrad}; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #fff; }
  .brand b { font-size: 16px; } .brand span { display: block; font-size: 11px; color: #94a3b8; font-weight: 400; }
  .nav-item { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-radius: 10px; color: #cbd5e1; text-decoration: none; margin-bottom: 3px; font-size: 13.5px; }
  .nav-item:hover { background: rgba(148,163,184,.12); color: #fff; }
  .nav-item.active { background: ${activeBg}; color: #fff; box-shadow: 0 4px 14px ${activeColor}66; }
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
  .bars { display: flex; align-items: flex-end; gap: 6px; min-height: 170px; padding-top: 8px; overflow-x: auto; }
  .bar-col { flex: 1; min-width: 22px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
  .bar { width: 100%; max-width: 34px; background: linear-gradient(180deg,#2563eb,#3b82f6); border-radius: 6px 6px 2px 2px; }
  .bar-col .qtd { font-size: 10px; color: #64748b; font-weight: 700; }
  .bar-col .day { font-size: 10px; color: #94a3b8; white-space: nowrap; }
  .mini-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; }
  .mini-bar { height: 8px; border-radius: 4px; background: linear-gradient(90deg,#2563eb,#38bdf8); }
  .muted { color: #94a3b8; }
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
  function toggleAllCbx(cbx, sel){
    document.querySelectorAll(sel).forEach(c => { c.checked = cbx.checked; });
  }
  function excluirRegistro(actionUrl, id, msg){
    if (!confirm(msg)) return;
    const f = document.createElement('form');
    f.method = 'POST'; f.action = actionUrl;
    const i = document.createElement('input'); i.type='hidden'; i.name='id'; i.value=id;
    f.appendChild(i); document.body.appendChild(f); f.submit();
  }
  function excluirLead(actionUrl, id){
    const senha = prompt('Para excluir este lead (com pedidos e conversas), digite sua senha:');
    if (senha === null) return;
    const f = document.createElement('form');
    f.method = 'POST'; f.action = actionUrl;
    const i = document.createElement('input'); i.type='hidden'; i.name='id'; i.value=id;
    const s = document.createElement('input'); s.type='hidden'; s.name='senha'; s.value=senha;
    f.appendChild(i); f.appendChild(s);
    document.body.appendChild(f); f.submit();
  }
  function excluirSelecionados(actionUrl, sel, label, nameFn){
    const marcados = document.querySelectorAll(sel + ':checked');
    if (!marcados.length) { alert('Selecione pelo menos um ' + label + '.'); return; }
    if (!confirm('Excluir ' + marcados.length + ' ' + label + '(s)?')) return;
    const f = document.createElement('form');
    f.method = 'POST'; f.action = actionUrl;
    marcados.forEach(c => {
      const i = document.createElement('input'); i.type='hidden';
      i.name = nameFn ? nameFn(c) : 'ids[]';
      i.value = c.dataset.val;
      f.appendChild(i);
    });
    document.body.appendChild(f); f.submit();
  }
  function excluirLeadsLote(actionUrl){
    const marcados = document.querySelectorAll('.sel-lote:checked');
    const senhaEl = document.getElementById('senhaLoteLeads');
    const senha = senhaEl ? senhaEl.value : '';
    if (!marcados.length) { alert('Selecione pelo menos um lead.'); return; }
    if (!senha) { alert('Digite sua senha para confirmar.'); return; }
    if (!confirm('Excluir ' + marcados.length + ' lead(s) (com pedidos e conversas)?')) return;
    const f = document.createElement('form');
    f.method = 'POST'; f.action = actionUrl;
    marcados.forEach(c => {
      const i = document.createElement('input'); i.type='hidden'; i.name='ids[]'; i.value = c.dataset.val;
      f.appendChild(i);
    });
    const s = document.createElement('input'); s.type='hidden'; s.name='senha'; s.value = senha;
    f.appendChild(s);
    document.body.appendChild(f); f.submit();
  }
  function limparCampo(id){ document.getElementById(id).value=''; }
</script>
${printScript}
</body></html>`;
}

function pageSub(active) {
  const map = {
    '/admin': 'Visão geral de toda a operação', '/admin/clientes': 'Crie e gerencie os clientes do SaaS',
    '/admin/assinaturas': 'Licenças, renovações e vencimentos', '/admin/segmentos': 'Ramos de negócio e seus templates',     '/painel': 'Visão geral do seu negócio',
    '/painel/relatorios': 'Resultados por período', '/admin/relatorios': 'Resultados do cliente por período',
    '/painel/produtos': 'Seu catálogo', '/painel/listas': 'Textos dos blocos de seleção do bot',
    '/admin/listas': 'Textos dos blocos de seleção de cada cliente',
    '/painel/pedidos': 'Seus pedidos', '/painel/leads': 'Seus clientes',
    '/painel/perguntas': 'Seus questionários', '/painel/mensagens': 'Seus textos do bot', '/painel/botoes': 'Nomes dos botões e fluxo do atendente',
    '/admin/mensagens': 'Textos do bot de cada cliente', '/admin/botoes': 'Botões e atendente de cada cliente',
    '/painel/config': 'Suas configurações', '/painel/senha': 'Altere sua senha de acesso',
  };
  return map[active] || '';
}

// ======================================================
//  LOGIN DO ADMIN
// ======================================================
function loginPage(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — RespVZap</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Ctext x='16' y='22' font-size='16' font-family='sans-serif' font-weight='bold' fill='%23fff' text-anchor='middle'%3ERZ%3C/text%3E%3C/svg%3E"><style>
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
<title>Painel do Cliente — RespVZap</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2316a34a'/%3E%3Ctext x='16' y='22' font-size='16' font-family='sans-serif' font-weight='bold' fill='%23fff' text-anchor='middle'%3ER%3C/text%3E%3C/svg%3E"><style>
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

router.get('/painel/login', async (req, res) => {
  const session = getTenantSession(req);
  if (session) {
    // Se o cliente foi excluído, limpa o cookie (evita loop de redirect)
    const tenant = await repo.getTenant(session.tenantId);
    if (tenant) return res.redirect('/painel');
    res.setHeader('Set-Cookie', 'rpz_tenant_auth=; Path=/; Max-Age=0');
  }
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
//  IMPRESSORA DE PEDIDOS (painel do cliente — ramos de operação)
// ======================================================
function _ehRamoOperacao(tenant) {
  return !!tenant?.segment_name && tenant.segment_name !== 'vendas';
}

/**
 * Fila de impressão: pedidos pagos ainda não impressos (com ticket HTML).
 * O painel consulta a cada 4s e imprime automaticamente.
 */
router.get('/painel/api/impressao', clientPanelAuth, async (req, res) => {
  const tenant = req.tenantSession;
  try {
    const toPrint = await repo.getOrdersToPrint(tenant.id, 5);
    const tickets = [];
    for (const o of toPrint) {
      const t = await ticket.buildTicket(tenant.id, o.id);
      if (t) tickets.push({ id: o.id, external_id: o.external_id, html: t.html, texto: t.texto });
    }
    res.json(tickets);
  } catch (e) {
    console.error('[IMPRESSAO] fila:', e.message);
    res.json([]);
  }
});

router.post('/painel/api/impressao/marcar', clientPanelAuth, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (id) await repo.markOrderPrinted(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[IMPRESSAO] marcar:', e.message);
    res.json({ ok: false });
  }
});

// ======================================================
//  IMPRESSORA NO ADMIN (tenant via query — para gerenciar/testar)
// ======================================================
router.get('/admin/api/impressao', requireAuth, async (req, res) => {
  const tenant = await repo.getTenant(Number(req.query.tenant));
  if (!tenant) return res.json([]);
  try {
    const toPrint = await repo.getOrdersToPrint(tenant.id, 5);
    const tickets = [];
    for (const o of toPrint) {
      const t = await ticket.buildTicket(tenant.id, o.id);
      if (t) tickets.push({ id: o.id, external_id: o.external_id, html: t.html, texto: t.texto });
    }
    res.json(tickets);
  } catch (e) {
    console.error('[IMPRESSAO-admin] fila:', e.message);
    res.json([]);
  }
});

router.post('/admin/api/impressao/marcar', requireAuth, async (req, res) => {
  try {
    const id = Number(req.body?.id);
    if (id) await repo.markOrderPrinted(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[IMPRESSAO-admin] marcar:', e.message);
    res.json({ ok: false });
  }
});

router.get('/admin/api/impressao/reimprimir', requireAuth, async (req, res) => {
  const tenant = await repo.getTenant(Number(req.query.tenant));
  const orderId = Number(req.query.id);
  if (!tenant || !orderId) return res.status(400).send('parâmetros inválidos');
  try {
    const t = await ticket.buildTicket(tenant.id, orderId);
    if (!t) return res.status(404).send('pedido não encontrado');
    res.json({ html: t.html, texto: t.texto });
  } catch (e) {
    console.error('[IMPRESSAO-admin] reimprimir:', e.message);
    res.status(500).send('erro ao gerar ticket');
  }
});

router.get('/admin/api/impressao/teste', requireAuth, async (req, res) => {
  const tenant = await repo.getTenant(Number(req.query.tenant));
  if (!tenant) return res.status(400).send('tenant inválido');
  const html = ticketTesteHtml(tenant.name);
  res.json({ html, texto: ticketTesteTexto(tenant.name) });
});

/**
 * Reimprimir um pedido específico (HTML + texto do ticket).
 */
router.get('/painel/api/impressao/reimprimir', clientPanelAuth, async (req, res) => {
  const tenant = req.tenantSession;
  const orderId = Number(req.query.id);
  if (!orderId) return res.status(400).send('id inválido');
  try {
    const t = await ticket.buildTicket(tenant.id, orderId);
    if (!t) return res.status(404).send('pedido não encontrado');
    res.json({ html: t.html, texto: t.texto });
  } catch (e) {
    console.error('[IMPRESSAO] reimprimir:', e.message);
    res.status(500).send('erro ao gerar ticket');
  }
});

/**
 * Ticket de teste para calibrar a impressora (HTML + texto).
 */
function ticketTesteHtml(nomeEmpresa) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Teste de impressão</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', monospace; width: 80mm; font-size: 12px; color: #000; padding: 4mm; }
  .center { text-align: center; }
  .empresa { font-size: 16px; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; }
  .div { border-top: 1px dashed #000; margin: 6px 0; }
  .pedido-num { font-size: 30px; font-weight: bold; text-align: center; margin: 6px 0; }
  .item { margin: 5px 0; }
  .nome { font-weight: bold; }
  .linha { display: flex; justify-content: space-between; font-size: 12px; }
  .total { font-size: 18px; font-weight: bold; text-align: center; margin: 6px 0; }
  .pago { text-align: center; font-weight: bold; font-size: 13px; margin: 4px 0; }
  .rodape { text-align: center; margin-top: 8px; font-size: 11px; }
</style></head><body>
  <div class="center"><div class="empresa">${ticket.esc(nomeEmpresa)}</div></div>
  <div class="div"></div>
  <div class="pedido-num">TESTE</div>
  <div class="center">Impressão de teste — ${new Date().toLocaleString('pt-BR')}</div>
  <div class="div"></div>
  <div class="item"><div class="nome">Produto de exemplo <small>(Bacon, Cheddar)</small></div><div class="linha"><span>1x</span><span>R$ 24,50</span></div></div>
  <div class="item"><div class="nome">Refrigerante</div><div class="linha"><span>2x</span><span>R$ 12,00</span></div></div>
  <div class="div"></div>
  <div class="linha"><span>Subtotal</span><span>R$ 36,50</span></div>
  <div class="linha"><span>Entrega</span><span>R$ 7,00</span></div>
  <div class="total">TOTAL R$ 43,50</div>
  <div class="pago">✅ PIX — PAGO</div>
  <div class="div"></div>
  <div class="rodape">Se esta impressão saiu com as bordas cortadas, ajuste as margens da impressora (nenhuma) e o papel 80mm.</div>
</body></html>`;
}

function ticketTesteTexto(nomeEmpresa) {
  return [
    '   ' + ticket.ascii((nomeEmpresa || '').toUpperCase()).slice(0, 42),
    '-'.repeat(42),
    '                TESTE',
    '   Impressao de teste ' + new Date().toLocaleString('pt-BR'),
    '-'.repeat(42),
    'Produto de exemplo (Bacon, Cheddar)',
    '1x' + ' '.repeat(30) + 'R$ 24,50',
    'Refrigerante',
    '2x' + ' '.repeat(31) + 'R$ 12,00',
    '-'.repeat(42),
    'Subtotal' + ' '.repeat(23) + 'R$ 36,50',
    'Entrega' + ' '.repeat(24) + 'R$ 7,00',
    '          TOTAL R$ 43,50',
    '      * PIX - PAGO *',
    '-'.repeat(42),
    'Se esta impressao saiu com as bordas',
    'cortadas, verifique o papel 80mm e',
    'as margens da impressora.',
  ].join('\n');
}

router.get('/painel/api/impressao/teste', clientPanelAuth, async (req, res) => {
  const tenant = req.tenantSession;
  res.json({ html: ticketTesteHtml(tenant.name), texto: ticketTesteTexto(tenant.name) });
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

  // ---- Dashboard por ramo ----
  const isOperation = clientMode && tenant.segment_name && tenant.segment_name !== 'vendas';
  let ramoCards = '', ramoBlock = '';
  if (clientMode) {
    const [statsToday, stats30, top30] = await Promise.all([
      reports.orderStats(tenant.id, 0),
      reports.orderStats(tenant.id, 30),
      reports.topProducts(tenant.id, 30, 6),
    ]);
    if (isOperation) {
      ramoCards = `<div class="cards">
        <div class="card"><div class="ico blue">${esc(tenant.segment_emoji || '🏷️')}</div><div class="num blue" style="font-size:19px">${esc(tenant.segment_name || 'Operação')}</div><div class="label">Ramo do negócio</div></div>
        <div class="card"><div class="ico green">💰</div><div class="num green">${money(statsToday.receita)}</div><div class="label">Faturamento hoje</div></div>
        <div class="card"><div class="ico cyan" style="background:#cffafe">🧾</div><div class="num" style="color:#0e7490">${statsToday.pedidos}</div><div class="label">Pedidos hoje</div></div>
        <div class="card"><div class="ico violet">🎯</div><div class="num violet">${money(stats30.ticket_medio)}</div><div class="label">Ticket médio (30d)</div></div>
        <div class="card"><div class="ico amber">📈</div><div class="num amber">${stats30.por_metodo.reduce((s, m) => s + m.qtd, 0)}</div><div class="label">Vendas pagas (30d)</div></div>
      </div>`;
      const max30 = Math.max(1, ...top30.map(t => t.receita));
      ramoBlock = `<div class="panel"><h2>🔥 Mais vendidos (30 dias) <a class="right btn small gray" href="${clientMode ? '/painel' : '/admin'}/relatorios">Ver relatórios completos →</a></h2>
        <table><thead><tr><th>#</th><th>Item</th><th>Qtd</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
        ${top30.map((t, i) => `<tr><td>${i + 1}º</td><td>${esc(t.nome)}</td><td>${t.qtd}x</td><td>${money(t.receita)}</td>
          <td style="min-width:140px"><div class="mini-row"><div class="mini-bar" style="width:${Math.round((t.receita / max30) * 100)}%"></div></div></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">Sem vendas pagas ainda. Divulgue seu bot! 🚀</div></td></tr>'}
        </tbody></table></div>`;
    } else {
      const max30 = Math.max(1, ...top30.map(t => t.receita));
      ramoBlock = `<div class="panel"><h2>🔥 Mais vendidos (30 dias) <a class="right btn small gray" href="/painel/relatorios">Ver relatórios completos →</a></h2>
        <table><thead><tr><th>#</th><th>Produto / Plano</th><th>Qtd</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
        ${top30.map((t, i) => `<tr><td>${i + 1}º</td><td>${esc(t.nome)}</td><td>${t.qtd}x</td><td>${money(t.receita)}</td>
          <td style="min-width:140px"><div class="mini-row"><div class="mini-bar" style="width:${Math.round((t.receita / max30) * 100)}%"></div></div></td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">Sem vendas pagas ainda. Divulgue seu bot! 🚀</div></td></tr>'}
        </tbody></table></div>`;
    }
  }

  const cards = clientMode
    ? (ramoCards || `<div class="cards">
        <div class="card"><div class="ico blue">${esc(tenant.segment_emoji || '🏷️')}</div><div class="num blue" style="font-size:19px">${esc(tenant.segment_name || '—')}</div><div class="label">Ramo do negócio</div></div>
        <div class="card"><div class="ico cyan" style="background:#cffafe">👥</div><div class="num" style="color:#0e7490">${leads.length}</div><div class="label">Leads</div></div>
        <div class="card"><div class="ico green">🧾</div><div class="num green">${orders.length}</div><div class="label">Pedidos</div></div>
        <div class="card"><div class="ico violet">💰</div><div class="num violet">${money(revenue)}</div><div class="label">Faturamento</div></div>
      </div>`)
    : `<div class="cards">
        <div class="card"><div class="ico blue">👥</div><div class="num blue">${tenants.length}</div><div class="label">Clientes (tenants)</div></div>
        <div class="card"><div class="ico green">✅</div><div class="num green">${activeSubs.length}</div><div class="label">Licenças ativas</div></div>
        <div class="card"><div class="ico amber">⏳</div><div class="num amber">${expiringSoon.length}</div><div class="label">Vencem em 7 dias</div></div>
        <div class="card"><div class="ico rose">❌</div><div class="num rose">${expired.length}</div><div class="label">Licenças vencidas</div></div>
        <div class="card"><div class="ico violet">💰</div><div class="num violet">${money(revenue)}</div><div class="label">Faturamento (${esc(tenant?.name || '—')})</div></div>
        <div class="card"><div class="ico cyan" style="background:#cffafe">🧾</div><div class="num" style="color:#0e7490">${orders.length}</div><div class="label">Pedidos (${esc(tenant?.name || '—')})</div></div>
      </div>`;

  // Admin: receita por segmento
  let segmentBlock = '';
  if (!clientMode) {
    const segData = await reports.revenueBySegment(30);
    const maxSeg = Math.max(1, ...segData.map(s => s.receita));
    segmentBlock = `<div class="panel"><h2>🧭 Receita por ramo (30 dias)</h2>
      <table><thead><tr><th>Ramo</th><th>Clientes</th><th>Pedidos</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
      ${segData.map(s => `<tr><td>${esc(s.emoji)} ${esc(s.nome)}</td><td>${s.clientes}</td><td>${s.pedidos}</td><td>${money(s.receita)}</td>
        <td style="min-width:140px"><div class="mini-row"><div class="mini-bar" style="width:${Math.round((s.receita / maxSeg) * 100)}%"></div></div></td></tr>`).join('')}
      </tbody></table></div>`;
  }

  const quickActions = clientMode ? '' : `<div class="panel" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <a class="btn" href="/admin/clientes">👥 Página de clientes</a>
    <a class="btn green" href="/painel/login" target="_blank">🔗 Login do painel do cliente</a>
    <button class="btn amber" onclick="copyText('${config.webhookUrl || 'https://respodzap.vercel.app'}/painel/login', this)">📋 Copiar link do login</button>
  </div>`;

  res.send(layout('Dashboard', clientMode ? '/painel' : '/admin', `
    ${cards}
    ${quickActions}
    ${segmentBlock}
    ${onboarding}
    ${ramoBlock}
    ${clientMode ? `<div class="panel" style="background:#f0fdf4;border-color:#bbf7d0"><h2 style="color:#166534">👋 Olá, ${esc(tenant.name)}!</h2><p style="font-size:13px;color:#166534">Este é o painel do seu negócio. Gerencie seus produtos, veja seus pedidos e clientes.</p></div>` : tenantSelector(tenant.id, tenants, clientMode)}
    <div class="panel"><h2>📅 Pedidos dos últimos 14 dias</h2><div class="bars">${bars || '<div class="empty">Sem pedidos no período.</div>'}</div></div>
    <div class="panel"><h2>🕒 Últimos pedidos</h2><table><thead><tr><th>Pedido</th><th>Cliente</th><th>Total</th><th>Status</th><th>Data</th></tr></thead><tbody>${recentRows.join('') || '<tr><td colspan="5"><div class="empty">Nenhum pedido.</div></td></tr>'}</tbody></table></div>
  `, tenants, tenant, clientMode));
}

router.get('/admin', requireAuth, pageDashboard);
router.get('/painel', clientPanelAuth, pageDashboard);

// ======================================================
//  RELATÓRIOS (client + admin)
// ======================================================
const reports = require('./reports');
const PERIODS = [0, 7, 30, 60, 90];

async function pageRelatorios(req, res) {
  const clientMode = !!req.clientMode;
  const { tenant, tenants } = await resolveTenant(req, res);
  if (!tenant) return res.send(layout('Relatórios', clientMode ? '/painel/relatorios' : '/admin/relatorios', '<div class="empty">Crie um cliente primeiro.</div>', tenants, null, clientMode));
  const period = PERIODS.includes(Number(req.query.period)) ? Number(req.query.period) : 30;

  const [stats, daily, top, leads, topLeadsList] = await Promise.all([
    reports.orderStats(tenant.id, period),
    reports.ordersByDay(tenant.id, period),
    reports.topProducts(tenant.id, period),
    reports.leadStats(tenant.id, period),
    reports.topLeads(tenant.id, period),
  ]);

  const periodLabel = period === 0 ? 'hoje' : `nos últimos ${period} dias`;
  const maxDaily = Math.max(1, ...daily.map(d => d.receita));
  const bars = daily.map(d => {
    const h = Math.max(3, Math.round((d.receita / maxDaily) * 130));
    return `<div class="bar-col" title="${esc(d.dia)} — R$ ${d.receita.toFixed(2)} (${d.qtd} pedido(s))"><div class="qtd">R$${Math.round(d.receita)}</div><div class="bar" style="height:${h}px"></div><div class="day">${esc(d.dia.slice(5))}</div></div>`;
  }).join('');

  const maxTop = Math.max(1, ...top.map(t => t.receita));
  const topRows = top.map((t, i) => `<tr>
    <td>${i + 1}º</td><td>${esc(t.nome)}</td><td>${t.qtd}x</td><td>${money(t.receita)}</td>
    <td style="min-width:140px"><div class="mini-row"><div class="mini-bar" style="width:${Math.round((t.receita / maxTop) * 100)}%"></div></div></td>
  </tr>`).join('');

  const statusMap = {
    pending: ['wait', '⏳ Pendente'], approved: ['ok', '✅ Pago'], shipped: ['info', '🚚 Enviado'],
    delivered: ['done', '📦 Entregue'], cancelled: ['no', '❌ Cancelado'], failed: ['no', '❌ Falhou'],
  };
  const statusChips = (stats.por_status || []).map(s => {
    const [cls, label] = statusMap[s.status] || ['wait', s.status];
    return `<span class="badge ${cls}" style="margin-right:6px">${label}: ${s.qtd}</span>`;
  }).join('') || '<span class="muted">Nenhum pedido no período.</span>';

  const metodoLabel = m => ({ pix: '💠 PIX', credit_card: '💳 Crédito', debit_card: '💳 Débito', 'n/a': '—' }[m] || m);
  const maxMetodo = Math.max(1, ...stats.por_metodo.map(p => p.total));
  const metodoRows = stats.por_metodo.map(p =>
    `<div class="mini-row"><span style="width:130px">${metodoLabel(p.metodo)}</span><div class="mini-bar" style="width:${Math.round((p.total / maxMetodo) * 100)}%"></div><b>${money(p.total)}</b> <span class="muted">(${p.qtd}x)</span></div>`,
  ).join('') || '<div class="muted">Sem pagamentos aprovados no período.</div>';

  const maxLead = Math.max(1, ...topLeadsList.map(l => l.gasto));
  const leadRows = topLeadsList.map(l => `<tr>
    <td>${esc(l.nome)}</td><td>${l.qtd_pedidos}x</td><td>${money(l.gasto)}</td>
    <td style="min-width:140px"><div class="mini-row"><div class="mini-bar" style="width:${Math.round((l.gasto / maxLead) * 100)}%"></div></div></td>
  </tr>`).join('');

  const filter = `<div class="filters"><span style="font-size:12px;color:#64748b">Período:</span>
    ${PERIODS.map(p => `<a class="btn ${p === period ? '' : 'gray'} small" href="?period=${p}">${p === 0 ? 'Hoje' : p + ' dias'}</a>`).join('')}
    <span class="muted" style="font-size:12px">Mostrando ${periodLabel}</span></div>`;

  const cards = `<div class="cards">
    <div class="card"><div class="ico green">💰</div><div class="num green">${money(stats.receita)}</div><div class="label">Receita (pagos)</div></div>
    <div class="card"><div class="ico blue">🧾</div><div class="num blue">${stats.aprovados}</div><div class="label">Pedidos pagos</div></div>
    <div class="card"><div class="ico violet">🎯</div><div class="num violet">${money(stats.ticket_medio)}</div><div class="label">Ticket médio</div></div>
    <div class="card"><div class="ico cyan" style="background:#cffafe">👥</div><div class="num" style="color:#0e7490">${leads.novos}</div><div class="label">Novos leads</div></div>
    <div class="card"><div class="ico amber">📈</div><div class="num amber">${leads.conversao.toFixed(1)}%</div><div class="label">Conversão</div></div>
  </div>`;

  res.send(layout('Relatórios', clientMode ? '/painel/relatorios' : '/admin/relatorios', `
    ${clientMode ? '' : tenantSelector(tenant.id, tenants, clientMode)}
    ${filter}
    ${cards}
    <div class="panel"><h2>💵 Receita diária (pedidos pagos)</h2><div class="bars">${bars || '<div class="empty">Sem pedidos pagos no período.</div>'}</div></div>
    <div class="grid2">
      <div class="panel"><h2>🏆 Top produtos e planos</h2><table><thead><tr><th>#</th><th>Produto</th><th>Qtd</th><th>Receita</th><th>Participação</th></tr></thead><tbody>${topRows || '<tr><td colspan="5"><div class="empty">Sem vendas no período.</div></td></tr>'}</tbody></table></div>
      <div>
        <div class="panel"><h2>💳 Formas de pagamento</h2>${metodoRows}</div>
        <div class="panel"><h2>📦 Pedidos por status</h2>${statusChips}</div>
      </div>
    </div>
    <div class="panel"><h2>⭐ Melhores clientes</h2><table><thead><tr><th>Cliente</th><th>Pedidos</th><th>Gasto</th><th>Participação</th></tr></thead><tbody>${leadRows || '<tr><td colspan="4"><div class="empty">Sem clientes com pedidos pagos.</div></td></tr>'}</tbody></table></div>
  `, tenants, tenant, clientMode));
}

router.get('/painel/relatorios', clientPanelAuth, pageRelatorios);
router.get('/admin/relatorios', requireAuth, pageRelatorios);

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
      <td><input type="checkbox" class="sel-lote" data-val="${t.id}"></td>
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
        <form class="inline-form" method="POST" action="/admin/clientes/excluir" onsubmit="return confirm('Excluir o cliente ${esc(t.name)}? Todos os dados (pedidos, leads, catálogo, licenças) serão apagados permanentemente.');"><input type="hidden" name="id" value="${t.id}"><button class="btn red small" title="Excluir cliente permanentemente">🗑 Excluir</button></form>
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
    <div class="panel"><h2>Clientes <span class="right"><button class="btn red small" onclick="excluirSelecionados('/admin/clientes/excluir-lote', '.sel-lote', 'cliente')">🗑 Excluir selecionados</button></span></h2>
      <table>
      <thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.sel-lote')" title="Selecionar todos"></th><th>Cliente</th><th>Contato</th><th>Ramo</th><th>Phone Number ID</th><th>Status</th><th>Painel</th><th>Licença</th><th>Ações</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="9"><div class="empty">Nenhum cliente ainda.</div></td></tr>'}</tbody>
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
      <td><input type="checkbox" class="sel-lote" data-val="${sg.id}"></td>
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
        <thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.sel-lote')" title="Selecionar todos"></th><th>Emoji</th><th>Nome</th><th>Uso</th><th>Ações</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5"><div class="empty">Nenhum segmento ainda.</div></td></tr>'}</tbody>
      </table>
      <div style="margin-top:10px"><button class="btn red small" onclick="excluirSelecionados('/admin/segmentos/excluir-lote', '.sel-lote', 'segmento')">🗑 Excluir selecionados</button> <span class="muted" style="font-size:12px">(segmentos em uso são mantidos)</span></div>
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
    const limite = s.product_limit ?? 30;
    const tipo = limite >= 30 ? 'Pro' : 'Starter';
    return `<tr>
      <td><input type="checkbox" class="sel-lote" data-val="${s.id}"></td>
      <td><b>${esc(s.tenant_name)}</b></td>
      <td>${esc(s.plan_name || '—')} ${custom ? '<span class="badge wait">personalizado</span>' : ''}<br><span class="badge ${tipo === 'Pro' ? 'info' : 'wait'}">${tipo} — ${limite} produtos</span></td>
      <td>${money(s.price)}<br><small style="color:#94a3b8">${days} dias</small></td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.expires_at ? esc(String(s.expires_at).slice(0, 10)) : '—'}</td>
      <td style="white-space:nowrap">
        <form class="inline-form" method="POST" action="/admin/assinaturas/tipo"><input type="hidden" name="id" value="${s.id}"><select name="tipo" onchange="this.form.submit()" title="Trocar tipo da licença (limite de produtos)">
          <option value="starter" ${tipo === 'Starter' ? 'selected' : ''}>Starter (20)</option>
          <option value="pro" ${tipo === 'Pro' ? 'selected' : ''}>Pro (30)</option>
        </select></form>
        <form class="inline-form" method="POST" action="/admin/assinaturas/renovar"><input type="hidden" name="id" value="${s.id}"><input type="hidden" name="days" value="${days}"><button class="btn green small">Renovar</button></form>
        <form class="inline-form" method="POST" action="/admin/assinaturas/pix"><input type="hidden" name="id" value="${s.id}"><button class="btn amber small">Gerar PIX</button></form>
        ${s.status === 'ativa' ? `<form class="inline-form" method="POST" action="/admin/assinaturas/cancelar"><input type="hidden" name="id" value="${s.id}"><button class="btn red small">Cancelar</button></form>` : ''}
        <form class="inline-form" method="POST" action="/admin/assinaturas/excluir" onsubmit="return confirm('Excluir a licença de ${esc(s.tenant_name)}? Essa ação não pode ser desfeita.');"><input type="hidden" name="id" value="${s.id}"><button class="btn red small" title="Excluir licença permanentemente">🗑 Excluir</button></form>
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
        <div style="min-width:150px"><label>TIPO DE PLANO (limite de produtos)</label><select name="tipo" required>
          <option value="starter">Starter — até 20 produtos</option>
          <option value="pro" selected>Pro — até 30 produtos</option>
        </select></div>
        <div style="min-width:130px"><label>PREÇO (R$) — vazio = do plano</label><input type="text" name="preco_custom" placeholder="Ex: 250,00"></div>
        <div style="min-width:120px"><label>PERÍODO (dias) — vazio = do plano</label><input type="number" name="dias_custom" placeholder="Ex: 45"></div>
        <button class="btn green" type="submit">+ Criar licença</button>
      </form>
      <p style="font-size:12px;color:#64748b;margin-top:8px">O tipo de plano define quantos produtos o cliente pode cadastrar no painel (Starter: 20 · Pro: 30). Preço e período podem ser personalizados. O bot envia o PIX de renovação automaticamente 3 dias antes do vencimento.</p>
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
    <div class="panel"><h2>📋 Licenças ativas <span class="right"><button class="btn red small" onclick="excluirSelecionados('/admin/assinaturas/excluir-lote', '.sel-lote', 'licença')">🗑 Excluir selecionadas</button></span></h2><table>
      <thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.sel-lote')" title="Selecionar todos"></th><th>Cliente</th><th>Plano</th><th>Valor</th><th>Status</th><th>Vencimento</th><th>Ações</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7"><div class="empty">Nenhuma assinatura ainda.</div></td></tr>'}</tbody>
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
  const limite = b.tipo === 'starter' ? 20 : 30;

  await repo.createSubscription(Number(b.tenant_id), plan.id, price, days, limite);
  const tipoNome = limite >= 30 ? 'Pro' : 'Starter';
  const nota = (precoCustom !== '' || diasCustom !== '') ? ` (personalizado: R$ ${price} / ${days} dias)` : '';
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Licença criada: ${plan.name} (${tipoNome} — ${limite} produtos) — vence em ${days} dias.${nota}`));
});

router.post('/admin/assinaturas/tipo', requireAuth, async (req, res) => {
  const limite = req.body.tipo === 'starter' ? 20 : 30;
  await repo.updateSubscriptionLimit(Number(req.body.id), limite);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`Tipo da licença alterado para ${limite >= 30 ? 'Pro' : 'Starter'} (${limite} produtos).`));
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

router.post('/admin/assinaturas/excluir', requireAuth, async (req, res) => {
  await repo.deleteSubscription(Number(req.body.id));
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent('Licença excluída.'));
});

// ======================================================
//  CONTEÚDO DO TENANT (telas compartilhadas admin/cliente)
// ======================================================
function productImgSrc(image) {
  if (/^https?:\/\//.test(image)) return image;
  return `/images/${image}`;
}

/**
 * Renderiza uma área de entrega como editor visual (caixa bairro + valor).
 */
function areasEditorHtml(areas) {
  const lista = Array.isArray(areas) ? areas : [];
  if (!lista.length) return '<div class="muted" style="font-size:12px;margin:4px 0">Nenhum bairro cadastrado. Clique em "+ Adicionar bairro" para cadastrar o bairro e a taxa de entrega.</div>';
  return lista.map((a, i) => `
    <div class="area-linha" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      <input type="text" name="store[delivery_areas][${i}][bairro]" value="${esc(a.bairro || '')}" placeholder="Bairro (ex: Centro)" style="flex:1">
      <div style="display:flex;align-items:center;gap:4px;width:130px;flex-shrink:0"><span style="font-size:12px;color:#64748b">R$</span><input type="text" name="store[delivery_areas][${i}][taxa]" value="${esc(a.taxa ?? '')}" placeholder="0,00"></div>
      <button type="button" class="btn red small" onclick="removeArea(this)">✕</button>
    </div>`).join('');
}

/**
 * Renderiza um grupo de adicionais como editor visual (caixas nome + valor).
 */
function addonsGrupoHtml(gi, g) {
  const opcoes = (g.opcoes || []).map((o, oi) => `
    <div class="addons-opcao" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
      <input type="text" name="adicionais[${gi}][opcoes][${oi}][nome]" value="${esc(o.nome || '')}" placeholder="Nome (ex: Bacon)" style="flex:1">
      <div style="display:flex;align-items:center;gap:4px;width:130px;flex-shrink:0"><span style="font-size:12px;color:#64748b">R$</span><input type="text" name="adicionais[${gi}][opcoes][${oi}][preco]" value="${esc(o.preco ?? '')}" placeholder="0,00"></div>
      <button type="button" class="btn red small" onclick="removeAddonsOpcao(this)">✕</button>
    </div>`).join('');
  return `
    <div class="addons-grupo" style="border:1px dashed #cbd5e1;border-radius:10px;padding:12px;margin-bottom:10px;background:#f8fafc">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" name="adicionais[${gi}][grupo]" value="${esc(g.grupo || '')}" placeholder="Nome do grupo (ex: Extras)" style="min-width:170px">
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#475569;white-space:nowrap"><input type="checkbox" name="adicionais[${gi}][unico]" value="on" ${g.unico ? 'checked' : ''} style="width:auto"> Só 1 opção</label>
        <div style="display:flex;align-items:center;gap:4px"><span style="font-size:12px;color:#64748b">Máx.</span><input type="number" name="adicionais[${gi}][max]" value="${esc(g.max ?? '')}" placeholder="—" style="width:64px" title="Limite de opções (vazio = escolhe à vontade)"></div>
        <button type="button" class="btn red small" onclick="removeAddonsGrupo(this)">🗑 Grupo</button>
      </div>
      <div class="addons-opcoes" style="margin-top:8px">${opcoes}</div>
      <button type="button" class="btn gray small" onclick="addAddonsOpcao(this)">+ Opção</button>
    </div>`;
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
  const showAddonsEditor = !!tenant.segment_name && tenant.segment_name !== 'vendas';

  // Limite de produtos do plano (Starter 20 / Pro 30) — painel do cliente
  let limiteHtml = '';
  let limiteAtingido = false;
  let productLimit = null;
  if (clientMode) {
    const sub = await repo.getActiveSubscription(tenant.id);
    productLimit = sub?.product_limit ?? null;
    const totalProducts = (data.categories || []).reduce((s, c) => s + (c.products || []).length, 0);
    limiteAtingido = !!productLimit && totalProducts >= productLimit;
    if (productLimit) {
      const pct = Math.min(100, Math.round((totalProducts / productLimit) * 100));
      const cor = limiteAtingido ? '#dc2626' : pct >= 80 ? '#d97706' : '#16a34a';
      const planoNome = productLimit >= 30 ? 'Pro' : 'Starter';
      limiteHtml = `<div class="panel" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:#f8fafc">
        <div style="font-size:13px;white-space:nowrap"><b>🛍 ${totalProducts}/${productLimit} produtos</b> <span class="badge ${planoNome === 'Pro' ? 'info' : 'wait'}">${planoNome}</span>
        ${limiteAtingido ? '<span class="badge no">limite atingido</span>' : `<span class="badge ${pct >= 80 ? 'wait' : 'ok'}">${productLimit - totalProducts} restante(s)</span>`}</div>
        <div style="flex:1;min-width:200px;height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${cor};border-radius:6px"></div></div>
        ${limiteAtingido ? `<a class="btn small" href="/painel/botoes" style="white-space:nowrap">Preciso de mais — falar com suporte</a>` : ''}
      </div>`;
    }
  }

  const catsHtml = data.categories.map((cat, ci) => {
    const prods = cat.products.map((p, pi) => {
      const base = clientMode ? '/painel' : '/admin';
      const plans = (p.plans || []).map((pl, k) => `
      <tr>
        <td><input type="hidden" name="plans[${k}][id]" value="${esc(pl.id || '')}"><input type="text" name="plans[${k}][name]" value="${esc(pl.name || '')}" placeholder="Ex: Mensal"></td>
        <td><input type="text" name="plans[${k}][price]" value="${pl.price ?? ''}" placeholder="Ex: 299,00"></td>
        <td><input type="text" name="plans[${k}][period]" value="${esc(pl.period || '')}" placeholder="mês / ano"></td>
        <td style="text-align:center"><input type="checkbox" name="plans[${k}][popular]" ${pl.popular ? 'checked' : ''}></td>
        <td><input type="text" name="plans[${k}][payment_link]" value="${esc(pl.payment_link || '')}" placeholder="https://mpago.li/..." style="min-width:130px"></td>
        <td><input type="text" name="plans[${k}][redirect_link]" value="${esc(pl.redirect_link || '')}" placeholder="https://wa.me/55..." style="min-width:130px"></td>
        <td><textarea name="plans[${k}][features]" rows="3">${esc(pl.features || '')}</textarea></td>
        <td style="text-align:center"><button class="btn red small" type="button" onclick="enviarFormAcao(this.form, '${base}/produtos/excluir-plano?ci=${ci}&pi=${pi}&plan_i=${k}')">🗑</button></td>
      </tr>`).join('') || '<tr><td colspan="8" style="color:#94a3b8;font-size:12px">Sem planos — adicione abaixo.</td></tr>';

      return `
      <div class="panel" style="margin-bottom:14px"><h2>✏️ ${esc(p.name)} ${p.plans?.length ? `<span class="badge info">${p.plans.length} plano(s)</span>` : ''} ${statusBadge(p.available ? 'ok' : 'no')}
        <label style="margin-left:10px;font-weight:400;font-size:12px;color:#64748b"><input type="checkbox" class="del-prod" data-ci="${ci}" data-val="${pi}"> excluir</label></h2>
      <form method="POST" action="${base}/produtos/salvar" class="grid2" onsubmit="reindexAddons()">
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
        ${showAddonsEditor ? `<div style="grid-column:1/-1">
          <h3 style="font-size:13px;margin:4px 0 8px">🧀 ADICIONAIS <small style="font-weight:400;color:#94a3b8">— o bot pergunta antes de adicionar ao pedido, e o valor é somado ao item</small></h3>
          <div id="addonsList-${ci}-${pi}">
            ${(p.adicionais || []).map((g, gi) => addonsGrupoHtml(gi, g)).join('') || '<div class="muted" style="font-size:12px;margin:4px 0">Nenhum grupo ainda. Clique em "+ Adicionar grupo" para criar (ex: Extras, Tamanho, Ponto da carne).</div>'}
          </div>
          <button type="button" class="btn gray small" style="margin-top:6px" onclick="addAddonsGrupo(${ci}, ${pi})">+ Adicionar grupo</button>
          <p style="font-size:12px;color:#64748b;margin-top:6px"><b>Só 1 opção</b> = cliente escolhe apenas uma · <b>Máx.</b> = limite de opções por grupo (vazio = à vontade) · o valor digitado em cada opção é somado ao preço do item (0 = sem custo)</p>
        </div>` : ''}
        <div style="grid-column:1/-1">
          <h3 style="font-size:13px;margin:4px 0 8px">📋 PLANOS DE ASSINATURA <small style="font-weight:400;color:#94a3b8">(opcional)</small></h3>
          <table><thead><tr><th>Nome</th><th>Preço</th><th>Período</th><th>★</th><th>Link pagamento</th><th>Link redirecionamento</th><th>Recursos</th><th></th></tr></thead>
          <tbody>${plans}</tbody></table>
          <button class="btn gray small" type="button" onclick="enviarFormAcao(this.form, '${base}/produtos/novo-plano?ci=${ci}&pi=${pi}')" style="margin-top:8px">+ Adicionar plano</button>
        </div>
        <div style="grid-column:1/-1;display:flex;gap:8px;margin-top:6px">
          <button class="btn red" type="button" onclick="enviarFormAcao(this.form, '${base}/produtos/excluir')">🗑 Excluir produto</button>
        </div>
      </form></div>`;
    });
    return `<div class="panel"><h2>${esc(cat.emoji || '')} ${esc(cat.name)} <span class="right badge info">${cat.products.length} produto(s)</span></h2>
      ${prods.join('')}
      ${limiteAtingido
        ? `<p style="font-size:12px;color:#b91c1c;margin-top:8px">🚫 Limite de ${productLimit} produtos do plano ${productLimit >= 30 ? 'Pro' : 'Starter'} atingido. Fale com o suporte para aumentar o limite.</p>`
        : `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:#2563eb;font-weight:600">+ Adicionar novo produto</summary>
      <form method="POST" action="${clientMode ? '/painel' : '/admin'}/produtos/novo" class="grid2" style="margin-top:12px">
        <input type="hidden" name="tenant" value="${tenant.id}">
        <input type="hidden" name="ci" value="${ci}">
        <div><label>ID ÚNICO</label><input type="text" name="id" required><label>NOME</label><input type="text" name="name" required><label>PREÇO (R$)</label><input type="text" name="price" required>
          <label><input type="checkbox" name="digital" style="width:auto"> Produto digital</label></div>
        <div><label>RESUMO</label><input type="text" name="short_description"><label>DESCRIÇÃO</label><textarea name="long_description"></textarea></div>
        <div style="grid-column:1/-1"><button class="btn green" type="submit">+ Criar produto</button></div>
      </form></details>`}</div>`;
  }).join('');

  res.send(layout('Produtos', clientMode ? '/painel/produtos' : '/admin/produtos', `${tenantSelector(tenant.id, tenants, clientMode)}${flash}
    ${limiteHtml}
    <div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn green" onclick="salvarTudo()">💾 Salvar tudo</button>
      <button class="btn red" onclick="excluirSelecionados('${base}/produtos/excluir-lote', '.del-prod', 'produto', function(c){ return 'del[' + c.dataset.ci + '][]'; })">🗑 Excluir selecionados</button>
      <span class="muted" style="font-size:13px">Altere quantos produtos quiser e salve tudo de uma vez (as ações por produto continuam funcionando).</span>
    </div>
    <div class="panel"><h2>📤 Enviar foto de produto <span class="right"><button class="btn small" onclick="document.getElementById('fileInput').click()">Escolher arquivo</button></span></h2>
      <form method="POST" action="${base}/upload" enctype="multipart/form-data">
        <input type="hidden" name="tenant" value="${tenant.id}">
        <input type="file" id="fileInput" name="foto" accept="image/*" required style="display:none" onchange="this.form.submit()">
      </form>
      <p style="font-size:12px;color:#64748b">Depois de enviar, a foto aparece na galeria abaixo — <b>clique nela</b> (nos produtos) para usar, ou copie a URL.</p>
    </div>
    ${gallery}
    ${catsHtml}
    <div class="panel" style="display:flex;gap:10px;align-items:center">
      <button class="btn green" onclick="salvarTudo()">💾 Salvar tudo</button>
      <span class="muted" style="font-size:13px">Salva todos os produtos desta página.</span>
    </div>
    <script>
      function enviarFormAcao(form, url){
        form.action = url;
        form.submit();
      }
      async function salvarTudo(){
        reindexAddons();
        const forms = Array.from(document.querySelectorAll('form[action*="/produtos/salvar"]'));
        if (!forms.length) { alert('Nenhum produto para salvar.'); return; }
        for (const f of forms) {
          const body = new URLSearchParams(new FormData(f)).toString();
          const r = await fetch(f.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
          if (!r.ok) { alert('Erro ao salvar — recarregue e tente novamente.'); return; }
        }
        location.href = location.pathname + '?msg=' + encodeURIComponent('Todos os produtos foram salvos!');
      }
      function addonsOpcaoHtml(){
        return '<div class="addons-opcao" style="display:flex;gap:8px;margin-bottom:6px;align-items:center"><input type="text" name="adicionais[0][opcoes][0][nome]" placeholder="Nome (ex: Bacon)" style="flex:1"><div style="display:flex;align-items:center;gap:4px;width:130px;flex-shrink:0"><span style="font-size:12px;color:#64748b">R$</span><input type="text" name="adicionais[0][opcoes][0][preco]" placeholder="0,00"></div><button type="button" class="btn red small" onclick="removeAddonsOpcao(this)">✕</button></div>';
      }
      function addAddonsOpcao(btn){ btn.closest('.addons-grupo').querySelector('.addons-opcoes').insertAdjacentHTML('beforeend', addonsOpcaoHtml()); }
      function removeAddonsOpcao(btn){ btn.closest('.addons-opcao').remove(); }
      function removeAddonsGrupo(btn){ btn.closest('.addons-grupo').remove(); }
      function addAddonsGrupo(ci, pi){
        const el = document.getElementById('addonsList-' + ci + '-' + pi);
        if (!el) return;
        el.insertAdjacentHTML('beforeend',
          '<div class="addons-grupo" style="border:1px dashed #cbd5e1;border-radius:10px;padding:12px;margin-bottom:10px;background:#f8fafc">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          '<input type="text" name="adicionais[0][grupo]" placeholder="Nome do grupo (ex: Extras)" style="min-width:170px">' +
          '<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#475569;white-space:nowrap"><input type="checkbox" name="adicionais[0][unico]" value="on" style="width:auto"> Só 1 opção</label>' +
          '<div style="display:flex;align-items:center;gap:4px"><span style="font-size:12px;color:#64748b">Máx.</span><input type="number" name="adicionais[0][max]" placeholder="—" style="width:64px"></div>' +
          '<button type="button" class="btn red small" onclick="removeAddonsGrupo(this)">🗑 Grupo</button>' +
          '</div><div class="addons-opcoes" style="margin-top:8px"></div>' +
          '<button type="button" class="btn gray small" onclick="addAddonsOpcao(this)">+ Opção</button></div>');
      }
      function reindexAddons(){
        document.querySelectorAll('.addons-grupo').forEach(function(g, gi){
          g.querySelectorAll('input[name^="adicionais["]').forEach(function(el){
            el.name = el.name.replace(/^adicionais\\[\\d+\\]/, 'adicionais[' + gi + ']');
          });
          g.querySelectorAll('.addons-opcao').forEach(function(o, oi){
            o.querySelectorAll('input[name^="adicionais["]').forEach(function(el){
              el.name = el.name.replace(/adicionais\\[\\d+\\]\\[opcoes\\]\\[\\d+\\]/, 'adicionais[' + gi + '][opcoes][' + oi + ']');
            });
          });
        });
      }
    </script>`, tenants, tenant, clientMode));
}

router.get('/admin/produtos', requireAuth, pageProdutos);
router.get('/painel/produtos', clientPanelAuth, pageProdutos);

async function postProdutosNovo(req, res) {
  const b = req.body;
  const tenantId = tenantIdFromReq(req, b.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);

  // Limite de produtos do plano (Starter 20 / Pro 30) — só no painel do cliente
  if (req.clientMode) {
    const sub = await repo.getActiveSubscription(tenantId);
    const limite = sub?.product_limit ?? null;
    if (limite) {
      const total = (data.categories || []).reduce((s, c) => s + (c.products || []).length, 0);
      if (total >= limite) {
        return res.redirect(`${base}/produtos?msg=` + encodeURIComponent(`Limite de ${limite} produtos do plano ${limite >= 30 ? 'Pro' : 'Starter'} atingido — fale com o suporte para aumentar.`) + '&type=err');
      }
    }
  }

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
  const tenant = await repo.getTenant(tenantId);
  const showAddonsEditor = !!tenant?.segment_name && tenant.segment_name !== 'vendas';
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

  // Adicionais (editor visual — arrays do form); só processa se o form enviou o campo
  if (showAddonsEditor && b.adicionais !== undefined) {
    const addons = [];
    const grupos = Array.isArray(b.adicionais) ? b.adicionais : [b.adicionais];
    for (const g of grupos) {
      const nomeGrupo = String(g.grupo || '').trim();
      if (!nomeGrupo) continue;
      const opcoesRaw = Array.isArray(g.opcoes) ? g.opcoes : (g.opcoes ? [g.opcoes] : []);
      const opcoes = opcoesRaw
        .map(o => ({ nome: String(o.nome || '').trim(), preco: parseFloat(String(o.preco || '0').replace(',', '.')) || 0 }))
        .filter(o => o.nome);
      if (!opcoes.length) continue;
      addons.push({
        grupo: nomeGrupo,
        unico: (Array.isArray(g.unico) ? g.unico[g.unico.length - 1] : g.unico) === 'on',
        max: g.max !== '' && g.max !== undefined && g.max !== null ? Number(g.max) : undefined,
        opcoes,
      });
    }
    p.adicionais = addons.length ? addons : undefined;
  }

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
            <textarea id="pld-${ci}-${pi}-${ki}" name="pld[${ci}][${pi}][${ki}]" placeholder="Vazio = ${esc(previewPlano(pl))}">${esc(pl.list_description || '')}</textarea>
            <div style="font-size:11.5px;color:#64748b;margin-top:4px">Fallback: ${esc(previewPlano(pl))} <button class="btn red small" onclick="limparCampo('pld-${ci}-${pi}-${ki}')" title="Limpar (volta ao padrão)" style="margin-left:8px">🗑</button></div>
          </div>`).join('');
        return `
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:12px">
          <h3 style="font-size:14px;margin-bottom:8px">${pi + 1}. ${esc(p.name)} <button class="btn red small" onclick="limparCampo('ld-${ci}-${pi}')" title="Limpar (volta ao padrão)">🗑</button></h3>
          <label>DESCRIÇÃO DA LISTA (bloco de seleção no WhatsApp)</label>
          <textarea id="ld-${ci}-${pi}" name="ld[${ci}][${pi}]" placeholder="Vazio = ${esc(previewProduto(p))}">${esc(p.list_description || '')}</textarea>
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
    const items = (await repo.getOrderItems(o.id)).map(it => {
      const extra = repo.formatAddons(it.addons);
      return `${it.quantity}x ${esc(it.product_name)}${extra ? ` <small style="color:#64748b">(${esc(extra)})</small>` : ''}`;
    }).join('<br>');
    const pay = await repo.getPaymentByOrderId(o.id);
    const lead = await repo.getLead(o.lead_id);
    return `<tr>
      <td><input type="checkbox" class="sel-lote" data-val="${o.id}"></td>
      <td><b>#${esc(o.external_id)}</b><br><small style="color:#94a3b8">${esc(String(o.created_at).slice(0, 16))}</small></td>
      <td>${esc(lead?.full_name || '—')}<br><small style="color:#94a3b8">${esc(lead?.phone || '')}</small></td>
      <td>${items}${o.observations ? `<br><small style="color:#b45309">📝 ${esc(o.observations)}</small>` : ''}</td><td>${money(o.total)}</td><td>${statusBadge(o.status)}</td>
      <td>${methodLabel(pay?.payment_method)}<br><small style="color:#94a3b8">${esc(pay?.mp_payment_id || '')}</small></td>
      <td style="white-space:nowrap">${o.status === 'pending' ? `<form class="inline-form" method="POST" action="${clientMode ? '/painel' : '/admin'}/pedidos/status"><input type="hidden" name="id" value="${o.id}"><input type="hidden" name="status" value="approved"><button class="btn green small">Pago</button></form>` : ''}${clientMode && o.status === 'approved' ? ` <button class="btn amber small" onclick="reimprimirPedido(${o.id})" title="Reimprimir ticket">🖨️</button>` : ''} <button class="btn red small" onclick="excluirRegistro('${clientMode ? '/painel' : '/admin'}/pedidos/excluir', ${o.id}, 'Excluir o pedido #${esc(o.external_id)}?')" title="Excluir pedido">🗑</button></td>
    </tr>`;
  }))).join('');

  res.send(layout('Pedidos', clientMode ? '/painel/pedidos' : '/admin/pedidos', `${tenantSelector(tenant.id, tenants, clientMode)}
    <div class="filters">${statusFilter}<button class="btn amber small" onclick="testarImpressora()">🖨️ Imprimir teste</button>
      <form class="inline-form" method="POST" action="${clientMode ? '/painel' : '/admin'}/pedidos/verificar-pagamentos">${clientMode ? '' : `<input type="hidden" name="tenant" value="${tenant.id}">`}<button class="btn small">🔍 Verificar pagamentos</button></form>
    </div>
    <div class="panel"><h2>🖨️ Impressora</h2>
      <div class="grid2">
        <div><label>MODO DE IMPRESSÃO</label><select id="impModo" onchange="salvarPrefImp()">
          <option value="sistema">Impressora do sistema (PC / navegador)</option>
          <option value="bluetooth">Bluetooth (térmica ESC/POS)</option>
        </select></div>
        <div><label>LARGURA DO PAPEL</label><select id="impLargura" onchange="salvarPrefImp()">
          <option value="80">80mm</option>
          <option value="58">58mm</option>
        </select></div>
      </div>
      <div id="impBtBox" style="display:none;margin-top:10px;border-top:1px dashed #e2e8f0;padding-top:12px">
        <button class="btn" onclick="conectarImpressora()">🔗 Conectar impressora Bluetooth</button>
        <span id="impStatus" class="muted" style="font-size:13px;margin-left:10px"></span>
        <p style="font-size:12px;color:#64748b;margin-top:8px">Funciona no <b>Chrome Android</b>. Conecte a térmica bluetooth uma vez — os pedidos pagos imprimem automaticamente. No iPhone/iPad use impressora AirPrint ou um Android na loja.</p>
      </div>
    </div>
    <div class="panel"><table><thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.sel-lote')" title="Selecionar todos"></th><th>Pedido</th><th>Cliente</th><th>Itens</th><th>Total</th><th>Status</th><th>Pagamento</th><th>Ações</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="8"><div class="empty">Nenhum pedido com esse filtro.</div></td></tr>'}</tbody></table>
    <div style="margin-top:10px"><button class="btn red small" onclick="excluirSelecionados('${clientMode ? '/painel' : '/admin'}/pedidos/excluir-lote', '.sel-lote', 'pedido')">🗑 Excluir selecionados</button></div>
    </div>`, tenants, tenant, clientMode));
}

router.get('/admin/pedidos', requireAuth, pagePedidos);
router.get('/painel/pedidos', clientPanelAuth, pagePedidos);

async function postPedidosStatus(req, res) {
  const _tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const orderId = Number(req.body.id);
  const status = String(req.body.status);
  await repo.updateOrderStatus(orderId, status);

  // Confirmação manual (ex: PIX com QR próprio): notifica cliente + dono
  if (status === 'approved') {
    try {
      const order = await repo.getOrder(orderId);
      const tenant = await repo.getTenant(order.tenant_id);
      if (order && tenant) {
        const webhook = require('./webhook');
        await webhook.confirmarPagamentoAprovado(tenant, order);
      }
    } catch (e) {
      console.error('[PEDIDO] erro ao notificar pagamento aprovado:', e.message);
    }
  }
  res.redirect(`${base}/pedidos`);
}

router.post('/admin/pedidos/status', requireAuth, postPedidosStatus);
router.post('/painel/pedidos/status', clientPanelAuth, postPedidosStatus);

// Verificação manual de pagamentos pendentes (confirma pagos que o webhook não capturou)
async function postVerificarPagamentos(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const webhook = require('./webhook');
  const aprovados = await webhook.verificarPagamentosPendentes(tenantId);
  const msg = aprovados > 0
    ? `${aprovados} pedido(s) pagos confirmados!`
    : 'Nenhum pagamento pendente para confirmar.';
  res.redirect(`${base}/pedidos?msg=` + encodeURIComponent(msg));
}
router.post('/admin/pedidos/verificar-pagamentos', requireAuth, postVerificarPagamentos);
router.post('/painel/pedidos/verificar-pagamentos', clientPanelAuth, postVerificarPagamentos);

// ----- EXCLUSÃO DE PEDIDOS (individual + lote) -----
async function postPedidosExcluir(req, res) {
  const base = req.clientMode ? '/painel' : '/admin';
  await repo.deleteOrder(Number(req.body.id));
  res.redirect(`${base}/pedidos?msg=` + encodeURIComponent('Pedido excluído.'));
}
async function postPedidosExcluirLote(req, res) {
  const base = req.clientMode ? '/painel' : '/admin';
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  for (const id of ids) await repo.deleteOrder(id);
  res.redirect(`${base}/pedidos?msg=` + encodeURIComponent(`${ids.length} pedido(s) excluído(s).`));
}
router.post('/painel/pedidos/excluir', clientPanelAuth, postPedidosExcluir);
router.post('/admin/pedidos/excluir', requireAuth, postPedidosExcluir);
router.post('/painel/pedidos/excluir-lote', clientPanelAuth, postPedidosExcluirLote);
router.post('/admin/pedidos/excluir-lote', requireAuth, postPedidosExcluirLote);

// ----- LEADS -----
async function pageLeads(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Leads', clientMode ? '/painel/leads' : '/admin/leads', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const leads = await repo.listLeads(tenant.id);
  const rows = leads.map(l => `<tr>
    <td><input type="checkbox" class="sel-lote" data-val="${l.id}"></td>
    <td><b>${esc(l.full_name || '—')}</b><br><small style="color:#94a3b8">${esc(l.phone)}</small></td>
    <td>${esc(l.delivery_address || '—')}</td>
    <td>${statusBadge(l.status)}</td>
    <td><form class="inline-form" method="POST" action="${clientMode ? '/painel' : '/admin'}/leads/status"><input type="hidden" name="id" value="${l.id}">
      <select name="status" onchange="this.form.submit()">${['novo', 'contatado', 'convertido', 'fechado'].map(s => `<option value="${s}" ${(l.status === s || (l.status?.startsWith('pausado') && s === 'novo')) ? 'selected' : ''}>${s}</option>`).join('')}</select></form></td>
    <td>${esc(String(l.created_at).slice(0, 16))}</td>
    <td><button class="btn small" onclick="copyText('${esc(l.phone)}', this)">📋 Número</button>
      <button class="btn red small" onclick="excluirLead('${clientMode ? '/painel' : '/admin'}/leads/excluir', ${l.id})" title="Excluir lead (pede senha)">🗑</button></td>
  </tr>`).join('');
  res.send(layout('Leads', clientMode ? '/painel/leads' : '/admin/leads', `${tenantSelector(tenant.id, tenants, clientMode)}
    <div class="panel"><h2>Leads <span class="right"><input type="password" id="senhaLoteLeads" placeholder="Sua senha" style="width:170px"> <button class="btn red small" onclick="excluirLeadsLote('${clientMode ? '/painel' : '/admin'}/leads/excluir-lote')">🗑 Excluir selecionados</button></span></h2>
    <table id="tblLeads"><thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.sel-lote')" title="Selecionar todos"></th><th>Cliente</th><th>Endereço</th><th>Status</th><th>Alterar</th><th>Contato</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7"><div class="empty">Nenhum lead.</div></td></tr>'}</tbody></table>
    <p style="font-size:12px;color:#64748b;margin-top:8px">Excluir lead apaga também os pedidos e conversas dele. A exclusão exige a sua senha de acesso.</p></div>`, tenants, tenant, clientMode));
}

router.get('/admin/leads', requireAuth, pageLeads);
router.get('/painel/leads', clientPanelAuth, pageLeads);

async function postLeadsStatus(req, res) {
  const _tenantId = tenantIdFromReq(req, req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  await repo.updateLeadStatus(Number(req.body.id), String(req.body.status));
  res.redirect(`${base}/leads`);
}

router.post('/admin/leads/status', requireAuth, postLeadsStatus);
router.post('/painel/leads/status', clientPanelAuth, postLeadsStatus);

// ----- EXCLUSÃO DE LEADS (individual + lote, confirma com a senha do login) -----
function senhaLeadValida(req, senha) {
  if (req.clientMode) return repo.verifyPassword(senha, req.tenantSession.panel_password);
  return senha === config.adminPassword;
}
async function postLeadsExcluir(req, res) {
  const base = req.clientMode ? '/painel' : '/admin';
  if (!senhaLeadValida(req, String(req.body.senha || ''))) {
    return res.redirect(`${base}/leads?msg=` + encodeURIComponent('Senha incorreta — lead não excluído.') + '&type=err');
  }
  await repo.deleteLeadCompleto(Number(req.body.id));
  res.redirect(`${base}/leads?msg=` + encodeURIComponent('Lead excluído (com pedidos e conversas).'));
}
async function postLeadsExcluirLote(req, res) {
  const base = req.clientMode ? '/painel' : '/admin';
  if (!senhaLeadValida(req, String(req.body.senha || ''))) {
    return res.redirect(`${base}/leads?msg=` + encodeURIComponent('Senha incorreta — nada foi excluído.') + '&type=err');
  }
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  for (const id of ids) await repo.deleteLeadCompleto(id);
  res.redirect(`${base}/leads?msg=` + encodeURIComponent(`${ids.length} lead(s) excluído(s) (com pedidos e conversas).`));
}
router.post('/painel/leads/excluir', clientPanelAuth, postLeadsExcluir);
router.post('/admin/leads/excluir', requireAuth, postLeadsExcluir);
router.post('/painel/leads/excluir-lote', clientPanelAuth, postLeadsExcluirLote);
router.post('/admin/leads/excluir-lote', requireAuth, postLeadsExcluirLote);

// ----- PERGUNTAS -----
async function pagePerguntas(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Perguntas', clientMode ? '/painel/perguntas' : '/admin/perguntas', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const base = clientMode ? '/painel' : '/admin';
  const qs = Object.entries(data.questionnaires || {}).map(([qid, q]) => {
    const rows = (q.questions || []).map((question, qi) => `
      <tr><td style="text-align:center"><input type="checkbox" class="del-perg" data-qid="${esc(qid)}" data-val="${qi}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][key]" value="${esc(question.key)}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][field]" value="${esc(question.field || '')}"></td>
      <td><input type="text" name="q[${esc(qid)}][${qi}][question]" value="${esc(question.question)}" style="min-width:240px"></td>
      <td style="text-align:center"><input type="checkbox" name="q[${esc(qid)}][${qi}][optional]" ${question.optional ? 'checked' : ''}></td>
      <td style="text-align:center"><button class="btn red small" type="submit" formaction="${base}/perguntas/remover?qid=${esc(qid)}&qi=${qi}" formnovalidate>🗑</button></td></tr>`).join('') || '<tr><td colspan="6" style="color:#64748b">Sem perguntas.</td></tr>';
    return `<div class="panel"><h2>${esc(q.label || qid)} <span class="badge info">${esc(qid)}</span> <span class="right"><button class="btn red small" type="button" onclick="excluirSelecionados('${base}/perguntas/remover-lote', '.del-perg', 'pergunta', function(c){ return 'del[' + c.dataset.qid + '][]'; })">🗑 Excluir selecionadas</button></span></h2>
      <form method="POST" action="${base}/perguntas/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
        <table><thead><tr><th><input type="checkbox" onclick="toggleAllCbx(this, '.del-perg')" title="Selecionar todas"></th><th>Chave</th><th>Campo do lead</th><th>Pergunta</th><th>Opcional</th><th></th></tr></thead><tbody>${rows}</tbody></table>
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
  const base = clientMode ? '/painel' : '/admin';
  if (!tenant) return res.send(layout('Mensagens', clientMode ? '/painel/mensagens' : '/admin/mensagens', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const fields = Object.entries(data.messages || {}).map(([key, value]) => `
    <div class="panel"><h2>${esc(key)} <button class="btn red small" onclick="excluirRegistro('${base}/mensagens/excluir', '${esc(key)}', 'Remover esta mensagem (o bot volta ao texto padrão)?')" title="Remover (volta ao padrão)">🗑</button></h2><textarea name="msgs[${esc(key)}]" style="min-height:80px">${esc(value)}</textarea></div>`).join('');
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

// ----- EXCLUSÕES EM LOTE E RESTAURAÇÃO (clientes/assinaturas/segmentos/produtos/perguntas/mensagens/botões/config) -----

// Clientes (lote)
router.post('/admin/clientes/excluir-lote', requireAuth, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  for (const id of ids) await repo.deleteTenant(id);
  res.redirect('/admin/clientes?msg=' + encodeURIComponent(`${ids.length} cliente(s) excluído(s).`));
});

// Assinaturas (lote)
router.post('/admin/assinaturas/excluir-lote', requireAuth, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  for (const id of ids) await repo.deleteSubscription(id);
  res.redirect('/admin/assinaturas?msg=' + encodeURIComponent(`${ids.length} licença(s) excluída(s).`));
});

// Segmentos (lote — respeita bloqueio em uso)
router.post('/admin/segmentos/excluir-lote', requireAuth, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  let excluidos = 0, bloqueados = 0;
  for (const id of ids) {
    const emUso = await repo.countTenantsBySegment(id);
    if (emUso > 0) { bloqueados++; continue; }
    await repo.deleteSegment(id);
    excluidos++;
  }
  res.redirect('/admin/segmentos?msg=' + encodeURIComponent(`${excluidos} segmento(s) excluído(s)${bloqueados ? ` — ${bloqueados} em uso mantidos` : ''}.`));
});

// Produtos (lote — painel + admin)
async function postProdutosExcluirLote(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const marcados = req.body.del || {};
  let count = 0;
  for (const [ci, pis] of Object.entries(marcados)) {
    const cat = data.categories[Number(ci)];
    if (!cat) continue;
    const idxs = (Array.isArray(pis) ? pis : [pis]).map(Number).filter(Number.isInteger).sort((a, b) => b - a);
    for (const pi of idxs) { cat.products.splice(pi, 1); count++; }
  }
  if (count) await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/produtos?msg=` + encodeURIComponent(`${count} produto(s) excluído(s).`));
}
router.post('/painel/produtos/excluir-lote', clientPanelAuth, postProdutosExcluirLote);
router.post('/admin/produtos/excluir-lote', requireAuth, postProdutosExcluirLote);

// Perguntas (lote — painel + admin)
async function postPerguntasRemoverLote(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const marcados = req.body.del || {};
  let count = 0;
  for (const [qid, pis] of Object.entries(marcados)) {
    if (!data.questionnaires[qid]) continue;
    const idxs = (Array.isArray(pis) ? pis : [pis]).map(Number).filter(Number.isInteger).sort((a, b) => b - a);
    for (const idx of idxs) { data.questionnaires[qid].questions.splice(idx, 1); count++; }
  }
  if (count) await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/perguntas?msg=` + encodeURIComponent(`${count} pergunta(s) removida(s).`));
}
router.post('/painel/perguntas/remover-lote', clientPanelAuth, postPerguntasRemoverLote);
router.post('/admin/perguntas/remover-lote', requireAuth, postPerguntasRemoverLote);

// Mensagens (restaurar ao padrão — painel + admin)
async function postMensagensExcluir(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const key = String(req.body.id || '');
  const data = await catalog.loadTenantCatalog(tenantId);
  if (key && data.messages) delete data.messages[key];
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/mensagens?msg=` + encodeURIComponent('Mensagem removida — o bot volta ao texto padrão.'));
}
router.post('/painel/mensagens/excluir', clientPanelAuth, postMensagensExcluir);
router.post('/admin/mensagens/excluir', requireAuth, postMensagensExcluir);

// Botões (restaurar ao padrão — painel + admin)
async function postBotoesExcluir(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const key = String(req.body.id || '');
  const data = await catalog.loadTenantCatalog(tenantId);
  if (key && data.buttons) delete data.buttons[key];
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/botoes?msg=` + encodeURIComponent('Botão restaurado ao nome padrão.'));
}
router.post('/painel/botoes/excluir', clientPanelAuth, postBotoesExcluir);
router.post('/admin/botoes/excluir', requireAuth, postBotoesExcluir);

// Horários (restaurar dia como fechado — painel + admin)
async function postConfigHorariosExcluir(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const dia = String(req.body.id || '');
  const data = await catalog.loadTenantCatalog(tenantId);
  if (data.store.hours && data.store.hours[dia]) delete data.store.hours[dia];
  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/config?msg=` + encodeURIComponent('Horário do dia removido — fica fechado.'));
}
router.post('/painel/config/horarios/excluir', clientPanelAuth, postConfigHorariosExcluir);
router.post('/admin/config/horarios/excluir', requireAuth, postConfigHorariosExcluir);

// ----- BOTÕES E ATENDENTE -----
const BOTOES_ROTULOS = {
  menu_shop: 'Comprar (menu principal)',
  menu_support: 'Atendente (menu principal)',
  menu_track: 'Meus Pedidos (menu principal)',
  back: 'Voltar',
  buy: 'Comprar (na página do produto)',
  quote: 'Quero saber mais (sob consulta)',
  add_product: 'Adicionar ao carrinho (card do produto)',
  detail: 'Detalhes (card do produto)',
  add_to_cart: 'Continuar comprando (após adicionar)',
  cart_show: 'Ver carrinho (após adicionar)',
  cart_buy: 'Finalizar pedido (no carrinho)',
  cart_clear: 'Esvaziar carrinho',
  add_more: 'Adicionar mais itens (carrinho/confirmação)',
  confirm_order: 'Confirmar pedido',
  cancel: 'Cancelar',
  pay_pix: 'PIX',
  pay_credit: 'Cartão de Crédito',
  pay_debit: 'Cartão de Débito',
  list_button: 'Botão das listas (Ver opções)',
};

async function pageBotoes(req, res) {
  const { tenant, tenants } = await resolveTenant(req, res);
  const clientMode = !!req.clientMode;
  if (!tenant) return res.send(layout('Botões e Atendente', clientMode ? '/painel/botoes' : '/admin/botoes', '<div class="empty">Crie um cliente.</div>', tenants, null, clientMode));
  const data = await catalog.loadTenantCatalog(tenant.id);
  const btns = await catalog.getButtons(tenant.id);
  const msgs = data.messages || {};
  const base = clientMode ? '/painel' : '/admin';

  const rows = Object.entries(BOTOES_ROTULOS).map(([k, rotulo]) => `
    <tr><td>${esc(rotulo)}</td>
    <td><input type="text" name="buttons[${k}]" value="${esc(btns[k] || '')}" maxlength="20"> <button class="btn red small" onclick="excluirRegistro('${base}/botoes/excluir', '${esc(k)}', 'Restaurar este botão ao nome padrão?')" title="Restaurar ao padrão">🗑</button></td></tr>`).join('');

  const suporte = [
    ['notify_title', 'TÍTULO DA NOTIFICAÇÃO (você recebe)', msgs.support_notify_title || 'ATENDIMENTO SOLICITADO', false],
    ['notify_body', 'CORPO DA NOTIFICAÇÃO (você recebe)', msgs.support_notify_body || 'Nome: {nome}\nWhatsApp: {telefone}\nMotivo: {motivo}', true],
    ['ask_name', 'PERGUNTAR NOME (cliente recebe)', msgs.ask_support_name || 'Informe seu nome completo:', false],
    ['ask_reason', 'PERGUNTAR MOTIVO (cliente recebe)', msgs.ask_support_reason || 'Qual o motivo do seu contato?', false],
    ['escalation', 'RESPOSTA FINAL (cliente recebe)', msgs.support_escalation || 'Um dos nossos atendentes vai falar com você em breve pelo WhatsApp!', true],
  ].map(([k, rotulo, valor, grande]) => `
    <div style="grid-column:1/-1"><label>${esc(rotulo)}</label>
    ${grande ? `<textarea name="support[${k}]" rows="3">${esc(valor)}</textarea>` : `<input type="text" name="support[${k}]" value="${esc(valor)}">`}</div>`).join('');

  res.send(layout('Botões e Atendente', clientMode ? '/painel/botoes' : '/admin/botoes', `${tenantSelector(tenant.id, tenants, clientMode)}
    <form method="POST" action="${base}/botoes/salvar"><input type="hidden" name="tenant" value="${tenant.id}">
      <div class="panel"><h2>🔘 Nomes dos botões</h2>
        <table><thead><tr><th>Botão</th><th>Nome exibido no WhatsApp (máx. 20 caracteres)</th></tr></thead>
        <tbody>${rows}</tbody></table>
        <p style="font-size:12px;color:#64748b;margin-top:8px">O WhatsApp limita os botões a 20 caracteres — textos maiores são cortados automaticamente.</p>
      </div>
      <div class="panel"><h2>👤 Botão Atendente</h2>
        <p style="font-size:12px;color:#64748b;margin-bottom:6px">Na notificação, use as variáveis: <b>{nome}</b> (nome do cliente), <b>{telefone}</b> (WhatsApp dele) e <b>{motivo}</b> (o que ele digitou).</p>
        <div class="grid2">${suporte}</div>
      </div>
      <div class="panel"><h2>📲 Notificações</h2>
        <div class="grid2">
          <div><label>WHATSAPP QUE RECEBE AS NOTIFICAÇÕES</label><input type="text" name="notify[phone]" value="${esc(tenant.notify_phone || '')}" placeholder="5548999999999">
            <p style="font-size:12px;color:#64748b;margin-top:4px">É para esse número que chegam os avisos de <b>novo pedido</b>, <b>atendente</b> e <b>pagamento recebido</b>. Deixe vazio para manter o atual.</p></div>
          <div><label>E-MAIL DE NOTIFICAÇÕES</label><input type="email" name="notify[email]" value="${esc(tenant.notify_email || '')}" placeholder="seu@email.com">
            <p style="font-size:12px;color:#64748b;margin-top:4px">Recebe as mesmas notificações por e-mail. Deixe vazio para manter o atual.</p></div>
        </div>
      </div>
      <button class="btn" type="submit">💾 Salvar</button>
    </form>`, tenants, tenant, clientMode));
}

router.get('/admin/botoes', requireAuth, pageBotoes);
router.get('/painel/botoes', clientPanelAuth, pageBotoes);

async function postBotoesSalvar(req, res) {
  const tenantId = tenantIdFromReq(req, req.body.tenant || req.query.tenant);
  const base = req.clientMode ? '/painel' : '/admin';
  const data = await catalog.loadTenantCatalog(tenantId);
  const b = req.body;
  if (b.buttons) {
    const buttons = {};
    for (const [k, v] of Object.entries(b.buttons)) buttons[k] = String(v || '').trim().slice(0, 20);
    data.buttons = buttons;
  }
  const sp = b.support || {};
  const maps = {
    support_notify_title: sp.notify_title, support_notify_body: sp.notify_body,
    ask_support_name: sp.ask_name, ask_support_reason: sp.ask_reason, support_escalation: sp.escalation,
  };
  for (const [chave, valor] of Object.entries(maps)) {
    if (valor !== undefined) {
      if (!data.messages) data.messages = {};
      data.messages[chave] = String(valor).trim();
    }
  }

  // Notificações (número/e-mail do tenant) — vazio mantém o atual
  const ntf = b.notify || {};
  const upd = {};
  if (ntf.phone !== undefined && String(ntf.phone).trim()) {
    upd.notify_phone = repo.normalizePhoneBr(ntf.phone);
  }
  if (ntf.email !== undefined && String(ntf.email).trim()) {
    upd.notify_email = String(ntf.email).trim();
  }
  if (Object.keys(upd).length) await repo.updateTenant(tenantId, upd);

  await catalog.saveTenantCatalog(tenantId, data);
  res.redirect(`${base}/botoes?msg=` + encodeURIComponent('Botões e atendente salvos!'));
}

router.post('/admin/botoes/salvar', requireAuth, postBotoesSalvar);
router.post('/painel/botoes/salvar', clientPanelAuth, postBotoesSalvar);

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
  const showAreasEditor = !!tenant.segment_name && tenant.segment_name !== 'vendas';
  const areas = Array.isArray(s.delivery_areas) ? s.delivery_areas : [];
  const mpUser = tenant.mp_user_id || '';
  const firstCat = (data.categories || []).find(cat => (cat.products || []).some(p => p.available)) || data.categories?.[0];

  // Horário de funcionamento (por dia da semana)
  const DIAS_HORARIO = [
    { chave: '0', nome: 'Domingo' }, { chave: '1', nome: 'Segunda-feira' }, { chave: '2', nome: 'Terça-feira' },
    { chave: '3', nome: 'Quarta-feira' }, { chave: '4', nome: 'Quinta-feira' }, { chave: '5', nome: 'Sexta-feira' },
    { chave: '6', nome: 'Sábado' },
  ];
  const hoursData = s.hours || {};
  const hoursRows = DIAS_HORARIO.map((d, i) => {
    const h = hoursData[d.chave];
    const fechado = !h;
    return `<tr>
      <td><b>${d.nome}</b></td>
      <td style="text-align:center"><input type="checkbox" name="store[hours][${d.chave}][fechado]" value="on" ${fechado ? 'checked' : ''} onchange="toggleHorario(${i})"></td>
      <td><input type="time" name="store[hours][${d.chave}][open]" value="${esc(h?.open || '11:00')}" data-h="1" ${fechado ? 'disabled' : ''}></td>
      <td><input type="time" name="store[hours][${d.chave}][close]" value="${esc(h?.close || '23:00')}" data-h="1" ${fechado ? 'disabled' : ''}></td>
      <td style="text-align:center">${fechado ? '' : `<button class="btn red small" onclick="excluirRegistro('${base}/config/horarios/excluir', '${d.chave}', 'Remover o horário de ${d.nome} (fica fechado)?')" title="Remover horário (fica fechado)">🗑</button>`}</td>
    </tr>`;
  }).join('');

  const previewCat = firstCat?.id || '';
  const logoUrl = c.logo_url || '';
  const logoThumb = logoUrl ? `<div style="margin-top:8px"><img src="${esc(logoUrl)}" style="max-height:56px;border-radius:8px"><button class="btn red small" style="margin-left:8px" onclick="document.getElementById('logoUrlField').value=''">Remover</button></div>` : '';

  res.send(layout('Configurações', clientMode ? '/painel/config' : '/admin/config', `${tenantSelector(tenant.id, tenants, clientMode)}
    <form method="POST" action="${base}/config/salvar" onsubmit="reindexAreas()"><input type="hidden" name="tenant" value="${tenant.id}">
      <div class="panel"><h2>🏪 Loja</h2><div class="grid3">
        <div><label>FRETE (R$)</label><input type="text" name="store[delivery_fee]" value="${s.delivery_fee ?? 0}"></div>
        <div><label>FRETE GRÁTIS ACIMA (R$)</label><input type="text" name="store[delivery_free_full]" value="${s.delivery_free_full ?? 0}"></div>
        <div><label>DESCONTO PIX (%)</label><input type="text" name="store[pix_discount_percent]" value="${s.pix_discount_percent ?? 0}"></div>
      </div>
      ${showAreasEditor ? `<div style="margin-top:10px;border-top:1px dashed #e2e8f0;padding-top:12px">
        <h3 style="font-size:13px;margin-bottom:6px">🛵 ÁREAS DE ENTREGA <small style="font-weight:400;color:#94a3b8">— o bot pergunta o bairro no checkout e cobra a taxa de cada um</small></h3>
        <div id="areasList">${areasEditorHtml(areas)}</div>
        <button type="button" class="btn gray small" style="margin-top:6px" onclick="addArea()">+ Adicionar bairro</button>
        <p style="font-size:12px;color:#64748b;margin-top:6px">Bairros fora da lista são <b>bloqueados</b> no checkout com sugestão de contato. Lista vazia = vale o frete fixo acima.</p>
      </div>` : ''}
      </div>
      <div class="panel"><h2>🏢 Empresa</h2><div class="grid2">
        <div><label>NOME DA EMPRESA</label><input type="text" name="company[name]" value="${esc(c.name || '')}"></div>
        <div><label>HORÁRIO (texto exibido no ticket)</label><input type="text" name="company[business_hours]" value="${esc(c.business_hours || '')}"></div>
        <div><label>ENDEREÇO (rua, n°)</label><input type="text" name="company[address][street]" value="${esc(addr.street || '')}"></div>
        <div><label>CIDADE</label><input type="text" name="company[address][city]" value="${esc(addr.city || '')}"></div>
      </div></div>
      ${showAreasEditor ? `<div class="panel"><h2>🕒 Horário de funcionamento <small style="font-weight:400;color:#94a3b8">— o bot bloqueia pedidos fora do horário</small></h2>
        <table><thead><tr><th>Dia</th><th>Fechado</th><th>Abre</th><th>Fecha</th><th></th></tr></thead>
        <tbody>${hoursRows}</tbody></table>
        <p style="font-size:12px;color:#64748b;margin-top:8px">Dia marcado como <b>Fechado</b> bloqueia pedidos o dia inteiro. Cliente fora do horário recebe aviso e não consegue comprar/finalizar.</p>
      </div>` : ''}
      <div class="panel"><h2>💳 Pagamentos (Mercado Pago)</h2>
        ${mpUser ? `
          <p style="font-size:13px">✅ <b>Conectado</b> — conta: <b>${esc(mpUser)}</b></p>
          <p style="font-size:12px;color:#64748b;margin:6px 0 10px">Os pagamentos dos seus pedidos (PIX e cartão) entram <b>direto na sua conta</b> do Mercado Pago, com confirmação automática.</p>
          <a class="btn red small" href="/mercadopago/desconectar?tenant=${tenant.id}">🔌 Desconectar</a>`
        : `
          <p style="font-size:12px;color:#64748b;margin-bottom:10px">Conecte sua conta do Mercado Pago para receber os pagamentos dos pedidos (PIX e cartão) <b>direto nela</b>, com confirmação automática. Sem conexão, os pagamentos caem na conta padrão do sistema.</p>
          <a class="btn green" href="/mercadopago/connect?tenant=${tenant.id}">🔗 Conectar Mercado Pago</a>`}
      </div>
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
      ${previewCat
        ? `<img id="menuPreview" src="/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(previewCat)}&refresh=1&v=${Date.now()}" style="max-width:360px;width:100%;border:1px solid #e2e8f0;border-radius:10px" alt="Preview">`
        : `<div class="empty" style="border:1px dashed #cbd5e1;border-radius:10px">📭 Nenhum produto ativo para gerar a imagem do menu.<br><br>Cadastre produtos em <a href="${base}/produtos">Produtos</a> e deixe marcado como <b>ativo</b> — a imagem aparece aqui e é enviada no bot.</div>`}
      <p style="font-size:12px;color:#64748b;margin-top:8px">Atualiza conforme você muda as cores/acima. Salve para aplicar no bot (em até 15s).</p>
    </div>
    <script>
      function areaLinhaHtml(){
        return '<div class="area-linha" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
          '<input type="text" name="store[delivery_areas][0][bairro]" placeholder="Bairro (ex: Centro)" style="flex:1">' +
          '<div style="display:flex;align-items:center;gap:4px;width:130px;flex-shrink:0"><span style="font-size:12px;color:#64748b">R$</span><input type="text" name="store[delivery_areas][0][taxa]" placeholder="0,00"></div>' +
          '<button type="button" class="btn red small" onclick="removeArea(this)">✕</button></div>';
      }
      function addArea(){
        const el = document.getElementById('areasList');
        if (el) { el.insertAdjacentHTML('beforeend', areaLinhaHtml()); reindexAreas(); }
      }
      function removeArea(btn){ btn.closest('.area-linha').remove(); }
      function reindexAreas(){
        document.querySelectorAll('#areasList .area-linha').forEach(function(linha, i){
          linha.querySelectorAll('input[name^="store[delivery_areas]"]').forEach(function(el){
            el.name = el.name.replace(/^store\[delivery_areas\]\[\d+\]/, 'store[delivery_areas][' + i + ']');
          });
        });
      }
      function toggleHorario(i){
        const rows = document.querySelectorAll('table tbody tr');
        const row = rows[i];
        if (!row) return;
        const fechado = row.querySelector('input[type=checkbox]').checked;
        row.querySelectorAll('input[type=time]').forEach(inp => { inp.disabled = fechado; });
      }
      function previewMenu(){
        const el = document.getElementById('menuPreview');
        if (!el) return;
        const v = Date.now();
        const sp = document.getElementById('miShowPrice').checked ? '1' : '0';
        const sn = document.getElementById('miShowNums').checked ? '1' : '0';
        const url = '/api/menu-image?tenant=${tenant.id}&cat=${encodeURIComponent(previewCat)}&refresh=1&v=' + v +
          '&header_bg=' + encodeURIComponent(document.getElementById('miHeaderBg').value) +
          '&price_color=' + encodeURIComponent(document.getElementById('miPriceColor').value) +
          '&show_price=' + sp + '&show_numbers=' + sn +
          '&footer_text=' + encodeURIComponent(document.getElementById('miFooter').value);
        el.src = url;
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

  // Áreas de entrega (editor visual — caixas bairro + taxa)
  if (s.delivery_areas !== undefined) {
    const areasRaw = Array.isArray(s.delivery_areas) ? s.delivery_areas : [s.delivery_areas];
    const areas = areasRaw
      .map(a => ({ bairro: String(a?.bairro || '').trim(), taxa: parseFloat(String(a?.taxa || '0').replace(',', '.')) || 0 }))
      .filter(a => a.bairro);
    data.store.delivery_areas = areas.length ? areas : undefined;
  }

  // Horário de funcionamento (por dia da semana — ramo de operação)
  const checkboxVal = (v) => (Array.isArray(v) ? v[v.length - 1] : v) === 'on';

  if (s.hours) {
    const hours = {};
    for (const [chave, v] of Object.entries(s.hours)) {
      if (checkboxVal(v?.fechado)) continue; // dia fechado
      const open = String(v?.open || '');
      const close = String(v?.close || '');
      if (/^\d{2}:\d{2}$/.test(open) && /^\d{2}:\d{2}$/.test(close)) {
        hours[chave] = { open, close };
      }
    }
    data.store.hours = Object.keys(hours).length ? hours : undefined;
  }

  // Imagem do menu
  const mi = s.menu_image || {};
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