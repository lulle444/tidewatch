// Telegram webhook for the Tidewatch alerts bot.
const {send, tg, esc, webhookSecret} = require("../lib/telegram");
const {redis} = require("../lib/store");
const {currentPools} = require("../lib/llama");
const A = require("../lib/alerts");

const ctxKey = c => `tw:ctx:${c}`;       // the pool a chat last opened, for /above and /below
const UUID = /^[0-9a-f-]{36}$/i;
const round1 = v => Math.round(v * 10) / 10;

async function findPool(id){
  const {data, protocols} = await currentPools(A.SITE);
  const p = data.find(x => x.pool === id);
  return p ? {p, name: A.nameOf(p, protocols)} : null;
}

async function poolCard(chat, id){
  const hit = await findPool(id);
  if (!hit) return send(chat, "I couldn’t find that pool any more. Pick another one on " + A.SITE + "/yields");
  const {p, name} = hit, apy = A.apyOf(p);
  const up = round1(Math.max(apy * 1.25, apy + 0.5)), down = round1(Math.max(0, Math.min(apy * 0.75, apy - 0.5)));
  await redis("SET", ctxKey(chat), id, "EX", 86400);
  const rows = [[{text: `🔔 Above ${up}%`, callback_data: `s|a|${id}|${up}`}]];
  if (down > 0) rows[0].push({text: `🔔 Below ${down}%`, callback_data: `s|b|${id}|${down}`});
  rows.push([{text: "Open Tidewatch", url: A.SITE + "/yields"}]);
  return send(chat,
    `<b>${esc(p.symbol)} · ${esc(name)}</b>\nAPY now <b>${A.pct(apy)}</b> (30-day avg ${A.pct(p.apyMean30d)})\nTVL ${A.usd(p.tvlUsd)}\n\n` +
    `When should I ping you? Tap a level, or send <code>/above 9</code> or <code>/below 5</code> for your own.`,
    {reply_markup: {inline_keyboard: rows}});
}

async function create(chat, id, dir, thr){
  if (!(thr >= 0 && thr < 10000)) return send(chat, "That level doesn’t look right. Try something like <code>/above 8.5</code>.");
  const hit = await findPool(id);
  if (!hit) return send(chat, "That pool isn’t available any more.");
  const r = await A.addAlert(chat, hit.p, dir, thr);
  if (r.error) return send(chat, r.error);
  const word = dir === "above" ? "rises above" : "falls below";
  return send(chat, `${r.dup ? "You already have this one" : "Done"}. I’ll message you when <b>${esc(hit.p.symbol)} · ${esc(hit.name)}</b> ${word} <b>${A.pct(thr)}</b> APY (now ${A.pct(A.apyOf(hit.p))}).\n\nSee all your alerts with /list.`);
}

async function list(chat){
  const [alerts, np] = await Promise.all([A.listAlerts(chat), redis("SISMEMBER", A.K.newpools, String(chat))]);
  const lines = alerts.map((a, i) => `${i + 1}. ${esc(a.symbol)} (${esc(a.project)}) ${a.dir === "above" ? "above" : "below"} ${A.pct(a.thr)}`);
  const rows = alerts.map((a, i) => [{text: `Remove ${i + 1}`, callback_data: `d|${a.id}`}]);
  rows.push([np ? {text: "Stop new-pool alerts", callback_data: "n|off"} : {text: "🆕 Alert me about new pools", callback_data: "n|on"}]);
  return send(chat, (lines.length ? "<b>Your alerts</b>\n" + lines.join("\n") : "You have no pool alerts yet. Tap 🔔 next to any pool on " + A.SITE + "/yields") +
    `\n\nNew-pool alerts: <b>${np ? "on" : "off"}</b>`, {reply_markup: {inline_keyboard: rows}});
}

const WELCOME = `<b>Tidewatch alerts</b> for Robinhood Chain yields.\n\n` +
  `• Tap 🔔 next to a pool on ${A.SITE}/yields to get pinged when its APY crosses a level.\n` +
  `• /new to hear about new pools on the chain.\n• /list to see or remove your alerts.\n• /stop to remove everything.\n\n` +
  `Checked every 15 minutes. Not financial advice.`;

async function onMessage(m){
  const chat = m.chat.id, text = String(m.text || "").trim();
  const [cmd, ...args] = text.split(/\s+/); const c = cmd.toLowerCase().replace(/@\w+$/, "");
  if (c === "/start"){
    const pl = args[0] || "";
    if (pl.startsWith("p_") && UUID.test(pl.slice(2))) return poolCard(chat, pl.slice(2));
    return send(chat, WELCOME, {reply_markup: {inline_keyboard: [[{text: "🆕 Alert me about new pools", callback_data: "n|on"}], [{text: "Open Tidewatch", url: A.SITE + "/yields"}]]}});
  }
  if (c === "/above" || c === "/below"){
    const id = await redis("GET", ctxKey(chat));
    if (!id) return send(chat, "First open a pool: tap 🔔 next to it on " + A.SITE + "/yields");
    return create(chat, id, c.slice(1), round1(parseFloat(String(args[0] || "").replace(",", ".").replace("%", ""))));
  }
  if (c === "/list") return list(chat);
  if (c === "/new"){ await redis("SADD", A.K.newpools, String(chat)); return send(chat, "New-pool alerts are on. I’ll tell you when a pool with at least $100k TVL appears on Robinhood Chain."); }
  if (c === "/stop"){ const n = await A.removeAll(chat); return send(chat, `Removed ${n} alert${n === 1 ? "" : "s"} and turned off new-pool alerts.`); }
  return send(chat, WELCOME);
}

async function onCallback(q){
  const chat = q.message && q.message.chat.id, [kind, a, b, cthr] = String(q.data || "").split("|");
  await tg("answerCallbackQuery", {callback_query_id: q.id}).catch(() => {});
  if (!chat) return;
  if (kind === "s" && UUID.test(b)) return create(chat, b, a === "a" ? "above" : "below", round1(parseFloat(cthr)));
  if (kind === "d"){ await A.removeAlert(chat, a); return list(chat); }
  if (kind === "n"){
    await redis(a === "on" ? "SADD" : "SREM", A.K.newpools, String(chat));
    return send(chat, a === "on" ? "New-pool alerts are on." : "New-pool alerts are off.");
  }
}

module.exports = async function handler(req, res){
  if (req.method !== "POST" || req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret())
    return res.status(401).json({error: "unauthorized"});
  try {
    const u = req.body || {};
    if (u.message && u.message.chat && u.message.chat.type === "private") await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) {
    console.error("telegram webhook:", e);
  }
  res.status(200).json({ok: true});   // always 200 so Telegram doesn't retry a failing update forever
};
