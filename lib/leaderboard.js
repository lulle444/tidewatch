// Stock-token trader leaderboard: reads Uniswap v3/v4 swaps in stock-token pools straight from Robinhood Chain,
// works out which wallet traded from the token transfers in the same transaction, and keeps rolling
// 24h / 7d totals per wallet in Redis. Runs hourly; each run indexes whole hour-sized block chunks.
const zlib = require("zlib");
const {redis, pipeline} = require("./store");
const {rpc, batch, logs, hex, addrOf, word, int256, uint} = require("./chain");
const {currentStocks} = require("./stocks");

const SITE = "https://tidewatch-olive.vercel.app";
const T = {
  v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  v4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  init: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};
const V4_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const ZERO = "0x0000000000000000000000000000000000000000";
const CHUNK = 36000;                   // blocks per chunk, about an hour (blocks are ~0.1s apart)
const HOUR = 3600e3, DAY = 24 * HOUR;
const WINDOWS = {"24h": DAY, "7d": 7 * DAY};
const MIN_VOLUME = 250;                // wallets below this volume in a window are left off the board
const BOT_PER_HOUR = 4;                // more trades than this per covered hour marks a wallet as a bot
const K = {
  pools: "tw:lb:pools",                // hash: v3 pool address or v4 pool id -> JSON meta, or "-" when not a stock pool
  toks: "tw:lb:toks",                  // hash: token address -> JSON {sym, dec}
  state: "tw:lb:state",                // JSON {lo, hi}: the range of chunks already indexed
  chunk: i => `tw:lb:c:${i}`,          // gzipped per-wallet totals for one chunk
  agg: w => `tw:lb:a:${w}`,            // gzipped rolling totals for one window
  top: "tw:lb:top",                    // the published leaderboard
  lock: "tw:lb:lock",
  run: "tw:lb:run",                    // JSON: outcome of the last indexer run
};
const STABLE = /^(USDG|USDC|USDT|USD₮0|USDT0|USDC\.E|PYUSD|DAI|USDS|USDE)$/i;
const ETHLIKE = /^(WETH|ETH)$/i;

const gz = o => zlib.gzipSync(JSON.stringify(o)).toString("base64");
const ungz = s => s ? JSON.parse(zlib.gunzipSync(Buffer.from(s, "base64")).toString()) : null;
const r2 = x => Math.round(x * 100) / 100;
const r6 = x => +x.toPrecision(7);

async function ethPrice(){
  const tries = [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", j => +j.data.amount],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", j => +j.ethereum.usd],
  ];
  for (const [url, pick] of tries) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(8000)});
      const v = pick(await r.json());
      if (v > 0) return v;
    } catch (e) {}
  }
  throw new Error("no ETH price");
}

// ABI string (or bytes32) returned by symbol().
function decodeString(h){
  if (!h || h === "0x") return "";
  const d = h.slice(2);
  if (d.length === 64) return Buffer.from(d, "hex").toString().replace(/\0+$/, "");
  const len = Number(uint(d.slice(64, 128)));
  return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString();
}

async function tokenMeta(addrs){
  const want = [...new Set(addrs)];
  const known = want.length ? await redis("HMGET", K.toks, ...want) : [];
  const out = {}, missing = [];
  want.forEach((a, i) => known[i] ? out[a] = JSON.parse(known[i]) : missing.push(a));
  const fresh = missing.filter(a => a !== ZERO);
  if (missing.includes(ZERO)) out[ZERO] = {sym: "ETH", dec: 18};
  if (fresh.length) {
    const res = await batch(fresh.flatMap(a => [["eth_call", [{to: a, data: "0x95d89b41"}, "latest"]], ["eth_call", [{to: a, data: "0x313ce567"}, "latest"]]]));
    const save = [];
    fresh.forEach((a, i) => {
      let sym = ""; try { sym = decodeString(res[2 * i]); } catch (e) {}
      const dec = res[2 * i + 1] ? Number(uint(res[2 * i + 1].slice(2) || "0")) : 18;
      out[a] = {sym, dec};
      save.push(a, JSON.stringify(out[a]));
    });
    await redis("HSET", K.toks, ...save);
  }
  if (missing.includes(ZERO)) await redis("HSET", K.toks, ZERO, JSON.stringify(out[ZERO]));
  return out;
}

// Finds pools active in the last few minutes that we haven't classified yet and records whether each one
// pairs a stock token with a dollar or ETH quote.
async function discover(latest, stockAddrs){
  const from = latest - 3000;
  const [v3, v4] = await Promise.all([
    logs({topics: [T.v3]}, from, latest),
    logs({address: V4_MANAGER, topics: [T.v4]}, from, latest),
  ]);
  const v3pools = [...new Set(v3.map(l => l.address.toLowerCase()))];
  const v4ids = [...new Set(v4.map(l => l.topics[1]))];
  const keys = v3pools.concat(v4ids);
  if (!keys.length) return 0;
  const known = await redis("HMGET", K.pools, ...keys);
  const newV3 = v3pools.filter((k, i) => !known[i]);
  const newV4 = v4ids.filter((k, i) => !known[v3pools.length + i]);
  const pairs = {};
  if (newV3.length) {
    const res = await batch(newV3.flatMap(p => [["eth_call", [{to: p, data: "0x0dfe1681"}, "latest"]], ["eth_call", [{to: p, data: "0xd21220a7"}, "latest"]]]));
    newV3.forEach((p, i) => { if (res[2 * i] && res[2 * i + 1]) pairs[p] = [addrOf(res[2 * i]), addrOf(res[2 * i + 1])]; else pairs[p] = null; });
  }
  for (let i = 0; i < newV4.length; i += 50) {
    const ids = newV4.slice(i, i + 50);
    const inits = await rpc("eth_getLogs", [{address: V4_MANAGER, fromBlock: "0x0", toBlock: hex(latest), topics: [T.init, ids]}]);
    ids.forEach(id => pairs[id] = null);
    inits.forEach(l => pairs[l.topics[1]] = [addrOf(l.topics[2]), addrOf(l.topics[3])]);
  }
  const quoteAddrs = [];
  for (const pr of Object.values(pairs)) if (pr && stockAddrs.has(pr[0]) !== stockAddrs.has(pr[1])) quoteAddrs.push(...pr);
  const meta = await tokenMeta(quoteAddrs);
  const save = [];
  for (const [key, pr] of Object.entries(pairs)) {
    let m = "-";
    if (pr) {
      const [a, b] = pr, sa = stockAddrs.has(a), sb = stockAddrs.has(b);
      if (sa !== sb) {
        const s = sa ? a : b, q = sa ? b : a, qs = (meta[q] || {}).sym || "";
        const k = STABLE.test(qs) ? "usd" : ETHLIKE.test(qs) ? "eth" : "";
        if (k) m = JSON.stringify({v: key.length === 66 ? 4 : 3, s, q, k, sd: meta[s].dec, qd: meta[q].dec, s0: sa});
      }
    }
    save.push(key, m);
  }
  if (save.length) await redis("HSET", K.pools, ...save);
  return save.length / 2;
}

async function loadPools(){
  const all = await redis("HGETALL", K.pools) || [];
  const pools = {};
  for (let i = 0; i < all.length; i += 2) if (all[i + 1] !== "-") pools[all[i]] = JSON.parse(all[i + 1]);
  return pools;
}

// Reads the stock-token trades in a block range: [{hash, block, wallet, sym, side (1 buy, -1 sell), qty, usd}].
async function readTrades(from, to, pools, symOf, eth){
  const v3 = Object.keys(pools).filter(k => pools[k].v === 3);
  const v4 = Object.keys(pools).filter(k => pools[k].v === 4);
  const tokens = [...new Set(Object.values(pools).map(m => m.s))];
  const [s3, s4] = await Promise.all([
    v3.length ? logs({address: v3, topics: [T.v3]}, from, to) : [],
    v4.length ? logs({address: V4_MANAGER, topics: [T.v4, v4]}, from, to) : [],
  ]);
  // per tx and stock token: traded size and dollar value summed over its swaps
  const txs = new Map();
  for (const l of s3.concat(s4)) {
    const m = pools[l.address.toLowerCase() === V4_MANAGER ? l.topics[1] : l.address.toLowerCase()];
    if (!m) continue;
    const a0 = int256(word(l.data, 0)), a1 = int256(word(l.data, 1));
    const sAmt = m.s0 ? a0 : a1, qAmt = m.s0 ? a1 : a0;
    const qty = Math.abs(Number(sAmt)) / 10 ** m.sd;
    const usd = Math.abs(Number(qAmt)) / 10 ** m.qd * (m.k === "eth" ? eth : 1);
    if (!(qty > 0) || !(usd > 0)) continue;
    const t = txs.get(l.transactionHash) || new Map();
    const e = t.get(m.s) || {qty: 0, usd: 0, n: 0, block: parseInt(l.blockNumber, 16)};
    e.qty += qty; e.usd += usd; e.n++;
    t.set(m.s, e); txs.set(l.transactionHash, t);
  }
  if (!txs.size) return [];
  const poolAddrs = new Set(v3.concat([V4_MANAGER, ZERO]));
  const moves = await logs({address: tokens, topics: [T.transfer]}, from, to);
  const nets = new Map(); // tx -> token -> address -> raw net
  for (const l of moves) {
    if (!txs.has(l.transactionHash) || l.topics.length < 3) continue;
    const tok = l.address.toLowerCase(), v = uint(l.data.slice(2));
    const byTok = nets.get(l.transactionHash) || new Map();
    const net = byTok.get(tok) || new Map();
    const f = addrOf(l.topics[1]), to_ = addrOf(l.topics[2]);
    net.set(f, (net.get(f) || 0n) - v);
    net.set(to_, (net.get(to_) || 0n) + v);
    byTok.set(tok, net); nets.set(l.transactionHash, byTok);
  }
  const decOf = {};
  for (const m of Object.values(pools)) decOf[m.s] = m.sd;
  const out = [];
  for (const [hash, t] of txs) {
    for (const [tok, e] of t) {
      const net = nets.get(hash) && nets.get(hash).get(tok);
      if (!net) continue;
      let who = null, best = 0n;
      for (const [a, v] of net) {
        if (poolAddrs.has(a)) continue;
        const abs = v < 0n ? -v : v;
        if (abs > best) { best = abs; who = a; }
      }
      if (!who) continue;
      const got = Number(net.get(who)) / 10 ** decOf[tok];
      // arbitrage and routing leave little or no net position behind, so they drop out here
      if (Math.abs(got) < 0.5 * e.qty || Math.abs(got) > 1.5 * e.qty) continue;
      const sym = symOf[tok];
      if (!sym) continue;
      out.push({hash, block: e.block, wallet: who, sym, side: got > 0 ? 1 : -1, qty: e.qty, usd: e.usd});
    }
  }
  return out;
}

// Indexes one chunk of blocks and returns {wallet: {SYM: [qty, cash, volume, trades]}}.
// qty is the tokens the wallet gained (negative when it sold); cash is the dollars it received (negative when it paid).
async function indexChunk(from, to, pools, symOf, eth){
  const out = {};
  for (const t of await readTrades(from, to, pools, symOf, eth)) {
    const w = out[t.wallet] || (out[t.wallet] = {});
    const row = w[t.sym] || (w[t.sym] = [0, 0, 0, 0]);
    row[0] = r6(row[0] + t.side * t.qty);
    row[1] = r2(row[1] - t.side * t.usd);
    row[2] = r2(row[2] + t.usd);
    row[3] += 1;
  }
  return out;
}

// The latest trades straight from the chain (about the last five minutes), largest first, for the live strip.
// Bots flagged on the published board are left out.
const LIVE_BLOCKS = 3000, LIVE_MIN_USD = 1000;
async function liveTrades(){
  const [latestHex, stocks, eth, pools, topRaw] = await Promise.all([
    rpc("eth_blockNumber", []), currentStocks(SITE), ethPrice(), loadPools(), redis("GET", K.top),
  ]);
  const latest = parseInt(latestHex, 16);
  const symOf = {};
  for (const s of stocks) symOf[s.address.toLowerCase()] = s.symbol;
  const bots = new Set();
  const top = topRaw ? JSON.parse(topRaw) : null;
  if (top) for (const w of Object.values(top.windows)) for (const r of w.rows) if (r.bot) bots.add(r.a);
  const [blk] = await batch([["eth_getBlockByNumber", [hex(latest), false]]]);
  const now = parseInt(blk.timestamp, 16) * 1000;
  const trades = (await readTrades(latest - LIVE_BLOCKS, latest, pools, symOf, eth))
    .filter(t => t.usd >= LIVE_MIN_USD && !bots.has(t.wallet))
    .sort((a, b) => b.usd - a.usd).slice(0, 12)
    .map(t => ({at: new Date(now - (latest - t.block) * 100).toISOString(), wallet: t.wallet, sym: t.sym, side: t.side > 0 ? "buy" : "sell", qty: r6(t.qty), usd: r2(t.usd), tx: t.hash}));
  return {updatedAt: new Date(now).toISOString(), minutes: Math.round(LIVE_BLOCKS * 0.1 / 60), trades};
}

function merge(agg, bucket, sign){
  for (const [w, syms] of Object.entries(bucket)) {
    const a = agg[w] || (agg[w] = {});
    for (const [sym, v] of Object.entries(syms)) {
      const row = a[sym] || (a[sym] = [0, 0, 0, 0]);
      for (let i = 0; i < 4; i++) row[i] = i === 0 ? r6(row[i] + sign * v[i]) : r2(row[i] + sign * v[i]);
      if (row[3] <= 0) delete a[sym];
    }
    if (!Object.keys(a).length) delete agg[w];
  }
}

// Ranks wallets in one window, marking open positions to today's on-chain price.
function rank(agg, prices, hours){
  const rows = [];
  let volume = 0, trades = 0, wallets = 0;
  for (const [w, syms] of Object.entries(agg.w)) {
    let pnl = 0, vol = 0, n = 0;
    const parts = [];
    for (const [sym, [qty, cash, v, k]] of Object.entries(syms)) {
      const p = prices[sym];
      const sp = p ? cash + qty * p : null;
      if (sp != null) pnl += sp;
      vol += v; n += k;
      parts.push([sym, qty, cash, sp == null ? null : r2(sp), v, k]);
    }
    volume += vol; trades += n; wallets++;
    if (vol < MIN_VOLUME) continue;
    parts.sort((a, b) => Math.abs(b[3] || 0) - Math.abs(a[3] || 0));
    rows.push({a: w, pnl: r2(pnl), vol: r2(vol), n, bot: n > BOT_PER_HOUR * Math.max(1, hours), syms: parts.slice(0, 8)});
  }
  const pick = new Map();
  const add = list => list.forEach(r => pick.set(r.a, r));
  const humans = rows.filter(r => !r.bot), bots = rows.filter(r => r.bot);
  add([...humans].sort((a, b) => b.pnl - a.pnl).slice(0, 150));
  add([...humans].sort((a, b) => a.pnl - b.pnl).slice(0, 25));
  add([...humans].sort((a, b) => b.vol - a.vol).slice(0, 50));
  add([...bots].sort((a, b) => b.pnl - a.pnl).slice(0, 25));
  add([...bots].sort((a, b) => b.vol - a.vol).slice(0, 25));
  return {wallets, ranked: rows.length, volume: r2(volume), trades, rows: [...pick.values()]};
}

async function run({budgetMs = 200e3} = {}){
  const started = Date.now();
  if (!await redis("SET", K.lock, "1", "NX", "EX", 290)) return {skipped: "already running"};
  try {
    const latest = parseInt(await rpc("eth_blockNumber", []), 16);
    const lastDone = Math.floor((latest + 1) / CHUNK) - 1;
    // nothing to do until the next hour-sized chunk completes, so frequent calls stay cheap
    const peek = JSON.parse(await redis("GET", K.state) || "null");
    if (peek && peek.full && peek.hi >= lastDone) return {skipped: "up to date", state: peek, nextChunkInBlocks: (lastDone + 2) * CHUNK - 1 - latest};
    const stocks = await currentStocks(SITE);
    const symOf = {}, prices = {};
    for (const s of stocks) {
      symOf[s.address.toLowerCase()] = s.symbol;
      const p = s.onchain || s.ref;
      if (p > 0) prices[s.symbol] = p;
    }
    const eth = await ethPrice();
    const found = await discover(latest, new Set(Object.keys(symOf)));
    const pools = await loadPools();

    const [stateRaw, ...aggRaw] = await pipeline([["GET", K.state], ...Object.keys(WINDOWS).map(w => ["GET", K.agg(w)])]);
    let state = stateRaw ? JSON.parse(stateRaw) : null;
    const aggs = {};
    Object.keys(WINDOWS).forEach((w, i) => aggs[w] = ungz(aggRaw[i]) || {chunks: {}, w: {}});

    const now = Date.now();
    const todo = [];
    if (!state) todo.push(lastDone);
    else for (let i = state.hi + 1; i <= lastDone; i++) todo.push(i);
    const done = [];
    const add = async (idx) => {
      const from = idx * CHUNK, to = from + CHUNK - 1;
      const [blk] = await batch([["eth_getBlockByNumber", [hex(to), false]]]);
      const ts = parseInt(blk.timestamp, 16) * 1000;
      const bucket = await indexChunk(from, to, pools, symOf, eth);
      await redis("SET", K.chunk(idx), gz(bucket), "EX", 9 * 86400);
      for (const [w, span] of Object.entries(WINDOWS)) {
        if (ts >= now - span && !aggs[w].chunks[idx]) { merge(aggs[w].w, bucket, 1); aggs[w].chunks[idx] = ts; }
      }
      state = state ? {...state, lo: Math.min(state.lo, idx), hi: Math.max(state.hi, idx)} : {lo: idx, hi: idx};
      done.push(idx);
      return ts;
    };
    // a chunk that fails stops this run, but everything indexed before it is still saved below
    let failed = null;
    try {
      for (const idx of todo) {
        if (Date.now() - started > budgetMs) break;
        await add(idx);
      }
      // fill in older history while there is time left, back to the longest window
      const oldest = now - Math.max(...Object.values(WINDOWS));
      while (state && !state.full && Date.now() - started < budgetMs && state.lo > 0 && state.hi >= lastDone) {
        if (await add(state.lo - 1) < oldest) state.full = true;
      }
    } catch (e) {
      failed = String(e.message || e).slice(0, 400);
    }
    // drop chunks that have aged out of each window
    for (const [w, span] of Object.entries(WINDOWS)) {
      for (const [idx, ts] of Object.entries(aggs[w].chunks)) {
        if (ts >= now - span) continue;
        const bucket = ungz(await redis("GET", K.chunk(idx)));
        if (bucket) merge(aggs[w].w, bucket, -1);
        delete aggs[w].chunks[idx];
      }
    }
    const top = {updatedAt: new Date().toISOString(), windows: {}};
    for (const [w, span] of Object.entries(WINDOWS)) {
      const ts = Object.values(aggs[w].chunks);
      const hours = ts.length;
      top.windows[w] = {hours, since: ts.length ? new Date(Math.min(...ts) - HOUR).toISOString() : null, full: hours >= span / HOUR - 1, ...rank(aggs[w], prices, hours)};
    }
    await pipeline([
      ["SET", K.state, JSON.stringify(state)],
      ...Object.keys(WINDOWS).map(w => ["SET", K.agg(w), gz(aggs[w])]),
      ["SET", K.top, JSON.stringify(top)],
    ]);
    return {latest, indexed: done, state, error: failed, newPools: found, stockPools: Object.keys(pools).length, eth, ms: Date.now() - started,
      windows: Object.fromEntries(Object.entries(top.windows).map(([w, v]) => [w, {hours: v.hours, wallets: v.wallets, ranked: v.ranked, volume: v.volume, trades: v.trades}]))};
  } finally {
    await redis("DEL", K.lock).catch(() => {});
  }
}

module.exports = {run, indexChunk, readTrades, liveTrades, merge, rank, discover, decodeString, K, CHUNK, WINDOWS};
