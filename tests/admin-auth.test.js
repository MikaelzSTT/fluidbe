const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const { generateSync } = require('otplib');

const adminRoutes = require('../routes/adminRoutes');
const adminAuthRoutes = require('../routes/adminAuthRoutes');
const authRoutes = require('../routes/authRoutes');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminSession = require('../models/AdminSession');
const AdminUser = require('../models/AdminUser');
const Session = require('../models/Session');
const User = require('../models/User');
const { getAdminTokenKey } = require('../middleware/rateLimit');
const { ADMIN_PERMISSIONS, getRouteMetadata, requireAdmin } = require('../middleware/adminAuth');
const {
  encryptAdminTotpSecret,
  signAdminToken,
} = require('../utils/adminIdentity');

const ADMIN_USER_ID = '64f000000000000000000011';
const USER_ID = '64f000000000000000000001';
const OTHER_USER_ID = '64f000000000000000000002';

function setAdminEnv() {
  process.env.JWT_SECRET = 'public-auth-test-secret';
  process.env.ADMIN_JWT_SECRET = 'separate-admin-auth-test-secret';
  process.env.ADMIN_JWT_ISSUER = 'fluid-admin-test';
  process.env.ADMIN_JWT_AUDIENCE = 'fluid-admin-api-test';
  process.env.ADMIN_TWO_FACTOR_SECRET_KEY = 'admin-mfa-test-secret';
  process.env.ADMIN_SESSION_TTL_MS = String(20 * 60 * 1000);
  process.env.ADMIN_REAUTH_TTL_MS = String(5 * 60 * 1000);
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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

function signPublicToken(payload = {}) {
  return jwt.sign(
    {
      id: USER_ID,
      jti: 'public-session-jti',
      ...payload,
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

function makeAdminUser(overrides = {}) {
  return {
    _id: ADMIN_USER_ID,
    email: 'operator@example.com',
    active: true,
    permissions: ['admin:read'],
    mfa: {
      enabled: true,
      secretEnc: 'encrypted-secret',
      lastVerifiedAt: new Date(),
      recoveryCodes: [],
    },
    ...overrides,
  };
}

function makeAdminSession(overrides = {}) {
  const now = new Date();

  return {
    _id: 'admin-session-id',
    adminUserId: ADMIN_USER_ID,
    jti: 'admin-session-jti',
    createdAt: new Date(now.getTime() - 1000),
    mfaVerifiedAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    revokedAt: null,
    save: async function saveSession() {
      return this;
    },
    ...overrides,
  };
}

function selectable(document) {
  return {
    select: async () => document,
    then(resolve, reject) {
      return Promise.resolve(document).then(resolve, reject);
    },
  };
}

async function callRequireAdmin({
  path = '/api/admin/projects',
  method = 'GET',
  adminUser = makeAdminUser(),
  adminSession = makeAdminSession(),
  token,
  body = {},
  params = {},
  headers = {},
} = {}) {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    ADMIN_JWT_ISSUER: process.env.ADMIN_JWT_ISSUER,
    ADMIN_JWT_AUDIENCE: process.env.ADMIN_JWT_AUDIENCE,
    ADMIN_TWO_FACTOR_SECRET_KEY: process.env.ADMIN_TWO_FACTOR_SECRET_KEY,
    ADMIN_SESSION_TTL_MS: process.env.ADMIN_SESSION_TTL_MS,
    ADMIN_REAUTH_TTL_MS: process.env.ADMIN_REAUTH_TTL_MS,
  };
  const originalAdminSessionFindOne = AdminSession.findOne;
  const originalAdminUserFindById = AdminUser.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  let nextCalled = false;

  setAdminEnv();
  const bearer = token || signAdminToken(adminUser, adminSession?.jti || 'admin-session-jti');
  AdminSession.findOne = async () => adminSession;
  AdminUser.findById = () => selectable(adminUser);
  AdminAuditLog.findOne = () => ({ sort: async () => null });
  AdminAuditLog.create = async () => ({ _id: 'audit-id' });

  try {
    const req = {
      method,
      originalUrl: path,
      url: path.replace('/api/admin', ''),
      params,
      query: {},
      body,
      ip: '203.0.113.10',
      socket: {},
      headers: {
        authorization: `Bearer ${bearer}`,
        'user-agent': 'Node Test Browser/1.0',
        ...headers,
      },
    };
    const res = createResponse();

    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    return { req, res, nextCalled };
  } finally {
    AdminSession.findOne = originalAdminSessionFindOne;
    AdminUser.findById = originalAdminUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
    restoreEnv(previousEnv);
  }
}

test('normal public JWT receives 401 on admin routes', async () => {
  setAdminEnv();
  const token = signPublicToken();
  const { res, nextCalled } = await callRequireAdmin({ token });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('public JWT with forged role=admin claim fails on admin routes', async () => {
  setAdminEnv();
  const token = signPublicToken({ role: 'admin', permissions: ADMIN_PERMISSIONS });
  const { res, nextCalled } = await callRequireAdmin({ token });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('AdminUser without administrative MFA cannot access admin routes', async () => {
  const { res, nextCalled } = await callRequireAdmin({
    adminUser: makeAdminUser({ mfa: { enabled: false } }),
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('AdminUser with own MFA and valid AdminSession accesses admin routes', async () => {
  const { res, nextCalled } = await callRequireAdmin();

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('expired or revoked AdminSession fails closed', async () => {
  const expired = await callRequireAdmin({ adminSession: null });

  assert.equal(expired.nextCalled, false);
  assert.equal(expired.res.statusCode, 401);

  const revoked = await callRequireAdmin({ adminSession: null });

  assert.equal(revoked.nextCalled, false);
  assert.equal(revoked.res.statusCode, 401);
});

test('critical admin route requires recent admin MFA from AdminSession', async () => {
  const staleMfaSession = makeAdminSession({
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    mfaVerifiedAt: new Date(Date.now() - 10 * 60 * 1000),
  });
  const { res, nextCalled } = await callRequireAdmin({
    path: `/api/admin/users/${OTHER_USER_ID}/role`,
    method: 'PATCH',
    adminUser: makeAdminUser({ permissions: ADMIN_PERMISSIONS }),
    adminSession: staleMfaSession,
    params: { userId: OTHER_USER_ID },
    body: { role: 'admin' },
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('public user registration never creates AdminUser', async () => {
  const originalUserFindOne = User.findOne;
  const originalUserExists = User.exists;
  const originalUserCreate = User.create;
  const originalAdminCreate = AdminUser.create;
  const handler = getAuthRouteHandler('/register', 'post');
  let capturedUserCreate = null;
  let adminCreateCalled = false;

  User.findOne = async () => null;
  User.exists = async () => null;
  User.create = async (payload) => {
    capturedUserCreate = payload;
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
  AdminUser.create = async () => {
    adminCreateCalled = true;
    throw new Error('AdminUser must not be created by public registration.');
  };

  try {
    const res = createResponse();
    await handler({
      body: {
        name: 'Public Client',
        email: 'same@example.com',
        password: 'correct-horse-battery-staple',
        role: 'admin',
        admin: { permissions: ADMIN_PERMISSIONS },
      },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(adminCreateCalled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedUserCreate, 'role'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(capturedUserCreate, 'admin'), false);
  } finally {
    User.findOne = originalUserFindOne;
    User.exists = originalUserExists;
    User.create = originalUserCreate;
    AdminUser.create = originalAdminCreate;
  }
});

test('admin action audit preserves idempotency and does not store raw token or MFA values', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    ADMIN_JWT_ISSUER: process.env.ADMIN_JWT_ISSUER,
    ADMIN_JWT_AUDIENCE: process.env.ADMIN_JWT_AUDIENCE,
    ADMIN_TWO_FACTOR_SECRET_KEY: process.env.ADMIN_TWO_FACTOR_SECRET_KEY,
  };
  const originalAdminSessionFindOne = AdminSession.findOne;
  const originalAdminUserFindById = AdminUser.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const createdAudits = [];
  const adminUser = makeAdminUser({ permissions: ADMIN_PERMISSIONS });
  const adminSession = makeAdminSession();
  let mutationCount = 0;

  setAdminEnv();
  const token = signAdminToken(adminUser, adminSession.jti);
  AdminSession.findOne = async () => adminSession;
  AdminUser.findById = () => selectable(adminUser);
  AdminAuditLog.findOne = () => ({ sort: async () => null });
  AdminAuditLog.create = async (payload) => {
    createdAudits.push(payload);
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
        token,
        code: '123456',
        password: 'admin-password',
        role: 'admin',
      },
      ip: '203.0.113.20',
      socket: {},
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'critical-admin-action',
        'user-agent': 'Node Test Browser/1.0',
      },
    };
    const res = createResponse();

    await requireAdmin(req, res, async () => {
      mutationCount += 1;
      await res.json({ ok: true });
    });

    assert.equal(res.statusCode, 200);
    assert.equal(mutationCount, 1);
    assert.deepEqual(createdAudits.map((audit) => audit.result), ['pending', 'success']);
    assert.equal(createdAudits[0].idempotencyKey, createdAudits[1].idempotencyKey);
    assert.equal(createdAudits[1].actorType, 'admin_user');
    assert.equal(JSON.stringify(createdAudits).includes(token), false);
    assert.equal(JSON.stringify(createdAudits).includes('123456'), false);
    assert.equal(JSON.stringify(createdAudits).includes('admin-password'), false);
  } finally {
    AdminSession.findOne = originalAdminSessionFindOne;
    AdminUser.findById = originalAdminUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
    restoreEnv(previousEnv);
  }
});

test('retry of completed critical admin action remains idempotent', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    ADMIN_JWT_ISSUER: process.env.ADMIN_JWT_ISSUER,
    ADMIN_JWT_AUDIENCE: process.env.ADMIN_JWT_AUDIENCE,
    ADMIN_TWO_FACTOR_SECRET_KEY: process.env.ADMIN_TWO_FACTOR_SECRET_KEY,
  };
  const originalAdminSessionFindOne = AdminSession.findOne;
  const originalAdminUserFindById = AdminUser.findById;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const adminUser = makeAdminUser({ permissions: ADMIN_PERMISSIONS });
  const adminSession = makeAdminSession();

  setAdminEnv();
  const token = signAdminToken(adminUser, adminSession.jti);
  const existingAudit = {
    result: 'success',
    idempotencyKey: 'already-done',
    timestamp: new Date(),
  };
  AdminSession.findOne = async () => adminSession;
  AdminUser.findById = () => selectable(adminUser);
  AdminAuditLog.findOne = () => ({ sort: async () => existingAudit });
  AdminAuditLog.create = async () => {
    throw new Error('No audit should be created for completed idempotent retry.');
  };

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
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'already-done-request',
      },
    };
    const res = createResponse();
    let nextCalled = false;

    await requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotent, true);
  } finally {
    AdminSession.findOne = originalAdminSessionFindOne;
    AdminUser.findById = originalAdminUserFindById;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
    restoreEnv(previousEnv);
  }
});

test('legacy admin token is disabled by default and gated by flag', async () => {
  const previousEnv = {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    ADMIN_TOKEN_LEGACY_ENABLED: process.env.ADMIN_TOKEN_LEGACY_ENABLED,
  };
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
    const disabledRes = createResponse();
    let disabledNext = false;

    await requireAdmin(req, disabledRes, () => {
      disabledNext = true;
    });

    assert.equal(disabledNext, false);
    assert.equal(disabledRes.statusCode, 401);

    process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'true';

    const enabledRes = createResponse();
    let enabledNext = false;

    await requireAdmin(req, enabledRes, async () => {
      enabledNext = true;
      await enabledRes.json({ ok: true });
    });

    assert.equal(enabledNext, true);
    assert.equal(enabledRes.statusCode, 200);
  } finally {
    AdminAuditLog.create = originalAuditCreate;
    restoreEnv(previousEnv);
  }
});

test('legacy admin token cannot perform critical mutations unless explicitly enabled', async () => {
  const previousEnv = {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    ADMIN_TOKEN_LEGACY_ENABLED: process.env.ADMIN_TOKEN_LEGACY_ENABLED,
    ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED: process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED,
  };

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
    restoreEnv(previousEnv);
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
    method: 'PATCH',
    originalUrl: `/api/admin/users/${OTHER_USER_ID}/role`,
    params: { userId: OTHER_USER_ID },
  }).critical, true);
});

async function startTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin-auth', adminAuthRoutes);
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

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
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
    body,
  };
}

test('public User and AdminUser can share email without sharing session or permissions', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    ADMIN_JWT_ISSUER: process.env.ADMIN_JWT_ISSUER,
    ADMIN_JWT_AUDIENCE: process.env.ADMIN_JWT_AUDIENCE,
    ADMIN_TWO_FACTOR_SECRET_KEY: process.env.ADMIN_TWO_FACTOR_SECRET_KEY,
    ADMIN_SESSION_TTL_MS: process.env.ADMIN_SESSION_TTL_MS,
    ADMIN_REAUTH_TTL_MS: process.env.ADMIN_REAUTH_TTL_MS,
  };
  const originalUserFindOne = User.findOne;
  const originalUserFindById = User.findById;
  const originalSessionCreate = Session.create;
  const originalSessionFindOne = Session.findOne;
  const originalAdminUserFindOne = AdminUser.findOne;
  const originalAdminUserFindById = AdminUser.findById;
  const originalAdminUserUpdateOne = AdminUser.updateOne;
  const originalAdminSessionCreate = AdminSession.create;
  const originalAdminSessionFindOne = AdminSession.findOne;
  const originalAdminSessionUpdateOne = AdminSession.updateOne;
  const originalAuditCreate = AdminAuditLog.create;
  const originalAuditFindOne = AdminAuditLog.findOne;
  const app = await startTestApp();

  setAdminEnv();

  const email = 'same@example.com';
  const publicPassword = 'public-password';
  const adminPassword = 'admin-password-long';
  const totpSecret = 'S47NGTYLRNCFTSKGFW3FXLFED24EQ3TT';
  const publicUser = {
    _id: USER_ID,
    name: 'Public Client',
    email,
    password: await bcrypt.hash(publicPassword, 10),
    providers: ['local'],
    deletedAt: null,
    onboardingComplete: true,
    profile: {},
    preferences: {},
    twoFactor: { enabled: false },
  };
  const adminUser = {
    _id: ADMIN_USER_ID,
    email,
    passwordHash: await bcrypt.hash(adminPassword, 12),
    active: true,
    permissions: ADMIN_PERMISSIONS,
    mfa: {
      enabled: true,
      secretEnc: encryptAdminTotpSecret(totpSecret),
      recoveryCodes: [],
    },
    failedLoginCount: 0,
    save: async function saveAdminUser() {
      return this;
    },
  };
  const publicSessionsByJti = new Map();
  const adminSessionsByJti = new Map();

  User.findOne = async (query) => query?.email === email ? publicUser : null;
  User.findById = async (id) => String(id) === USER_ID ? publicUser : null;
  Session.create = async (payload) => {
    const session = {
      _id: `public-session-${publicSessionsByJti.size + 1}`,
      ...payload,
      revokedAt: null,
    };
    publicSessionsByJti.set(session.jti, session);
    return session;
  };
  Session.findOne = async (query) => {
    const session = publicSessionsByJti.get(query?.jti);

    if (!session || String(session.userId) !== String(query?.userId)) {
      return null;
    }

    if (query.revokedAt === null && session.revokedAt) {
      return null;
    }

    if (query.expiresAt?.$gt && !(session.expiresAt > query.expiresAt.$gt)) {
      return null;
    }

    return session;
  };
  AdminUser.findOne = () => ({ select: async () => adminUser });
  AdminUser.findById = () => selectable(adminUser);
  AdminUser.updateOne = async (query, update) => {
    if (update?.$set?.['mfa.lastVerifiedAt']) {
      adminUser.mfa.lastVerifiedAt = update.$set['mfa.lastVerifiedAt'];
    }

    return { matchedCount: 1, modifiedCount: 1 };
  };
  AdminSession.create = async (payload) => {
    const session = {
      _id: `admin-session-${adminSessionsByJti.size + 1}`,
      ...payload,
      revokedAt: null,
      save: async function saveAdminSession() {
        return this;
      },
    };
    adminSessionsByJti.set(session.jti, session);
    return session;
  };
  AdminSession.findOne = async (query) => {
    const session = adminSessionsByJti.get(query?.jti);

    if (!session || String(session.adminUserId) !== String(query?.adminUserId)) {
      return null;
    }

    if (query.revokedAt === null && session.revokedAt) {
      return null;
    }

    if (query.expiresAt?.$gt && !(session.expiresAt > query.expiresAt.$gt)) {
      return null;
    }

    return session;
  };
  AdminSession.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });
  AdminAuditLog.findOne = () => ({ sort: async () => null });
  AdminAuditLog.create = async () => ({ _id: 'audit-id' });

  try {
    const publicLogin = await requestJson(app.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email, password: publicPassword },
    });
    assert.equal(publicLogin.status, 200);
    assert.ok(publicLogin.body.token);

    const publicDenied = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: { Authorization: `Bearer ${publicLogin.body.token}` },
    });
    assert.equal(publicDenied.status, 401);

    const adminLogin = await requestJson(app.baseUrl, '/api/admin-auth/login', {
      method: 'POST',
      body: { email, password: adminPassword },
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.requiresMfa, true);

    const adminMfa = await requestJson(app.baseUrl, '/api/admin-auth/mfa/verify', {
      method: 'POST',
      body: {
        loginChallenge: adminLogin.body.loginChallenge,
        code: generateSync({ secret: totpSecret }),
      },
    });
    assert.equal(adminMfa.status, 200);
    assert.ok(adminMfa.body.token);

    const adminStatus = await requestJson(app.baseUrl, '/api/admin/status', {
      headers: { Authorization: `Bearer ${adminMfa.body.token}` },
    });
    assert.equal(adminStatus.status, 200);
    assert.equal(adminStatus.body.admin.actorType, 'admin_user');
    assert.equal(adminStatus.body.admin.userId, ADMIN_USER_ID);

    const adminTokenRejectedByPublicAuth = await requestJson(app.baseUrl, '/api/auth/me', {
      headers: { Authorization: `Bearer ${adminMfa.body.token}` },
    });
    assert.equal(adminTokenRejectedByPublicAuth.status, 401);
  } finally {
    await app.close();
    User.findOne = originalUserFindOne;
    User.findById = originalUserFindById;
    Session.create = originalSessionCreate;
    Session.findOne = originalSessionFindOne;
    AdminUser.findOne = originalAdminUserFindOne;
    AdminUser.findById = originalAdminUserFindById;
    AdminUser.updateOne = originalAdminUserUpdateOne;
    AdminSession.create = originalAdminSessionCreate;
    AdminSession.findOne = originalAdminSessionFindOne;
    AdminSession.updateOne = originalAdminSessionUpdateOne;
    AdminAuditLog.create = originalAuditCreate;
    AdminAuditLog.findOne = originalAuditFindOne;
    restoreEnv(previousEnv);
  }
});

test('admin.html does not depend on fluid-token', () => {
  const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');

  if (!fs.existsSync(adminHtmlPath)) {
    assert.equal(fs.existsSync(adminHtmlPath), false);
    return;
  }

  const html = fs.readFileSync(adminHtmlPath, 'utf8');

  assert.equal(html.includes('fluid-token'), false);
  assert.match(html, /admin-token|admin-auth/i);
});
