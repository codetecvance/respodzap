const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

// Fonte embutida (base64) — o ambiente serverless (Vercel) não tem fontconfig,
// então o texto SVG viraria quadradinhos sem a fonte embutida no próprio SVG.
const FONT_PATH = path.join(__dirname, 'assets', 'Roboto.ttf');
let _fontB64 = null;
function fontFaceSvg() {
  if (_fontB64 === null) {
    try { _fontB64 = fs.readFileSync(FONT_PATH).toString('base64'); } catch { _fontB64 = ''; }
  }
  return _fontB64
    ? `<style>@font-face{font-family:'AppFont';src:url(data:font/truetype;base64,${_fontB64})}</style>`
    : '';
}

function escSvg(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function precoExibicao(tenantId, product) {
  if (product.sob_consulta) return 'Sob consulta';
  return catalog.formatPrice(product.price);
}

/**
 * Baixa uma imagem remota e devolve buffer redimensionado (ou null).
 */
async function fetchRemoteThumb(url, size) {
  try {
    const axios = require('axios');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return await sharp(Buffer.from(resp.data)).resize(size, size, { fit: 'cover' }).png().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Gera a imagem-menu (lista vertical de produtos).
 *
 * @param {number} tenantId
 * @param {object} cat       — categoria
 * @param {object[]} products — produtos disponíveis
 * @param {object} [cfg]     — personalização: headerBg, priceColor, showPrice,
 *                             showNumbers, footerText, companyName, logoUrl
 */
async function generateMenuImage(tenantId, cat, products, cfg = {}) {
  const W = 800;
  const headerH = 110;
  const rowH = 128;
  const pad = 26;
  const thumb = 92;
  const footerH = cfg.footerText ? 46 : 0;
  const H = headerH + products.length * rowH + 30 + footerH;

  const imagesDir = path.join(__dirname, '..', 'public', 'images');
  const companyName = cfg.companyName || cat?.name || 'Produtos';

  let textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  textSvg += fontFaceSvg();
  textSvg += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;

  const nameX = cfg.logoUrl ? pad + 76 : pad;
  textSvg += `<text x="${nameX}" y="52" font-family="AppFont" font-size="34" font-weight="bold" fill="#ffffff">${escSvg(companyName)}</text>`;
  textSvg += `<text x="${nameX}" y="86" font-family="AppFont" font-size="22" fill="#93c5fd">${escSvg(cat?.name || 'Produtos')} — ${products.length} produto(s)</text>`;

  products.forEach((p, i) => {
    const y = headerH + i * rowH;
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    textSvg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${bg}"/>`;
    textSvg += `<rect x="${pad}" y="${y + rowH - 2}" width="${W - pad * 2}" height="2" fill="#eef2f7"/>`;
    textSvg += `<text x="${pad + thumb + 26}" y="${y + 50}" font-family="AppFont" font-size="32" font-weight="bold" fill="#0f172a">${escSvg(p.name)}</text>`;
    if (cfg.showPrice !== false) {
      textSvg += `<text x="${pad + thumb + 26}" y="${y + 92}" font-family="AppFont" font-size="30" font-weight="bold" fill="${escSvg(cfg.priceColor || '#1d4ed8')}">${escSvg(precoExibicao(tenantId, p))}</text>`;
    }
    if (cfg.showNumbers !== false) {
      textSvg += `<text x="${W - pad}" y="${y + 92}" font-family="AppFont" font-size="24" fill="#94a3b8" text-anchor="end">${i + 1}</text>`;
    }
  });

  if (footerH) {
    const fy = H - footerH;
    textSvg += `<rect x="0" y="${fy}" width="${W}" height="${footerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;
    textSvg += `<text x="${W / 2}" y="${fy + 29}" font-family="AppFont" font-size="22" fill="#ffffff" text-anchor="middle">${escSvg(cfg.footerText || '')}</text>`;
  }
  textSvg += '</svg>';

  const layers = [{ input: Buffer.from(textSvg) }];

  // Logo do cliente (se houver)
  if (cfg.logoUrl) {
    const logoBuf = await fetchRemoteThumb(cfg.logoUrl, 60);
    if (logoBuf) layers.push({ input: logoBuf, left: pad, top: (headerH - 60) / 2 });
  }

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    let imgBuf;
    try {
      const image = p.image || 'placeholder.png';
      const imgPath = /^https?:\/\//.test(image) ? null : path.join(imagesDir, image);
      if (imgPath && fs.existsSync(imgPath)) {
        imgBuf = await sharp(imgPath).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
      } else if (/^https?:\/\//.test(image)) {
        imgBuf = await fetchRemoteThumb(image, thumb);
      }
      if (!imgBuf) {
        imgBuf = await sharp(path.join(imagesDir, 'placeholder.png')).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
      }
    } catch {
      imgBuf = await sharp(path.join(imagesDir, 'placeholder.png')).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
    }
    layers.push({ input: imgBuf, left: pad, top: headerH + i * rowH + 18 });
  }

  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

module.exports = { generateMenuImage, generateProductCard };

/**
 * Banner pequeno e horizontal do produto: foto pequena à esquerda,
 * nome + descrição à direita e preço no canto — 800x180 (compacto no WhatsApp).
 * Usa a fonte embutida (AppFont) — sem depender do fontconfig do servidor.
 */
async function generateProductCard(tenantId, product, cfg = {}) {
  const W = 800;
  const H = 180;
  const pad = 20;
  const thumb = 140;
  const imagesDir = path.join(__dirname, '..', 'public', 'images');

  const preco = product.sob_consulta
    ? 'Sob consulta'
    : catalog.formatPrice(product.price);
  const nome = String(product.name || 'Produto').slice(0, 34);
  const desc = String(product.short_description || '').slice(0, 46);

  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += fontFaceSvg();
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
  svg += `<rect x="${pad}" y="${(H - thumb) / 2}" width="${thumb}" height="${thumb}" rx="12" fill="#f1f5f9"/>`;
  svg += `<text x="${pad + thumb + 24}" y="${H / 2 - 2}" font-family="AppFont" font-size="36" font-weight="bold" fill="#0f172a">${escSvg(nome)}</text>`;
  if (desc) svg += `<text x="${pad + thumb + 24}" y="${H / 2 + 36}" font-family="AppFont" font-size="22" fill="#64748b">${escSvg(desc)}</text>`;
  svg += `<text x="${W - pad}" y="${H / 2 + 8}" font-family="AppFont" font-size="34" font-weight="bold" fill="${escSvg(cfg.priceColor || '#1d4ed8')}" text-anchor="end">${escSvg(preco)}</text>`;
  svg += '</svg>';

  const layers = [{ input: Buffer.from(svg) }];

  // Foto pequena do produto (à esquerda)
  let imgBuf = null;
  try {
    const image = product.image || 'placeholder.png';
    const imgPath = /^https?:\/\//.test(image) ? null : path.join(imagesDir, image);
    if (imgPath && fs.existsSync(imgPath)) {
      imgBuf = await sharp(imgPath).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
    } else if (/^https?:\/\//.test(image)) {
      imgBuf = await fetchRemoteThumb(image, thumb);
    }
  } catch { imgBuf = null; }
  if (!imgBuf) {
    imgBuf = await sharp(path.join(imagesDir, 'placeholder.png')).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
  }
  layers.push({ input: imgBuf, left: pad, top: (H - thumb) / 2 });

  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(layers)
    .png()
    .toBuffer();
}