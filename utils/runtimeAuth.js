const jwt = require('jsonwebtoken');

const RUNTIME_USER_COLLECTION = '_users';
const RUNTIME_AUTH_ROLES = new Set(['user', 'buyer', 'seller']);

let warnedAboutFallbackSecret = false;

function getRuntimeJwtSecret() {
  if (process.env.RUNTIME_JWT_SECRET) {
    return process.env.RUNTIME_JWT_SECRET;
  }

  if (process.env.NODE_ENV !== 'production' && process.env.JWT_SECRET) {
    if (!warnedAboutFallbackSecret) {
      console.warn('RUNTIME_JWT_SECRET is not set; falling back to JWT_SECRET for runtime auth in development.');
      warnedAboutFallbackSecret = true;
    }

    return process.env.JWT_SECRET;
  }

  throw new Error('RUNTIME_JWT_SECRET is required for runtime auth.');
}

function normalizeRuntimeEmail(email) {
  if (typeof email !== 'string') {
    return null;
  }

  const normalized = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeRuntimeRole(role) {
  if (role === undefined || role === null || role === '') {
    return 'user';
  }

  if (typeof role !== 'string') {
    return null;
  }

  const normalized = role.trim().toLowerCase();

  return RUNTIME_AUTH_ROLES.has(normalized) ? normalized : null;
}

function serializeRuntimeUser(document) {
  const data = document?.data || {};

  return {
    id: String(document._id),
    projectId: String(document.projectId),
    email: data.email,
    role: data.role || 'user',
    createdAt: data.createdAt || document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function signRuntimeAuthToken(document) {
  const safeUser = serializeRuntimeUser(document);

  return jwt.sign(
    {
      runtimeUserId: safeUser.id,
      projectId: safeUser.projectId,
      role: safeUser.role,
    },
    getRuntimeJwtSecret(),
    { expiresIn: '7d' }
  );
}

function verifyRuntimeAuthToken(token) {
  return jwt.verify(token, getRuntimeJwtSecret());
}

module.exports = {
  RUNTIME_AUTH_ROLES,
  RUNTIME_USER_COLLECTION,
  getRuntimeJwtSecret,
  normalizeRuntimeEmail,
  normalizeRuntimeRole,
  serializeRuntimeUser,
  signRuntimeAuthToken,
  verifyRuntimeAuthToken,
};
