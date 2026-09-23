// Robinhood Chain pools from DefiLlama, fetched and filtered once on the server and cached at
// Vercel's CDN, so visitors download a few KB instead of DefiLlama's full multi-chain list.
const {chainPools} = require("../lib/llama");

module.exports = async function handler(req, res){
  try {
    const {data, protocols} = await chainPools();
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({updatedAt: new Date().toISOString(), data, protocols});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
