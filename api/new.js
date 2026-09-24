// When each Robinhood Chain pool first appeared, for the "New on the chain" page. The date is the first
// day DefiLlama tracked the pool; it's looked up once per pool and kept in Redis, then cached at the CDN.
const {currentPools} = require("../lib/llama");
const {redis} = require("../lib/store");
const A = require("../lib/alerts");

const KEY = "tw:firstseen";     // hash: pool id -> first-seen time in ms
const BUDGET_MS = 20000, PARALLEL = 8;
const hasDb = () => !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);

async function firstPoint(id){
  const r = await fetch("https://yields.llama.fi/chart/" + id, {headers: {accept: "application/json"}, signal: AbortSignal.timeout(10000)});
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json(), t = (j.data || []).map(d => Date.parse(d.timestamp)).filter(isFinite);
  // no history yet means DefiLlama only just started tracking the pool, so it's new today
  return t.length ? Math.min(...t) : Date.now();
}

module.exports = async function handler(req, res){
  try {
    const {data} = await currentPools(A.SITE);
    const ids = data.map(p => p.pool);
    const known = hasDb() ? await redis("HMGET", KEY, ...ids) || [] : [];
    const firstSeen = {}, missing = [];
    ids.forEach((id, i) => known[i] ? firstSeen[id] = +known[i] : missing.push(id));

    // look up new pools a few at a time; anything left over is picked up by the next request
    const start = Date.now(), found = [];
    for (let i = 0; i < missing.length && Date.now() - start < BUDGET_MS; i += PARALLEL){
      const batch = missing.slice(i, i + PARALLEL);
      const ts = await Promise.all(batch.map(id => firstPoint(id).catch(() => null)));
      batch.forEach((id, k) => { if (ts[k]){ firstSeen[id] = ts[k]; found.push(id, String(ts[k])); } });
    }
    if (found.length && hasDb()) await redis("HSET", KEY, ...found);

    const complete = Object.keys(firstSeen).length === ids.length;
    res.setHeader("Cache-Control", complete ? "public, s-maxage=1800, stale-while-revalidate=86400" : "public, s-maxage=60");
    res.status(200).json({updatedAt: new Date().toISOString(), complete, firstSeen});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
