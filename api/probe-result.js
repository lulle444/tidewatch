// Temporary: shows the last probe run.
const { redis } = require("../lib/store");
module.exports = async (req, res) => { res.setHeader("cache-control", "no-store"); res.json(JSON.parse(await redis("GET", "tw:probe") || "null")); };
