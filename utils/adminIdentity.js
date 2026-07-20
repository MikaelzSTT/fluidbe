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

function getAdminSessionTtlMs() {
  return Number(process.env.ADMIN_SESSION_TTL_MS || 20 * 60 * 1000);
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
  return jwt.sign(
    {
      sub: String(adminUser._id),
      jti,
      typ: 'admin',
    },
    getAdminJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: Math.max(1, Math.floor(getAdminSessionTtlMs() / 1000)),
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

async function createAdminSession(adminUser, req, verifiedAt = new Date()) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + getAdminSessionTtlMs());
  const jti = crypto.randomUUID();
  const userAgent = typeof req?.headers?.['user-agent'] === 'string'
    ? req.headers['user-agent'].slice(0, 512)
    : undefined;

  const session = await AdminSession.create({
    adminUserId: adminUser._id,
    jti,
    userAgent,
    ipHash: hashAdminIp(req),
    mfaVerifiedAt: verifiedAt,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });

  return {
    session,
    token: signAdminToken(adminUser, jti),
    expiresAt,
  };
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
  createAdminSession,
  decryptAdminTotpSecret,
  encryptAdminTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getAdminJwtAudience,
  getAdminJwtIssuer,
  getAdminReauthTtlMs,
  getAdminSessionTtlMs,
  getAdminTotpAuthUrl,
  hashAdminIp,
  hashAdminRecoveryCodes,
  serializeAdminUser,
  signAdminLoginChallenge,
  signAdminToken,
  verifyAdminLoginChallenge,
  verifyAdminMfaCredential,
  verifyAdminToken,
};
