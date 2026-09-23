# Tidewatch

Yield-sammenligner for stock tokens og stablecoins på Robinhood Chain.

- Én statisk fil: `index.html` (ingen build-trin).
- Data hentes live i browseren fra DefiLlama: `yields.llama.fi/pools` (filtreret på `chain == "Robinhood Chain"`) og `api.llama.fi/protocols` (audits, alder).
- Hvis data ikke kan hentes, vises tydeligt markerede eksempeldata.

Kør lokalt: åbn `index.html` i en browser, eller `npx serve .`.
