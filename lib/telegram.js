// Telegram Bot API helpers. The webhook secret is derived from the bot token, so the only
// setting Louise has to add is TELEGRAM_BOT_TOKEN.
const crypto = require("crypto");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const webhookSecret = () => crypto.createHash("sha256").update("tw-webhook:" + (TOKEN || "")).digest("hex").slice(0, 48);
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));

async function tg(method, body){
  if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
const send = (chat, text, extra = {}) =>
  tg("sendMessage", {chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra});

module.exports = {tg, send, esc, webhookSecret};
