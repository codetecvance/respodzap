const { runLicenseCheck } = require('../src/license');

module.exports = async (req, res) => {
  try {
    const report = await runLicenseCheck();
    res.json({ ok: true, report });
  } catch (e) {
    console.error('[CRON]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};