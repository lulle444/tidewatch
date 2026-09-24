// One-off: points the bot's webhook at this deployment and sets its command menu.
// Harmless to call again; it only ever registers this site's own webhook.
const {tg, webhookSecret} = require("../lib/telegram");
const {SITE} = require("../lib/alerts");

module.exports = async function handler(req, res){
  try {
    await tg("setWebhook", {url: SITE + "/api/telegram", secret_token: webhookSecret(),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true});
    await tg("setMyCommands", {commands: [
      {command: "list", description: "See or remove your alerts"},
      {command: "gap", description: "Stock token price-gap alert, e.g. /gap TSLA 1"},
      {command: "new", description: "Get told about new pools"},
      {command: "stop", description: "Remove all alerts"},
      {command: "start", description: "How Tidewatch alerts work"},
    ]});
    await tg("setMyDescription", {description: "Alerts for Robinhood Chain: get a message when a pool's APY crosses your level, when a new pool appears, or when a stock token trades away from its share price. From Tidewatch."}).catch(() => {});
    const me = await tg("getMe", {});
    res.status(200).json({ok: true, bot: "@" + me.username, webhook: SITE + "/api/telegram"});
  } catch (e) {
    res.status(500).json({ok: false, error: String(e.message || e)});
  }
};
