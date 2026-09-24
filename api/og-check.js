// Temporary: renders every share preview and reports size and timing.
const og = require("./og");
module.exports = async (req, res) => {
  const out = {};
  for (const p of ["home", "yields", "stocks", "leaderboard", "new"]) {
    const t = Date.now();
    const r = {h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.c = c; return this; }, end(b) { this.b = b; }, redirect(c, u) { this.c = c; this.loc = u; }};
    await og({query: {p}}, r);
    out[p] = {status: r.c, type: r.h["Content-Type"] || null, bytes: r.b ? r.b.length : 0, redirect: r.loc || null, ms: Date.now() - t};
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
};
