require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const repo = require('../src/repository');

/**
 * Migra o ambiente local (mono-cliente) para o Neon multi-tenant:
 * cria o Tenant 1 "CodetecVance" com o catálogo atual e uma licença.
 * (Leads/pedidos antigos do SQLite NÃO são migrados — começam limpos.)
 */
async function run() {
  const { initDb } = require('../src/db');
  await initDb();

  // Plano padrão: Mensal R$ 299 / 30 dias
  let plan = (await repo.getPlans()).find(p => p.name === 'Mensal');
  if (!plan) plan = await repo.createPlan('Mensal', 299, 30);

  // Tenant 1: CodetecVance (dono/SaaS padrão)
  let tenant = (await repo.getTenants()).find(t => t.name === 'CodetecVance');
  if (!tenant) {
    tenant = await repo.createTenant({
      name: 'CodetecVance',
      contact_name: 'CodetecVance',
      contact_phone: config.businessPhone,
      phone_number_id: config.phoneNumberId,
      access_token: config.accessToken,
      waba_id: '1057474020543503',
      notify_phone: config.businessPhone,
      notify_email: config.notifyEmail,
      status: 'ativo',
    });
    console.log('Tenant criado:', tenant.id);
  }

  // Catálogo atual vira o catálogo do tenant
  const catalogJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'catalog.json'), 'utf-8'));
  await repo.saveTenantCatalog(tenant.id, catalogJson);
  console.log('Catálogo salvo para o tenant', tenant.id);

  // Licença inicial (30 dias)
  const subs = await repo.getSubscriptionsByTenant(tenant.id);
  if (!subs.length) {
    await repo.createSubscription(tenant.id, plan.id, plan.price, plan.period_days);
    console.log('Licença inicial criada (30 dias)');
  }

  console.log('✅ Migração concluída! Tenant 1 =', tenant.name, '(id', tenant.id + ')');
}

run().then(() => process.exit(0)).catch(e => {
  console.error('ERRO NA MIGRAÇÃO:', e.message);
  process.exit(1);
});