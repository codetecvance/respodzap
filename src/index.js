const express = require('express');
const path = require('path');
const config = require('./config');
const webhookRoutes = require('./webhook');
const adminRoutes = require('./admin');
const repo = require('./repository');
const catalog = require('./catalog');
const { generateMenuImage } = require('./menu');

const app = express();

// ======================================================
//  COOKIE PARSER SIMPLES (sessão do painel admin)
// ======================================================
app.use((req, res, next) => {
  try {
    const raw = req.headers.cookie || '';
    req.cookies = {};
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) req.cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  } catch (_) {
    req.cookies = {};
  }
  next();
});

// ======================================================
//  ESTÁTICO (imagens locais — dev; em produção as fotos
//  ficam no Vercel Blob com URL completa)
// ======================================================
app.use('/images', express.static(path.join(__dirname, '..', 'public', 'images'), {
  maxAge: '1d',
  setHeaders: (res) => res.set('Access-Control-Allow-Origin', '*'),
}));

// ======================================================
//  BODY PARSERS
// ======================================================
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// ======================================================
//  IMAGEM-MENU (gerada na hora — sem disco persistente)
// ======================================================
app.get('/api/menu-image', async (req, res) => {
  try {
    const tenantId = Number(req.query.tenant);
    const catId = String(req.query.cat || '');
    if (!tenantId) return res.status(400).send('tenant inválido');
    const tenant = await repo.getTenant(tenantId);
    if (!tenant) return res.status(404).send('tenant não encontrado');
    const data = await catalog.loadTenantCatalog(tenantId, req.query.refresh === '1');
    const cat = (data.categories || []).find(c => c.id === catId);
    const products = cat?.products?.filter(p => p.available) || [];
    if (!products.length) return res.status(404).send('categoria vazia');

    // Configuração do tenant + overrides (para o preview ao vivo)
    const m = data.store?.menu_image || {};
    const cfg = {
      headerBg: req.query.header_bg || m.header_bg || '#1e3a8a',
      priceColor: req.query.price_color || m.price_color || '#1d4ed8',
      showPrice: req.query.show_price !== undefined ? req.query.show_price === '1' : m.show_price !== false,
      showNumbers: req.query.show_numbers !== undefined ? req.query.show_numbers === '1' : m.show_numbers !== false,
      footerText: req.query.footer_text || m.footer_text || '',
      companyName: data.company?.name || cat?.name || 'Produtos',
      logoUrl: data.company?.logo_url || '',
    };

    const buf = await generateMenuImage(tenantId, cat, products, cfg);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('[MENU-IMAGE]', e.message);
    res.status(500).send('erro ao gerar imagem');
  }
});

// ======================================================
//  ROTAS
// ======================================================
app.use(webhookRoutes);
app.use(adminRoutes);

app.get('/', (req, res) => res.status(200).send('RespVZap Bot — Online'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ======================================================
//  INÍCIO (apenas em execução local; no Vercel usa api/index.js)
// ======================================================
if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`[RESPODZAP] Servidor iniciado em http://localhost:${config.port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[RESPODZAP] ERRO: Porta ${config.port} já está em uso.`);
    }
    process.exit(1);
  });
}

module.exports = app;