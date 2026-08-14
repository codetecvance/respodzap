const repo = require('./repository');
const { notifyAdmin, notifyTenant } = require('./notify');

const DAY = 86400000;

/**
 * Rodar 1x/dia (Vercel Cron): avisa sobre licenças vencidas e prestes a vencer,
 * e envia o PIX de renovação automaticamente 3 dias antes do vencimento.
 */
async function runLicenseCheck() {
  const subs = await repo.getSubscriptions();
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  let report = [];

  for (const sub of subs) {
    if (sub.status !== 'ativa') continue;
    if (!sub.expires_at) continue;
    const expires = new Date(sub.expires_at).getTime();
    const daysLeft = Math.ceil((expires - now) / DAY);

    // Vencida → avisa admin (1x por dia por licença)
    if (daysLeft < 0) {
      if (sub.last_notified_day !== `vencida:${todayKey}`) {
        await notifyAdmin('⚠️ LICENÇA VENCIDA', `Cliente: ${sub.tenant_name}\nVenceu em: ${String(sub.expires_at).slice(0, 10)}\nValor: R$ ${sub.price}\nO bot está com "serviço pausado".`);
        await repo.renewSubscriptionMark(sub.id, `vencida:${todayKey}`);
        report.push(`vencida: ${sub.tenant_name}`);
      }
      continue;
    }

    // Avisos de antecedência (7, 3, 1 dias)
    if ([1, 3, 7].includes(daysLeft)) {
      if (sub.last_notified_day !== `aviso:${daysLeft}:${todayKey}`) {
        await notifyAdmin(`⏳ LICENÇA VENCE EM ${daysLeft} DIA(S)`, `Cliente: ${sub.tenant_name}\nVencimento: ${String(sub.expires_at).slice(0, 10)}\nValor: R$ ${sub.price}`);
        await repo.renewSubscriptionMark(sub.id, `aviso:${daysLeft}:${todayKey}`);
        report.push(`aviso ${daysLeft}d: ${sub.tenant_name}`);
      }
    }

    // Envio automático do PIX de renovação 3 dias antes
    if (daysLeft <= 3) {
      if (sub.last_notified_day !== `pix:${todayKey}`) {
        try {
          const tenant = await repo.getTenant(sub.tenant_id);
          const { criarPixAssinatura } = require('./payment');
          const pix = await criarPixAssinatura(sub, tenant);
          if (tenant?.notify_phone) {
            await notifyTenant(
              tenant,
              '🔔 RENOVAÇÃO DE ASSINATURA',
              `Sua assinatura vence em ${daysLeft} dia(s).\n\nPague com o PIX abaixo para renovar automaticamente:\n\n${pix.pix_copy_paste}\n\nValor: R$ ${pix.total.toFixed(2)}`,
              tenant.notify_phone
            );
          }
          await repo.renewSubscriptionMark(sub.id, `pix:${todayKey}`);
          report.push(`pix enviado: ${sub.tenant_name}`);
        } catch (e) {
          console.error('[LICENSE] Erro PIX automático:', e.message);
        }
      }
    }
  }
  console.log('[LICENSE] Check diário concluído:', report.join(' | ') || 'nada a fazer');
  return report;
}

module.exports = { runLicenseCheck };