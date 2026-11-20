'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'patente_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Ephemeral fallback secret if SESSION_SECRET is not configured in .env
const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[SECURITY] ADMIN_PASSWORD non impostata in .env! Uso password predefinita "admin1234" — cambiala subito in produzione.');
}

// Simple in-memory login rate limiter (max 10 failed attempts per 15 min per IP)
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILS = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (now - entry.firstFail > RATE_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (entry.count >= MAX_LOGIN_FAILS) {
    const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - entry.firstFail)) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstFail > RATE_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstFail: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

/**
 * Constant-time password verification via SHA-256 + timingSafeEqual.
 */
function verifyPassword(inputPassword) {
  if (typeof inputPassword !== 'string') return false;
  const h1 = crypto.createHash('sha256').update(inputPassword).digest();
  const h2 = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/**
 * Create HMAC-signed session token: base64url(payload).base64url(sig)
 */
function createSessionToken() {
  const payload = JSON.stringify({
    role: 'admin',
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.role !== 'admin') return false;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse Cookie header safely without extra dependencies.
 */
function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, token) {
  const secure = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const secure = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
  const parts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Non autenticato. Effettua il login admin.' });
  }
  return next();
}

module.exports = {
  checkRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  verifyPassword,
  createSessionToken,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
};
