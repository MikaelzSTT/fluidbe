const express = require('express');
const bcrypt = require('bcryptjs');
const AdminUser = require('../models/AdminUser');
const AdminSession = require('../models/AdminSession');
const {
  createAdminSession,
  hashAdminIp,
  serializeAdminUser,
  signAdminLoginChallenge,
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
const LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 1000;

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

function jsonCode(res, status, code) {
  return res.status(status).json({
    ok: false,
    code,
    message: code,
  });
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
  const token = getBearerToken(req);

  if (!token) {
    return jsonCode(res, 401, 'ADMIN_SESSION_REQUIRED');
  }

  let decoded;

  try {
    decoded = verifyAdminToken(token);
  } catch (error) {
    return jsonCode(res, 401, 'ADMIN_SESSION_INVALID');
  }

  if (!decoded?.sub || !decoded?.jti || decoded.typ !== 'admin') {
    return jsonCode(res, 401, 'ADMIN_SESSION_INVALID');
  }

  const now = new Date();
  const session = await AdminSession.findOne({
    jti: decoded.jti,
    adminUserId: decoded.sub,
    revokedAt: null,
    expiresAt: { $gt: now },
  });

  if (!session?.mfaVerifiedAt) {
    return jsonCode(res, 403, 'ADMIN_MFA_REQUIRED');
  }

  const adminUser = await AdminUser.findById(decoded.sub);

  if (!adminUser || !adminUser.active || !adminUser.mfa?.enabled) {
    return jsonCode(res, 403, 'ADMIN_FORBIDDEN');
  }

  req.adminUser = adminUser;
  req.adminSession = session;

  if (!session.lastSeenAt || now - session.lastSeenAt >= LAST_SEEN_UPDATE_INTERVAL_MS) {
    session.lastSeenAt = now;
    session.save().catch(() => {});
  }

  return next();
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

    const adminSession = await createAdminSession(adminUser, req, now);

    return res.json({
      ok: true,
      token: adminSession.token,
      expiresAt: adminSession.expiresAt,
      adminUser: serializeAdminUser(adminUser),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = getBearerToken(req);

    if (token) {
      try {
        const decoded = verifyAdminToken(token);

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

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/me', authenticateAdminRequest, async (req, res) => res.json({
  ok: true,
  adminUser: serializeAdminUser(req.adminUser),
  session: {
    id: String(req.adminSession._id),
    expiresAt: req.adminSession.expiresAt,
    mfaVerifiedAt: req.adminSession.mfaVerifiedAt,
  },
}));

module.exports = router;
module.exports.authenticateAdminRequest = authenticateAdminRequest;
