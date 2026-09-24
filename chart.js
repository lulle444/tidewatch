/* Small SVG line chart shared by the yields table and the stock tracker: one y-axis, a crosshair that snaps
   to the nearest reading, a tooltip listing every series, arrow-key reading, and breaks across data gaps. */
(function(){
"use strict";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function niceStep(span){
  const raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}
const fmtAxisTime = (t, span) => new Date(t).toLocaleString("en-US", span > 2 * 864e5 ? {month:"short", day:"numeric"} : {hour:"2-digit", minute:"2-digit"});
const fmtWhen = (t, daily) => new Date(t).toLocaleString("en-US", daily ? {weekday:"short", month:"short", day:"numeric", year:"numeric"} : {weekday:"short", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});

/* opts: series [{name, cls, pts:[[t, v], ...]}] (all series share the first one's timestamps),
   fmt(v) for axis and tooltip values, t0/t1 (x domain), include [values the y-axis must show],
   band {lo, hi, label}, zero (draw a stronger 0 line), breakMs (gap that splits the line),
   daily (tooltip dates without times), extra(i) -> extra tooltip line, label (for screen readers). */
function draw(box, o){
  const main = o.series[0].pts;
  if (!main.length){ box.innerHTML = `<p class="muted">No readings in this range yet.</p>`; return; }
  const W = box.clientWidth, H = o.height || 220, L = 52, R = 16, T = 12, B = 26;
  const t0 = o.t0 ?? main[0][0], t1 = Math.max(o.t1 ?? main[main.length - 1][0], t0 + 1);
  const vals = o.series.flatMap(s => s.pts.map(p => p[1])).concat(o.include || []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad;
  if (o.floor != null) lo = Math.max(lo, o.floor);
  const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R), y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = []; for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toPrecision(12));
  const nx = W < 480 ? 3 : 4, xt = Array.from({length: nx}, (_, i) => t0 + (t1 - t0) * (i + 0.5) / nx);
  const lineOf = pts => {
    const segs = []; let cur = [];
    pts.forEach((p, i) => { if (i && o.breakMs && p[0] - pts[i - 1][0] > o.breakMs){ segs.push(cur); cur = []; } cur.push(p); }); segs.push(cur);
    return {d: segs.map(sg => sg.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("")).join(""), lone: segs.filter(sg => sg.length === 1).map(sg => sg[0])};
  };
  const lines = o.series.map(s => ({s, ...lineOf(s.pts)}));
  const last = main[main.length - 1];
  box.innerHTML = `<svg class="gcsvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(o.label)} Latest ${esc(o.fmt(last[1]))}. Use the arrow keys to read values.">
      ${o.band ? `<rect class="fairband" x="${L}" y="${y(o.band.hi)}" width="${W - L - R}" height="${y(o.band.lo) - y(o.band.hi)}"/><text class="fairlbl" x="${W - R - 6}" y="${y(o.band.hi) + 12}" text-anchor="end">${esc(o.band.label)}</text>` : ""}
      ${ticks.map(v => `<line class="${o.zero && Math.abs(v) < step / 1e6 ? "zero" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ylbl" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(o.axisFmt ? o.axisFmt(v) : o.fmt(v))}</text>`).join("")}
      ${xt.map(t => `<text class="xlbl" x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(fmtAxisTime(t, t1 - t0))}</text>`).join("")}
      ${lines.slice().reverse().map(l => `<path class="gline ${l.s.cls || ""}" d="${l.d}"/>${l.lone.map(p => `<circle class="gdot ${l.s.cls || ""}" cx="${x(p[0])}" cy="${y(p[1])}" r="4"/>`).join("")}`).join("")}
      <circle class="gdot end" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/>
      <line class="xhair" y1="${T}" y2="${H - B}" hidden/>${o.series.map(s => `<circle class="gdot hov ${s.cls || ""}" r="5" hidden/>`).join("")}
    </svg><div class="gctip" hidden></div>`;
  const svg = box.querySelector("svg"), tip = box.querySelector(".gctip"), xh = svg.querySelector(".xhair"), dots = [...svg.querySelectorAll(".hov")];
  let idx = main.length - 1;
  const show = i => {
    idx = Math.max(0, Math.min(main.length - 1, i));
    const px = x(main[idx][0]);
    xh.setAttribute("x1", px); xh.setAttribute("x2", px); xh.hidden = tip.hidden = false;
    tip.textContent = "";
    const when = document.createElement("small"); when.className = "when";
    when.textContent = o.whenText ? o.whenText(idx) : fmtWhen(main[idx][0], o.daily);
    tip.appendChild(when);
    o.series.forEach((s, k) => {
      const p = s.pts[idx]; dots[k].hidden = !p;
      if (!p) return;
      dots[k].setAttribute("cx", px); dots[k].setAttribute("cy", y(p[1]));
      const row = document.createElement("div"); row.className = "tiprow";
      const key = document.createElement("i"); key.className = "key " + (s.cls || "");
      const v = document.createElement("b"); v.className = "num"; v.textContent = o.fmt(p[1]);
      const n = document.createElement("span"); n.textContent = s.tipName ? s.tipName(p) : s.name;
      if (o.series.length > 1) row.appendChild(key);
      row.append(v, " ", n); tip.appendChild(row);
    });
    if (o.extra){ const ex = document.createElement("small"); ex.className = "num"; ex.textContent = o.extra(idx); tip.appendChild(ex); }
    const tw = tip.offsetWidth, top = Math.min(...o.series.map(s => s.pts[idx] ? y(s.pts[idx][1]) : H));
    tip.style.left = Math.max(0, Math.min(W - tw, px - tw / 2)) + "px";
    tip.style.top = Math.max(0, top - tip.offsetHeight - 14) + "px";
  };
  const hide = () => { xh.hidden = tip.hidden = true; dots.forEach(d => d.hidden = true); };
  svg.addEventListener("pointermove", e => {
    const t = t0 + (e.clientX - svg.getBoundingClientRect().left - L) / (W - L - R) * (t1 - t0);
    let best = 0; main.forEach((p, i) => { if (Math.abs(p[0] - t) < Math.abs(main[best][0] - t)) best = i; }); show(best);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(idx)); svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight"){ e.preventDefault(); show(idx + (e.key === "ArrowLeft" ? -1 : 1)); }
    else if (e.key === "Home" || e.key === "End"){ e.preventDefault(); show(e.key === "Home" ? 0 : main.length - 1); }
  });
}

window.TWChart = {draw, fmtWhen};
})();
