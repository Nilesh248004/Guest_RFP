import crypto from "node:crypto";
import config from "./config.js";

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function extractKey(req) {
  const headerKey = req.get("x-api-key");
  if (headerKey) return headerKey.trim();
  const auth = req.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

export function apiKeyAuth(req, res, next) {
  if (config.authDisabled) return next();

  const provided = extractKey(req);
  if (!provided) {
    return res.status(401).json({ error: "Missing API key (x-api-key or Authorization: Bearer)" });
  }
  const valid = config.apiKeys.some((k) => timingSafeEqual(k, provided));
  if (!valid) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  next();
}
