const crypto = require('crypto');

const DEFAULT_PUBLIC_COOKIE_NAME = '__Host-fluid_session';
const DEFAULT_PUBLIC_CSRF_COOKIE_NAME = '__Host-fluid_csrf';
const DEFAULT_PUBLIC_APP_ORIGIN = 'https://askfluid.now';
const DEFAULT_MIGRATION_DEADLINE = '2026-08-15';
const CSRF_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function envFlag(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

function isPublicCookieAuthEnabled() {
  return envFlag('PUBLIC_COOKIE_AUTH_ENABLED', false);
}

function isPublicBearerAuthLegacyEnabled() {
  return envFlag('PUBLIC_BEARER_AUTH_LEGACY_ENABLED', false);
}

function getPublicAuthMigrationDeadline() {
  return process.env.PUBLIC_AUTH_MIGRATION_DEADLINE || DEFAULT_MIGRATION_DEADLINE;
}

function getPublicSessionCookieName() {
  return process.env.PUBLIC_COOKIE_NAME || DEFAULT_PUBLIC_COOKIE_NAME;
}

function getPublicCsrfCookieName() {
  return process.env.PUBLIC_CSRF_COOKIE_NAME || DEFAULT_PUBLIC_CSRF_COOKIE_NAME;
}

function getPublicAppOrigin() {
  return (process.env.PUBLIC_APP_ORIGIN || DEFAULT_PUBLIC_APP_ORIGIN).replace(/\/+$/, '');
}

function getPublicCookieSameSite() {
  return 'lax';
}

function shouldUseSecureCookie(name = getPublicSessionCookieName()) {
  return process.env.NODE_ENV === 'production'
    || String(name).startsWith('__Host-')
    || envFlag('PUBLIC_COOKIE_SECURE', false);
}

function parseCookieHeader(req) {
  const cookies = {};
  const header = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';

  header.split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (error) {
      cookies[name] = '';
    }
  });

  return cookies;
}

function getCookieValue(req, name) {
  return parseCookieHeader(req)[name] || '';
}

function getPublicSessionCookieValue(req) {
  return getCookieValue(req, getPublicSessionCookieName());
}

function getSessionCookieOptions(maxAgeMs) {
  const options = {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: getPublicCookieSameSite(),
    path: '/',
  };

  if (Number.isFinite(maxAgeMs)) {
    options.maxAge = Math.max(0, Math.floor(maxAgeMs));
  }

  return options;
}

function getMaxAgeMsFromExpiresAt(expiresAt) {
  const expiresMs = new Date(expiresAt || 0).getTime();

  if (!Number.isFinite(expiresMs)) {
    return undefined;
  }

  return Math.max(0, expiresMs - Date.now());
}

function setPublicSessionCookie(res, token, expiresAt) {
  if (!isPublicCookieAuthEnabled() || !token) {
    return;
  }

  res.cookie(
    getPublicSessionCookieName(),
    token,
    getSessionCookieOptions(getMaxAgeMsFromExpiresAt(expiresAt))
  );
}

function clearPublicSessionCookie(res) {
  res.cookie(getPublicSessionCookieName(), '', {
    ...getSessionCookieOptions(0),
    expires: new Date(0),
  });
}

function getCsrfCookieOptions(maxAgeMs = CSRF_TOKEN_TTL_MS) {
  return {
    httpOnly: false,
    secure: shouldUseSecureCookie(getPublicCsrfCookieName()),
    sameSite: getPublicCookieSameSite(),
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeMs)),
  };
}

function getCsrfSecret() {
  return process.env.PUBLIC_CSRF_SECRET || process.env.JWT_SECRET || '';
}

function signCsrfPayload(payload) {
  const secret = getCsrfSecret();

  if (!secret) {
    throw new Error('PUBLIC_CSRF_SECRET or JWT_SECRET is required for CSRF tokens.');
  }

  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createCsrfToken() {
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const payload = `${issuedAt}.${nonce}`;
  const signature = signCsrfPayload(payload);

  return `${payload}.${signature}`;
}

function verifyCsrfToken(token) {
  if (typeof token !== 'string' || !token) {
    return false;
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return false;
  }

  const [issuedAtRaw, nonce, signature] = parts;
  const issuedAt = Number(issuedAtRaw);

  if (!Number.isFinite(issuedAt) || !nonce || !signature) {
    return false;
  }

  if (Date.now() - issuedAt > CSRF_TOKEN_TTL_MS || issuedAt > Date.now() + 60 * 1000) {
    return false;
  }

  const expected = signCsrfPayload(`${issuedAtRaw}.${nonce}`);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  return expectedBuffer.length === signatureBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function setPublicCsrfCookie(res, token) {
  res.cookie(getPublicCsrfCookieName(), token, getCsrfCookieOptions());
}

function clearPublicCsrfCookie(res) {
  res.cookie(getPublicCsrfCookieName(), '', {
    ...getCsrfCookieOptions(0),
    expires: new Date(0),
  });
}

function getPresentedCsrfToken(req) {
  return typeof req.headers?.['x-csrf-token'] === 'string'
    ? req.headers['x-csrf-token']
    : '';
}

function hasValidCsrfToken(req) {
  const headerToken = getPresentedCsrfToken(req);
  const cookieToken = getCookieValue(req, getPublicCsrfCookieName());

  return Boolean(
    headerToken &&
    cookieToken &&
    headerToken === cookieToken &&
    verifyCsrfToken(headerToken)
  );
}

module.exports = {
  clearPublicCsrfCookie,
  clearPublicSessionCookie,
  createCsrfToken,
  getCookieValue,
  getCsrfCookieOptions,
  getPublicAppOrigin,
  getPublicAuthMigrationDeadline,
  getPublicCookieSameSite,
  getPublicCsrfCookieName,
  getPublicSessionCookieName,
  getPublicSessionCookieValue,
  getSessionCookieOptions,
  hasValidCsrfToken,
  isPublicBearerAuthLegacyEnabled,
  isPublicCookieAuthEnabled,
  parseCookieHeader,
  setPublicCsrfCookie,
  setPublicSessionCookie,
  shouldUseSecureCookie,
  verifyCsrfToken,
};
