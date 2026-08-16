const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const catalog = require('./catalog');

// A fonte é convertida em PATHs SVG na hora de renderizar (via opentype.js) —
// não depende do fontconfig do servidor (Vercel), eliminando os "quadradinhos".
const FONT_PATH = path.join(__dirname, 'assets', 'Lato-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, 'assets', 'Lato-Bold.ttf');
let _font = null;
let _fontBold = null;

function appFont(bold = false) {
  if (bold) {
    if (_fontBold === null) {
      try { _fontBold = opentype.parse(fs.readFileSync(FONT_BOLD_PATH)); } catch { _fontBold = undefined; }
    }
    return _fontBold;
  }
  if (_font === null) {
    try { _font = opentype.parse(fs.readFileSync(FONT_PATH)); } catch { _font = undefined; }
  }
  return _font;
}

/**
 * Remove emojis/asterais (a fonte Roboto não tem glifos para eles).
 */
function stripEmoji(v) {
  return String(v ?? '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
}

function escSvg(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Converte texto em <path> SVG (usando a fonte embutida).
 * x,y = posição da BASELINE. align: 'start' | 'middle' | 'end'. bold: fake bold via stroke.
 */
function textPath(text, x, y, size, color, { align = 'start', bold = false } = {}) {
  const font = appFont(bold);
  const clean = stripEmoji(text);
  if (!font || !clean) return '';
  const width = font.getAdvanceWidth(clean, size) || 0;
  let tx = x;
  if (align === 'end') tx = x - width;
  if (align === 'middle') tx = x - width / 2;
  const d = font.getPath(clean, 0, 0, size).toPathData(2);
  if (!d) return '';
  const stroke = bold ? ` stroke="${color}" stroke-width="${Math.max(0.8, size / 30)}"` : '';
  return `<path d="${d}" transform="translate(${tx.toFixed(1)}, ${y.toFixed(1)})" fill="${color}"${stroke}/>`;
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
  textSvg += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;

  const nameX = cfg.logoUrl ? pad + 76 : pad;
  textSvg += textPath(companyName, nameX, 56, 34, '#ffffff', { bold: true });
  textSvg += textPath(`${cat?.name || 'Produtos'} — ${products.length} produto(s)`, nameX, 88, 22, '#93c5fd');

  products.forEach((p, i) => {
    const y = headerH + i * rowH;
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    textSvg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${bg}"/>`;
    textSvg += `<rect x="${pad}" y="${y + rowH - 2}" width="${W - pad * 2}" height="2" fill="#eef2f7"/>`;
    textSvg += textPath(p.name, pad + thumb + 26, y + 54, 32, '#0f172a', { bold: true });
    if (cfg.showPrice !== false) {
      textSvg += textPath(precoExibicao(tenantId, p), pad + thumb + 26, y + 94, 30, cfg.priceColor || '#1d4ed8', { bold: true });
    }
    if (cfg.showNumbers !== false) {
      textSvg += textPath(String(i + 1), W - pad, y + 94, 24, '#94a3b8', { align: 'end' });
    }
  });

  if (footerH) {
    const fy = H - footerH;
    textSvg += `<rect x="0" y="${fy}" width="${W}" height="${footerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;
    textSvg += textPath(cfg.footerText || '', W / 2, fy + 31, 22, '#ffffff', { align: 'middle' });
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

/**
 * Banner pequeno e horizontal do produto: foto pequena à esquerda,
 * nome + descrição à direita e preço no canto — 800x150 (compacto).
 */
async function generateProductCard(tenantId, product, cfg = {}) {
  const W = 800;
  const H = 150;
  const pad = 20;
  const thumb = 110;
  const imagesDir = path.join(__dirname, '..', 'public', 'images');

  const preco = product.sob_consulta
    ? 'Sob consulta'
    : catalog.formatPrice(product.price);
  const nome = String(product.name || 'Produto').slice(0, 34);
  const desc = String(product.short_description || '').slice(0, 46);

  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
  svg += `<rect x="${pad}" y="${(H - thumb) / 2}" width="${thumb}" height="${thumb}" rx="12" fill="#f1f5f9"/>`;
  svg += textPath(nome, pad + thumb + 24, H / 2 + 4, 32, '#0f172a', { bold: true });
  if (desc) svg += textPath(desc, pad + thumb + 24, H / 2 + 40, 20, '#64748b');
  svg += textPath(preco, W - pad, H / 2 + 12, 30, cfg.priceColor || '#1d4ed8', { align: 'end', bold: true });
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

module.exports = { generateMenuImage, generateProductCard };
