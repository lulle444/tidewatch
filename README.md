# Tidewatch

Yield comparison for stock tokens and stablecoins on Robinhood Chain.

- Static pages, no build step: `index.html` (home), `yields.html`, `calculator.html`, `stock-yield.html`, `stocks.html`, `new.html`, `risk.html`, `learn.html`, `about.html`, sharing `styles.css`, `app.js`, `chart.js` (the SVG line chart) and `tide.js`. `vercel.json` turns on clean URLs (`/yields`, `/calculator`, ...).
- Data is fetched live in the browser from DefiLlama: `yields.llama.fi/pools` (filtered to `chain == "Robinhood Chain"`) and `api.llama.fi/protocols` (audits, protocol age).
- If data can't be loaded, clearly labelled sample data is shown instead.

Data: `api/pools.js` is a Vercel function that fetches DefiLlama, keeps only Robinhood Chain pools and caches the result at the CDN for 10 minutes. The page calls `/api/pools` first and falls back to DefiLlama directly, then to sample data.

Pool history: tapping a pool's asset opens its APY chart. `api/pool-history.js` proxies DefiLlama's daily `yields.llama.fi/chart/<pool>` (cached for an hour); the page falls back to DefiLlama directly.

New on the chain: `new.html` (rendered by `app.js` when `<body data-page="new">`) lists pools first seen in the last 7/30/90 days and the protocols they belong to. `api/new.js` returns each pool's first-seen date: the first day in DefiLlama's history for that pool, looked up once and kept in Redis (`tw:firstseen`).

Stock tracker: `api/stocks.js` (via `lib/stocks.js`) merges Robinhood's public stock-token API (`api.robinhood.com/rhj/assets` and `/prices`, the reference price per token) with DexScreener's Robinhood Chain pools (the on-chain price in each token's deepest pool), cached at the CDN for 60 seconds. `stocks.html` renders it with `stocks.js` instead of `app.js`.

Stock alerts and history: the scheduled check (`api/check-alerts.js`) also evaluates price-gap alerts (`/gap TSLA 1` in the bot, or 🔔 on `/stocks`) and, once an hour while the US market is open, saves each liquid token's gap to Redis (`tw:g:<SYMBOL>`, 30 days). `api/stock-history.js` serves that list to the chart on `/stocks`.

Weekly recap: `api/weekly.js` (text built in `lib/weekly.js`) previews this week's X-sized recap on GET. On Mondays the `weekly.yml` workflow (plus a Vercel cron as backup) calls it with `?send=1`, and it sends once per ISO week to chats that turned on `/weekly`, with a "Post on X" button that opens X's composer with the text.

Alerts: a Telegram bot. `api/telegram.js` is its webhook, `api/check-alerts.js` compares live APYs with saved alerts (run every 15 minutes by `.github/workflows/alerts.yml`, daily by Vercel cron as a backup) and `api/telegram-setup.js` registers the webhook once. Needs Upstash Redis connected in Vercel and a `TELEGRAM_BOT_TOKEN` env var; set `TG_BOT` in `app.js` to show the bell buttons.

Run locally: `npx serve .` (pages use absolute paths, so opening the files directly won't load styles).

Brand assets live in `assets/` (logo, favicon, share image) and `assets/brand/` (imagery, WebP).
