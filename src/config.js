require('dotenv').config();

const config = {
  appId: process.env.APP_ID || '',
  appSecret: process.env.APP_SECRET || '',
  phoneNumberId: process.env.PHONE_NUMBER_ID || '',
  accessToken: process.env.ACCESS_TOKEN || '',
  verifyToken: process.env.VERIFY_TOKEN || 'respzap-verify-2026',
  webhookUrl: process.env.WEBHOOK_URL || '',
  businessPhone: process.env.BUSINESS_PHONE || '',
  businessName: process.env.BUSINESS_NAME || 'RespVZap',
  port: Number(process.env.PORT) || 3001,
  graphVersion: process.env.GRAPH_VERSION || 'v21.0',
  databaseUrl: process.env.DATABASE_URL || '',
  mpAccessToken: process.env.MP_ACCESS_TOKEN || '',
  mpClientId: process.env.MP_CLIENT_ID || '',
  mpClientSecret: process.env.MP_CLIENT_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || 'respodzap123',
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || process.env.GMAIL_PASSWORD || '',
  },
  notifyEmail: process.env.NOTIFY_EMAIL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
};

const warnings = [];
if (!config.phoneNumberId) warnings.push('PHONE_NUMBER_ID ausente no .env');
if (!config.accessToken) warnings.push('ACCESS_TOKEN ausente no .env');
if (!config.mpAccessToken) warnings.push('MP_ACCESS_TOKEN ausente (Mercado Pago desativado até configurar)');
if (!config.databaseUrl) warnings.push('DATABASE_URL ausente (Neon) — o banco não vai conectar');
if (warnings.length) console.warn('⚠️  AVISOS:', warnings.join(' | '));

module.exports = config;