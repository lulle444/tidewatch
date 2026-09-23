// Robinhood Chain pools from DefiLlama, fetched and filtered once on the server and cached at
// Vercel's CDN, so visitors download a few KB instead of DefiLlama's full multi-chain list.
const CHAIN = "Robinhood Chain";
const PROTOCOL_FIELDS = ["slug", "name", "category", "url", "audit_links", "listedAt"];

async function getJson(url){
  const r = await fetch(url, {headers: {accept: "application/json"}, signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

module.exports = async function handler(req, res){
  try {
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
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({updatedAt: new Date().toISOString(), data, protocols: protos});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
