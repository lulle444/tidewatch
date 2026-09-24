// Indexes new stock-token trades for the leaderboard. Called hourly by the GitHub Actions workflow;
// a lock keeps overlapping calls from running twice. The outcome of each run is kept in Redis so
// /api/leaderboard can show when the indexer last ran and why it failed, if it did.
const {redis} = require("../lib/store");
const lb = require("../lib/leaderboard");

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  const at = new Date().toISOString();
  try {
    const out = await lb.run({budgetMs: 220e3});
    if (!out.skipped) await redis("SET", lb.K.run, JSON.stringify({at, ok: !out.error, indexed: out.indexed, error: out.error, ms: out.ms})).catch(() => {});
    res.status(out.error ? 502 : 200).json(out);
  } catch (e) {
    const error = String(e.message || e).slice(0, 500);
    await redis("SET", lb.K.run, JSON.stringify({at, ok: false, error})).catch(() => {});
    res.status(502).json({error});
  }
};
