// Alert storage and pool formatting shared by the bot webhook and the scheduled check.
const {redis, pipeline} = require("./store");

const SITE = "https://tidewatch-olive.vercel.app";
const K = {
  alerts: "tw:alerts",                 // hash: alert id -> JSON
  chat: c => `tw:chat:${c}`,           // set of alert ids per chat
  newpools: "tw:newpools",             // set of chats that want new-pool alerts
  known: "tw:known",                   // set of pool ids already seen
  lock: "tw:lock",                     // keeps the scheduled check to one run per window
  gaps: s => `tw:g:${s}`,              // list per stock token: "minute,gap,sharePrice,onchainPrice", one entry an hour
  hour: h => `tw:hist:${h}`,           // marks an hour whose gap snapshot is already saved
  newlog: "tw:newlog",                 // sorted set: pool id scored by when we first saw it
  weekly: "tw:weekly",                 // set of chats that want the weekly recap
  weeklySent: w => `tw:weekly:sent:${w}`,
  weeklyTvl: "tw:weekly:tvl",          // total pool TVL at the last recap, for the week-on-week change
};
const HISTORY_POINTS = 24 * 30;        // keep 30 days of hourly gaps per token
const MAX_PER_CHAT = 20;

const pct = v => (v == null || !isFinite(v)) ? "–" : `${(+v).toFixed(2)}%`;
const usd = v => v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`;
const titleCase = s => String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const apyOf = p => p.apy ?? ((p.apyBase || 0) + (p.apyReward || 0));

function nameOf(p, protocols){
  const m = (protocols || []).find(x => x.slug === p.project);
  return m ? m.name : titleCase(p.project);
}

async function listAlerts(chat){
  const ids = await redis("SMEMBERS", K.chat(chat)) || [];
  if (!ids.length) return [];
  const vals = await redis("HMGET", K.alerts, ...ids) || [];
  return vals.filter(Boolean).map(v => JSON.parse(v));
}

async function addAlert(chat, pool, dir, thr){
  const existing = await listAlerts(chat);
  if (existing.length >= MAX_PER_CHAT) return {error: `You can have up to ${MAX_PER_CHAT} alerts. Remove one with /list first.`};
  const dup = existing.find(a => a.pool === pool.pool && a.dir === dir && a.thr === thr);
  if (dup) return {alert: dup, dup: true};
  const apy = apyOf(pool);
  const alert = {id: Math.random().toString(36).slice(2, 10), chat, pool: pool.pool, symbol: pool.symbol,
    project: pool.project, dir, thr, armed: dir === "above" ? apy < thr : apy > thr, created: Date.now()};
  await pipeline([["HSET", K.alerts, alert.id, JSON.stringify(alert)], ["SADD", K.chat(chat), alert.id]]);
  return {alert};
}

// Stock-token price-gap alert: fires when the on-chain price drifts thr% or more from the share price.
async function addGapAlert(chat, stock, thr){
  const existing = await listAlerts(chat);
  if (existing.length >= MAX_PER_CHAT) return {error: `You can have up to ${MAX_PER_CHAT} alerts. Remove one with /list first.`};
  const dup = existing.find(a => a.kind === "gap" && a.symbol === stock.symbol && a.thr === thr);
  if (dup) return {alert: dup, dup: true};
  const alert = {id: Math.random().toString(36).slice(2, 10), chat, kind: "gap", symbol: stock.symbol, name: stock.name,
    thr, armed: !(stock.gap != null && Math.abs(stock.gap * 100) >= thr), created: Date.now()};
  await pipeline([["HSET", K.alerts, alert.id, JSON.stringify(alert)], ["SADD", K.chat(chat), alert.id]]);
  return {alert};
}

async function removeAlert(chat, id){
  await pipeline([["HDEL", K.alerts, id], ["SREM", K.chat(chat), id]]);
}

async function removeAll(chat){
  const ids = await redis("SMEMBERS", K.chat(chat)) || [];
  const cmds = [["DEL", K.chat(chat)], ["SREM", K.newpools, String(chat)], ["SREM", K.weekly, String(chat)]];
  if (ids.length) cmds.push(["HDEL", K.alerts, ...ids]);
  await pipeline(cmds);
  return ids.length;
}

module.exports = {K, SITE, HISTORY_POINTS, pct, usd, apyOf, nameOf, listAlerts, addAlert, addGapAlert, removeAlert, removeAll};
