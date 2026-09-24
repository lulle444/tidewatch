// Stock tokens on Robinhood Chain with their reference and on-chain prices, cached briefly at Vercel's CDN
// so every visitor shares one upstream request a minute.
const {stockBoard} = require("../lib/stocks");

module.exports = async function handler(req, res){
  try {
    const data = await stockBoard();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({updatedAt: new Date().toISOString(), data});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
