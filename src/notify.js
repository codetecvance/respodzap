const config = require('./config');
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const { host, port, user, pass } = config.smtp;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

/**
 * Envia e-mail de notificação (fire-and-forget).
 */
async function sendEmail(subject, text, to) {
  try {
    const t = getTransporter();
    const destino = to || config.notifyEmail;
    if (!t || !destino) {
      console.warn('[NOTIFY] SMTP não configurado — e-mail não enviado');
      return false;
    }
    await t.sendMail({
      from: `"RespVZap Bot" <${config.smtp.user}>`,
      to: destino,
      subject,
      text,
    });
    console.log('[NOTIFY] E-mail enviado:', subject);
    return true;
  } catch (e) {
    console.error('[NOTIFY] Erro ao enviar e-mail:', e.message);
    return false;
  }
}

/**
 * Link wa.me para responder o cliente com 1 toque.
 */
function waLink(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : '';
}

/**
 * Notificação para o CONTATO DO TENANT (cliente do SaaS):
 * WhatsApp (pelo número do tenant) + E-mail do tenant.
 *
 * @param {object} tenant — tenant atual (com notify_phone, notify_email, credenciais)
 * @param {string} titulo
 * @param {string} corpo
 * @param {string} [leadPhone] — telefone do cliente final (link wa.me)
 */
async function notifyTenant(tenant, titulo, corpo, leadPhone) {
  const whatsapp = require('./whatsapp');
  let linhas = [`*${titulo}*`, '', corpo].join('\n');
  if (leadPhone) linhas += `\n\nResponder cliente: ${waLink(leadPhone)}`;

  if (tenant?.notify_phone) {
    try {
      await whatsapp.sendText(tenant.notify_phone, linhas, tenant);
    } catch (e) {
      console.error('[NOTIFY] Erro WhatsApp tenant:', e.message);
    }
  }
  if (tenant?.notify_email) {
    await sendEmail(titulo, `${corpo}\n\nCliente: ${leadPhone || '—'}\nResponder: ${waLink(leadPhone) || '—'}`, tenant.notify_email);
  }
}

/**
 * Notificação ADMINISTRATIVA (para você, o dono do SaaS):
 * usa as credenciais globais e o BUSINESS_PHONE/NOTIFY_EMAIL.
 */
async function notifyAdmin(titulo, corpo) {
  const whatsapp = require('./whatsapp');
  const linhas = [`*${titulo}*`, '', corpo].join('\n');
  if (config.businessPhone) {
    try {
      await whatsapp.sendText(config.businessPhone, linhas, null);
    } catch (e) {
      console.error('[NOTIFY] Erro WhatsApp admin:', e.message);
    }
  }
  await sendEmail(titulo, corpo);
}

module.exports = { notifyTenant, notifyAdmin, sendEmail, waLink };