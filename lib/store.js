// Tiny Upstash Redis client over its REST API (the env vars Vercel's Upstash integration adds).
const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function call(path, body){
  if (!BASE || !TOKEN) throw new Error("database not connected (Upstash env vars missing)");
  const r = await fetch(BASE.replace(/\/$/, "") + path, {
    method: "POST", headers: {authorization: `Bearer ${TOKEN}`, "content-type": "application/json"},
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("redis: " + (j.error || r.status));
  return j;
}
const redis = async (...cmd) => (await call("", cmd)).result;
const pipeline = async cmds => cmds.length ? (await call("/pipeline", cmds)).map(x => x.result) : [];

module.exports = {redis, pipeline};
