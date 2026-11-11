const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Session secret: SESSION_SECRET env var if it is a real value, otherwise a
// random secret generated once and persisted next to the database.
const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'tapmenu-secret-change-me-in-production'
]);

function getSessionSecret(dataDir) {
  const env = process.env.SESSION_SECRET;
  if (env && env.length >= 16 && !PLACEHOLDER_SECRETS.has(env)) return env;
  if (env) console.warn('⚠️  SESSION_SECRET is unset, too short, or a placeholder; using a generated secret instead.');

  const file = path.join(dataDir, '.session_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (e) { /* not created yet */ }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// Minimal in-memory fixed-window rate limiter keyed by client IP.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests, try again later' });
    }
    next();
  };
}

// Allow only http(s) URLs or site-relative paths (e.g. /uploads/x.png).
function isSafeUrl(value) {
  if (value === undefined || value === null || value === '') return true;
  const s = String(value).trim();
  if (/^\/(?!\/)/.test(s)) return !/[\u0000-\u001f\\]/.test(s);
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

const TAP_STATUSES = ['active', 'coming-soon', 'kicked', 'inactive', 'hidden', 'deleted'];

// Validates the security-relevant fields of a tap/beer payload (only those present).
// Returns an error string, or null if valid.
function validateTapInput(body) {
  const b = body || {};
  if (b.status !== undefined && b.status !== null && !TAP_STATUSES.includes(b.status)) return 'Invalid status';
  if (b.category !== undefined && b.category !== null && b.category !== '' && !/^[A-Za-z0-9 _-]{1,40}$/.test(b.category)) return 'Invalid category';
  if (b.color !== undefined && b.color !== null && b.color !== '' && !/^#[0-9a-fA-F]{3,8}$/.test(b.color)) return 'Color must be a hex value like #f59e0b';
  if (b.keg_level !== undefined && b.keg_level !== null && b.keg_level !== '') {
    const n = Number(b.keg_level);
    if (!Number.isFinite(n) || n < 0 || n > 100) return 'keg_level must be 0-100';
  }
  for (const f of ['untappd_url', 'image_url']) {
    if (!isSafeUrl(b[f])) return `${f} must be an http(s) URL`;
  }
  return null;
}

module.exports = { getSessionSecret, rateLimit, isSafeUrl, validateTapInput };
