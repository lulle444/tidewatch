// Indexes new stock-token trades for the leaderboard. Called hourly by the GitHub Actions workflow;
// a lock keeps overlapping calls from running twice.
const lb = require("../lib/leaderboard");

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  try {
    res.status(200).json(await lb.run({budgetMs: 220e3}));
  } catch (e) {
    res.status(502).json({error: String(e.message || e)});
  }
};
