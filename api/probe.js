// Temporary: measures stock-token swap activity on Robinhood Chain.
const { currentStocks } = require("../lib/stocks");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const T = {
  v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  v4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  v2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  init: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
};
let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ": " + JSON.stringify(j.error)); return j.result;
}
let SIZE = 100;
async function batch(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += SIZE) {
    const part = calls.slice(i, i + SIZE).map((c, k) => ({ jsonrpc: "2.0", id: k, method: c[0], params: c[1] }));
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(part) });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("batch " + part.length + ": " + JSON.stringify(j).slice(0, 300));
    j.sort((a, b) => a.id - b.id); out.push(...j.map(x => x.result));
  }
  return out;
}
const hex = n => "0x" + n.toString(16);
const addrOf = w => "0x" + w.slice(-40);
module.exports = async (req, res) => {
  const t0 = Date.now(), out = {};
  try {
    SIZE = Number(req.query.b || 100);
    const span = Math.min(Number(req.query.span || 3000), 20000);
    const stocks = await currentStocks("https://tidewatch-olive.vercel.app");
    const stockSet = new Set(stocks.map(s => s.address.toLowerCase()));
    const n = parseInt(await rpc("eth_blockNumber", []), 16);
    const range = { fromBlock: hex(n - span), toBlock: hex(n) };
    const [v3, v4, v2] = await Promise.all([T.v3, T.v4, T.v2].map(t => rpc("eth_getLogs", [{ ...range, topics: [t] }])));
    out.counts = { v3: v3.length, v4: v4.length, v2: v2.length, v4managers: [...new Set(v4.map(l => l.address))] };
    const pools = [...new Set(v3.map(l => l.address))];
    const toks = await batch(pools.flatMap(p => [["eth_call", [{ to: p, data: "0x0dfe1681" }, "latest"]], ["eth_call", [{ to: p, data: "0xd21220a7" }, "latest"]]]));
    const stockPools = new Set();
    pools.forEach((p, i) => { const a = toks[2 * i] && addrOf(toks[2 * i]), b = toks[2 * i + 1] && addrOf(toks[2 * i + 1]); if (stockSet.has(a) || stockSet.has(b)) stockPools.add(p); });
    out.v3pools = { active: pools.length, stock: stockPools.size };
    // v4 pool ids -> currencies via Initialize logs
    const ids = [...new Set(v4.map(l => l.topics[1]))];
    out.v4ids = ids.length;
    let v4stock = new Set();
    try {
      const mgr = v4[0] && v4[0].address;
      const inits = await rpc("eth_getLogs", [{ address: mgr, fromBlock: "0x0", toBlock: hex(n), topics: [T.init, ids.slice(0, 50)] }]);
      inits.forEach(l => { if (stockSet.has(addrOf(l.topics[2])) || stockSet.has(addrOf(l.topics[3]))) v4stock.add(l.topics[1]); });
      out.v4init = { found: inits.length, stock: v4stock.size };
    } catch (e) { out.v4init = String(e).slice(0, 300); }
    const swaps = v3.filter(l => stockPools.has(l.address)).concat(v4.filter(l => v4stock.has(l.topics[1])));
    const hashes = [...new Set(swaps.map(l => l.transactionHash))];
    out.stockSwaps = { swaps: swaps.length, txs: hashes.length };
    const txs = await batch(hashes.slice(0, 1500).map(h => ["eth_getTransactionByHash", [h]]));
    const byTo = {};
    txs.forEach(t => { if (!t) return; const k = t.to; (byTo[k] = byTo[k] || { n: 0, from: new Set() }).n++; byTo[k].from.add(t.from); });
    out.targets = Object.entries(byTo).map(([to, v]) => ({ to, txs: v.n, senders: v.from.size })).sort((a, b) => b.txs - a.txs).slice(0, 25);
    out.distinctSenders = new Set(txs.filter(Boolean).map(t => t.from)).size;
    out.minutes = null;
    const bt = await batch([["eth_getBlockByNumber", [hex(n - span), false]], ["eth_getBlockByNumber", [hex(n), false]]]);
    out.minutes = (parseInt(bt[1].timestamp, 16) - parseInt(bt[0].timestamp, 16)) / 60;
  } catch (e) { out.error = String(e).slice(0, 500); }
  out.ms = Date.now() - t0;
  res.setHeader("cache-control", "no-store");
  res.json(out);
};
