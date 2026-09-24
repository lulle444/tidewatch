// Robinhood Chain stock tokens: Robinhood's own reference price next to what the token trades for on chain.
// Reference: Robinhood's public stock-token API (live bid/ask, already adjusted by the token's multiplier).
// On chain: DexScreener, which indexes the Uniswap and other DEX pools on Robinhood Chain.
const RH = "https://api.robinhood.com/rhj";
const DEX = "https://api.dexscreener.com/tokens/v1/robinhood/";
const CHAIN_ID = 4663;
const BATCH = 30;   // DexScreener's limit on addresses per request

async function getJson(url){
  const r = await fetch(url, {headers: {accept: "application/json", "user-agent": "tidewatch/1.0 (+https://tidewatch-olive.vercel.app)"},
    signal: AbortSignal.timeout(15000)});
  if (!r.ok) throw new Error(`${url.split("?")[0]} → HTTP ${r.status}`);
  return r.json();
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const addrOf = x => ((x.deployments || []).find(d => d.chainId === CHAIN_ID) || {}).contractAddress;

async function dexPairs(addrs){
  const chunks = [];
  for (let i = 0; i < addrs.length; i += BATCH) chunks.push(addrs.slice(i, i + BATCH));
  const lists = await Promise.all(chunks.map(c => getJson(DEX + c.join(",")).catch(() => [])));
  return lists.flat().filter(p => p && p.baseToken && p.priceUsd);
}

async function stockBoard(){
  const [assets, prices] = await Promise.all([getJson(RH + "/assets"), getJson(RH + "/prices")]);
  const quotes = new Map();
  for (const q of prices.quotes || []){ const a = addrOf(q); if (a) quotes.set(a.toLowerCase(), q); }

  const list = (assets.assets || []).filter(a => a.status === "ASSET_STATUS_ACTIVE" && addrOf(a));
  const pairs = await dexPairs(list.map(addrOf));
  const byToken = new Map();
  for (const p of pairs){
    const k = String(p.baseToken.address).toLowerCase();   // only pools where the stock is the priced side
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(p);
  }

  const data = list.map(a => {
    const address = addrOf(a), q = quotes.get(address.toLowerCase()) || {};
    const mult = num(a.currentMultiplier) || 1;
    const bid = num(q.tokenBid) ?? (num(q.bid) != null ? num(q.bid) * mult : null);
    const ask = num(q.tokenAsk) ?? (num(q.ask) != null ? num(q.ask) * mult : null);
    const ref = bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const ps = (byToken.get(address.toLowerCase()) || []).sort((x, y) => ((y.liquidity || {}).usd || 0) - ((x.liquidity || {}).usd || 0));
    const top = ps[0];
    const onchain = top ? num(top.priceUsd) : null;
    return {
      symbol: a.tokenSymbol,
      name: String(a.tokenName || a.tokenSymbol).split("•")[0].trim(),
      address, logo: a.logoUrl || null, multiplier: mult,
      ref, bid, ask, refAt: q.generatedAt || null, halted: !!q.isTradingHalt,
      onchain, gap: ref && onchain ? onchain / ref - 1 : null,
      liquidity: top ? num((top.liquidity || {}).usd) : null,
      volume24h: ps.length ? ps.reduce((s, p) => s + (num((p.volume || {}).h24) || 0), 0) : null,
      tokenized: top ? num(top.marketCap ?? top.fdv) : null,
      mintBurn24h: num(q.mintBurnUsdVolume),
      pool: top ? {dex: top.dexId, quote: (top.quoteToken || {}).symbol, url: top.url} : null,
    };
  });
  if (!data.length) throw new Error("no stock tokens");
  return data;
}

module.exports = {stockBoard};
