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
 * Gera (em memória) a imagem-menu: produtos em lista vertical,
 * thumbnail pequeno + nome + preço, um bloco abaixo do outro.
 * @returns {Promise<Buffer>} PNG
 */
async function generateMenuImage(tenantId, cat, products) {
  const W = 800;
  const headerH = 110;
  const rowH = 128;
  const pad = 26;
  const thumb = 92;
  const H = headerH + products.length * rowH + 30;

  const imagesDir = path.join(__dirname, '..', 'public', 'images');

  let textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
  textSvg += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="#1e3a8a"/>`;
  textSvg += `<text x="${pad}" y="52" font-family="Arial" font-size="34" font-weight="bold" fill="#ffffff">${escSvg(cat?.name || 'Produtos')}</text>`;
  textSvg += `<text x="${pad}" y="86" font-family="Arial" font-size="22" fill="#93c5fd">${products.length} produto(s)</text>`;

  products.forEach((p, i) => {
    const y = headerH + i * rowH;
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    textSvg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${bg}"/>`;
    textSvg += `<rect x="${pad}" y="${y + rowH - 2}" width="${W - pad * 2}" height="2" fill="#eef2f7"/>`;
    textSvg += `<text x="${pad + thumb + 26}" y="${y + 50}" font-family="Arial" font-size="32" font-weight="bold" fill="#0f172a">${escSvg(p.name)}</text>`;
    textSvg += `<text x="${pad + thumb + 26}" y="${y + 92}" font-family="Arial" font-size="30" font-weight="bold" fill="${p.sob_consulta ? '#d97706' : '#1d4ed8'}">${escSvg(precoExibicao(tenantId, p))}</text>`;
    textSvg += `<text x="${W - pad}" y="${y + 92}" font-family="Arial" font-size="24" fill="#94a3b8" text-anchor="end">${i + 1}</text>`;
  });
  textSvg += '</svg>';

  const layers = [{ input: Buffer.from(textSvg) }];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    let imgBuf;
    try {
      const image = p.image || 'placeholder.png';
      const imgPath = /^https?:\/\//.test(image) ? null : path.join(imagesDir, image);
      if (imgPath && fs.existsSync(imgPath)) {
        imgBuf = await sharp(imgPath).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
      } else if (/^https?:\/\//.test(image)) {
        // Imagem remota (ex: Vercel Blob) — baixa e redimensiona
        const axios = require('axios');
        const resp = await axios.get(image, { responseType: 'arraybuffer', timeout: 8000 });
        imgBuf = await sharp(Buffer.from(resp.data)).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
      } else {
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