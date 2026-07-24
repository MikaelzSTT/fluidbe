const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const AdminSession = require('../models/AdminSession');
const {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotpCode,
} = require('./twoFactor');

const DEFAULT_ADMIN_ISSUER = 'fluid-admin';
const DEFAULT_ADMIN_AUDIENCE = 'fluid-admin-api';
const ADMIN_MFA_ISSUER = 'Fluid Admin';
const GCM_IV_BYTES = 12;
const ENCRYPTION_VERSION = 'v1';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * MINUTE_MS;
const DEFAULT_ADMIN_ACCESS_TTL_MINUTES = 20;
const DEFAULT_ADMIN_IDLE_TIMEOUT_MINUTES = 120;
const DEFAULT_ADMIN_ABSOLUTE_SESSION_HOURS = 12;
const DEFAULT_ADMIN_TRUSTED_DEVICE_DAYS = 7;
const DEFAULT_ADMIN_MAX_SESSIONS = 5;
const DEFAULT_ADMIN_COOKIE_NAME = 'fluid_admin_session';
const DEFAULT_ADMIN_TRUSTED_COOKIE_NAME = 'fluid_admin_trusted';
const DEFAULT_ADMIN_CSRF_COOKIE_NAME = 'fluid_admin_csrf';
const DEFAULT_ADMIN_COOKIE_PATH = '/api';
const ADMIN_CSRF_TOKEN_TTL_MS = 2 * HOUR_MS;

function envFlag(name, defaultValue = false) {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }

  return String(value).toLowerCase() === 'true';
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAdminSessionTtlMs() {
  return getAdminAccessTtlMs();
}

function getAdminAccessTtlMs() {
  if (process.env.ADMIN_ACCESS_TTL_MINUTES !== undefined) {
    return parsePositiveNumber(
      process.env.ADMIN_ACCESS_TTL_MINUTES,
      DEFAULT_ADMIN_ACCESS_TTL_MINUTES
    ) * MINUTE_MS;
  }

  return parsePositiveNumber(process.env.ADMIN_SESSION_TTL_MS, DEFAULT_ADMIN_ACCESS_TTL_MINUTES * MINUTE_MS);
}

function getAdminIdleTimeoutMs() {
  return parsePositiveNumber(
    process.env.ADMIN_IDLE_TIMEOUT_MINUTES,
    DEFAULT_ADMIN_IDLE_TIMEOUT_MINUTES
  ) * MINUTE_MS;
}

function getAdminAbsoluteSessionMs() {
  return parsePositiveNumber(
    process.env.ADMIN_ABSOLUTE_SESSION_HOURS,
    DEFAULT_ADMIN_ABSOLUTE_SESSION_HOURS
  ) * HOUR_MS;
}

function getAdminTrustedDeviceMs() {
  return parsePositiveNumber(
    process.env.ADMIN_TRUSTED_DEVICE_DAYS,
    DEFAULT_ADMIN_TRUSTED_DEVICE_DAYS
  ) * DAY_MS;
}

function getAdminMaxSessionsPerUser() {
  return Math.max(1, Math.floor(parsePositiveNumber(
    process.env.ADMIN_MAX_SESSIONS_PER_ADMIN,
    DEFAULT_ADMIN_MAX_SESSIONS
  )));
}

function getAdminReauthTtlMs() {
  return Number(process.env.ADMIN_REAUTH_TTL_MS || 5 * 60 * 1000);
}

function getAdminJwtIssuer() {
  return process.env.ADMIN_JWT_ISSUER || DEFAULT_ADMIN_ISSUER;
}

function getAdminJwtAudience() {
  return process.env.ADMIN_JWT_AUDIENCE || DEFAULT_ADMIN_AUDIENCE;
}

function getAdminJwtSecret() {
  if (!process.env.ADMIN_JWT_SECRET) {
    throw new Error('ADMIN_JWT_SECRET is required for admin auth.');
  }

  return process.env.ADMIN_JWT_SECRET;
}

function getAdminMfaEncryptionKey() {
  if (!process.env.ADMIN_TWO_FACTOR_SECRET_KEY) {
    throw new Error('ADMIN_TWO_FACTOR_SECRET_KEY is required for admin MFA.');
  }

  return crypto.createHash('sha256').update(process.env.ADMIN_TWO_FACTOR_SECRET_KEY).digest();
}

function encryptAdminTotpSecret(secret) {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAdminMfaEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

function decryptAdminTotpSecret(encryptedSecret) {
  if (typeof encryptedSecret !== 'string' || !encryptedSecret) {
    return '';
  }

  const [version, ivBase64, tagBase64, encryptedBase64] = encryptedSecret.split(':');

  if (version !== ENCRYPTION_VERSION || !ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Invalid encrypted admin TOTP secret.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getAdminMfaEncryptionKey(),
    Buffer.from(ivBase64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function getAdminTotpAuthUrl(email, secret) {
  const label = encodeURIComponent(email);
  const issuer = encodeURIComponent(ADMIN_MFA_ISSUER);

  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}`;
}

function signAdminLoginChallenge(adminUser) {
  return jwt.sign(
    {
      sub: String(adminUser._id),
      purpose: 'admin_mfa_login',
    },
    getAdminJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: getAdminJwtIssuer(),
      audience: getAdminJwtAudience(),
    }
  );
}

function verifyAdminLoginChallenge(token) {
  return jwt.verify(token, getAdminJwtSecret(), {
    algorithms: ['HS256'],
    issuer: getAdminJwtIssuer(),
    audience: getAdminJwtAudience(),
  });
}

function signAdminToken(adminUser, jti) {
  const accessTtlMs = getAdminAccessTtlMs();

  return jwt.sign(
    {
      sub: String(adminUser._id),
      jti,
      typ: 'admin',
    },
    getAdminJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: Math.max(1, Math.floor(accessTtlMs / 1000)),
      issuer: getAdminJwtIssuer(),
      audience: getAdminJwtAudience(),
    }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, getAdminJwtSecret(), {
    algorithms: ['HS256'],
    issuer: getAdminJwtIssuer(),
    audience: getAdminJwtAudience(),
  });
}

function decodeAdminTokenIgnoringExpiration(token) {
  return jwt.verify(token, getAdminJwtSecret(), {
    algorithms: ['HS256'],
    issuer: getAdminJwtIssuer(),
    audience: getAdminJwtAudience(),
    ignoreExpiration: true,
  });
}

function getAdminSessionCookieName() {
  return process.env.ADMIN_SESSION_COOKIE_NAME || DEFAULT_ADMIN_COOKIE_NAME;
}

function getAdminTrustedDeviceCookieName() {
  return process.env.ADMIN_TRUSTED_DEVICE_COOKIE_NAME || DEFAULT_ADMIN_TRUSTED_COOKIE_NAME;
}

function getAdminCsrfCookieName() {
  return process.env.ADMIN_CSRF_COOKIE_NAME || DEFAULT_ADMIN_CSRF_COOKIE_NAME;
}

function getAdminCookiePath() {
  return process.env.ADMIN_COOKIE_PATH || DEFAULT_ADMIN_COOKIE_PATH;
}

function getAdminCookieSameSite() {
  const value = String(process.env.ADMIN_COOKIE_SAMESITE || 'lax').toLowerCase();

  return ['strict', 'lax', 'none'].includes(value) ? value : 'lax';
}

function shouldUseAdminSecureCookie() {
  return process.env.NODE_ENV === 'production' || envFlag('ADMIN_COOKIE_SECURE', false);
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

function getAdminSessionCookieValue(req) {
  return getCookieValue(req, getAdminSessionCookieName());
}

function getAdminTrustedDeviceCookieValue(req) {
  return getCookieValue(req, getAdminTrustedDeviceCookieName());
}

function getCookieMaxAgeMsFromExpiresAt(expiresAt) {
  const expiresMs = new Date(expiresAt || 0).getTime();

  if (!Number.isFinite(expiresMs)) {
    return undefined;
  }

  return Math.max(0, expiresMs - Date.now());
}

function getAdminCookieOptions(maxAgeMs, overrides = {}) {
  const options = {
    httpOnly: true,
    secure: shouldUseAdminSecureCookie(),
    sameSite: getAdminCookieSameSite(),
    path: getAdminCookiePath(),
    ...overrides,
  };

  if (Number.isFinite(maxAgeMs)) {
    options.maxAge = Math.max(0, Math.floor(maxAgeMs));
  }

  return options;
}

function setAdminSessionCookie(res, token, expiresAt) {
  if (!token || !res?.cookie) {
    return;
  }

  res.cookie(
    getAdminSessionCookieName(),
    token,
    getAdminCookieOptions(getCookieMaxAgeMsFromExpiresAt(expiresAt))
  );
}

function clearAdminSessionCookie(res) {
  if (!res?.cookie) {
    return;
  }

  res.cookie(getAdminSessionCookieName(), '', {
    ...getAdminCookieOptions(0),
    expires: new Date(0),
  });
}

function getCsrfCookieOptions(maxAgeMs = ADMIN_CSRF_TOKEN_TTL_MS) {
  return getAdminCookieOptions(maxAgeMs, { httpOnly: false });
}

function getAdminCsrfSecret() {
  return process.env.ADMIN_CSRF_SECRET || process.env.ADMIN_JWT_SECRET || '';
}

function signCsrfPayload(payload) {
  const secret = getAdminCsrfSecret();

  if (!secret) {
    throw new Error('ADMIN_CSRF_SECRET or ADMIN_JWT_SECRET is required for admin CSRF tokens.');
  }

  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createAdminCsrfToken() {
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const payload = `${issuedAt}.${nonce}`;
  const signature = signCsrfPayload(payload);

  return `${payload}.${signature}`;
}

function verifyAdminCsrfToken(token) {
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

  const now = Date.now();

  if (now - issuedAt > ADMIN_CSRF_TOKEN_TTL_MS || issuedAt > now + MINUTE_MS) {
    return false;
  }

  const expected = signCsrfPayload(`${issuedAtRaw}.${nonce}`);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  return expectedBuffer.length === signatureBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function setAdminCsrfCookie(res, token) {
  if (!res?.cookie) {
    return;
  }

  res.cookie(getAdminCsrfCookieName(), token, getCsrfCookieOptions());
}

function clearAdminCsrfCookie(res) {
  if (!res?.cookie) {
    return;
  }

  res.cookie(getAdminCsrfCookieName(), '', {
    ...getCsrfCookieOptions(0),
    expires: new Date(0),
  });
}

function hasValidAdminCsrfToken(req) {
  const headerToken = typeof req.headers?.['x-csrf-token'] === 'string'
    ? req.headers['x-csrf-token']
    : '';
  const cookieToken = getCookieValue(req, getAdminCsrfCookieName());
  const headerBuffer = Buffer.from(headerToken);
  const cookieBuffer = Buffer.from(cookieToken);

  return Boolean(
    headerToken &&
    cookieToken &&
    headerBuffer.length === cookieBuffer.length &&
    crypto.timingSafeEqual(headerBuffer, cookieBuffer) &&
    verifyAdminCsrfToken(headerToken)
  );
}

function createOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashOpaqueToken(token) {
  const secret = process.env.ADMIN_DEVICE_TOKEN_SECRET || process.env.ADMIN_JWT_SECRET;

  if (!token || !secret) {
    return '';
  }

  return crypto.createHmac('sha256', secret).update(String(token)).digest('hex');
}

function setAdminTrustedDeviceCookie(res, token, expiresAt) {
  if (!token || !res?.cookie) {
    return;
  }

  res.cookie(
    getAdminTrustedDeviceCookieName(),
    token,
    getAdminCookieOptions(getCookieMaxAgeMsFromExpiresAt(expiresAt))
  );
}

function clearAdminTrustedDeviceCookie(res) {
  if (!res?.cookie) {
    return;
  }

  res.cookie(getAdminTrustedDeviceCookieName(), '', {
    ...getAdminCookieOptions(0),
    expires: new Date(0),
  });
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function hashAdminIp(req) {
  const ip = getClientIp(req);
  const secret = process.env.ADMIN_SESSION_IP_HASH_SECRET || process.env.ADMIN_JWT_SECRET;

  if (!ip || !secret) {
    return undefined;
  }

  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

function hashAdminDevice(req) {
  const userAgent = typeof req?.headers?.['user-agent'] === 'string'
    ? req.headers['user-agent']
    : '';
  const secret = process.env.ADMIN_DEVICE_HASH_SECRET
    || process.env.ADMIN_SESSION_IP_HASH_SECRET
    || process.env.ADMIN_JWT_SECRET;

  if (!userAgent || !secret) {
    return undefined;
  }

  return crypto.createHmac('sha256', secret).update(userAgent).digest('hex');
}

function minDate(...dates) {
  const validTimes = dates
    .map((date) => new Date(date || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0);

  return new Date(Math.min(...validTimes));
}

function getServerSessionExpiry(session) {
  const fallback = session?.expiresAt || new Date(0);
  const idleExpiresAt = session?.idleExpiresAt || fallback;
  const absoluteExpiresAt = session?.absoluteExpiresAt || fallback;

  return minDate(idleExpiresAt, absoluteExpiresAt);
}

function isAdminSessionWithinServerLimits(session, now = new Date()) {
  const serverExpiresAt = getServerSessionExpiry(session);

  return serverExpiresAt.getTime() > now.getTime();
}

function buildAdminSessionPayload(adminUser, req, verifiedAt = new Date(), options = {}) {
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + getAdminAccessTtlMs());
  const idleExpiresAt = new Date(now.getTime() + getAdminIdleTimeoutMs());
  const absoluteExpiresAt = new Date(
    now.getTime() + (options.trustedDevice ? getAdminTrustedDeviceMs() : getAdminAbsoluteSessionMs())
  );
  const expiresAt = absoluteExpiresAt;
  const jti = crypto.randomUUID();
  const userAgent = typeof req?.headers?.['user-agent'] === 'string'
    ? req.headers['user-agent'].slice(0, 512)
    : undefined;
  const payload = {
    adminUserId: adminUser._id,
    jti,
    userAgent,
    ipHash: hashAdminIp(req),
    deviceHash: hashAdminDevice(req),
    mfaVerifiedAt: verifiedAt,
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt,
    absoluteExpiresAt,
    accessExpiresAt,
    expiresAt,
  };

  let trustedDeviceToken = '';

  if (options.trustedDevice) {
    trustedDeviceToken = createOpaqueToken();
    payload.trustedDevice = {
      tokenHash: hashOpaqueToken(trustedDeviceToken),
      expiresAt: absoluteExpiresAt,
      rotatedAt: now,
    };
  }

  return {
    payload,
    jti,
    accessExpiresAt,
    sessionExpiresAt: getServerSessionExpiry(payload),
    cookieExpiresAt: expiresAt,
    trustedDeviceToken,
  };
}

async function enforceAdminSessionLimit(adminUserId, currentSessionId) {
  const maxSessions = getAdminMaxSessionsPerUser();

  try {
    if (AdminSession.db?.readyState !== 1) {
      return;
    }

    const query = AdminSession.find({
      adminUserId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    const activeSessions = await query
      .sort({ createdAt: -1 })
      .select('_id')
      .lean();
    const extraSessionIds = activeSessions
      .map((session) => String(session._id))
      .filter((sessionId) => sessionId !== String(currentSessionId))
      .slice(Math.max(0, maxSessions - 1));

    if (extraSessionIds.length === 0) {
      return;
    }

    await AdminSession.updateMany(
      { _id: { $in: extraSessionIds }, revokedAt: null },
      {
        $set: {
          revokedAt: new Date(),
          revokedReason: 'session_limit',
        },
      }
    );
  } catch (error) {
    console.warn('Admin session limit enforcement failed.', {
      name: error?.name || 'Error',
      code: error?.code || null,
    });
  }
}

async function createAdminSession(adminUser, req, verifiedAt = new Date(), options = {}) {
  const builtSession = buildAdminSessionPayload(adminUser, req, verifiedAt, options);
  const session = await AdminSession.create(builtSession.payload);

  await enforceAdminSessionLimit(adminUser._id, session._id);

  return {
    session,
    token: signAdminToken(adminUser, builtSession.jti),
    accessExpiresAt: builtSession.accessExpiresAt,
    expiresAt: builtSession.sessionExpiresAt,
    cookieExpiresAt: builtSession.cookieExpiresAt,
    trustedDeviceToken: builtSession.trustedDeviceToken,
    trustedDeviceExpiresAt: builtSession.payload.trustedDevice?.expiresAt || null,
  };
}

function rotateTrustedDeviceTokenOnSession(session, now = new Date()) {
  if (!session?.trustedDevice?.tokenHash || !session.trustedDevice.expiresAt) {
    return '';
  }

  const trustedExpiresAt = new Date(session.trustedDevice.expiresAt);

  if (!(trustedExpiresAt > now)) {
    return '';
  }

  const token = createOpaqueToken();
  session.trustedDevice.tokenHash = hashOpaqueToken(token);
  session.trustedDevice.rotatedAt = now;
  return token;
}

async function renewAdminSession(adminUser, session, req, options = {}) {
  const now = new Date();
  const nextJti = crypto.randomUUID();
  const nextAccessExpiresAt = new Date(now.getTime() + getAdminAccessTtlMs());
  const nextIdleExpiresAt = new Date(now.getTime() + getAdminIdleTimeoutMs());
  const absoluteExpiresAt = session.absoluteExpiresAt || session.expiresAt;

  session.jti = nextJti;
  session.accessExpiresAt = nextAccessExpiresAt;
  session.idleExpiresAt = minDate(nextIdleExpiresAt, absoluteExpiresAt);
  session.lastSeenAt = now;

  let trustedDeviceToken = '';

  if (options.rotateTrustedDevice !== false) {
    trustedDeviceToken = rotateTrustedDeviceTokenOnSession(session, now);
  }

  if (typeof session.save === 'function') {
    await session.save();
  } else {
    await AdminSession.updateOne(
      { _id: session._id, revokedAt: null },
      {
        $set: {
          jti: nextJti,
          accessExpiresAt: nextAccessExpiresAt,
          idleExpiresAt: session.idleExpiresAt,
          lastSeenAt: now,
          ...(trustedDeviceToken ? {
            'trustedDevice.tokenHash': session.trustedDevice.tokenHash,
            'trustedDevice.rotatedAt': now,
          } : {}),
        },
      }
    );
  }

  return {
    session,
    token: signAdminToken(adminUser, nextJti),
    accessExpiresAt: nextAccessExpiresAt,
    expiresAt: getServerSessionExpiry(session),
    cookieExpiresAt: session.expiresAt,
    trustedDeviceToken,
    trustedDeviceExpiresAt: session.trustedDevice?.expiresAt || null,
  };
}

async function touchAdminSession(session, now = new Date()) {
  if (!session || session.revokedAt) {
    return false;
  }

  const lastSeenMs = new Date(session.lastSeenAt || 0).getTime();

  if (Number.isFinite(lastSeenMs) && now.getTime() - lastSeenMs < LAST_SEEN_UPDATE_INTERVAL_MS) {
    return false;
  }

  const nextIdleExpiresAt = new Date(now.getTime() + getAdminIdleTimeoutMs());
  const absoluteExpiresAt = session.absoluteExpiresAt || session.expiresAt;
  session.lastSeenAt = now;
  session.idleExpiresAt = minDate(nextIdleExpiresAt, absoluteExpiresAt);

  if (typeof session.save === 'function') {
    session.save().catch(() => {});
  } else {
    AdminSession.updateOne(
      { _id: session._id, revokedAt: null },
      {
        $set: {
          lastSeenAt: now,
          idleExpiresAt: session.idleExpiresAt,
        },
      }
    ).catch(() => {});
  }

  return true;
}

async function hashAdminRecoveryCodes(recoveryCodes) {
  return Promise.all(
    recoveryCodes.map(async (recoveryCode) => ({
      hash: await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 12),
    }))
  );
}

function verifyAdminTotp(adminUser, code) {
  if (!adminUser?.mfa?.enabled || !adminUser.mfa.secretEnc) {
    return false;
  }

  const secret = decryptAdminTotpSecret(adminUser.mfa.secretEnc);

  return verifyTotpCode(secret, code);
}

async function verifyAdminRecoveryCode(adminUser, code, options = {}) {
  const normalizedCode = normalizeRecoveryCode(code);

  if (!normalizedCode) {
    return false;
  }

  const recoveryCodes = Array.isArray(adminUser?.mfa?.recoveryCodes)
    ? adminUser.mfa.recoveryCodes
    : [];

  for (const recoveryCode of recoveryCodes) {
    if (!recoveryCode?.hash || recoveryCode.usedAt) {
      continue;
    }

    const matches = await bcrypt.compare(normalizedCode, recoveryCode.hash);

    if (!matches) {
      continue;
    }

    if (options.markUsed) {
      recoveryCode.usedAt = new Date();
    }

    return true;
  }

  return false;
}

async function verifyAdminMfaCredential(adminUser, code, options = {}) {
  if (verifyAdminTotp(adminUser, code)) {
    return { valid: true, usedRecoveryCode: false };
  }

  const recoveryCodeIsValid = await verifyAdminRecoveryCode(adminUser, code, {
    markUsed: options.markRecoveryUsed,
  });

  if (recoveryCodeIsValid) {
    return { valid: true, usedRecoveryCode: true };
  }

  return { valid: false, usedRecoveryCode: false };
}

function serializeAdminUser(adminUser) {
  return {
    id: String(adminUser._id),
    email: adminUser.email,
    active: Boolean(adminUser.active),
    permissions: Array.isArray(adminUser.permissions) ? adminUser.permissions : [],
    mfa: {
      enabled: Boolean(adminUser.mfa?.enabled),
    },
    createdAt: adminUser.createdAt || null,
    updatedAt: adminUser.updatedAt || null,
  };
}

module.exports = {
  ADMIN_MFA_ISSUER,
  clearAdminCsrfCookie,
  clearAdminSessionCookie,
  clearAdminTrustedDeviceCookie,
  createAdminSession,
  createAdminCsrfToken,
  decodeAdminTokenIgnoringExpiration,
  decryptAdminTotpSecret,
  encryptAdminTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getAdminAbsoluteSessionMs,
  getAdminAccessTtlMs,
  getAdminCookiePath,
  getAdminCsrfCookieName,
  getAdminIdleTimeoutMs,
  getAdminJwtAudience,
  getAdminJwtIssuer,
  getAdminMaxSessionsPerUser,
  getAdminReauthTtlMs,
  getAdminSessionTtlMs,
  getAdminSessionCookieName,
  getAdminSessionCookieValue,
  getAdminTotpAuthUrl,
  getAdminTrustedDeviceCookieName,
  getAdminTrustedDeviceCookieValue,
  getAdminTrustedDeviceMs,
  getServerSessionExpiry,
  hasValidAdminCsrfToken,
  hashAdminDevice,
  hashAdminIp,
  hashAdminRecoveryCodes,
  hashOpaqueToken,
  isAdminSessionWithinServerLimits,
  renewAdminSession,
  serializeAdminUser,
  setAdminCsrfCookie,
  setAdminSessionCookie,
  setAdminTrustedDeviceCookie,
  signAdminLoginChallenge,
  signAdminToken,
  touchAdminSession,
  verifyAdminLoginChallenge,
  verifyAdminCsrfToken,
  verifyAdminMfaCredential,
  verifyAdminToken,
};
