// Temporary: checks which Robinhood Chain data sources a Vercel function can reach.
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
async function rpc(body) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function tryit(fn) { const t = Date.now(); try { return { ok: true, ms: Date.now() - t, v: await fn() }; } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; } }
module.exports = async (req, res) => {
  const pool = (req.query.pool || "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3");
  const span = Number(req.query.span || 5000);
  const out = {};
  out.block = await tryit(async () => parseInt((await rpc({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })).result, 16));
  const n = out.block.v;
  if (n) {
    out.times = await tryit(async () => {
      const r = await rpc([n, n - 100000].map((b, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] })));
      return r.map(x => x.result && parseInt(x.result.timestamp, 16));
    });
    out.logs = await tryit(async () => {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: pool, topics: [V3_SWAP], fromBlock: "0x" + (n - span).toString(16), toBlock: "0x" + n.toString(16) }] });
      if (r.error) return r.error;
      const logs = r.result;
      const hs = [...new Set(logs.slice(-8).map(l => l.transactionHash))];
      const tx = await rpc(hs.map((h, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getTransactionByHash", params: [h] })));
      return { count: logs.length, sample: logs.slice(-2), txs: tx.map(t => t.result && { from: t.result.from, to: t.result.to }) };
    });
    out.bigLogs = await tryit(async () => {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ topics: [V3_SWAP], fromBlock: "0x" + (n - span).toString(16), toBlock: "0x" + n.toString(16) }] });
      return r.error || { count: r.result.length, pools: new Set(r.result.map(l => l.address)).size };
    });
  }
  out.blockscout = await tryit(async () => { const r = await fetch("https://robinhoodchain.blockscout.com/api/v2/stats"); return { status: r.status, body: (await r.text()).slice(0, 600) }; });
  out.bsLogs = await tryit(async () => { const r = await fetch("https://robinhoodchain.blockscout.com/api/v2/addresses/" + pool + "/logs"); const t = await r.text(); return { status: r.status, body: t.slice(0, 900) }; });
  res.setHeader("cache-control", "no-store");
  res.json(out);
};
