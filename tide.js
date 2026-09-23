/* Tide background (the drifting light behind it is CSS, see body::before/::after): rolling swells, tide-chart lines that react to the pointer
   and to scrolling, plus a few sun glints. A single still frame for reduced-motion users. */
(function(){
"use strict";
const c = document.getElementById("tide");
const ctx = c && c.getContext("2d");
if (!ctx) return;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let w = 0, h = 0, t = 0, last = 0, raf = 0, scroll = 0, sScroll = 0;
const ptr = {x: -1e4, y: -1e4, sx: -1e4, sy: -1e4, on: 0, s: 0};

const SWELLS = [
  {y: .80, amp: 22, len: 900, sp: .30, top: "rgba(43,181,176,.10)", bot: "rgba(13,116,128,.16)"},
  {y: .86, amp: 18, len: 650, sp: -.42, top: "rgba(58,141,222,.10)", bot: "rgba(13,92,115,.18)"},
  {y: .92, amp: 14, len: 480, sp: .55, top: "rgba(43,181,176,.12)", bot: "rgba(13,92,115,.15)"},
];
let glints = [];

function size(){
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  w = c.clientWidth; h = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(46, w * h / 32000));
  glints = Array.from({length: n}, () => ({x: Math.random(), y: Math.random(), r: .6 + Math.random() * 1.6,
    v: .004 + Math.random() * .01, ph: Math.random() * 6.3, tw: .8 + Math.random() * 1.6}));
}

function lines(){
  const n = 14, drift = sScroll * .12;
  ctx.lineWidth = 1.25;
  for (let i = 0; i < n; i++){
    const span = h * 1.05, gap = span / n;
    const y0 = ((i * gap - drift * (.6 + i * .03)) % span + span) % span - h * .02;
    const amp = 12 + i * 2.2;
    const k = (2 * Math.PI) / (420 + i * 36);
    const sp = .38 + i * .025;
    ctx.beginPath();
    for (let x = -10; x <= w + 12; x += 12){
      const dx = x - ptr.sx, dy = y0 - ptr.sy;
      const pull = ptr.s * 38 * Math.exp(-(dx * dx) / 26000 - (dy * dy) / 16000);
      const y = y0 + Math.sin(x * k + t * sp + i * .8) * amp
                   + Math.sin(x * k * .43 - t * sp * .6 + i * 1.3) * amp * .65
                   + Math.sin(x * k * 2.1 + t * sp * 1.7) * amp * .12
                   - pull * Math.cos(dx / 70 - t * 3);
      if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    const g = ctx.createLinearGradient(0, 0, w, 0);
    const a = .30 - i * .012, s = (Math.sin(t * .5 + i * .6) + 1) / 2;
    g.addColorStop(0, `rgba(13,116,128,${a * .5})`);
    g.addColorStop(.15 + .7 * s, `rgba(43,181,176,${a * 1.25})`);
    g.addColorStop(1, `rgba(13,116,128,${a * .5})`);
    ctx.strokeStyle = g; ctx.stroke();
  }
}

function swells(){
  for (const S of SWELLS){
    const base = h * S.y + sScroll * .04, k = (2 * Math.PI) / S.len;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w + 16; x += 16){
      ctx.lineTo(x, base + Math.sin(x * k + t * S.sp) * S.amp + Math.sin(x * k * 2.3 - t * S.sp * 1.4) * S.amp * .35);
    }
    ctx.lineTo(w, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, base - S.amp, 0, h);
    g.addColorStop(0, S.top); g.addColorStop(1, S.bot);
    ctx.fillStyle = g; ctx.fill();
  }
}

function sparkle(){
  ctx.globalCompositeOperation = "lighter";
  for (const p of glints){
    const y = ((p.y - t * p.v) % 1 + 1) % 1;
    const x = p.x + .01 * Math.sin(t * .6 + p.ph);
    const a = Math.max(0, Math.sin(t * p.tw + p.ph)) ** 3 * .75;
    if (a < .02) continue;
    const X = x * w, Y = y * h, R = p.r * 4;
    const g = ctx.createRadialGradient(X, Y, 0, X, Y, R);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(X - R, Y - R, R * 2, R * 2);
  }
  ctx.globalCompositeOperation = "source-over";
}

function draw(){
  ctx.clearRect(0, 0, w, h);
  swells(); lines(); sparkle();
}

function frame(now){
  raf = requestAnimationFrame(frame);
  const dt = last ? Math.min(now - last, 100) : 0;
  if (last && dt < 30) return;              // ~30 fps keeps it smooth and light
  last = now; t += dt / 1000;
  const e = 1 - Math.pow(.001, dt / 1000);  // frame-rate independent easing
  ptr.sx += (ptr.x - ptr.sx) * e * 1.6; ptr.sy += (ptr.y - ptr.sy) * e * 1.6;
  ptr.s += (ptr.on - ptr.s) * e * .8;
  sScroll += (scroll - sScroll) * e;
  draw();
}
function start(){
  cancelAnimationFrame(raf); last = 0;
  if (reduce.matches || document.hidden){ sScroll = scroll; draw(); } else raf = requestAnimationFrame(frame);
}

size(); scroll = sScroll = window.scrollY; start();
window.addEventListener("resize", () => { size(); draw(); });
window.addEventListener("scroll", () => { scroll = window.scrollY; if (reduce.matches) { sScroll = scroll; draw(); } }, {passive: true});
window.addEventListener("pointermove", e => {
  if (e.pointerType !== "mouse" || reduce.matches) return;
  ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = 1;
  if (ptr.sx < -1e3) { ptr.sx = ptr.x; ptr.sy = ptr.y; }
}, {passive: true});
document.documentElement.addEventListener("pointerleave", () => { ptr.on = 0; });
document.addEventListener("visibilitychange", start);
reduce.addEventListener("change", start);
})();
