// Params whose values must never be written to disk, logs or API responses.
const SECRET_KEY = /password|secret|token|api[_-]?key/i;

export function isSecretKey(key) {
  return SECRET_KEY.test(key);
}

export function maskParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    out[key] = isSecretKey(key) ? "******" : value;
  }
  return out;
}

// Navigation tools may echo credentials as raw text or URL-encoded query values.
export function maskSecrets(text, params) {
  let out = String(text);
  const variants = new Set();
  for (const [key, value] of Object.entries(params || {})) {
    if (!isSecretKey(key) || !value) continue;
    const secret = String(value);
    variants.add(secret);
    try { variants.add(encodeURIComponent(secret)); } catch { /* malformed Unicode: still mask raw */ }
    variants.add(new URLSearchParams({ value: secret }).toString().slice("value=".length));
  }
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    // Percent-encoded hex is case insensitive; the rest of a key is not.
    const pattern = secret.match(/%[0-9a-f]{2}|[\s\S]/gi).map((part) => {
      if (/^%[0-9a-f]{2}$/i.test(part)) {
        return part.replace(/[a-f]/gi, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    out = out.replace(new RegExp(pattern, "g"), () => "******");
  }
  return out;
}
