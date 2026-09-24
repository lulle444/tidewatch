// Weekly recap of Robinhood Chain yields and stock tokens: one short post that fits on X,
// sent to /weekly subscribers in Telegram with a button that opens X with the text filled in.
const {redis, pipeline} = require("./store");
const {currentPools} = require("./llama");
const {currentStocks, usable} = require("./stocks");
const A = require("./alerts");

const FAIR = 0.005;
const X_LIMIT = 280, X_URL_LEN = 23;   // X counts every link as 23 characters
const signedPp = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " pp";
const signedPct = v => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(2) + "%";
// X counts emoji and other wide characters as 2
const xLen = t => [...t].reduce((n, ch) => n + (ch === "\uFE0F" ? 0 : ch.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
const shortSite = A.SITE.replace(/^https:\/\//, "");

// ISO week label like 2026-W39, so each recap goes out once per week
function isoWeek(d = new Date()){
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

async function stockLine(){
  let stocks = [];
  try { stocks = await currentStocks(A.SITE); } catch (e) { return null; }
  const liquid = stocks.filter(s => s.liquidity >= 1e5 && s.gap != null);
  if (!liquid.length) return null;
  const since = Date.now() - 7 * 864e5;
  const lists = await pipeline(liquid.map(s => ["LRANGE", A.K.gaps(s.symbol), -24 * 7, -1])).catch(() => []);
  const readings = [];
  liquid.forEach((s, i) => (lists[i] || []).forEach(r => {
    const [m, g] = r.split(",").map(Number);
    if (m * 60000 >= since && isFinite(g)) readings.push({symbol: s.symbol, g});
  }));
  if (readings.length >= liquid.length * 12){   // at least about half a day of history per token
    const fair = readings.filter(r => Math.abs(r.g) <= FAIR).length / readings.length;
    const worst = readings.reduce((a, b) => Math.abs(b.g) > Math.abs(a.g) ? b : a);
    return `⚖️ Stock tokens priced fairly (±0.5%) ${Math.round(fair * 100)}% of the time. Widest gap: ${worst.symbol} ${signedPct(worst.g)}`;
  }
  const now = liquid.filter(s => usable(s)), fairNow = now.filter(s => Math.abs(s.gap) <= FAIR).length;
  return now.length ? `⚖️ Stock tokens: ${fairNow} of ${now.length} deep pools priced within ±0.5% of the share` : null;
}

async function buildRecap(){
  const {data, protocols} = await currentPools(A.SITE);
  const pools = data.filter(p => !p.outlier && A.apyOf(p) > 0);
  const lines = [];
  const stable = pools.filter(p => p.stablecoin && p.tvlUsd >= 1e7).sort((a, b) => A.apyOf(b) - A.apyOf(a))[0];
  if (stable) lines.push({pri: 1, text: `💵 Top stablecoin yield: ${A.pct(A.apyOf(stable))} on ${stable.symbol} (${A.nameOf(stable, protocols)})`});
  // biggest 7-day rise, skipping one-off spikes (APY over 3× its 30-day average) that often reverse
  const mover = pools.filter(p => p.tvlUsd >= 1e6 && isFinite(p.apyPct7D) && p.apyPct7D >= 0.1 && A.apyOf(p) <= 3 * (p.apyMean30d || 0))
    .sort((a, b) => b.apyPct7D - a.apyPct7D)[0];
  if (mover) lines.push({pri: 2, text: `📈 Biggest mover: ${mover.symbol} (${A.nameOf(mover, protocols)}) ${signedPp(mover.apyPct7D)} to ${A.pct(A.apyOf(mover))}`});
  const tvl = data.reduce((s, p) => s + (p.tvlUsd || 0), 0), lastTvl = +(await redis("GET", A.K.weeklyTvl)) || 0;
  const chg = lastTvl ? (tvl / lastTvl - 1) * 100 : null;
  lines.push({pri: 3, text: `💧 ${A.usd(tvl)} in yield pools` + (chg == null ? "" : Math.abs(chg) < 0.5 ? " (flat vs last week)" : ` (${chg > 0 ? "+" : "−"}${Math.abs(chg).toFixed(Math.abs(chg) < 10 ? 1 : 0)}% vs last week)`)});
  const stockText = await stockLine();
  if (stockText) lines.push({pri: 1, text: stockText});
  const fresh = await redis("ZCOUNT", A.K.newlog, Date.now() - 7 * 864e5, "+inf") || 0;
  if (fresh > 0) lines.push({pri: 2, text: `🆕 ${fresh} new pool${fresh === 1 ? "" : "s"} this week`});

  // keep the post within X's limit by dropping the least important lines
  const head = "🌊 Robinhood Chain this week", tail = shortSite;
  const size = ls => xLen(head) + 2 + ls.reduce((s, l) => s + xLen(l.text) + 1, 0) + 1 + X_URL_LEN;
  let keep = lines.slice();
  while (keep.length > 1 && size(keep) > X_LIMIT) keep.splice(keep.indexOf(keep.reduce((a, b) => b.pri > a.pri ? b : a)), 1);
  const text = `${head}\n\n${keep.map(l => l.text).join("\n")}\n\n${tail}`;
  // which pools were picked, so a preview can be checked against the data
  const pick = p => p && {pool: p.pool, symbol: p.symbol, project: p.project, apy: A.apyOf(p), apyMean30d: p.apyMean30d, apyPct7D: p.apyPct7D, tvlUsd: p.tvlUsd};
  return {week: isoWeek(), text, tvl, picked: {stable: pick(stable), mover: pick(mover)}};
}

const shareUrl = text => "https://x.com/intent/post?text=" + encodeURIComponent(text);

module.exports = {buildRecap, isoWeek, shareUrl};
