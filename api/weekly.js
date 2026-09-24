// Weekly recap. GET shows this week's text (a preview). ?send=1, called by the Monday schedule,
// sends it once per week to everyone who turned on /weekly in the Telegram bot.
const {send, esc} = require("../lib/telegram");
const {redis} = require("../lib/store");
const {buildRecap, shareUrl} = require("../lib/weekly");
const A = require("../lib/alerts");

module.exports = async function handler(req, res){
  if (!process.env.TELEGRAM_BOT_TOKEN || !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL))
    return res.status(200).json({skipped: "alerts not configured yet"});
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = await buildRecap();
    const scheduled = String((req.query || {}).send || "") === "1" || /vercel-cron/i.test((req.headers || {})["user-agent"] || "");
    if (!scheduled) return res.status(200).json({...r, share: shareUrl(r.text)});
    // Only on Mondays (UTC), and only once per week, however often the schedule calls
    if (new Date().getUTCDay() !== 1) return res.status(200).json({skipped: "recaps go out on Mondays"});
    if (!(await redis("SET", A.K.weeklySent(r.week), String(Date.now()), "NX", "EX", 8 * 86400)))
      return res.status(200).json({skipped: "already sent this week", week: r.week});
    await redis("SET", A.K.weeklyTvl, String(Math.round(r.tvl)));
    const subs = await redis("SMEMBERS", A.K.weekly) || [];
    const markup = {inline_keyboard: [[{text: "Post on X", url: shareUrl(r.text)}], [{text: "Open Tidewatch", url: A.SITE}]]};
    const results = await Promise.allSettled(subs.map(c => send(c, esc(r.text), {reply_markup: markup})));
    const failed = results.filter(x => x.status === "rejected");
    failed.forEach(x => console.error("weekly send failed:", x.reason && x.reason.message));
    res.status(200).json({week: r.week, sent: subs.length - failed.length, failed: failed.length});
  } catch (e) {
    console.error("weekly:", e);
    res.status(500).json({error: String(e.message || e)});
  }
};
