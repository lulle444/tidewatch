// DefiLlama access shared by the API routes: Robinhood Chain pools plus the protocol fields we use.
const CHAIN = "Robinhood Chain";
const PROTOCOL_FIELDS = ["slug", "name", "category", "url", "audit_links", "listedAt"];

async function getJson(url){
  const r = await fetch(url, {headers: {accept: "application/json"}, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function chainPools(){
  const [pools, protocols] = await Promise.all([
    getJson("https://yields.llama.fi/pools"),
    getJson("https://api.llama.fi/protocols").catch(() => []),
  ]);
  const data = (pools.data || []).filter(p => p.chain === CHAIN);
  if (!data.length) throw new Error("no pools for chain");
  const slugs = new Set(data.map(p => p.project));
  const protos = (Array.isArray(protocols) ? protocols : [])
    .filter(p => slugs.has(p.slug))
    .map(p => Object.fromEntries(PROTOCOL_FIELDS.map(k => [k, p[k]])));
  return {data, protocols: protos};
}

module.exports = {chainPools};

// For the bot and the scheduled check: our CDN-cached endpoint first, DefiLlama directly as backup.
async function currentPools(site){
  try {
    const j = await getJson(site.replace(/\/$/, "") + "/api/pools");
    if (j && j.data && j.data.length) return {data: j.data, protocols: j.protocols || []};
  } catch (e) {}
  return chainPools();
}

module.exports.currentPools = currentPools;
