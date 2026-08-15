const { runLicenseCheck } = require('../src/license');

module.exports = async (req, res) => {
  // Proteção opcional: se CRON_SECRET estiver definido, exige o header
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const report = await runLicenseCheck();
    res.json({ ok: true, report });
  } catch (e) {
    console.error('[CRON]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};
