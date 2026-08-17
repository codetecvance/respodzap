const { runLicenseCheck } = require('../src/license');

module.exports = async (req, res) => {
  // Proteção opcional: se CRON_SECRET estiver definido, exige o header
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const report = await runLicenseCheck();
    // Rede de segurança: confirma pagamentos pendentes que o webhook não capturou
    const webhook = require('../src/webhook');
    const aprovados = await webhook.verificarPagamentosPendentes();
    // Limpeza automática: pedidos pendentes com mais de 3 dias
    const repo = require('../src/repository');
    const limpos = await repo.deletePendingOrdersOlderThan(3);
    res.json({ ok: true, report, pagamentos_aprovados: aprovados, pedidos_pendentes_limpos: limpos });
  } catch (e) {
    console.error('[CRON]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
