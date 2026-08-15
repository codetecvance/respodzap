const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');

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
  textSvg += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;

  const nameX = cfg.logoUrl ? pad + 76 : pad;
  textSvg += `<text x="${nameX}" y="52" font-family="Arial" font-size="34" font-weight="bold" fill="#ffffff">${escSvg(companyName)}</text>`;
  textSvg += `<text x="${nameX}" y="86" font-family="Arial" font-size="22" fill="#93c5fd">${escSvg(cat?.name || 'Produtos')} — ${products.length} produto(s)</text>`;

  products.forEach((p, i) => {
    const y = headerH + i * rowH;
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    textSvg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${bg}"/>`;
    textSvg += `<rect x="${pad}" y="${y + rowH - 2}" width="${W - pad * 2}" height="2" fill="#eef2f7"/>`;
    textSvg += `<text x="${pad + thumb + 26}" y="${y + 50}" font-family="Arial" font-size="32" font-weight="bold" fill="#0f172a">${escSvg(p.name)}</text>`;
    if (cfg.showPrice !== false) {
      textSvg += `<text x="${pad + thumb + 26}" y="${y + 92}" font-family="Arial" font-size="30" font-weight="bold" fill="${escSvg(cfg.priceColor || '#1d4ed8')}">${escSvg(precoExibicao(tenantId, p))}</text>`;
    }
    if (cfg.showNumbers !== false) {
      textSvg += `<text x="${W - pad}" y="${y + 92}" font-family="Arial" font-size="24" fill="#94a3b8" text-anchor="end">${i + 1}</text>`;
    }
  });

  if (footerH) {
    const fy = H - footerH;
    textSvg += `<rect x="0" y="${fy}" width="${W}" height="${footerH}" fill="${escSvg(cfg.headerBg || '#1e3a8a')}"/>`;
    textSvg += `<text x="${W / 2}" y="${fy + 29}" font-family="Arial" font-size="22" fill="#ffffff" text-anchor="middle">${escSvg(cfg.footerText || '')}</text>`;
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

module.exports = { generateMenuImage };