const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const Session = require('../models/Session');
const User = require('../models/User');
const { getClientIp } = require('./rateLimit');
const { timingSafeEqualString } = require('../utils/timingSafe');

const ADMIN_ROLES = Object.freeze(['user', 'admin']);
const ADMIN_PERMISSIONS = Object.freeze([
  'admin:read',
  'admin:write',
  'admin:build',
  'admin:users',
  'admin:secrets',
]);
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 20 * 60 * 1000);
const ADMIN_REAUTH_TTL_MS = Number(process.env.ADMIN_REAUTH_TTL_MS || 5 * 60 * 1000);
const MFA_LOGIN_CLOCK_SKEW_MS = 5 * 1000;

function getBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(/\s+/);
  return scheme === 'Bearer' && token ? token : null;
}

function safeAdminMessage(res, statusCode) {
  return res.status(statusCode).json({ message: 'Admin não autorizado' });
}

function normalizeIp(ip) {
  return String(ip || '')
    .trim()
    .replace(/^::ffff:/, '');
}

function ipv4ToLong(ip) {
  const parts = String(ip || '').split('.');

  if (parts.length !== 4) {
    return null;
  }

  let result = 0;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }

    const value = Number(part);

    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }

    result = (result << 8) + value;
  }

  return result >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [network, prefixValue] = String(cidr || '').split('/');
  const prefix = Number(prefixValue);

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const ipLong = ipv4ToLong(ip);
  const networkLong = ipv4ToLong(network);

  if (ipLong === null || networkLong === null) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipLong & mask) === (networkLong & mask);
}

function legacyIpAllowed(req) {
  const allowlist = String(process.env.ADMIN_TOKEN_LEGACY_IP_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (allowlist.length === 0) {
    return true;
  }

  const ip = normalizeIp(getClientIp(req));
  return allowlist.some((entry) => {
    if (entry === '*') {
      return true;
    }

    if (entry.includes('/')) {
      return ipv4InCidr(ip, entry);
    }

    return normalizeIp(entry) === ip;
  });
}

function getRequestId(req) {
  const header = req.headers['idempotency-key']
    || req.headers['x-idempotency-key']
    || req.headers['x-request-id']
    || req.headers['x-correlation-id'];
  const value = Array.isArray(header) ? header[0] : header;
  const normalized = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();

  if (normalized) {
    return normalized.slice(0, 160);
  }

  return crypto.randomUUID();
}

function getAuditHashSecret() {
  return process.env.ADMIN_AUDIT_HASH_SECRET
    || process.env.RATE_LIMIT_KEY_SECRET
    || process.env.JWT_SECRET
    || 'fluidbe-admin-audit-hash-v1';
}

function stableJson(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (typeof value !== 'object' || depth > 8 || seen.has(value)) {
    return JSON.stringify(String(value));
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item, depth + 1, seen)).join(',')}]`;
  }

  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key], depth + 1, seen)}`
  )).join(',')}}`;
}

function hmacAuditValue(value) {
  return crypto
    .createHmac('sha256', getAuditHashSecret())
    .update(String(value))
    .digest('base64url');
}

function getRequestHash(req, metadata) {
  return hmacAuditValue(stableJson({
    method: req.method,
    action: metadata.action,
    resourceType: metadata.resourceType,
    resourceId: metadata.resourceId,
    params: req.params || {},
    query: req.query || {},
    body: req.body || {},
  }));
}

function getAdminActorKey(req) {
  if (req.adminAuth?.actorType === 'user') {
    return `user:${String(req.adminAuth.adminUserId || '')}`;
  }

  return 'legacy_token';
}

function getAuditIdempotencyKey(req, metadata, requestHash) {
  return hmacAuditValue([
    getAdminActorKey(req),
    req.adminRequestId,
    metadata.action,
    metadata.resourceType,
    metadata.resourceId || '',
    requestHash,
  ].join('|'));
}

function summarizeUserAgent(req) {
  const value = Array.isArray(req.headers['user-agent'])
    ? req.headers['user-agent'][0]
    : req.headers['user-agent'];

  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function containsUnsafeKey(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (depth > 8 || seen.has(value)) {
    return false;
  }

  seen.add(value);

  for (const key of Object.keys(value)) {
    if (
      key.startsWith('$') ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      return true;
    }

    if (containsUnsafeKey(value[key], depth + 1, seen)) {
      return true;
    }
  }

  return false;
}

function rejectUnsafeAdminInput(req, res) {
  if (containsUnsafeKey(req.body) || containsUnsafeKey(req.query)) {
    res.status(400).json({ message: 'Requisição inválida.' });
    return true;
  }

  return false;
}

function normalizeAdminPath(req) {
  return String(req.originalUrl || req.url || '')
    .split('?')[0]
    .replace(/^\/api\/admin/, '')
    .replace(/\/+/g, '/')
    || '/';
}

function getRouteMetadata(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = normalizeAdminPath(req);
  const mutating = method !== 'GET';
  let resourceType = 'admin';
  let permission = mutating ? 'admin:write' : 'admin:read';
  let recentReauthRequired = mutating;

  if (path.startsWith('/users/')) {
    resourceType = 'user';
    permission = 'admin:users';
  } else if (path.includes('/connectors')) {
    resourceType = 'connector';
    permission = 'admin:secrets';
    recentReauthRequired = true;
  } else if (path.includes('/builds') || path.includes('/react-vite') || path.includes('/security-scan')) {
    resourceType = 'build';
    permission = 'admin:build';
    recentReauthRequired = mutating || path.includes('/publish') || path.includes('/security-scan');
  } else if (path.includes('/change-requests')) {
    resourceType = 'change_request';
  } else if (path.includes('/projects')) {
    resourceType = 'project';
  }

  return {
    action: `${method} ${path}`,
    permission,
    resourceType,
    resourceId: req.params?.userId || req.params?.requestId || req.params?.buildId || req.params?.projectId || req.params?.id || '',
    recentReauthRequired,
    critical: mutating,
  };
}

function hasAdminPermission(user, permission) {
  if (!user || user.role !== 'admin' || user.deletedAt) {
    return false;
  }

  const permissions = Array.isArray(user.admin?.permissions) ? user.admin.permissions : [];
  return permissions.includes(permission);
}

function isMfaVerifiedForSession(user, session, now) {
  if (!user.twoFactor?.enabled || !session?.mfaVerifiedAt || !session?.createdAt) {
    return false;
  }

  const lastVerifiedAt = new Date(session.mfaVerifiedAt).getTime();
  const sessionCreatedAt = new Date(session.createdAt).getTime();

  if (!Number.isFinite(lastVerifiedAt) || !Number.isFinite(sessionCreatedAt)) {
    return false;
  }

  return lastVerifiedAt + MFA_LOGIN_CLOCK_SKEW_MS >= sessionCreatedAt
    && now.getTime() - sessionCreatedAt <= ADMIN_SESSION_TTL_MS;
}

function hasRecentAdminReauth(session, now) {
  const lastVerifiedAt = new Date(session?.mfaVerifiedAt || 0).getTime();

  return Number.isFinite(lastVerifiedAt) && now.getTime() - lastVerifiedAt <= ADMIN_REAUTH_TTL_MS;
}

function isSessionAfterAdminGrant(user, session) {
  if (!user.admin?.grantedAt || !session?.createdAt) {
    return false;
  }

  const grantedAt = new Date(user.admin.grantedAt).getTime();
  const sessionCreatedAt = new Date(session.createdAt).getTime();

  if (!Number.isFinite(grantedAt) || !Number.isFinite(sessionCreatedAt)) {
    return false;
  }

  return sessionCreatedAt + MFA_LOGIN_CLOCK_SKEW_MS >= grantedAt;
}

async function authenticateLegacyAdmin(req) {
  if (process.env.ADMIN_TOKEN_LEGACY_ENABLED !== 'true') {
    return false;
  }

  const adminToken = process.env.ADMIN_TOKEN;
  const presentedToken = req.headers['x-admin-token'];

  if (!adminToken || !timingSafeEqualString(presentedToken, adminToken)) {
    return false;
  }

  if (!legacyIpAllowed(req)) {
    return false;
  }

  req.adminAuth = {
    actorType: 'legacy_token',
    legacy: true,
  };
  return true;
}

function warnLegacyAdminAccepted(req, critical = false) {
  console.warn(
    critical
      ? 'Legacy ADMIN_TOKEN accepted for critical admin route.'
      : 'Legacy ADMIN_TOKEN accepted for admin route.',
    {
      path: normalizeAdminPath(req),
      requestId: req.adminRequestId,
    }
  );
}

function legacyAdminAllowedForMetadata(req, res, metadata) {
  if (!req.adminAuth?.legacy) {
    return true;
  }

  if (!metadata.critical) {
    warnLegacyAdminAccepted(req, false);
    return true;
  }

  if (process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED === 'true') {
    warnLegacyAdminAccepted(req, true);
    return true;
  }

  return safeAdminMessage(res, 403);
}

async function authenticateUserAdmin(req, res, metadata) {
  const token = getBearerToken(req);

  if (!token) {
    return safeAdminMessage(res, 401);
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    return safeAdminMessage(res, 401);
  }

  if (!decoded?.id || !decoded?.jti || decoded.runtimeUserId || !mongoose.Types.ObjectId.isValid(decoded.id)) {
    return safeAdminMessage(res, 401);
  }

  const now = new Date();
  const session = await Session.findOne({
    jti: decoded.jti,
    userId: decoded.id,
    revokedAt: null,
    adminRevokedAt: null,
    expiresAt: { $gt: now },
  });

  if (!session) {
    return safeAdminMessage(res, 401);
  }

  const user = await User.findById(decoded.id).select(
    'role admin.permissions admin.grantedAt deletedAt twoFactor.enabled'
  );

  if (!hasAdminPermission(user, metadata.permission)) {
    return safeAdminMessage(res, 403);
  }

  if (!isSessionAfterAdminGrant(user, session)) {
    return safeAdminMessage(res, 403);
  }

  if (!isMfaVerifiedForSession(user, session, now)) {
    return safeAdminMessage(res, 403);
  }

  if (metadata.recentReauthRequired && !hasRecentAdminReauth(session, now)) {
    return safeAdminMessage(res, 403);
  }

  req.adminAuth = {
    actorType: 'user',
    adminUserId: user._id,
    sessionId: session._id,
    permission: metadata.permission,
  };
  req.adminUser = user;
  req.adminSession = session;
  return true;
}

function buildAdminAuditPayload(req, metadata, result, statusCode, failureReason) {
  if (!req.adminAuth) {
    return null;
  }

  const payload = {
    adminUserId: req.adminAuth.adminUserId || null,
    actorType: req.adminAuth.actorType,
    action: metadata.action,
    resourceType: metadata.resourceType,
    resourceId: String(metadata.resourceId || '').slice(0, 120),
    result,
    statusCode,
    requestId: req.adminRequestId,
    ip: normalizeIp(getClientIp(req)),
    userAgent: summarizeUserAgent(req),
    failureReason: failureReason ? String(failureReason).slice(0, 120) : undefined,
  };

  if (metadata.critical) {
    const requestHash = req.adminAuditRequestHash || getRequestHash(req, metadata);
    const idempotencyKey = req.adminAuditIdempotencyKey || getAuditIdempotencyKey(req, metadata, requestHash);
    payload.idempotencyKey = idempotencyKey;
    payload.requestHash = requestHash;
  }

  return payload;
}

async function recordAdminAudit(req, metadata, result, statusCode, failureReason) {
  const payload = buildAdminAuditPayload(req, metadata, result, statusCode, failureReason);

  if (!payload) {
    return null;
  }

  return AdminAuditLog.create(payload);
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

async function findExistingCriticalAudit(idempotencyKey) {
  if (!idempotencyKey) {
    return null;
  }

  const query = AdminAuditLog.findOne({
    idempotencyKey,
    result: { $in: ['success', 'pending'] },
  });

  if (query && typeof query.sort === 'function') {
    return query.sort({ timestamp: -1 });
  }

  return query;
}

async function beginCriticalAdminAudit(req, res, metadata) {
  if (!metadata.critical) {
    return true;
  }

  const requestHash = getRequestHash(req, metadata);
  const idempotencyKey = getAuditIdempotencyKey(req, metadata, requestHash);
  req.adminAuditRequestHash = requestHash;
  req.adminAuditIdempotencyKey = idempotencyKey;

  let existing;

  try {
    existing = await findExistingCriticalAudit(idempotencyKey);
  } catch (error) {
    console.error('Admin audit preflight failed.', {
      name: error?.name || 'Error',
      code: error?.code || null,
      requestId: req.adminRequestId,
    });
    res.status(503).json({ message: 'Admin audit unavailable.' });
    return false;
  }

  if (existing?.result === 'success') {
    res.status(200).json({
      ok: true,
      idempotent: true,
      message: 'ADMIN_ACTION_ALREADY_COMPLETED',
    });
    return false;
  }

  if (existing?.result === 'pending') {
    res.status(202).json({
      ok: true,
      idempotent: true,
      message: 'ADMIN_ACTION_AUDIT_PENDING',
    });
    return false;
  }

  try {
    await recordAdminAudit(req, metadata, 'pending', 102);
    req.adminAuditPendingRecorded = true;
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      res.status(202).json({
        ok: true,
        idempotent: true,
        message: 'ADMIN_ACTION_AUDIT_PENDING',
      });
      return false;
    }

    console.error('Admin audit preflight failed.', {
      name: error?.name || 'Error',
      code: error?.code || null,
      requestId: req.adminRequestId,
    });
    res.status(503).json({ message: 'Admin audit unavailable.' });
    return false;
  }
}

function installAdminAuditResponseHook(req, res, metadata) {
  const originalJson = res.json.bind(res);
  let audited = false;

  res.json = function adminAuditJson(payload) {
    if (audited) {
      return originalJson(payload);
    }

    audited = true;
    const statusCode = res.statusCode || 200;
    const result = statusCode >= 200 && statusCode < 400 ? 'success' : 'failure';

    return Promise.resolve(recordAdminAudit(req, metadata, result, statusCode))
      .then(() => originalJson(payload))
      .catch((error) => {
        console.error('Admin audit completion failed.', {
          name: error?.name || 'Error',
          code: error?.code || null,
          requestId: req.adminRequestId,
          pendingRecorded: Boolean(req.adminAuditPendingRecorded),
        });

        if (metadata.critical && req.adminAuditPendingRecorded && !res.headersSent) {
          res.set('X-Admin-Audit-State', 'pending');
        }

        return originalJson(payload);
      });
  };
}

async function requireAdmin(req, res, next) {
  try {
    req.adminRequestId = getRequestId(req);
    res.set('X-Request-Id', req.adminRequestId);

    if (rejectUnsafeAdminInput(req, res)) {
      return undefined;
    }

    const metadata = getRouteMetadata(req);
    req.adminAuditMetadata = metadata;

    if (!await authenticateLegacyAdmin(req)) {
      const authenticated = await authenticateUserAdmin(req, res, metadata);

      if (authenticated !== true) {
        return undefined;
      }
    } else if (legacyAdminAllowedForMetadata(req, res, metadata) !== true) {
      return undefined;
    }

    const auditReady = await beginCriticalAdminAudit(req, res, metadata);

    if (auditReady !== true) {
      return undefined;
    }

    installAdminAuditResponseHook(req, res, metadata);
    return next();
  } catch (error) {
    console.error('Admin authentication failed.', {
      name: error?.name || 'Error',
      code: error?.code || null,
      requestId: req.adminRequestId || null,
    });
    return safeAdminMessage(res, 401);
  }
}

async function revokeAdminSessionsForUser(userId, reason) {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return 0;
  }

  const result = await Session.updateMany(
    {
      userId,
      revokedAt: null,
      adminRevokedAt: null,
    },
    {
      $set: {
        adminRevokedAt: new Date(),
        adminRevokedReason: reason,
      },
    }
  );

  return result.modifiedCount || 0;
}

module.exports = {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  getRouteMetadata,
  hasAdminPermission,
  beginCriticalAdminAudit,
  recordAdminAudit,
  requireAdmin,
  revokeAdminSessionsForUser,
};
