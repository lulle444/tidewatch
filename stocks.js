/* Stock tracker: every Robinhood Chain stock token, its on-chain price next to the real share price. */
(function(){
"use strict";
const API_URL = "/api/stocks";
const HIST_URL = "/api/stock-history?symbol=";
const TG_BOT = "Usetidewatch_bot";
const RANGES = {"24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5};
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

const state = {rows:[], view:"all", minLiq:THIN, q:"", sort:"tokenized", dir:-1, limit:PAGE, paused:false, open:null, range:"7d"};
const history = new Map();   // symbol -> [[time ms, gap, share price, on-chain price], ...]
const BELL = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const startOf = sym => "s_" + sym.replace(/\./g, "-");

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
    const firstLoad = !state.loaded; state.loaded = true;
    if (firstLoad && state.open){   // make sure a linked token is on screen
      const i = filtered().sort((a, b) => (b.tokenized ?? -1) - (a.tokenized ?? -1)).findIndex(r => r.symbol === state.open);
      if (i < 0) state.open = null; else state.limit = Math.max(PAGE, Math.ceil((i + 1) / PAGE) * PAGE);
    }
    render();
    if (firstLoad && state.open) $("rows").querySelector("tr.detail")?.scrollIntoView({block:"center"});
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
  $("rows").innerHTML = shown.length ? shown.map(r => `<tr class="srow${state.open === r.symbol ? " is-open" : ""}" data-sym="${esc(r.symbol)}">
      <td><button class="ticker" type="button" aria-expanded="${state.open === r.symbol}" aria-label="${esc(r.symbol)}, ${esc(r.name)}: show the price-gap chart">${r.logo ? `<img src="${esc(r.logo)}" alt="" width="28" height="28" loading="lazy" onerror="this.remove()">` : ""}<span class="proto"><b class="asset">${esc(r.symbol)}</b><span>${esc(r.name)}</span></span><span class="chev" aria-hidden="true">›</span></button></td>
      <td class="r">${gapCell(r)}</td>
      <td class="r num">${fmtPrice(r.ref)}${r.stale ? '<small class="sub2">paused</small>' : ""}</td>
      <td class="r num">${fmtPrice(r.onchain)}${r.pool ? `<small class="sub2">${esc(r.pool.quote || "")} pool</small>` : ""}</td>
      <td class="r num">${fmtUsd(r.liquidity)}${r.thin && r.onchain != null ? '<small class="sub2 warn">thin</small>' : ""}</td>
      <td class="r num">${fmtUsd(r.volume24h)}</td>
      <td class="r"><div class="acts">${r.pool && r.pool.url ? `<a class="trade" href="${esc(r.pool.url)}" target="_blank" rel="noopener" aria-label="View the ${esc(r.symbol)} pool on DexScreener">Pool ↗</a>` : ""}${bell(r)}</div></td>
    </tr>${state.open === r.symbol ? detailRow(r) : ""}`).join("") : `<tr><td colspan="7" class="empty">No stock tokens match these filters.</td></tr>`;
  set("count", `Showing ${shown.length} of ${list.length} tokens`);
  if (state.open && shown.some(r => r.symbol === state.open)) drawChart();
  $("showMore").hidden = list.length <= state.limit;
  document.querySelectorAll("th button[data-sort]").forEach(b => {
    const on = b.dataset.sort === state.sort;
    b.closest("th").setAttribute("aria-sort", on ? (state.dir > 0 ? "ascending" : "descending") : "none");
    b.textContent = b.textContent.replace(/ [↓↑]$/, "") + (on ? (state.dir < 0 ? " ↓" : " ↑") : "");
  });
}

function bell(r){
  return `<a class="bell" href="https://t.me/${TG_BOT}?start=${startOf(r.symbol)}" target="_blank" rel="noopener" data-sym="${esc(r.symbol)}" data-label="${esc(r.symbol)} · ${esc(r.name)}" title="Get a Telegram alert when ${esc(r.symbol)} drifts from its share price" aria-label="Get a Telegram alert for ${esc(r.symbol)}">${BELL}</a>`;
}

/* ---------- price-gap chart ---------- */
function detailRow(r){
  const chips = Object.keys(RANGES).map(k => `<button class="chip" type="button" data-range="${k}" aria-pressed="${k === state.range}">${k}</button>`).join("");
  return `<tr class="detail"><td colspan="7"><div class="gapchart" id="gapchart">
    <div class="gchead">
      <div><h3>${esc(r.symbol)} price gap</h3><p>How far the on-chain price sat from the share price, hourly while the US market is open. Above zero is a premium, below is a discount.</p></div>
      <div class="gctools"><div class="chips" role="group" aria-label="Time range">${chips}</div>${bell(r).replace('class="bell"', 'class="btn ghost small bellbtn"').replace(BELL, BELL + " Alert me")}</div>
    </div>
    <div class="gcplot" id="gcplot"><p class="muted">Loading history…</p></div>
    <p class="gcnote" id="gcnote"></p>
  </div></td></tr>`;
}

async function loadHistory(sym){
  if (history.has(sym)) return history.get(sym);
  let pts = [];
  try {
    const r = await fetch(HIST_URL + encodeURIComponent(sym));
    if (r.ok) pts = (await r.json()).points || [];
  } catch (e) {}
  history.set(sym, pts);
  return pts;
}

function niceStep(span){
  for (const s of [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) if (span / s <= 5) return s;
  return 1;
}
const fmtTime = (t, span) => new Date(t).toLocaleString("en-US", span > 2 * 864e5 ? {month:"short", day:"numeric"} : {hour:"2-digit", minute:"2-digit"});
const fmtWhen = t => new Date(t).toLocaleString("en-US", {weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});

async function drawChart(){
  const sym = state.open, row = state.rows.find(r => r.symbol === sym), box = $("gcplot"), note = $("gcnote");
  if (!row || !box) return;
  // keep the chart inside the visible part of the horizontally scrolling table
  const tb = box.closest(".tablebox"); $("gapchart").style.width = Math.max(260, tb.clientWidth - 2) + "px";
  const saved = await loadHistory(sym);
  if (state.open !== sym || !$("gcplot")) return;
  const now = Date.now(), from = now - RANGES[state.range];
  const pts = saved.filter(p => p[0] >= from);
  if (!row.stale && row.gap != null && row.liquidity >= THIN && (!pts.length || now - pts[pts.length - 1][0] > 10 * 60000))
    pts.push([now, row.gap, row.ref, row.onchain]);   // the live reading, so the line ends at "now"
  const first = saved.length ? saved[0][0] : null;
  note.textContent = !saved.length
    ? (row.liquidity >= THIN ? "History starts today: we save one reading an hour while the US market is open, so this chart fills in over the coming days." : "This token’s deepest pool is under $10k, so we don’t chart it. Thin pools swing on single trades.")
    : first > from ? `History starts ${fmtWhen(first)}.` : "";
  if (!pts.length){ box.innerHTML = `<p class="muted">No readings in this range yet.</p>`; return; }

  const W = box.clientWidth, H = 220, L = 52, R = 16, T = 12, B = 26;
  const t0 = Math.min(pts[0][0], now - RANGES[state.range] * (pts.length > 1 ? 0 : 1)), t1 = now;
  const gaps = pts.map(p => p[1]);
  let lo = Math.min(-0.01, ...gaps.map(g => g * 1.15)), hi = Math.max(0.01, ...gaps.map(g => g * 1.15));
  const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R), y = g => T + (hi - g) / (hi - lo) * (H - T - B);
  const ticks = []; for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
  const nx = W < 480 ? 3 : 4, xt = Array.from({length: nx}, (_, i) => t0 + (t1 - t0) * (i + 0.5) / nx);
  // break the line where readings are more than 3 hours apart (market closed, missed runs)
  const segs = []; let cur = [];
  pts.forEach((p, i) => { if (i && p[0] - pts[i - 1][0] > 3 * 36e5){ segs.push(cur); cur = []; } cur.push(p); }); segs.push(cur);
  const path = segs.map(sg => sg.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")).join("");
  const lone = segs.filter(sg => sg.length === 1).map(sg => sg[0]);
  const last = pts[pts.length - 1];
  box.innerHTML = `<svg class="gcsvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(sym)} price gap over the last ${state.range}. Latest ${fmtGap(last[1])}. Use the arrow keys to read values.">
      <rect class="fairband" x="${L}" y="${y(FAIR)}" width="${W - L - R}" height="${y(-FAIR) - y(FAIR)}"/>
      <text class="fairlbl" x="${W - R - 6}" y="${y(FAIR) + 12}" text-anchor="end">Fair ±0.5%</text>
      ${ticks.map(v => `<line class="${Math.abs(v) < 1e-9 ? "zero" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ylbl" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtGap(v).replace(".00%", "%")}</text>`).join("")}
      ${xt.map(t => `<text class="xlbl" x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(fmtTime(t, t1 - t0))}</text>`).join("")}
      <path class="gline" d="${path}"/>
      ${lone.map(p => `<circle class="gdot" cx="${x(p[0])}" cy="${y(p[1])}" r="4"/>`).join("")}
      <circle class="gdot end" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/>
      <line class="xhair" id="xhair" y1="${T}" y2="${H - B}" hidden/><circle class="gdot hov" id="hovdot" r="5" hidden/>
    </svg><div class="gctip" id="gctip" hidden></div>`;
  const svg = box.querySelector("svg"), tip = $("gctip"), xh = $("xhair"), hd = $("hovdot");
  let idx = pts.length - 1;
  const show = i => {
    idx = Math.max(0, Math.min(pts.length - 1, i)); const p = pts[idx], px = x(p[0]), py = y(p[1]);
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); hd.setAttribute("cx", px); hd.setAttribute("cy", py);
    xh.hidden = hd.hidden = tip.hidden = false;
    const band = p[1] > FAIR ? "premium" : p[1] < -FAIR ? "discount" : "fair";
    tip.innerHTML = `<b class="num"></b> <span class="tb"></span><small></small><small class="num"></small>`;
    tip.children[0].textContent = fmtGap(p[1]); tip.children[1].textContent = band;
    tip.children[2].textContent = idx === pts.length - 1 && now - p[0] < 10 * 60000 ? "Now" : fmtWhen(p[0]);
    tip.children[3].textContent = `On chain ${fmtPrice(p[3])} · Share ${fmtPrice(p[2])}`;
    const tw = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + "px"; tip.style.top = Math.max(0, py - tip.offsetHeight - 14) + "px";
  };
  const hide = () => { xh.hidden = hd.hidden = tip.hidden = true; };
  svg.addEventListener("pointermove", e => {
    const bx = svg.getBoundingClientRect().left, t = t0 + (e.clientX - bx - L) / (W - L - R) * (t1 - t0);
    let best = 0; pts.forEach((p, i) => { if (Math.abs(p[0] - t) < Math.abs(pts[best][0] - t)) best = i; }); show(best);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(idx)); svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight"){ e.preventDefault(); show(idx + (e.key === "ArrowLeft" ? -1 : 1)); }
    else if (e.key === "Home" || e.key === "End"){ e.preventDefault(); show(e.key === "Home" ? 0 : pts.length - 1); }
  });
}

/* ---------- Telegram alert dialog (desktop; phones open the Telegram app straight away) ---------- */
function alertDialog(sym, label){
  let d = $("alertDlg");
  if (!d){
    d = document.createElement("dialog"); d.id = "alertDlg"; d.className = "alertdlg glass";
    d.setAttribute("aria-labelledby", "alertDlgH");
    d.innerHTML = `<form method="dialog"><button class="dlgx" aria-label="Close">×</button></form>
      <p class="eyebrow">Telegram alert</p><h3 id="alertDlgH"></h3>
      <p class="dlgsub">Open our bot, tap Start and pick how big a price gap to watch. We check every 15 minutes while the US market is open.</p>
      <div class="dlgbtns"><a class="btn primary" id="dlgApp" target="_blank" rel="noopener">Open Telegram app</a><a class="btn ghost" id="dlgWeb" target="_blank" rel="noopener">Open Telegram Web</a></div>
      <p class="dlgsub">Bot doesn’t show the token? Send it this message:</p>
      <div class="dlgcmd"><code id="dlgCmd"></code><button class="btn ghost small" id="dlgCopy" type="button">Copy</button></div>`;
    document.body.appendChild(d);
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    $("dlgCopy").addEventListener("click", () => {
      navigator.clipboard?.writeText($("dlgCmd").textContent).then(() => { $("dlgCopy").textContent = "Copied"; }, () => {});
    });
  }
  const start = startOf(sym);
  $("alertDlgH").textContent = label;
  $("dlgApp").href = `https://t.me/${TG_BOT}?start=${start}`;
  $("dlgWeb").href = "https://web.telegram.org/k/#?tgaddr=" + encodeURIComponent(`tg://resolve?domain=${TG_BOT}&start=${start}`);
  $("dlgCmd").textContent = "/gap " + sym + " 1";
  $("dlgCopy").textContent = "Copy";
  d.showModal();
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
  if (e.target.closest("#showMore")){ state.limit += PAGE; renderTable(); return; }
  const bl = e.target.closest(".bell, .bellbtn");
  if (bl){
    if (matchMedia("(pointer: coarse)").matches || typeof HTMLDialogElement !== "function") return;
    e.preventDefault(); alertDialog(bl.dataset.sym, bl.dataset.label); return;
  }
  const rg = e.target.closest("[data-range]");
  if (rg){
    state.range = rg.dataset.range;
    document.querySelectorAll("[data-range]").forEach(x => x.setAttribute("aria-pressed", x === rg ? "true" : "false"));
    drawChart(); return;
  }
  const tr = e.target.closest("tr.srow");
  if (tr && !e.target.closest("a")){
    state.open = state.open === tr.dataset.sym ? null : tr.dataset.sym;
    renderTable();
    if (state.open) $("rows").querySelector(`tr.srow[data-sym="${CSS.escape(state.open)}"] .ticker`)?.focus();
  }
});
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (state.open && $("gcplot")) drawChart(); }, 150); });
$("minLiq").addEventListener("change", e => { state.minLiq = +e.target.value; state.limit = PAGE; renderTable(); });
$("q").addEventListener("input", e => { state.q = e.target.value; state.limit = PAGE; renderTable(); });

// ?s=TSLA (the link in an alert) opens that token's chart, whatever the filters
const deep = new URLSearchParams(location.search).get("s");
if (deep && /^[A-Za-z0-9.]{1,12}$/.test(deep)){ state.open = deep.toUpperCase(); state.minLiq = 0; $("minLiq").value = "0"; }

load();
setInterval(() => { if (!document.hidden) load(); }, 120000);
})();
