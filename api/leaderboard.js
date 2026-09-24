// The published stock-token trader leaderboard (24h and 7 days), built by /api/lb-index.
const {redis} = require("../lib/store");
const lb = require("../lib/leaderboard");

module.exports = async function handler(req, res){
  try {
    const [raw, run] = await Promise.all([redis("GET", lb.K.top), redis("GET", lb.K.run)]);
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
    res.status(200).json({...(raw ? JSON.parse(raw) : {updatedAt: null, windows: {}}), lastRun: run ? JSON.parse(run) : null});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
