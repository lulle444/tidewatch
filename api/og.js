// Share-preview images (1200×630 PNG) with today's numbers, one per page: /api/og?p=leaderboard.
// Pages point their og:image here; X and others fetch it when a link is shared.
const {redis} = require("../lib/store");
const {currentPools} = require("../lib/llama");
const {currentStocks, usable} = require("../lib/stocks");
const A = require("../lib/alerts");
const lb = require("../lib/leaderboard");
const fs = require("fs"), path = require("path");

let logo;
const logoUri = () => logo || (logo = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "..", "assets", "logo-mark.png")).toString("base64"));

const C = {ink: "#0A2340", muted: "#5A6E84", accent: "#0D7480", up: "#1F7A4B", down: "#B03A26", card: "rgba(255,255,255,0.78)", edge: "rgba(10,35,64,0.08)"};
const FAIR = 0.005;

const usd = v => {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return s + "$" + a.toFixed(0);
};
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const fmtN = n => n.toLocaleString("en-US");

// tiny element builder for @vercel/og (it takes React-shaped objects)
const h = (style, ...children) => ({type: "div", props: {style: {display: "flex", ...style}, children: children.flat().filter(c => c != null && c !== false)}});

let fonts;
async function loadFonts(){
  if (fonts) return fonts;
  const want = [["Montserrat", 600], ["Montserrat", 700], ["IBM Plex Sans", 500]];
  const out = [];
  await Promise.all(want.map(async ([name, weight]) => {
    try {
      // without a browser user agent Google Fonts answers with TTF, which the renderer can read
      const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${name.replace(/ /g, "+")}:wght@${weight}`, {signal: AbortSignal.timeout(5000)})).text();
      const url = (css.match(/src: url\((.+?)\) format\('(truetype|opentype)'\)/) || [])[1];
      if (!url) return;
      out.push({name, weight, style: "normal", data: await (await fetch(url, {signal: AbortSignal.timeout(5000)})).arrayBuffer()});
    } catch (e) {}
  }));
  fonts = out;
  return fonts;
}

// What each page's card says. Each returns {eyebrow, big, bigColor, label, stats: [[value, caption] × 3], path}.
const CARDS = {
  async home(){
    const {data, protocols} = await currentPools(A.SITE);
    const pools = data.filter(p => !p.outlier && A.apyOf(p) > 0);
    const best = pools.filter(p => p.stablecoin && p.tvlUsd >= 1e7).sort((a, b) => A.apyOf(b) - A.apyOf(a))[0];
    const tvl = data.reduce((s, p) => s + (p.tvlUsd || 0), 0);
    return {
      eyebrow: "Robinhood Chain yields", big: best ? A.pct(A.apyOf(best)) : "–", bigColor: C.accent,
      label: best ? `Top stablecoin yield today: ${best.symbol} on ${A.nameOf(best, protocols)}` : "Live yields on Robinhood Chain",
      stats: [[fmtN(data.length), "yield pools tracked"], [usd(tvl), "in yield pools"], [fmtN(new Set(data.map(p => p.project)).size), "protocols"]],
      path: "",
    };
  },
  async yields(){ return {...await CARDS.home(), eyebrow: "Every yield pool, ranked", path: "/yields"}; },
  async stocks(){
    const all = await currentStocks(A.SITE);
    const deep = all.filter(s => usable(s) && s.liquidity >= 1e5);
    const fair = deep.filter(s => Math.abs(s.gap) <= FAIR).length;
    const vol = all.reduce((s, x) => s + (x.volume24h || 0), 0), tok = all.reduce((s, x) => s + (x.tokenized || 0), 0);
    return {
      eyebrow: "Stock tracker", big: deep.length ? Math.round(fair / deep.length * 100) + "%" : fmtN(all.length), bigColor: C.accent,
      label: deep.length ? "of deep stock-token pools priced within ±0.5% of the share" : "stock tokens on Robinhood Chain, priced against the real share",
      stats: [[fmtN(all.length), "stock tokens"], [usd(vol), "traded on chain, 24h"], [usd(tok), "tokenized value"]],
      path: "/stocks",
    };
  },
  async leaderboard(){
    const top = JSON.parse(await redis("GET", lb.K.top) || "null");
    const w = top && (top.windows["7d"] && top.windows["7d"].full ? top.windows["7d"] : top.windows["24h"]);
    if (!w) return null;
    const best = w.rows.filter(r => !r.bot).sort((a, b) => b.pnl - a.pnl)[0];
    const span = w === top.windows["7d"] ? "this week" : w.full ? "in the last 24 hours" : `in the last ${w.hours} hours`;
    return {
      eyebrow: "Stock-token leaderboard", big: best ? "+" + usd(best.pnl) : "–", bigColor: C.up,
      label: best ? `Top trader ${span}: ${short(best.a)}, mostly ${best.syms[0][0]}` : "Top stock-token traders",
      stats: [[fmtN(w.wallets), "wallets trading"], [usd(w.volume), "volume"], [fmtN(w.trades), "trades"]],
      path: "/leaderboard",
    };
  },
  async new(){
    const [{data}, seenRaw] = await Promise.all([currentPools(A.SITE), redis("HGETALL", "tw:firstseen")]);
    const seen = {};
    for (let i = 0; i < (seenRaw || []).length; i += 2) seen[seenRaw[i]] = +seenRaw[i + 1];
    const since = Date.now() - 30 * 864e5;
    const fresh = data.filter(p => seen[p.pool] >= since);
    return {
      eyebrow: "New on the chain", big: fmtN(fresh.length), bigColor: C.accent,
      label: `new yield pool${fresh.length === 1 ? "" : "s"} on Robinhood Chain in the last 30 days`,
      stats: [(n => [fmtN(n), n === 1 ? "protocol behind them" : "protocols behind them"])(new Set(fresh.map(p => p.project)).size), [usd(fresh.reduce((s, p) => s + (p.tvlUsd || 0), 0)), "deposited in them"], [fmtN(data.length), "pools in total"]],
      path: "/new",
    };
  },
};

function card(c, logo){
  const stat = ([v, cap]) => h({flexDirection: "column", padding: "22px 28px", borderRadius: 22, background: C.card, border: `1px solid ${C.edge}`, flex: 1},
    h({fontFamily: "Montserrat", fontWeight: 700, fontSize: 40, color: C.ink}, v),
    h({fontFamily: "IBM Plex Sans", fontSize: 22, color: C.muted, marginTop: 4}, cap));
  return h({width: 1200, height: 630, flexDirection: "column", padding: "56px 64px", fontFamily: "IBM Plex Sans", color: C.ink,
      backgroundImage: "radial-gradient(900px 500px at 90% -10%, #CDE9F1 0%, rgba(205,233,241,0) 60%), linear-gradient(180deg, #F6F9FC 0%, #EDF3F8 55%, #E2ECF4 100%)"},
    h({alignItems: "center", justifyContent: "space-between"},
      h({alignItems: "center"},
        {type: "img", props: {src: logo, width: 52, height: 52, style: {marginRight: 16}}},
        h({fontFamily: "Montserrat", fontWeight: 600, fontSize: 28, letterSpacing: 6, color: C.ink}, "TIDE", h({color: C.accent}, "WATCH"))),
      h({fontFamily: "Montserrat", fontWeight: 600, fontSize: 20, letterSpacing: 5, color: C.accent, textTransform: "uppercase"}, c.eyebrow)),
    h({flexDirection: "column", marginTop: 46, flex: 1},
      h({fontFamily: "Montserrat", fontWeight: 700, fontSize: 132, lineHeight: 1, color: c.bigColor, letterSpacing: -3}, c.big),
      h({fontFamily: "IBM Plex Sans", fontWeight: 500, fontSize: 34, color: C.ink, marginTop: 18, maxWidth: 1000, lineHeight: 1.25}, c.label)),
    h({gap: 20}, c.stats.map(stat)),
    h({marginTop: 22, fontSize: 20, color: C.muted, justifyContent: "space-between"},
      h({}, "usetidewatch.org" + c.path), h({}, "Live on-chain data · Not financial advice")));
}

module.exports = async function handler(req, res){
  const p = String((req.query || {}).p || "home");
  const fallback = () => { res.setHeader("Cache-Control", "public, s-maxage=600"); res.redirect(302, "/assets/og.jpg"); };
  if (!CARDS[p]) return fallback();
  try {
    const [c, f, {ImageResponse}] = await Promise.all([CARDS[p](), loadFonts(), import("@vercel/og")]);
    if (!c) return fallback();
    const img = new ImageResponse(card(c, logoUri()), {width: 1200, height: 630, fonts: f.length ? f : undefined});
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).end(buf);
  } catch (e) {
    console.error("og", p, e);
    fallback();
  }
};
