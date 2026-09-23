# Tidewatch

Yield comparison for stock tokens and stablecoins on Robinhood Chain.

- One static file: `index.html` (no build step).
- Data is fetched live in the browser from DefiLlama: `yields.llama.fi/pools` (filtered to `chain == "Robinhood Chain"`) and `api.llama.fi/protocols` (audits, protocol age).
- If data can't be loaded, clearly labelled sample data is shown instead.

Run locally: open `index.html` in a browser, or `npx serve .`.

Brand assets live in `assets/` (logo, favicon, share image) and `assets/brand/` (imagery, WebP).
