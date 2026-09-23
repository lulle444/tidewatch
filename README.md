# Tidewatch

Yield comparison for stock tokens and stablecoins on Robinhood Chain.

- Static pages, no build step: `index.html` (home), `yields.html`, `calculator.html`, `stock-yield.html`, `risk.html`, sharing `styles.css`, `app.js` and `tide.js`. `vercel.json` turns on clean URLs (`/yields`, `/calculator`, ...).
- Data is fetched live in the browser from DefiLlama: `yields.llama.fi/pools` (filtered to `chain == "Robinhood Chain"`) and `api.llama.fi/protocols` (audits, protocol age).
- If data can't be loaded, clearly labelled sample data is shown instead.

Run locally: `npx serve .` (pages use absolute paths, so opening the files directly won't load styles).

Brand assets live in `assets/` (logo, favicon, share image) and `assets/brand/` (imagery, WebP).
