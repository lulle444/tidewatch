// Daily APY and TVL history for one pool, from DefiLlama, trimmed and cached at Vercel's CDN for an hour.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r4 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4;

module.exports = async function handler(req, res){
  const pool = String((req.query || {}).pool || "");
  if (!UUID.test(pool)) return res.status(400).json({error: "unknown pool"});
  try {
    const r = await fetch("https://yields.llama.fi/chart/" + pool, {headers: {accept: "application/json"}, signal: AbortSignal.timeout(15000)});
    if (!r.ok) throw new Error("DefiLlama → HTTP " + r.status);
    const j = await r.json();
    // [time in ms, total APY, base APY, reward APY, TVL]
    const points = (j.data || []).map(d => [Date.parse(d.timestamp), r4(d.apy), r4(d.apyBase), r4(d.apyReward), Math.round(d.tvlUsd || 0)])
      .filter(p => isFinite(p[0]) && p[1] != null);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({pool, points});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
