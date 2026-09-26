// Minimal JSON-RPC client for Robinhood Chain. Set RPC_URL (e.g. an Alchemy URL) to use a keyed endpoint
// instead of the public one, which rate-limits batches.
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextId = 0;

async function post(body, tries = 0){
  const r = await fetch(RPC, {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = null; }
  const limited = r.status === 429 || (j && !Array.isArray(j) && j.error && j.error.code === 429);
  if (limited || (!j && r.status >= 500)) {
    if (tries >= 6) throw new Error(`rpc ${r.status}: ${text.slice(0, 200)}`);
    await sleep(400 * 2 ** tries);
    return post(body, tries + 1);
  }
  if (!j) throw new Error(`rpc ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

async function rpc(method, params){
  const j = await post({jsonrpc: "2.0", id: ++nextId, method, params});
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// Runs calls ([method, params]) in small batches; a failed call comes back as null.
async function batch(calls, size = 20){
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const part = calls.slice(i, i + size).map((c, k) => ({jsonrpc: "2.0", id: k, method: c[0], params: c[1]}));
    const j = await post(part);
    if (!Array.isArray(j)) throw new Error("batch: " + JSON.stringify(j).slice(0, 200));
    const byId = new Map(j.map(x => [x.id, x.error ? null : x.result]));
    part.forEach(p => out.push(byId.has(p.id) ? byId.get(p.id) : null));
  }
  return out;
}

// eth_getLogs over a block range, split into smaller ranges when the node refuses a big one.
async function logs(filter, from, to, step = 4000){
  const out = [];
  for (let a = from; a <= to; a += step) {
    const b = Math.min(to, a + step - 1);
    try {
      out.push(...await rpc("eth_getLogs", [{...filter, fromBlock: hex(a), toBlock: hex(b)}]));
    } catch (e) {
      if (step <= 250 || !/range|limit|too many|exceed|size|timed? ?out/i.test(e.message)) throw e;
      out.push(...await logs(filter, a, b, Math.ceil(step / 4)));
    }
  }
  return out;
}

const hex = n => "0x" + n.toString(16);
const addrOf = w => ("0x" + String(w).slice(-40)).toLowerCase();
const word = (data, i) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const int256 = w => BigInt.asIntN(256, BigInt("0x" + w));
const uint = w => BigInt("0x" + (w || "0"));

module.exports = {rpc, batch, logs, hex, addrOf, word, int256, uint};
