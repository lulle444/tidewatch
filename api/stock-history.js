// Hourly price-gap history for one stock token (saved by the scheduled check), for the tracker's chart.
const {redis} = require("../lib/store");
const A = require("../lib/alerts");

const SYM = /^[A-Z0-9.]{1,12}$/;

module.exports = async function handler(req, res){
  const symbol = String((req.query || {}).symbol || "").toUpperCase();
  if (!SYM.test(symbol)) return res.status(400).json({error: "unknown symbol"});
  try {
    const raw = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
      ? await redis("LRANGE", A.K.gaps(symbol), -A.HISTORY_POINTS, -1) || [] : [];
    // [time in ms, gap as a fraction, share price, on-chain price]
    const points = raw.map(r => r.split(",").map(Number)).filter(p => p.length === 4 && p.every(isFinite)).map(([m, g, ref, on]) => [m * 60000, g, ref, on]);
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({symbol, points});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
