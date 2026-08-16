// Keep-warm: mantém a função serverless aquecida (cron a cada 10 min)
module.exports = async (req, res) => {
  res.json({ ok: true });
};
