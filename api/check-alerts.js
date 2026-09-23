// Scheduled check (GitHub Actions every 15 min, Vercel cron daily as backup): compares live APYs
// with every alert and pings Telegram when a level is crossed, and announces new pools.
// Safe to call publicly: a lock allows one run per window and alerts only fire on a crossing.
const {send, esc} = require("../lib/telegram");
const {redis, pipeline} = require("../lib/store");
const {currentPools} = require("../lib/llama");
const A = require("../lib/alerts");

const REARM = 0.05;          // an alert re-arms once APY moves 5% back past its level
const NEW_POOL_MIN_TVL = 1e5;

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
    const writes = [], sends = [];
    let fired = 0;

    for (let i = 1; i < raw.length; i += 2){
      const a = JSON.parse(raw[i]), p = byId.get(a.pool);
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

    await pipeline(writes);
    const results = await Promise.allSettled(sends.map(([c, t]) => send(c, t)));
    const failed = results.filter(r => r.status === "rejected");
    failed.forEach(r => console.error("send failed:", r.reason && r.reason.message));
    res.status(200).json({pools: data.length, alerts: raw.length / 2, fired, newPools: announce.length, sent: sends.length - failed.length, failed: failed.length});
  } catch (e) {
    console.error("check-alerts:", e);
    res.status(500).json({error: String(e.message || e)});
  }
};
