/* Stock tracker: every Robinhood Chain stock token, its on-chain price next to the real share price. */
(function(){
"use strict";
const API_URL = "/api/stocks";
const FAIR = 0.005;        // gaps within ±0.5% count as fairly priced
const THIN = 10000;        // pools shallower than this move on small trades, so their gap means little
const STALE_MIN = 30;      // a reference price older than this is treated as paused (market closed)
const PAGE = 25;

const $ = id => document.getElementById(id);
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtUsd = v => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v/1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v/1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return "$" + (v/1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return "$" + v.toFixed(0);
};
const fmtPrice = v => v == null || !isFinite(v) ? "–" : "$" + v.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits: v < 1 ? 4 : 2});
const fmtGap = g => g == null ? "–" : (g > 0 ? "+" : g < 0 ? "−" : "") + Math.abs(g * 100).toFixed(2) + "%";

const state = {rows:[], view:"all", minLiq:THIN, q:"", sort:"tokenized", dir:-1, limit:PAGE, paused:false};

/* ---------- market clock (Robinhood trades stock tokens 24 hours a day, five days a week) ---------- */
function marketSession(now = new Date()){
  const et = new Date(now.toLocaleString("en-US", {timeZone:"America/New_York"}));
  const day = et.getDay(), m = et.getHours() * 60 + et.getMinutes();
  const weekend = day === 6 || (day === 5 && m >= 1200) || (day === 0 && m < 1200);
  if (weekend) return {key:"closed", label:"Closed for the weekend"};
  if (m >= 570 && m < 960) return {key:"open", label:"Regular session"};
  if (m >= 240 && m < 570) return {key:"open", label:"Pre-market"};
  if (m >= 960 && m < 1200) return {key:"open", label:"After hours"};
  return {key:"open", label:"Overnight session"};
}

/* ---------- data ---------- */
function prep(d){
  const refAge = d.refAt ? (Date.now() - Date.parse(d.refAt)) / 60000 : Infinity;
  const thin = !(d.liquidity >= THIN);
  const band = d.gap == null ? "none" : d.gap > FAIR ? "premium" : d.gap < -FAIR ? "discount" : "fair";
  return {...d, stale: refAge > STALE_MIN || d.halted, thin, band, absGap: d.gap == null ? -1 : Math.abs(d.gap)};
}

async function load(){
  try {
    const r = await fetch(API_URL, {headers:{accept:"application/json"}});
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!j.data || !j.data.length) throw new Error("empty");
    state.rows = j.data.map(prep);
    const at = new Date(j.updatedAt || Date.now());
    $("dot").className = "dot live";
    set("sourceText", "Live · " + at.toLocaleTimeString("en-US", {hour:"2-digit", minute:"2-digit"}));
    set("updated", "Prices from Robinhood and DexScreener, updated " + at.toLocaleString("en-US", {dateStyle:"medium", timeStyle:"short"}));
    render();
  } catch (e) {
    $("dot").className = "dot sample";
    set("sourceText", "Data unavailable");
    set("mkt", "Prices are temporarily unavailable.");
    $("rows").innerHTML = `<tr><td colspan="7" class="empty">Live prices couldn’t be loaded right now. Please try again in a minute.</td></tr>`;
    set("count", "");
  }
}

/* ---------- render ---------- */
function renderGauge(){
  const rows = state.rows, priced = rows.filter(r => r.gap != null && !r.thin);
  set("sTokens", rows.length);
  set("sTokensSub", `${rows.filter(r => r.onchain != null).length} trade on chain`);
  set("sTokenized", fmtUsd(rows.reduce((s, r) => s + (r.tokenized || 0), 0)));
  set("sTokenizedSub", "Value of all tokens issued");
  set("sVolume", fmtUsd(rows.reduce((s, r) => s + (r.volume24h || 0), 0)));
  const mb = rows.reduce((s, r) => s + (r.mintBurn24h || 0), 0);
  set("sVolumeSub", mb ? `${fmtUsd(mb)} minted or redeemed` : "On DEX pools");
  const fair = priced.filter(r => r.band === "fair").length;
  set("sFair", priced.length ? Math.round(fair / priced.length * 100) + "%" : "–");
  set("sFairSub", priced.length ? `${fair} of ${priced.length} within ±0.5%` : "No deep pools yet");
}

function renderMarket(){
  const s = marketSession(), newest = Math.max(...state.rows.map(r => r.refAt ? Date.parse(r.refAt) : 0));
  const pausedSince = newest && (Date.now() - newest) / 60000 > STALE_MIN ? new Date(newest) : null;
  state.paused = s.key === "closed" || !!pausedSince;
  const el = $("mkt");
  el.className = "mkt " + (state.paused ? "closed" : "open");
  el.innerHTML = state.paused
    ? `<b>US market ${s.key === "closed" ? "closed for the weekend" : "paused"}.</b> Share prices have been frozen${pausedSince ? " since " + esc(pausedSince.toLocaleString("en-US", {weekday:"short", hour:"2-digit", minute:"2-digit"})) : ""}, while tokens keep trading on chain, so gaps now say more about expectations than mispricing.`
    : `<b>${esc(s.label)}.</b> Share prices are live from Robinhood, refreshed every minute.`;
}

function filtered(){
  const q = state.q.trim().toLowerCase();
  return state.rows.filter(r =>
    (state.view === "all" || r.band === state.view) &&
    (state.minLiq === 0 || r.liquidity >= state.minLiq) &&
    (!q || r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)));
}

function gapCell(r){
  if (r.gap == null) return `<span class="muted">${r.onchain == null ? "No pool" : "No quote"}</span>`;
  const label = {premium:"Premium", discount:"Discount", fair:"Fair"}[r.band];
  return `<span class="gap ${r.band}${r.thin || r.stale ? " soft" : ""}"><span class="num">${fmtGap(r.gap)}</span><small>${label}</small></span>`;
}

function renderTable(){
  const list = filtered().sort((a, b) => {
    const k = state.sort, x = a[k], y = b[k];
    if (typeof x === "string") return state.dir * x.localeCompare(y);
    return state.dir * ((x ?? -Infinity) - (y ?? -Infinity)) || a.symbol.localeCompare(b.symbol);
  });
  const shown = list.slice(0, state.limit);
  $("rows").innerHTML = shown.length ? shown.map(r => `<tr>
      <td><div class="ticker">${r.logo ? `<img src="${esc(r.logo)}" alt="" width="28" height="28" loading="lazy" onerror="this.remove()">` : ""}<div class="proto"><b class="asset">${esc(r.symbol)}</b><span>${esc(r.name)}</span></div></div></td>
      <td class="r">${gapCell(r)}</td>
      <td class="r num">${fmtPrice(r.ref)}${r.stale ? '<small class="sub2">paused</small>' : ""}</td>
      <td class="r num">${fmtPrice(r.onchain)}${r.pool ? `<small class="sub2">${esc(r.pool.quote || "")} pool</small>` : ""}</td>
      <td class="r num">${fmtUsd(r.liquidity)}${r.thin && r.onchain != null ? '<small class="sub2 warn">thin</small>' : ""}</td>
      <td class="r num">${fmtUsd(r.volume24h)}</td>
      <td class="r">${r.pool && r.pool.url ? `<a class="trade" href="${esc(r.pool.url)}" target="_blank" rel="noopener" aria-label="View the ${esc(r.symbol)} pool on DexScreener">Pool ↗</a>` : ""}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">No stock tokens match these filters.</td></tr>`;
  set("count", `Showing ${shown.length} of ${list.length} tokens`);
  $("showMore").hidden = list.length <= state.limit;
  document.querySelectorAll("th button[data-sort]").forEach(b => {
    const on = b.dataset.sort === state.sort;
    b.closest("th").setAttribute("aria-sort", on ? (state.dir > 0 ? "ascending" : "descending") : "none");
    b.textContent = b.textContent.replace(/ [↓↑]$/, "") + (on ? (state.dir < 0 ? " ↓" : " ↑") : "");
  });
}

function render(){ renderGauge(); renderMarket(); renderTable(); }

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const chip = e.target.closest(".chip[data-view]");
  if (chip){
    state.view = chip.dataset.view; state.limit = PAGE;
    document.querySelectorAll(".chip[data-view]").forEach(x => x.setAttribute("aria-pressed", x === chip ? "true" : "false"));
    renderTable(); return;
  }
  const s = e.target.closest("th button[data-sort]");
  if (s){
    const k = s.dataset.sort;
    if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === "symbol" ? 1 : -1; }
    renderTable(); return;
  }
  if (e.target.closest("#showMore")){ state.limit += PAGE; renderTable(); }
});
$("minLiq").addEventListener("change", e => { state.minLiq = +e.target.value; state.limit = PAGE; renderTable(); });
$("q").addEventListener("input", e => { state.q = e.target.value; state.limit = PAGE; renderTable(); });

load();
setInterval(() => { if (!document.hidden) load(); }, 120000);
})();
