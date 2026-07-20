const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const { generateSync } = require('otplib');

const adminRoutes = require('../routes/adminRoutes');
const AdminAuditLog = require('../models/AdminAuditLog');
const Session = require('../models/Session');
const User = require('../models/User');
const { getAdminTokenKey } = require('../middleware/rateLimit');
const { ADMIN_PERMISSIONS, getRouteMetadata, requireAdmin } = require('../middleware/adminAuth');
const authRoutes = require('../routes/authRoutes');
const { encryptTotpSecret } = require('../utils/twoFactor');

const USER_ID = '64f000000000000000000001';
const OTHER_USER_ID = '64f000000000000000000002';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function getAuthRouteHandler(pathname, method) {
  const layer = authRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getAdminRouteHandler(pathname, method) {
  const layer = adminRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function signToken(payload = {}) {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-auth-test-secret';

  return jwt.sign(
    {
      id: USER_ID,
      jti: 'admin-session-jti',
      ...payload,
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

async function callRequireAdmin({
  path = '/api/admin/projects',
  method = 'GET',
  userRole = 'admin',
  permissions = ['admin:read'],
  twoFactorEnabled = true,
  lastVerifiedAt = new Date(),
  adminGrantedAt = new Date(Date.now() - 2000),
  session = {},
  tokenPayload = {},
  headers = {},
} = {}) {
  const originalSessionFindOne = Session.findOne;
  const originalUserFindById = User.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const token = signToken(tokenPayload);
  let nextCalled = false;

  Session.findOne = async () => session === null ? null : {
    _id: 'session-id',
    createdAt: new Date(Date.now() - 1000),
    mfaVerifiedAt: new Date(),
    ...session,
  };
  User.findById = () => ({
    select: async () => ({
      _id: USER_ID,
      role: userRole,
      deletedAt: null,
      admin: {
        permissions,
        grantedAt: adminGrantedAt,
      },
      twoFactor: {
        enabled: twoFactorEnabled,
        lastVerifiedAt,
      },
    }),
  });
  AdminAuditLog.findOne = () => ({
    sort: async () => null,
  });
  AdminAuditLog.create = async () => ({ _id: 'audit-id' });

  try {
    const req = {
      method,
      originalUrl: path,
      url: path.replace('/api/admin', ''),
      params: {},
      query: {},
      body: {},
      ip: '203.0.113.10',
      socket: {},
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'Node Test Browser/1.0 token-should-not-log',
        ...headers,
      },
    };
    const res = createResponse();

    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    return { req, res, nextCalled };
  } finally {
    Session.findOne = originalSessionFindOne;
    User.findById = originalUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
  }
}

test('ordinary user receives 403 on admin routes', async () => {
  const { res, nextCalled } = await callRequireAdmin({ userRole: 'user', permissions: [] });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('admin without MFA receives 403', async () => {
  const { res, nextCalled } = await callRequireAdmin({ twoFactorEnabled: false });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('admin with MFA enabled but session without MFA verification receives 403', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    twoFactorEnabled: true,
    session: { mfaVerifiedAt: undefined },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('admin with MFA and valid short session accesses admin route', async () => {
  const { res, nextCalled } = await callRequireAdmin();

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('forged MFA claim in JWT is ignored when session lacks MFA verification', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    session: { mfaVerifiedAt: undefined },
    tokenPayload: {
      mfaVerifiedAt: new Date().toISOString(),
      amr: ['mfa'],
    },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('promotion requires a new session created after the admin grant', async () => {
  const grantTime = new Date();
  const { res, nextCalled } = await callRequireAdmin({
    adminGrantedAt: grantTime,
    session: {
      createdAt: new Date(grantTime.getTime() - 60 * 1000),
      mfaVerifiedAt: new Date(grantTime.getTime() - 60 * 1000),
    },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('critical admin route requires recent MFA from the session, not JWT claims', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    path: `/api/admin/users/${OTHER_USER_ID}/role`,
    method: 'PATCH',
    permissions: ADMIN_PERMISSIONS,
    session: {
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      mfaVerifiedAt: new Date(Date.now() - 10 * 60 * 1000),
    },
    tokenPayload: {
      mfaVerifiedAt: new Date().toISOString(),
    },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('expired or revoked admin session fails', async () => {
  const { res, nextCalled } = await callRequireAdmin({ session: null });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('removed admin role invalidates admin access', async () => {
  const { res, nextCalled } = await callRequireAdmin({ userRole: 'user', permissions: ADMIN_PERMISSIONS });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('JWT forged with admin role fails when database role is user', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    userRole: 'user',
    tokenPayload: { role: 'admin', permissions: ADMIN_PERMISSIONS },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('user cannot alter another user without the admin users permission', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    path: `/api/admin/users/${OTHER_USER_ID}/role`,
    method: 'PATCH',
    permissions: ['admin:read', 'admin:write'],
    lastVerifiedAt: new Date(),
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('admin action creates audit log without request secrets', async () => {
  const originalSessionFindOne = Session.findOne;
  const originalUserFindById = User.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const capturedAudits = [];

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-auth-test-secret';
  Session.findOne = async () => ({
    _id: 'session-id',
    createdAt: new Date(Date.now() - 1000),
    mfaVerifiedAt: new Date(),
  });
  User.findById = () => ({
    select: async () => ({
      _id: USER_ID,
      role: 'admin',
      deletedAt: null,
      admin: {
        permissions: ADMIN_PERMISSIONS,
        grantedAt: new Date(Date.now() - 2000),
      },
      twoFactor: {
        enabled: true,
        lastVerifiedAt: new Date(),
      },
    }),
  });
  AdminAuditLog.findOne = () => ({
    sort: async () => null,
  });
  AdminAuditLog.create = async (payload) => {
    capturedAudits.push(payload);
    return { _id: 'audit-id' };
  };

  try {
    const req = {
      method: 'PATCH',
      originalUrl: `/api/admin/users/${OTHER_USER_ID}/role`,
      url: `/users/${OTHER_USER_ID}/role`,
      params: { userId: OTHER_USER_ID },
      query: {},
      body: {
        password: 'super-secret-password',
        token: 'secret-token-value',
        role: 'admin',
      },
      ip: '203.0.113.20',
      socket: {},
      headers: {
        authorization: `Bearer ${signToken()}`,
        'x-request-id': 'audit-test-request',
        'user-agent': 'Node Test Browser/1.0',
      },
    };
    const res = createResponse();

    await requireAdmin(req, res, async () => {
      await res.json({ ok: true });
    });

    assert.equal(res.statusCode, 200);
    assert.equal(capturedAudits.length, 2);
    assert.equal(capturedAudits[0].result, 'pending');
    assert.equal(capturedAudits[1].adminUserId, USER_ID);
    assert.equal(capturedAudits[1].action, `PATCH /users/${OTHER_USER_ID}/role`);
    assert.equal(capturedAudits[1].resourceType, 'user');
    assert.equal(capturedAudits[1].result, 'success');
    assert.equal(capturedAudits[1].requestId, 'audit-test-request');
    assert.equal(JSON.stringify(capturedAudits).includes('super-secret-password'), false);
    assert.equal(JSON.stringify(capturedAudits).includes('secret-token-value'), false);
  } finally {
    Session.findOne = originalSessionFindOne;
    User.findById = originalUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
  }
});

async function callCriticalAdminAction({
  requestId = 'critical-action-request',
  existingAudit = null,
  auditCreate,
  mutate,
} = {}) {
  const originalSessionFindOne = Session.findOne;
  const originalUserFindById = User.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const createdAudits = [];

  Session.findOne = async () => ({
    _id: 'session-id',
    createdAt: new Date(Date.now() - 1000),
    mfaVerifiedAt: new Date(),
  });
  User.findById = () => ({
    select: async () => ({
      _id: USER_ID,
      role: 'admin',
      deletedAt: null,
      admin: {
        permissions: ADMIN_PERMISSIONS,
        grantedAt: new Date(Date.now() - 2000),
      },
      twoFactor: {
        enabled: true,
        lastVerifiedAt: new Date(),
      },
    }),
  });
  AdminAuditLog.findOne = () => ({
    sort: async () => existingAudit,
  });
  AdminAuditLog.create = async (payload) => {
    createdAudits.push(payload);

    if (auditCreate) {
      return auditCreate(payload, createdAudits.length);
    }

    return { _id: `audit-${createdAudits.length}` };
  };

  try {
    const req = {
      method: 'PATCH',
      originalUrl: `/api/admin/users/${OTHER_USER_ID}/role`,
      url: `/users/${OTHER_USER_ID}/role`,
      params: { userId: OTHER_USER_ID },
      query: {},
      body: {
        role: 'admin',
        permissions: ADMIN_PERMISSIONS,
      },
      ip: '203.0.113.40',
      socket: {},
      headers: {
        authorization: `Bearer ${signToken()}`,
        'idempotency-key': requestId,
        'user-agent': 'Node Test Browser/1.0',
      },
    };
    const res = createResponse();
    let nextCalled = false;

    await requireAdmin(req, res, async () => {
      nextCalled = true;
      await mutate?.();
      await res.json({ ok: true });
    });

    return { res, nextCalled, createdAudits };
  } finally {
    Session.findOne = originalSessionFindOne;
    User.findById = originalUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
  }
}

test('audit preflight failure prevents critical admin mutation', async () => {
  let mutated = false;

  const { res, nextCalled, createdAudits } = await callCriticalAdminAction({
    auditCreate: async (payload) => {
      assert.equal(payload.result, 'pending');
      throw Object.assign(new Error('audit unavailable'), { code: 'AUDIT_DOWN' });
    },
    mutate: async () => {
      mutated = true;
    },
  });

  assert.equal(nextCalled, false);
  assert.equal(mutated, false);
  assert.equal(res.statusCode, 503);
  assert.equal(createdAudits.length, 1);
});

test('audit completion failure after mutation keeps success response and blocks duplicate retry', async () => {
  let mutationCount = 0;
  let pendingAudit = null;

  const first = await callCriticalAdminAction({
    requestId: 'retry-after-pending',
    auditCreate: async (payload, count) => {
      if (count === 1) {
        pendingAudit = payload;
        return { _id: 'pending-audit' };
      }

      throw Object.assign(new Error('completion failed'), { code: 'AUDIT_COMPLETION_DOWN' });
    },
    mutate: async () => {
      mutationCount += 1;
    },
  });

  assert.equal(first.nextCalled, true);
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.headers['X-Admin-Audit-State'], 'pending');
  assert.equal(mutationCount, 1);
  assert.equal(first.createdAudits.map((audit) => audit.result).join(','), 'pending,success');

  const retry = await callCriticalAdminAction({
    requestId: 'retry-after-pending',
    existingAudit: {
      ...pendingAudit,
      result: 'pending',
    },
    mutate: async () => {
      mutationCount += 1;
    },
  });

  assert.equal(retry.nextCalled, false);
  assert.equal(retry.res.statusCode, 202);
  assert.equal(mutationCount, 1);
});

test('retry of completed critical admin action is idempotent', async () => {
  let mutationCount = 0;

  const first = await callCriticalAdminAction({
    requestId: 'completed-idempotent-action',
    mutate: async () => {
      mutationCount += 1;
    },
  });

  const successAudit = first.createdAudits.find((audit) => audit.result === 'success');

  assert.equal(first.nextCalled, true);
  assert.equal(first.res.statusCode, 200);
  assert.equal(mutationCount, 1);
  assert.ok(successAudit);

  const retry = await callCriticalAdminAction({
    requestId: 'completed-idempotent-action',
    existingAudit: successAudit,
    mutate: async () => {
      mutationCount += 1;
    },
  });

  assert.equal(retry.nextCalled, false);
  assert.equal(retry.res.statusCode, 200);
  assert.equal(retry.res.body.idempotent, true);
  assert.equal(mutationCount, 1);
});

test('successful critical admin action writes pending and success audit records', async () => {
  let mutationCount = 0;

  const result = await callCriticalAdminAction({
    requestId: 'successful-critical-audit',
    mutate: async () => {
      mutationCount += 1;
    },
  });

  assert.equal(result.res.statusCode, 200);
  assert.equal(mutationCount, 1);
  assert.deepEqual(result.createdAudits.map((audit) => audit.result), ['pending', 'success']);
  assert.ok(result.createdAudits[0].idempotencyKey);
  assert.equal(result.createdAudits[0].idempotencyKey, result.createdAudits[1].idempotencyKey);
  assert.equal(JSON.stringify(result.createdAudits).includes('permissions'), false);
});

test('legacy admin token fails when feature flag is false', async () => {
  const previousToken = process.env.ADMIN_TOKEN;
  const previousFlag = process.env.ADMIN_TOKEN_LEGACY_ENABLED;
  const originalAuditCreate = AdminAuditLog.create;

  process.env.ADMIN_TOKEN = 'legacy-admin-token';
  process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'false';
  AdminAuditLog.create = async () => ({ _id: 'audit-id' });

  try {
    const req = {
      method: 'GET',
      originalUrl: '/api/admin/projects',
      url: '/projects',
      params: {},
      query: {},
      body: {},
      ip: '203.0.113.30',
      socket: {},
      headers: { 'x-admin-token': 'legacy-admin-token' },
    };
    const res = createResponse();
    let nextCalled = false;

    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  } finally {
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousToken;
    if (previousFlag === undefined) delete process.env.ADMIN_TOKEN_LEGACY_ENABLED;
    else process.env.ADMIN_TOKEN_LEGACY_ENABLED = previousFlag;
    AdminAuditLog.create = originalAuditCreate;
  }
});

test('legacy admin token works only when feature flag is true', async () => {
  const previousToken = process.env.ADMIN_TOKEN;
  const previousFlag = process.env.ADMIN_TOKEN_LEGACY_ENABLED;
  const originalAuditCreate = AdminAuditLog.create;
  let capturedAudit = null;

  process.env.ADMIN_TOKEN = 'legacy-admin-token';
  process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'true';
  AdminAuditLog.create = async (payload) => {
    capturedAudit = payload;
    return { _id: 'audit-id' };
  };

  try {
    const req = {
      method: 'GET',
      originalUrl: '/api/admin/projects',
      url: '/projects',
      params: {},
      query: {},
      body: {},
      ip: '203.0.113.30',
      socket: {},
      headers: { 'x-admin-token': 'legacy-admin-token' },
    };
    const res = createResponse();
    let nextCalled = false;

    await requireAdmin(req, res, async () => {
      nextCalled = true;
      await res.json({ ok: true });
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(capturedAudit.actorType, 'legacy_token');
    assert.equal(capturedAudit.adminUserId, null);
  } finally {
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousToken;
    if (previousFlag === undefined) delete process.env.ADMIN_TOKEN_LEGACY_ENABLED;
    else process.env.ADMIN_TOKEN_LEGACY_ENABLED = previousFlag;
    AdminAuditLog.create = originalAuditCreate;
  }
});

test('legacy admin token cannot perform critical mutations unless explicitly enabled', async () => {
  const previousToken = process.env.ADMIN_TOKEN;
  const previousFlag = process.env.ADMIN_TOKEN_LEGACY_ENABLED;
  const previousCriticalFlag = process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED;

  process.env.ADMIN_TOKEN = 'legacy-admin-token';
  process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'true';
  process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED = 'false';

  try {
    const req = {
      method: 'PATCH',
      originalUrl: `/api/admin/users/${OTHER_USER_ID}/role`,
      url: `/users/${OTHER_USER_ID}/role`,
      params: { userId: OTHER_USER_ID },
      query: {},
      body: { role: 'admin' },
      ip: '203.0.113.30',
      socket: {},
      headers: { 'x-admin-token': 'legacy-admin-token' },
    };
    const res = createResponse();
    let nextCalled = false;

    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  } finally {
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousToken;
    if (previousFlag === undefined) delete process.env.ADMIN_TOKEN_LEGACY_ENABLED;
    else process.env.ADMIN_TOKEN_LEGACY_ENABLED = previousFlag;
    if (previousCriticalFlag === undefined) delete process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED;
    else process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED = previousCriticalFlag;
  }
});

test('admin rate limit identity keys do not contain raw bearer or legacy token values', () => {
  const bearer = 'eyJraw.header.payload.signature';
  const legacy = 'legacy-admin-token';

  assert.equal(
    getAdminTokenKey({ headers: { authorization: `Bearer ${bearer}` } }).includes(bearer),
    false
  );
  assert.equal(
    getAdminTokenKey({ headers: { 'x-admin-token': legacy } }).includes(legacy),
    false
  );
});

test('admin route metadata only marks mutating routes as audit-critical', () => {
  assert.equal(getRouteMetadata({
    method: 'GET',
    originalUrl: '/api/admin/status',
    params: {},
  }).critical, false);
  assert.equal(getRouteMetadata({
    method: 'GET',
    originalUrl: '/api/admin/projects/64f000000000000000000099/connectors',
    params: { id: '64f000000000000000000099' },
  }).critical, false);
  assert.equal(getRouteMetadata({
    method: 'GET',
    originalUrl: '/api/admin/projects/64f000000000000000000099/builds/64f000000000000000000088/security-scan',
    params: {
      projectId: '64f000000000000000000099',
      buildId: '64f000000000000000000088',
    },
  }).critical, false);
  assert.equal(getRouteMetadata({
    method: 'PATCH',
    originalUrl: `/api/admin/users/${OTHER_USER_ID}/role`,
    params: { userId: OTHER_USER_ID },
  }).critical, true);
});

test('registration mass assignment cannot promote a user', async () => {
  const originalFindOne = User.findOne;
  const originalExists = User.exists;
  const originalCreate = User.create;
  const handler = getAuthRouteHandler('/register', 'post');
  let capturedCreate = null;

  User.findOne = async () => null;
  User.exists = async () => null;
  User.create = async (payload) => {
    capturedCreate = payload;
    return {
      _id: USER_ID,
      name: payload.name,
      email: payload.email,
      providers: payload.providers,
      onboardingComplete: false,
      preferences: {},
      profile: {},
      twoFactor: {},
    };
  };

  try {
    const res = createResponse();
    await handler({
      body: {
        name: 'Mass Assignment',
        email: 'mass-assignment@example.com',
        password: 'correct-horse-battery-staple',
        role: 'admin',
        isAdmin: true,
        admin: { permissions: ADMIN_PERMISSIONS },
      },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedCreate, 'role'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedCreate, 'isAdmin'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedCreate, 'admin'), false);
  } finally {
    User.findOne = originalFindOne;
    User.exists = originalExists;
    User.create = originalCreate;
  }
});

test('last active admin cannot be demoted', async () => {
  const originalFindById = User.findById;
  const originalCountDocuments = User.countDocuments;
  const handler = getAdminRouteHandler('/users/:userId/role', 'patch');
  let saved = false;

  User.findById = () => ({
    select: async () => ({
      _id: USER_ID,
      role: 'admin',
      admin: {
        permissions: ADMIN_PERMISSIONS,
      },
      deletedAt: null,
      save: async () => {
        saved = true;
      },
    }),
  });
  User.countDocuments = async () => 0;

  try {
    const res = createResponse();
    await handler({
      params: { userId: USER_ID },
      body: {
        role: 'user',
        confirmSelfDemotion: 'DEMOTE_SELF',
      },
      adminAuth: {
        adminUserId: USER_ID,
      },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'LAST_ACTIVE_ADMIN_REQUIRED');
    assert.equal(saved, false);
  } finally {
    User.findById = originalFindById;
    User.countDocuments = originalCountDocuments;
  }
});

test('removing admin role revokes that user admin sessions', async () => {
  const originalFindById = User.findById;
  const originalCountDocuments = User.countDocuments;
  const originalSessionUpdateMany = Session.updateMany;
  const handler = getAdminRouteHandler('/users/:userId/role', 'patch');
  let updateManyQuery = null;
  let saved = false;

  User.findById = () => ({
    select: async () => ({
      _id: OTHER_USER_ID,
      role: 'admin',
      admin: {
        permissions: ADMIN_PERMISSIONS,
      },
      deletedAt: null,
      save: async function saveUser() {
        saved = true;
        return this;
      },
    }),
  });
  User.countDocuments = async () => 1;
  Session.updateMany = async (query, update) => {
    updateManyQuery = { query, update };
    return { modifiedCount: 2 };
  };

  try {
    const res = createResponse();
    await handler({
      params: { userId: OTHER_USER_ID },
      body: { role: 'user' },
      adminAuth: {
        adminUserId: USER_ID,
      },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(saved, true);
    assert.equal(String(updateManyQuery.query.userId), OTHER_USER_ID);
    assert.equal(updateManyQuery.query.adminRevokedAt, null);
    assert.equal(updateManyQuery.update.$set.adminRevokedReason, 'admin_role_changed');
  } finally {
    User.findById = originalFindById;
    User.countDocuments = originalCountDocuments;
    Session.updateMany = originalSessionUpdateMany;
  }
});

test('disabling MFA revokes admin sessions', async () => {
  const originalFindById = User.findById;
  const originalSessionUpdateMany = Session.updateMany;
  const handler = getAuthRouteHandler('/me/2fa/disable', 'post');
  const recoveryCode = 'AAAA-BBBB-CCCC';
  let revokedReason = null;
  const recoveryHash = await bcrypt.hash(recoveryCode.replace(/[^A-Z0-9]/g, ''), 10);
  const user = {
    _id: USER_ID,
    password: await bcrypt.hash('current-password', 10),
    providers: ['local'],
    deletedAt: null,
    twoFactor: {
      enabled: true,
      secretEnc: '',
      recoveryCodes: [{ hash: recoveryHash }],
    },
    save: async function saveUser() {
      return this;
    },
  };

  User.findById = async () => user;
  Session.updateMany = async (query, update) => {
    revokedReason = update.$set.adminRevokedReason;
    return { modifiedCount: 1 };
  };

  try {
    const res = createResponse();
    await handler({
      userId: USER_ID,
      body: {
        currentPassword: 'current-password',
        code: recoveryCode,
      },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'TWO_FACTOR_DISABLED');
    assert.equal(user.twoFactor.enabled, false);
    assert.equal(revokedReason, 'two_factor_disabled');
  } finally {
    User.findById = originalFindById;
    Session.updateMany = originalSessionUpdateMany;
  }
});

async function startTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);

  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

test('Google admin login requires Fluid step-up MFA before admin access', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    TWO_FACTOR_SECRET_KEY: process.env.TWO_FACTOR_SECRET_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_CALLBACK_URL: process.env.GOOGLE_CALLBACK_URL,
    ADMIN_SESSION_TTL_MS: process.env.ADMIN_SESSION_TTL_MS,
    ADMIN_REAUTH_TTL_MS: process.env.ADMIN_REAUTH_TTL_MS,
  };
  const originalFetch = global.fetch;
  const originalUserFindOne = User.findOne;
  const originalUserFindById = User.findById;
  const originalUserExists = User.exists;
  const originalUserUpdateOne = User.updateOne;
  const originalSessionCreate = Session.create;
  const originalSessionFindOne = Session.findOne;
  const originalSessionUpdateOne = Session.updateOne;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const originalConsoleWarn = console.warn;
  const app = await startTestApp();

  process.env.JWT_SECRET = 'google-admin-flow-jwt-secret';
  process.env.TWO_FACTOR_SECRET_KEY = 'google-admin-flow-2fa-secret';
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  process.env.GOOGLE_CALLBACK_URL = `${app.baseUrl}/api/auth/google/callback`;
  process.env.ADMIN_SESSION_TTL_MS = String(20 * 60 * 1000);
  process.env.ADMIN_REAUTH_TTL_MS = String(5 * 60 * 1000);

  const totpSecret = 'S47NGTYLRNCFTSKGFW3FXLFED24EQ3TT';
  const sessionsByJti = new Map();
  const warnings = [];
  const user = {
    _id: USER_ID,
    name: 'Google Admin',
    email: 'google-admin@example.com',
    googleId: 'google-subject-1',
    avatar: '',
    emailVerified: true,
    providers: ['google'],
    role: 'admin',
    admin: {
      permissions: ADMIN_PERMISSIONS,
      grantedAt: new Date(Date.now() - 2000),
    },
    deletedAt: null,
    onboardingComplete: true,
    profile: {},
    preferences: {},
    twoFactor: {
      enabled: true,
      secretEnc: encryptTotpSecret(totpSecret),
      lastVerifiedAt: null,
      recoveryCodes: [],
    },
    save: async function saveUser() {
      return this;
    },
  };

  function selectable(document) {
    return {
      ...document,
      select: async () => document,
    };
  }

  global.fetch = async (url, options) => {
    const normalizedUrl = String(url);

    if (normalizedUrl === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({
          access_token: 'google-access-token',
          id_token: jwt.sign(
            {
              iss: 'https://accounts.google.com',
              aud: process.env.GOOGLE_CLIENT_ID,
              sub: user.googleId,
              amr: ['mfa'],
              acr: 'urn:forged:mfa',
            },
            'untrusted-oauth-claim'
          ),
        }),
      };
    }

    if (normalizedUrl === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return {
        ok: true,
        json: async () => ({
          sub: user.googleId,
          email: user.email,
          email_verified: true,
          name: user.name,
          picture: '',
          amr: ['mfa'],
          acr: 'urn:forged:mfa',
        }),
      };
    }

    return originalFetch(url, options);
  };
  User.findOne = async (query) => {
    if (query?.googleId === user.googleId || query?.email === user.email) {
      return user;
    }

    return null;
  };
  User.findById = () => selectable(user);
  User.exists = async () => null;
  User.updateOne = async (query, update) => {
    if (String(query?._id) === USER_ID && update?.$set?.['twoFactor.lastVerifiedAt']) {
      user.twoFactor.lastVerifiedAt = update.$set['twoFactor.lastVerifiedAt'];
    }

    return { matchedCount: 1, modifiedCount: 1 };
  };
  Session.create = async (payload) => {
    const session = {
      _id: `google-session-${sessionsByJti.size + 1}`,
      ...payload,
      createdAt: payload.createdAt || new Date(),
      expiresAt: payload.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      adminRevokedAt: null,
    };
    sessionsByJti.set(session.jti, session);
    return session;
  };
  Session.findOne = async (query) => {
    const session = sessionsByJti.get(query?.jti);

    if (!session || String(query?.userId) !== USER_ID) {
      return null;
    }

    if (query.revokedAt === null && session.revokedAt) {
      return null;
    }

    if (query.adminRevokedAt === null && session.adminRevokedAt) {
      return null;
    }

    if (query.expiresAt?.$gt && !(session.expiresAt > query.expiresAt.$gt)) {
      return null;
    }

    return session;
  };
  Session.updateOne = async (query, update) => {
    const session = Array.from(sessionsByJti.values()).find((item) => String(item._id) === String(query?._id));

    if (!session || String(query?.userId) !== USER_ID) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    session.mfaVerifiedAt = update.$set.mfaVerifiedAt;
    session.lastSeenAt = update.$set.lastSeenAt;
    return { matchedCount: 1, modifiedCount: 1 };
  };
  AdminAuditLog.findOne = () => ({
    sort: async () => null,
  });
  AdminAuditLog.create = async () => ({ _id: 'google-admin-audit' });
  console.warn = (message, metadata) => {
    if (message === 'Admin authorization denied.') {
      warnings.push(metadata);
      return;
    }

    originalConsoleWarn(message, metadata);
  };

  try {
    const start = await originalFetch(`${app.baseUrl}/api/auth/google?redirect=/admin.html`, {
      redirect: 'manual',
    });
    const authLocation = start.headers.get('location');
    const state = new URL(authLocation).searchParams.get('state');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];

    const callback = await originalFetch(`${app.baseUrl}/api/auth/google/callback?code=oauth-code&state=${encodeURIComponent(state)}`, {
      headers: {
        Cookie: stateCookie,
      },
      redirect: 'manual',
    });
    const redirectLocation = callback.headers.get('location');
    const fragment = new URL(redirectLocation).hash.slice(1);
    const token = new URLSearchParams(fragment).get('token');
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const session = sessionsByJti.get(decoded.jti);

    assert.ok(token);
    assert.equal(session.mfaVerifiedAt, undefined);

    const denied = await originalFetch(`${app.baseUrl}/api/admin/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Request-Id': 'google-admin-no-fluid-mfa',
      },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { message: 'Admin não autorizado' });
    assert.equal(warnings.at(-1).requestId, 'google-admin-no-fluid-mfa');
    assert.equal(warnings.at(-1).reason, 'mfa_not_verified');
    assert.equal(JSON.stringify(warnings).includes(user.email), false);
    assert.equal(JSON.stringify(warnings).includes(decoded.jti), false);

    const invalidStepUp = await requestJson(app.baseUrl, '/api/auth/me/2fa/step-up', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        code: '000000',
      },
    });
    assert.equal(invalidStepUp.status, 400);
    assert.equal(session.mfaVerifiedAt, undefined);

    const stillDenied = await originalFetch(`${app.baseUrl}/api/admin/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Request-Id': 'google-admin-invalid-step-up',
      },
    });
    assert.equal(stillDenied.status, 403);
    assert.equal(warnings.at(-1).reason, 'mfa_not_verified');

    const validStepUp = await requestJson(app.baseUrl, '/api/auth/me/2fa/step-up', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: {
        code: generateSync({ secret: totpSecret }),
      },
    });
    assert.equal(validStepUp.status, 200);
    assert.ok(session.mfaVerifiedAt);
    assert.ok(session.createdAt >= user.admin.grantedAt);

    const allowed = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.ok, true);
  } finally {
    await app.close();
    global.fetch = originalFetch;
    User.findOne = originalUserFindOne;
    User.findById = originalUserFindById;
    User.exists = originalUserExists;
    User.updateOne = originalUserUpdateOne;
    Session.create = originalSessionCreate;
    Session.findOne = originalSessionFindOne;
    Session.updateOne = originalSessionUpdateOne;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
    console.warn = originalConsoleWarn;

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('full admin flow uses per-session MFA, admin grant time, revocation, audit and legacy-off behavior', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    TWO_FACTOR_SECRET_KEY: process.env.TWO_FACTOR_SECRET_KEY,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    ADMIN_TOKEN_LEGACY_ENABLED: process.env.ADMIN_TOKEN_LEGACY_ENABLED,
    ADMIN_SESSION_TTL_MS: process.env.ADMIN_SESSION_TTL_MS,
    ADMIN_REAUTH_TTL_MS: process.env.ADMIN_REAUTH_TTL_MS,
  };
  const originalUserFindOne = User.findOne;
  const originalUserFindById = User.findById;
  const originalUserUpdateOne = User.updateOne;
  const originalUserCountDocuments = User.countDocuments;
  const originalSessionCreate = Session.create;
  const originalSessionFindOne = Session.findOne;
  const originalSessionUpdateMany = Session.updateMany;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const app = await startTestApp();

  process.env.JWT_SECRET = 'admin-flow-integration-jwt-secret';
  process.env.TWO_FACTOR_SECRET_KEY = 'admin-flow-integration-2fa-secret';
  process.env.ADMIN_TOKEN = 'legacy-token-value';
  process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'false';
  process.env.ADMIN_SESSION_TTL_MS = String(20 * 60 * 1000);
  process.env.ADMIN_REAUTH_TTL_MS = String(5 * 60 * 1000);

  const userId = USER_ID;
  const targetUserId = OTHER_USER_ID;
  const recoveryCode = 'ABCD-1234-EFGH';
  const password = 'correct-horse-battery-staple';
  const passwordHash = await bcrypt.hash(password, 10);
  const sessionsByJti = new Map();
  const audits = [];
  const auditByIdempotencyKey = new Map();
  const recoveryHash = await bcrypt.hash(recoveryCode.replace(/[^A-Z0-9]/g, ''), 10);
  const user = {
    _id: userId,
    name: 'Admin Candidate',
    email: 'admin-candidate@example.com',
    password: passwordHash,
    providers: ['local'],
    role: 'user',
    admin: {
      permissions: [],
      grantedAt: null,
    },
    deletedAt: null,
    onboardingComplete: true,
    profile: {},
    preferences: {},
    twoFactor: {
      enabled: false,
      secretEnc: encryptTotpSecret('JBSWY3DPEHPK3PXP'),
      lastVerifiedAt: null,
      recoveryCodes: [
        {
          hash: recoveryHash,
        },
      ],
    },
    save: async function saveUser() {
      return this;
    },
  };
  const targetUser = {
    _id: targetUserId,
    role: 'user',
    admin: {
      permissions: [],
      grantedAt: null,
    },
    deletedAt: null,
    save: async function saveTargetUser() {
      this.saved = true;
      return this;
    },
  };

  function selectable(document) {
    return {
      ...document,
      select: async () => document,
    };
  }

  User.findOne = async (query) => {
    if (query?.email === user.email) {
      return user;
    }

    return null;
  };
  User.findById = (id) => {
    const document = String(id) === targetUserId ? targetUser : user;
    return selectable(document);
  };
  User.updateOne = async (query, update) => {
    if (String(query?._id) === userId && update?.$set?.['twoFactor.lastVerifiedAt']) {
      user.twoFactor.lastVerifiedAt = update.$set['twoFactor.lastVerifiedAt'];
    }

    return { modifiedCount: 1 };
  };
  User.countDocuments = async () => 1;
  Session.create = async (payload) => {
    const session = {
      _id: `session-${sessionsByJti.size + 1}`,
      ...payload,
      createdAt: payload.createdAt || new Date(),
      expiresAt: payload.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      adminRevokedAt: null,
    };
    sessionsByJti.set(session.jti, session);
    return session;
  };
  Session.findOne = async (query) => {
    const session = sessionsByJti.get(query?.jti);

    if (!session || String(query?.userId) !== userId) {
      return null;
    }

    if (query.revokedAt === null && session.revokedAt) {
      return null;
    }

    if (query.adminRevokedAt === null && session.adminRevokedAt) {
      return null;
    }

    if (query.expiresAt?.$gt && !(session.expiresAt > query.expiresAt.$gt)) {
      return null;
    }

    return session;
  };
  Session.updateMany = async (query, update) => {
    let modifiedCount = 0;

    for (const session of sessionsByJti.values()) {
      if (String(session.userId) !== String(query.userId)) {
        continue;
      }

      if (query.adminRevokedAt === null && session.adminRevokedAt) {
        continue;
      }

      session.adminRevokedAt = update.$set.adminRevokedAt;
      session.adminRevokedReason = update.$set.adminRevokedReason;
      modifiedCount += 1;
    }

    return { modifiedCount };
  };
  AdminAuditLog.findOne = (query) => ({
    sort: async () => auditByIdempotencyKey.get(query?.idempotencyKey) || null,
  });
  AdminAuditLog.create = async (payload) => {
    const audit = {
      _id: `audit-${audits.length + 1}`,
      timestamp: new Date(),
      ...payload,
    };
    audits.push(audit);

    if (audit.idempotencyKey && ['pending', 'success'].includes(audit.result)) {
      auditByIdempotencyKey.set(audit.idempotencyKey, audit);
    }

    return audit;
  };

  try {
    const commonLogin = await requestJson(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: user.email,
        password,
      },
    });
    assert.equal(commonLogin.status, 200);
    assert.ok(commonLogin.body.token);

    const commonStatus = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${commonLogin.body.token}`,
      },
    });
    assert.equal(commonStatus.status, 403);

    const oldToken = commonLogin.body.token;
    user.role = 'admin';
    user.admin = {
      permissions: ADMIN_PERMISSIONS,
      grantedAt: new Date(),
    };
    user.twoFactor.enabled = true;

    const oldTokenAfterPromotion = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${oldToken}`,
      },
    });
    assert.equal(oldTokenAfterPromotion.status, 403);

    const login = await requestJson(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: {
        email: user.email,
        password,
      },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.requiresTwoFactor, true);
    assert.ok(login.body.loginChallenge);

    const mfa = await requestJson(app.baseUrl, '/api/auth/2fa/verify-login', {
      method: 'POST',
      body: {
        loginChallenge: login.body.loginChallenge,
        code: recoveryCode,
      },
    });
    assert.equal(mfa.status, 200);
    assert.ok(mfa.body.token);

    const decoded = jwt.verify(mfa.body.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const adminSession = sessionsByJti.get(decoded.jti);
    assert.ok(adminSession?.mfaVerifiedAt);
    assert.ok(adminSession.createdAt >= user.admin.grantedAt);

    const adminStatus = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
        'X-Forwarded-For': '198.51.100.77',
      },
    });
    assert.equal(adminStatus.status, 200);
    assert.equal(adminStatus.body.ok, true);

    const critical = await requestJson(app.baseUrl, `/api/admin/users/${targetUserId}/role`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
        'Idempotency-Key': 'admin-flow-role-update',
      },
      body: {
        role: 'admin',
        permissions: ['admin:read'],
      },
    });
    assert.equal(critical.status, 200);
    assert.equal(targetUser.role, 'admin');
    assert.equal(targetUser.saved, true);

    const retry = await requestJson(app.baseUrl, `/api/admin/users/${targetUserId}/role`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
        'Idempotency-Key': 'admin-flow-role-update',
      },
      body: {
        role: 'admin',
        permissions: ['admin:read'],
      },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);

    const successAudits = audits.filter((audit) => audit.result === 'success');
    assert.ok(successAudits.some((audit) => audit.action === 'GET /status'));
    assert.ok(successAudits.some((audit) => audit.action === `PATCH /users/${targetUserId}/role`));
    assert.equal(JSON.stringify(audits).includes(password), false);
    assert.equal(JSON.stringify(audits).includes(recoveryCode), false);
    assert.equal(JSON.stringify(audits).includes(mfa.body.token), false);

    adminSession.expiresAt = new Date(Date.now() - 1000);
    const expired = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
      },
    });
    assert.equal(expired.status, 401);

    adminSession.expiresAt = new Date(Date.now() + 60 * 1000);
    adminSession.adminRevokedAt = new Date();
    const revoked = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
      },
    });
    assert.equal(revoked.status, 401);

    adminSession.adminRevokedAt = null;
    user.role = 'user';
    const removedRole = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        Authorization: `Bearer ${mfa.body.token}`,
      },
    });
    assert.equal(removedRole.status, 403);

    const legacyOff = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: {
        'x-admin-token': 'legacy-token-value',
      },
    });
    assert.equal(legacyOff.status, 401);
  } finally {
    await app.close();
    User.findOne = originalUserFindOne;
    User.findById = originalUserFindById;
    User.updateOne = originalUserUpdateOne;
    User.countDocuments = originalUserCountDocuments;
    Session.create = originalSessionCreate;
    Session.findOne = originalSessionFindOne;
    Session.updateMany = originalSessionUpdateMany;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
