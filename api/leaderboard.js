// The published stock-token trader leaderboard (24h and 7 days), built by /api/lb-index,
// plus the live strip of the latest big trades (?live=1).
const {redis} = require("../lib/store");
const lb = require("../lib/leaderboard");

module.exports = async function handler(req, res){
  // ?live=1: the latest big trades straight from the chain, for the page's live strip
  if ((req.query || {}).live) {
    try {
      const out = await lb.liveTrades();
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
      return res.status(200).json(out);
    } catch (e) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(502).json({error: String(e.message || e)});
    }
  }
  try {
    const [raw, run] = await Promise.all([redis("GET", lb.K.top), redis("GET", lb.K.run)]);
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
    res.status(200).json({...(raw ? JSON.parse(raw) : {updatedAt: null, windows: {}}), lastRun: run ? JSON.parse(run) : null});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
