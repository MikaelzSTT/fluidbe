const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const AdminUser = require('../models/AdminUser');
const AdminSession = require('../models/AdminSession');
const {
  clearAdminCsrfCookie,
  clearAdminSessionCookie,
  clearAdminTrustedDeviceCookie,
  createAdminSession,
  createAdminCsrfToken,
  decodeAdminTokenIgnoringExpiration,
  getAdminAccessTtlMs,
  getAdminAbsoluteSessionMs,
  getAdminIdleTimeoutMs,
  getAdminSessionCookieValue,
  getAdminTrustedDeviceCookieValue,
  getAdminTrustedDeviceMs,
  getServerSessionExpiry,
  hasValidAdminCsrfToken,
  hashAdminIp,
  hashOpaqueToken,
  isAdminSessionWithinServerLimits,
  renewAdminSession,
  serializeAdminUser,
  setAdminCsrfCookie,
  setAdminSessionCookie,
  setAdminTrustedDeviceCookie,
  signAdminLoginChallenge,
  touchAdminSession,
  verifyAdminLoginChallenge,
  verifyAdminMfaCredential,
  verifyAdminToken,
} = require('../utils/adminIdentity');

const router = express.Router();
const MAX_EMAIL_CHARS = 320;
const MAX_PASSWORD_BYTES = 72;
const INVALID_PASSWORD_HASH = '$2b$10$oE4adb62xrznmIZJwK9GYOgfO83CCk9wNy5mZUnKXto9FfRRWHfbq';
const MAX_FAILED_LOGIN_ATTEMPTS = Number(process.env.ADMIN_MAX_FAILED_LOGIN_ATTEMPTS || 8);
const LOGIN_LOCK_MS = Number(process.env.ADMIN_LOGIN_LOCK_MS || 15 * 60 * 1000);

function getObjectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(/\s+/);
  return scheme === 'Bearer' && token ? token : null;
}

function getPresentedAdminSessionToken(req) {
  return getAdminSessionCookieValue(req) || getBearerToken(req);
}

function jsonCode(res, status, code) {
  return res.status(status).json({
    ok: false,
    code,
    message: code,
  });
}

function setSessionCookies(res, adminSession) {
  setAdminSessionCookie(res, adminSession.token, adminSession.cookieExpiresAt || adminSession.expiresAt);

  if (adminSession.trustedDeviceToken) {
    setAdminTrustedDeviceCookie(
      res,
      adminSession.trustedDeviceToken,
      adminSession.trustedDeviceExpiresAt || adminSession.cookieExpiresAt || adminSession.expiresAt
    );
  }

  const csrfToken = createAdminCsrfToken();
  setAdminCsrfCookie(res, csrfToken);
  return csrfToken;
}

function denyInvalidCsrf(res) {
  return jsonCode(res, 403, 'CSRF_TOKEN_INVALID');
}

function cookieAdminMutationNeedsCsrf(req) {
  return Boolean(getAdminSessionCookieValue(req)) && !hasValidAdminCsrfToken(req);
}

function serializeAdminSession(session, accessExpiresAt) {
  return {
    id: String(session._id),
    expiresAt: getServerSessionExpiry(session),
    idleExpiresAt: session.idleExpiresAt || session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt || session.expiresAt,
    accessExpiresAt: accessExpiresAt || session.accessExpiresAt || null,
    mfaVerifiedAt: session.mfaVerifiedAt,
    trustedDevice: Boolean(session.trustedDevice?.expiresAt && new Date(session.trustedDevice.expiresAt) > new Date()),
    trustedDeviceExpiresAt: session.trustedDevice?.expiresAt || null,
    limits: {
      accessTtlMinutes: Math.floor(getAdminAccessTtlMs() / 60000),
      idleTimeoutMinutes: Math.floor(getAdminIdleTimeoutMs() / 60000),
      absoluteSessionHours: Math.floor(getAdminAbsoluteSessionMs() / 3600000),
      trustedDeviceDays: Math.floor(getAdminTrustedDeviceMs() / 86400000),
    },
  };
}

function serializeAdminSessionListItem(session) {
  return {
    id: String(session._id),
    current: false,
    userAgent: session.userAgent || '',
    createdAt: session.createdAt || null,
    lastSeenAt: session.lastSeenAt || null,
    expiresAt: getServerSessionExpiry(session),
    idleExpiresAt: session.idleExpiresAt || session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt || session.expiresAt,
    trustedDevice: Boolean(session.trustedDevice?.expiresAt && new Date(session.trustedDevice.expiresAt) > new Date()),
    trustedDeviceExpiresAt: session.trustedDevice?.expiresAt || null,
  };
}

function adminAuthSelect() {
  return '+passwordHash +mfa.secretEnc +mfa.recoveryCodes.hash';
}

async function findAdminUserForLogin(email) {
  const query = AdminUser.findOne({ email }).select(adminAuthSelect());

  return typeof query.exec === 'function' ? query.exec() : query;
}

async function findAdminUserByIdForMfa(id) {
  const query = AdminUser.findById(id).select(adminAuthSelect());

  return typeof query.exec === 'function' ? query.exec() : query;
}

function adminUserCanLogin(adminUser, now = new Date()) {
  return Boolean(
    adminUser &&
    adminUser.active &&
    (!adminUser.lockedUntil || adminUser.lockedUntil <= now) &&
    adminUser.passwordHash
  );
}

async function recordFailedLogin(adminUser) {
  if (!adminUser) {
    return;
  }

  const failedLoginCount = Number(adminUser.failedLoginCount || 0) + 1;
  adminUser.failedLoginCount = failedLoginCount;

  if (failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
    adminUser.lockedUntil = new Date(Date.now() + LOGIN_LOCK_MS);
  }

  if (typeof adminUser.save === 'function') {
    await adminUser.save();
  } else {
    await AdminUser.updateOne(
      { _id: adminUser._id },
      {
        $set: {
          failedLoginCount,
          lockedUntil: adminUser.lockedUntil || null,
        },
      }
    );
  }
}

async function recordSuccessfulPasswordStep(adminUser, req) {
  adminUser.failedLoginCount = 0;
  adminUser.lockedUntil = null;
  adminUser.lastLoginAt = new Date();
  adminUser.lastLoginIpHash = hashAdminIp(req);

  if (typeof adminUser.save === 'function') {
    await adminUser.save();
    return;
  }

  await AdminUser.updateOne(
    { _id: adminUser._id },
    {
      $set: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: adminUser.lastLoginAt,
        lastLoginIpHash: adminUser.lastLoginIpHash,
      },
    }
  );
}

async function authenticateAdminRequest(req, res, next) {
  const token = getPresentedAdminSessionToken(req);

  if (!token) {
    return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
  }

  let decoded;
  let accessExpired = false;

  try {
    decoded = verifyAdminToken(token);
  } catch (error) {
    if (error?.name !== 'TokenExpiredError') {
      return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
    }

    accessExpired = true;

    try {
      decoded = decodeAdminTokenIgnoringExpiration(token);
    } catch (decodeError) {
      return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
    }
  }

  if (!decoded?.sub || !decoded?.jti || decoded.typ !== 'admin') {
    return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
  }

  const now = new Date();
  const session = await AdminSession.findOne({
    jti: decoded.jti,
    adminUserId: decoded.sub,
    revokedAt: null,
    expiresAt: { $gt: now },
  });

  if (!session?.mfaVerifiedAt) {
    return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
  }

  if (!isAdminSessionWithinServerLimits(session, now)) {
    return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
  }

  const adminUser = await AdminUser.findById(decoded.sub);

  if (!adminUser || !adminUser.active || !adminUser.mfa?.enabled) {
    return jsonCode(res, 403, 'ADMIN_FORBIDDEN');
  }

  req.adminUser = adminUser;
  req.adminSession = session;

  if (accessExpired) {
    const renewed = await renewAdminSession(adminUser, session, req);
    const csrfToken = setSessionCookies(res, renewed);
    req.adminSession = renewed.session;
    res.locals.adminCsrfToken = csrfToken;
  } else {
    await touchAdminSession(session, now);
  }

  return next();
}

async function findSessionByTrustedDeviceCookie(req) {
  const trustedToken = getAdminTrustedDeviceCookieValue(req);
  const tokenHash = hashOpaqueToken(trustedToken);

  if (!tokenHash) {
    return null;
  }

  const now = new Date();
  const query = AdminSession.findOne({
    'trustedDevice.tokenHash': tokenHash,
    'trustedDevice.expiresAt': { $gt: now },
    revokedAt: null,
    expiresAt: { $gt: now },
  });
  const selectedQuery = query && typeof query.select === 'function'
    ? query.select('+trustedDevice.tokenHash')
    : query;

  return selectedQuery && typeof selectedQuery.exec === 'function' ? selectedQuery.exec() : selectedQuery;
}

async function refreshAdminSessionFromCookies(req, res) {
  const accessToken = getAdminSessionCookieValue(req);
  let decoded = null;

  if (accessToken) {
    try {
      decoded = decodeAdminTokenIgnoringExpiration(accessToken);
    } catch (error) {
      decoded = null;
    }
  }

  let session = null;

  if (decoded?.sub && decoded?.jti && decoded.typ === 'admin') {
    session = await AdminSession.findOne({
      jti: decoded.jti,
      adminUserId: decoded.sub,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
  }

  if (!session) {
    session = await findSessionByTrustedDeviceCookie(req);
  }

  if (!session?.mfaVerifiedAt) {
    clearAdminSessionCookie(res);
    return null;
  }

  const adminUser = await AdminUser.findById(session.adminUserId);

  if (!adminUser || !adminUser.active || !adminUser.mfa?.enabled) {
    clearAdminSessionCookie(res);
    clearAdminTrustedDeviceCookie(res);
    return null;
  }

  const now = new Date();
  const trustedRestore = !isAdminSessionWithinServerLimits(session, now)
    && session.trustedDevice?.expiresAt
    && new Date(session.trustedDevice.expiresAt) > now;

  if (!isAdminSessionWithinServerLimits(session, now) && !trustedRestore) {
    clearAdminSessionCookie(res);
    return null;
  }

  if (trustedRestore) {
    session.idleExpiresAt = new Date(now.getTime() + getAdminIdleTimeoutMs());
  }

  const renewed = await renewAdminSession(adminUser, session, req);
  const csrfToken = setSessionCookies(res, renewed);

  return {
    adminUser,
    session: renewed.session,
    accessExpiresAt: renewed.accessExpiresAt,
    csrfToken,
  };
}

router.post('/login', async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || email.length > MAX_EMAIL_CHARS || !password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return jsonCode(res, 400, 'ADMIN_LOGIN_INVALID');
    }

    const adminUser = await findAdminUserForLogin(email);
    const passwordIsValid = await bcrypt.compare(password, adminUser?.passwordHash || INVALID_PASSWORD_HASH);

    if (!adminUserCanLogin(adminUser) || !passwordIsValid) {
      await recordFailedLogin(adminUser);
      return jsonCode(res, 401, 'ADMIN_LOGIN_INVALID');
    }

    if (!adminUser.mfa?.enabled || !adminUser.mfa.secretEnc) {
      return jsonCode(res, 403, 'ADMIN_MFA_REQUIRED');
    }

    await recordSuccessfulPasswordStep(adminUser, req);

    return res.json({
      ok: true,
      requiresMfa: true,
      loginChallenge: signAdminLoginChallenge(adminUser),
      message: 'ADMIN_MFA_REQUIRED',
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.post('/mfa/verify', async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const loginChallenge = typeof body.loginChallenge === 'string' ? body.loginChallenge : '';

    if (!loginChallenge) {
      return jsonCode(res, 401, 'ADMIN_MFA_CHALLENGE_EXPIRED');
    }

    let decoded;

    try {
      decoded = verifyAdminLoginChallenge(loginChallenge);
    } catch (error) {
      return jsonCode(res, 401, 'ADMIN_MFA_CHALLENGE_EXPIRED');
    }

    if (!decoded?.sub || decoded.purpose !== 'admin_mfa_login') {
      return jsonCode(res, 401, 'ADMIN_MFA_CHALLENGE_EXPIRED');
    }

    const adminUser = await findAdminUserByIdForMfa(decoded.sub);

    if (!adminUser || !adminUser.active || !adminUser.mfa?.enabled) {
      return jsonCode(res, 401, 'ADMIN_MFA_CHALLENGE_EXPIRED');
    }

    const verification = await verifyAdminMfaCredential(adminUser, body.code, {
      markRecoveryUsed: true,
    });

    if (!verification.valid) {
      return jsonCode(res, 400, 'ADMIN_MFA_INVALID');
    }

    const now = new Date();
    adminUser.mfa.lastVerifiedAt = now;

    if (verification.usedRecoveryCode && typeof adminUser.save === 'function') {
      await adminUser.save();
    } else {
      await AdminUser.updateOne(
        { _id: adminUser._id },
        { $set: { 'mfa.lastVerifiedAt': now } }
      );
    }

    const trustedDevice = body.trustDevice === true || body.trustedDevice === true;
    const adminSession = await createAdminSession(adminUser, req, now, { trustedDevice });
    const csrfToken = setSessionCookies(res, adminSession);

    return res.json({
      ok: true,
      expiresAt: adminSession.expiresAt,
      accessExpiresAt: adminSession.accessExpiresAt,
      csrfToken,
      adminUser: serializeAdminUser(adminUser),
      session: serializeAdminSession(adminSession.session, adminSession.accessExpiresAt),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    if (cookieAdminMutationNeedsCsrf(req)) {
      return denyInvalidCsrf(res);
    }

    const token = getPresentedAdminSessionToken(req);

    if (token) {
      try {
        const decoded = decodeAdminTokenIgnoringExpiration(token);

        if (decoded?.jti && decoded?.sub && decoded.typ === 'admin') {
          await AdminSession.updateOne(
            {
              jti: decoded.jti,
              adminUserId: decoded.sub,
              revokedAt: null,
            },
            {
              $set: {
                revokedAt: new Date(),
                revokedReason: 'logout',
              },
            }
          );
        }
      } catch (error) {
        // Logout is idempotent for malformed, expired, or already invalid admin tokens.
      }
    }

    const trustedTokenHash = hashOpaqueToken(getAdminTrustedDeviceCookieValue(req));

    if (trustedTokenHash) {
      await AdminSession.updateOne(
        {
          'trustedDevice.tokenHash': trustedTokenHash,
          revokedAt: null,
        },
        {
          $set: {
            revokedAt: new Date(),
            revokedReason: 'logout',
          },
        }
      );
    }

    clearAdminSessionCookie(res);
    clearAdminTrustedDeviceCookie(res);
    clearAdminCsrfCookie(res);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/csrf', (req, res) => {
  const csrfToken = createAdminCsrfToken();
  setAdminCsrfCookie(res, csrfToken);
  return res.json({ ok: true, csrfToken });
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshed = await refreshAdminSessionFromCookies(req, res);

    if (!refreshed) {
      return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
    }

    return res.json({
      ok: true,
      csrfToken: refreshed.csrfToken,
      adminUser: serializeAdminUser(refreshed.adminUser),
      session: serializeAdminSession(refreshed.session, refreshed.accessExpiresAt),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/session', async (req, res) => {
  try {
    const refreshed = await refreshAdminSessionFromCookies(req, res);

    if (!refreshed) {
      return jsonCode(res, 401, 'ADMIN_SESSION_EXPIRED');
    }

    return res.json({
      ok: true,
      csrfToken: refreshed.csrfToken,
      adminUser: serializeAdminUser(refreshed.adminUser),
      session: serializeAdminSession(refreshed.session, refreshed.accessExpiresAt),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/me', authenticateAdminRequest, async (req, res) => res.json({
  ok: true,
  adminUser: serializeAdminUser(req.adminUser),
  csrfToken: res.locals.adminCsrfToken || null,
  session: serializeAdminSession(req.adminSession),
}));

router.get('/sessions', authenticateAdminRequest, async (req, res) => {
  const now = new Date();
  const sessions = await AdminSession.find({
    adminUserId: req.adminUser._id,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .sort({ lastSeenAt: -1, createdAt: -1 })
    .select('userAgent createdAt lastSeenAt expiresAt idleExpiresAt absoluteExpiresAt trustedDevice.expiresAt')
    .lean();

  return res.json({
    ok: true,
    sessions: sessions.map((session) => ({
      ...serializeAdminSessionListItem(session),
      current: String(session._id) === String(req.adminSession._id),
    })),
  });
});

router.delete('/sessions/:sessionId', authenticateAdminRequest, async (req, res) => {
  if (cookieAdminMutationNeedsCsrf(req)) {
    return denyInvalidCsrf(res);
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.sessionId)) {
    return jsonCode(res, 400, 'ADMIN_SESSION_INVALID');
  }

  const result = await AdminSession.updateOne(
    {
      _id: req.params.sessionId,
      adminUserId: req.adminUser._id,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: 'admin_revoked',
      },
    }
  );

  if (String(req.params.sessionId) === String(req.adminSession._id)) {
    clearAdminSessionCookie(res);
    clearAdminTrustedDeviceCookie(res);
    clearAdminCsrfCookie(res);
  }

  return res.json({
    ok: true,
    revoked: Boolean(result.modifiedCount || result.matchedCount),
  });
});

module.exports = router;
module.exports.authenticateAdminRequest = authenticateAdminRequest;
module.exports.hasValidAdminCsrfToken = hasValidAdminCsrfToken;
