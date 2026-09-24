// Scheduled check (GitHub Actions every 15 min, Vercel cron daily as backup): compares live APYs
// with every alert and pings Telegram when a level is crossed, announces new pools, checks
// stock-token price gaps and saves one gap snapshot an hour for the tracker's charts.
// Safe to call publicly: a lock allows one run per window and alerts only fire on a crossing.
const {send, esc} = require("../lib/telegram");
const {redis, pipeline} = require("../lib/store");
const {currentPools} = require("../lib/llama");
const A = require("../lib/alerts");
const S = require("../lib/stocks");

const REARM = 0.05;          // an alert re-arms once APY moves 5% back past its level
const NEW_POOL_MIN_TVL = 1e5;
const GAP_REARM = 0.5;       // a gap alert re-arms once the gap shrinks to half its level
const r5 = v => +(+v).toPrecision(6);

module.exports = async function handler(req, res){
  // Until the database and bot are connected there is nothing to check; say so without failing,
  // so the scheduled job doesn't report errors.
  if (!process.env.TELEGRAM_BOT_TOKEN || !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL))
    return res.status(200).json({skipped: "alerts not configured yet"});
  try {
    if (!(await redis("SET", A.K.lock, String(Date.now()), "NX", "EX", 540)))
      return res.status(200).json({skipped: "ran recently"});

    const {data, protocols} = await currentPools(A.SITE);
    const byId = new Map(data.map(p => [p.pool, p]));
    const raw = await redis("HGETALL", A.K.alerts) || [];
    const all = [];
    for (let i = 1; i < raw.length; i += 2) all.push(JSON.parse(raw[i]));
    const writes = [], sends = [];
    let fired = 0;

    for (const a of all.filter(x => x.kind !== "gap")){
      const p = byId.get(a.pool);
      if (!p) continue;
      const apy = A.apyOf(p), hit = a.dir === "above" ? apy >= a.thr : apy <= a.thr;
      if (hit && a.armed){
        a.armed = false; a.lastFired = Date.now(); fired++;
        const arrow = a.dir === "above" ? "📈" : "📉";
        sends.push([a.chat, `${arrow} <b>${esc(p.symbol)} · ${esc(A.nameOf(p, protocols))}</b> is now <b>${A.pct(apy)}</b> APY, ${a.dir} your ${A.pct(a.thr)} level.\n` +
          `30-day avg ${A.pct(p.apyMean30d)} · TVL ${A.usd(p.tvlUsd)}\n\n${A.SITE}/yields`]);
        writes.push(["HSET", A.K.alerts, a.id, JSON.stringify(a)]);
      } else if (!hit && !a.armed){
        const back = a.dir === "above" ? apy < a.thr * (1 - REARM) : apy > a.thr * (1 + REARM);
        if (back){ a.armed = true; writes.push(["HSET", A.K.alerts, a.id, JSON.stringify(a)]); }
      }
    }

    // New pools: the first run only records what exists, so nobody gets a flood of "new" pools.
    const knownCount = await redis("SCARD", A.K.known);
    const known = new Set(knownCount ? await redis("SMEMBERS", A.K.known) : []);
    const fresh = data.filter(p => !known.has(p.pool));
    if (fresh.length) writes.push(["SADD", A.K.known, ...fresh.map(p => p.pool)]);
    const announce = knownCount ? fresh.filter(p => p.tvlUsd >= NEW_POOL_MIN_TVL && A.apyOf(p) > 0) : [];
    if (announce.length){
      const subs = await redis("SMEMBERS", A.K.newpools) || [];
      const lines = announce.slice(0, 8).map(p => `• <b>${esc(p.symbol)}</b> on ${esc(A.nameOf(p, protocols))}: ${A.pct(A.apyOf(p))} APY, ${A.usd(p.tvlUsd)} TVL`);
      const more = announce.length > 8 ? `\n…and ${announce.length - 8} more.` : "";
      subs.forEach(c => sends.push([c, `🆕 New on Robinhood Chain\n${lines.join("\n")}${more}\n\n${A.SITE}/yields`]));
    }

    // Stock tokens: price-gap alerts, and one snapshot an hour while the US market is open.
    const gapAlerts = all.filter(x => x.kind === "gap");
    const open = S.marketOpen(), hour = new Date().toISOString().slice(0, 13);
    const record = open && await redis("SET", A.K.hour(hour), "1", "NX", "EX", 7200);
    let recorded = 0;
    let stocks = [];
    if (open && (gapAlerts.length || record)){
      try { stocks = await S.currentStocks(A.SITE); }
      catch (e){   // pool alerts still go out, and the next run retries this hour's snapshot
        console.error("stocks:", e.message);
        if (record) writes.push(["DEL", A.K.hour(hour)]);
      }
    }
    if (stocks.length){
      const now = Date.now();
      const bySym = new Map(stocks.map(x => [x.symbol, x]));
      for (const a of gapAlerts){
        const st = bySym.get(a.symbol);
        if (!st || !S.usable(st, now)) continue;
        const g = Math.abs(st.gap * 100), hit = g >= a.thr;
        if (hit && a.armed){
          a.armed = false; a.lastFired = now; fired++;
          const side = st.gap > 0 ? "above" : "below";
          sends.push([a.chat, `⚖️ <b>${esc(st.symbol)} · ${esc(st.name)}</b> is trading <b>${g.toFixed(2)}% ${side}</b> its share price on Robinhood Chain (your level: ±${A.pct(a.thr)}).\n` +
            `On chain $${st.onchain.toFixed(2)} vs share $${st.ref.toFixed(2)} · pool depth ${A.usd(st.liquidity)}\n\n${A.SITE}/stocks?s=${encodeURIComponent(st.symbol)}`]);
          writes.push(["HSET", A.K.alerts, a.id, JSON.stringify(a)]);
        } else if (!hit && !a.armed && g < a.thr * GAP_REARM){
          a.armed = true; writes.push(["HSET", A.K.alerts, a.id, JSON.stringify(a)]);
        }
      }
      if (record){
        const minute = Math.round(now / 60000), trim = hour.endsWith("T00");
        for (const st of stocks){
          if (!S.usable(st, now)) continue;
          writes.push(["RPUSH", A.K.gaps(st.symbol), `${minute},${r5(st.gap)},${r5(st.ref)},${r5(st.onchain)}`]);
          if (trim) writes.push(["LTRIM", A.K.gaps(st.symbol), -A.HISTORY_POINTS, -1]);
          recorded++;
        }
      }
    }

    await pipeline(writes);
    const results = await Promise.allSettled(sends.map(([c, t]) => send(c, t)));
    const failed = results.filter(r => r.status === "rejected");
    failed.forEach(r => console.error("send failed:", r.reason && r.reason.message));
    res.status(200).json({pools: data.length, alerts: all.length, gapAlerts: gapAlerts.length, recorded, fired, newPools: announce.length, sent: sends.length - failed.length, failed: failed.length});
  } catch (e) {
    console.error("check-alerts:", e);
    res.status(500).json({error: String(e.message || e)});
  }
};
