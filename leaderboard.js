/* Leaderboard: the wallets making the most from trading stock tokens on Robinhood Chain. */
(function(){
"use strict";
const API_URL = "/api/leaderboard";
const STOCKS_URL = "/api/stocks";
const EXPLORER = "https://robinhoodchain.blockscout.com/address/";
const PAGE = 25;

const $ = id => document.getElementById(id);
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtUsd = v => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e9) return s + "$" + (a/1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a/1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return s + "$" + (a/1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return s + "$" + a.toFixed(0);
};
const fmtPnl = v => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + fmtUsd(v);
const pnlClass = v => v > 0 ? "delta up" : v < 0 ? "delta down" : "";
const fmtQty = v => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: Math.abs(v) < 10 ? 3 : 1});
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const fmtN = n => n.toLocaleString("en-US");

const state = {data:null, win:"7d", rank:"profit", bots:false, q:"", open:null, limit:PAGE, logos:{}};

async function load(){
  fetch(STOCKS_URL).then(r => r.ok ? r.json() : null).then(j => {
    if (!j || !j.data) return;
    j.data.forEach(s => { if (s.logo) state.logos[s.symbol] = s.logo; });
    if (state.data) renderTable();
  }).catch(() => {});
  try {
    const r = await fetch(API_URL, {headers:{accept:"application/json"}});
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!j.windows || !j.windows[state.win]) throw new Error("empty");
    state.data = j;
    const at = new Date(j.updatedAt);
    $("dot").className = "dot live";
    set("sourceText", "Updated hourly · " + at.toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"}));
    set("updated", "Trades read from Robinhood Chain, updated " + at.toLocaleString("en-US", {dateStyle:"medium", timeStyle:"short"}));
    render();
  } catch (e) {
    $("dot").className = "dot sample";
    set("sourceText", "Data unavailable");
    set("lbNote", "The leaderboard couldn’t be loaded right now.");
    $("rows").innerHTML = `<tr><td colspan="6" class="empty">${e.message === "empty" ? "The first trades are still being read from the chain. Check back in an hour." : "The leaderboard couldn’t be loaded right now. Please try again in a minute."}</td></tr>`;
    set("count", "");
  }
}

const win = () => state.data.windows[state.win];

/* ---------- render ---------- */
function renderGauge(){
  const w = win(), rows = w.rows.filter(r => !r.bot);
  const label = state.win === "24h" ? "in the last 24 hours" : w.full ? "in the last 7 days" : "since tracking began";
  set("lWallets", fmtN(w.wallets));
  set("lWalletsSub", label);
  set("lVolume", fmtUsd(w.volume));
  set("lVolumeSub", fmtN(w.trades) + " trades");
  const best = rows.slice().sort((a, b) => b.pnl - a.pnl)[0];
  set("lBest", best ? fmtPnl(best.pnl) : "–");
  set("lBestSub", best ? short(best.a) : "No trades yet");
  const vol = {};
  w.rows.forEach(r => r.syms.forEach(s => { vol[s[0]] = (vol[s[0]] || 0) + s[4]; }));
  const top = Object.entries(vol).sort((a, b) => b[1] - a[1])[0];
  set("lStock", top ? top[0] : "–");
  set("lStockSub", top ? fmtUsd(top[1]) + " by ranked wallets" : "No trades yet");
}

function renderNote(){
  const w = win(), el = $("lbNote");
  const since = w.since ? new Date(w.since).toLocaleString("en-US", {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"}) : null;
  el.className = "mkt " + (w.full ? "open" : "closed");
  el.innerHTML = w.full
    ? `<b>${state.win === "24h" ? "Last 24 hours" : "Last 7 days"}.</b> ${fmtN(w.ranked)} wallets traded at least $250 of stock tokens.`
    : `<b>Still filling in history.</b> This window covers ${w.hours} hour${w.hours === 1 ? "" : "s"} so far${since ? ", since " + esc(since) : ""}. Older trades are added every hour until the full ${state.win === "24h" ? "24 hours" : "7 days"} are covered.`;
}

function filtered(){
  const q = state.q.trim().toLowerCase();
  const list = win().rows.filter(r =>
    (state.bots || !r.bot) &&
    (!q || r.a.includes(q) || r.syms.some(s => s[0].toLowerCase().includes(q))));
  const k = {profit: (a, b) => b.pnl - a.pnl, loss: (a, b) => a.pnl - b.pnl, volume: (a, b) => b.vol - a.vol}[state.rank];
  return list.sort(k);
}

function stockChip(sym){
  const logo = state.logos[sym];
  return `<span class="lbstock">${logo ? `<img src="${esc(logo)}" alt="" width="18" height="18" loading="lazy" onerror="this.remove()">` : ""}${esc(sym)}</span>`;
}

function renderTable(){
  const list = filtered(), shown = list.slice(0, state.limit);
  $("rows").innerHTML = shown.length ? shown.map((r, i) => {
    const open = state.open === r.a;
    const most = r.syms.slice().sort((a, b) => b[4] - a[4]).slice(0, 3);
    return `<tr class="srow${open ? " is-open" : ""}" data-addr="${esc(r.a)}">
      <td class="r num muted rank">${i + 1}</td>
      <td><button class="ticker wallet" type="button" aria-expanded="${open}" aria-label="Wallet ${esc(r.a)}: show its trades"><span class="walletdot" style="--h:${parseInt(r.a.slice(2, 5), 16) % 360}" aria-hidden="true"></span><span class="proto"><b class="asset num">${esc(short(r.a))}</b>${r.bot ? '<span class="tag odd" title="Trades more than four times an hour on average">Bot</span>' : ""}</span><span class="chev" aria-hidden="true">›</span></button></td>
      <td class="r num"><span class="${pnlClass(r.pnl)}">${fmtPnl(r.pnl)}</span></td>
      <td class="r num">${fmtUsd(r.vol)}</td>
      <td class="r num">${fmtN(r.n)}</td>
      <td><div class="lbstocks">${most.map(s => stockChip(s[0])).join("")}</div></td>
    </tr>${open ? detailRow(r) : ""}`;
  }).join("") : `<tr><td colspan="6" class="empty">No wallets match these filters.</td></tr>`;
  set("count", `Showing ${shown.length} of ${list.length} wallets`);
  $("showMore").hidden = list.length <= state.limit;
  fitDetail();
}

// keeps the open wallet's breakdown inside the visible part of a sideways-scrolling table
function fitDetail(){
  const d = document.querySelector(".lbdetail"), box = document.querySelector(".tablebox");
  if (d && box) d.style.width = box.clientWidth + "px";
}

function detailRow(r){
  const rows = r.syms.map(([sym, qty, cash, pnl, vol, n]) => `<tr>
      <td>${stockChip(sym)}</td>
      <td class="r num">${fmtQty(qty)}</td>
      <td class="r num hm">${fmtPnl(cash)}</td>
      <td class="r num"><span class="${pnlClass(pnl)}">${fmtPnl(pnl)}</span></td>
      <td class="r num hm">${fmtUsd(vol)}</td>
      <td class="r num hm">${fmtN(n)}</td>
    </tr>`).join("");
  return `<tr class="detail"><td colspan="6"><div class="lbdetail">
      <table class="lbsub">
        <thead><tr><th>Stock</th><th class="r" title="Tokens bought (+) or sold (−)">Tokens</th><th class="r hm" title="Dollars received (+) or paid (−)">Cash</th><th class="r">Profit</th><th class="r hm">Volume</th><th class="r hm">Trades</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="lbfoot"><span class="num">${esc(r.a)}</span> · <a href="${EXPLORER + esc(r.a)}" target="_blank" rel="noopener">View on Blockscout ↗</a></p>
    </div></td></tr>`;
}

function renderChips(){
  document.querySelectorAll(".chip[data-win]").forEach(b => b.setAttribute("aria-pressed", b.dataset.win === state.win));
  document.querySelectorAll(".chip[data-rank]").forEach(b => b.setAttribute("aria-pressed", b.dataset.rank === state.rank));
}

function render(){ renderChips(); renderGauge(); renderNote(); renderTable(); }

/* ---------- events ---------- */
document.addEventListener("click", e => {
  const w = e.target.closest(".chip[data-win]");
  if (w && state.data) { state.win = w.dataset.win; state.limit = PAGE; state.open = null; render(); return; }
  const k = e.target.closest(".chip[data-rank]");
  if (k && state.data) { state.rank = k.dataset.rank; state.limit = PAGE; renderChips(); renderTable(); return; }
  const t = e.target.closest("tr.srow");
  if (t && !e.target.closest("a")) {
    const a = t.dataset.addr;
    state.open = state.open === a ? null : a;
    renderTable();
    document.querySelector(`tr[data-addr="${a}"] button.wallet`)?.focus();
  }
});
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(fitDetail, 120); });
$("showMore").addEventListener("click", () => { state.limit += PAGE; renderTable(); });
$("showBots").addEventListener("change", e => { state.bots = e.target.checked; state.limit = PAGE; if (state.data) { renderTable(); } });
$("q").addEventListener("input", e => { state.q = e.target.value; state.limit = PAGE; if (state.data) renderTable(); });

load();
})();
