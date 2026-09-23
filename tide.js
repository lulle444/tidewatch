/* Tide background: slow drifting wave lines, like a tide chart. Static for reduced-motion users. */
(function(){
"use strict";
const c = document.getElementById("tide");
const ctx = c && c.getContext("2d");
if (!ctx) return;
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const darkQ = matchMedia("(prefers-color-scheme: dark)");
let w = 0, h = 0, t = 0, last = 0, raf = 0, accent = "#0B7A72";

function readAccent(){ accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || accent; }
function size(){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  w = c.clientWidth; h = c.clientHeight;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function draw(){
  ctx.clearRect(0, 0, w, h);
  const lines = 13;
  ctx.strokeStyle = accent; ctx.lineWidth = 1.2;
  for (let i = 0; i < lines; i++){
    const y0 = h * (0.06 + i * 0.075);
    const amp = 9 + i * 1.8;
    const k = (2 * Math.PI) / (460 + i * 40);
    const sp = 0.16 + i * 0.012;
    ctx.beginPath();
    for (let x = 0; x <= w + 10; x += 10){
      const y = y0 + Math.sin(x * k + t * sp + i * 0.8) * amp
                   + Math.sin(x * k * 0.41 - t * sp * 0.55 + i * 1.3) * amp * 0.6;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = 0.26 - i * 0.013;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function frame(now){
  raf = requestAnimationFrame(frame);
  const dt = last ? Math.min(now - last, 100) : 0;
  if (last && dt < 33) return;              // ~30 fps is plenty for a slow tide
  last = now; t += dt / 1000; draw();
}
function start(){ cancelAnimationFrame(raf); last = 0; if (reduce.matches || document.hidden) draw(); else raf = requestAnimationFrame(frame); }

readAccent(); size(); start();
window.addEventListener("resize", () => { size(); draw(); });
document.addEventListener("visibilitychange", start);
reduce.addEventListener("change", start);
darkQ.addEventListener("change", () => { readAccent(); draw(); });
new MutationObserver(() => { readAccent(); draw(); }).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});
})();
