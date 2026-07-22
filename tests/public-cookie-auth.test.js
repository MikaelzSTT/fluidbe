const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const http = require('http');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const fs = require('fs/promises');
const path = require('path');

const authMiddleware = require('../middleware/authMiddleware');
const Session = require('../models/Session');
const User = require('../models/User');
const { app, previewIsolationHelpers, publicAuthHelpers } = require('../server');

const USER_ID = '64f000000000000000000501';
const JWT_SECRET = 'public-cookie-auth-test-secret';
const PUBLIC_APP_ORIGIN = 'https://askfluid.now';
const SESSION_COOKIE_NAME = '__Host-fluid_session';

function selectable(document) {
  return {
    select: async () => document,
    then(resolve, reject) {
      return Promise.resolve(document).then(resolve, reject);
    },
  };
}

function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setCookieModeEnv() {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_COOKIE_AUTH_ENABLED = 'true';
  process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'true';
  process.env.PUBLIC_COOKIE_NAME = SESSION_COOKIE_NAME;
  process.env.PUBLIC_APP_ORIGIN = PUBLIC_APP_ORIGIN;
  process.env.PUBLIC_AUTH_MIGRATION_DEADLINE = '2026-08-15';
}

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(server, options) {
  return new Promise((resolve, reject) => {
    const payload = options.body ? JSON.stringify(options.body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method: options.method || 'GET',
        path: options.path,
        headers: {
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let body = null;

          try {
            body = rawBody ? JSON.parse(rawBody) : null;
          } catch (error) {
            body = null;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            rawBody,
          });
        });
      }
    );

    req.on('error', reject);
    req.end(payload);
  });
}

function cookieHeaderFromSetCookie(setCookie) {
  return []
    .concat(setCookie || [])
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ');
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
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

async function withPublicAuthStubs(fn) {
  const previousEnv = snapshotEnv([
    'JWT_SECRET',
    'NODE_ENV',
    'PUBLIC_COOKIE_AUTH_ENABLED',
    'PUBLIC_BEARER_AUTH_LEGACY_ENABLED',
    'PUBLIC_COOKIE_NAME',
    'PUBLIC_APP_ORIGIN',
    'PUBLIC_AUTH_MIGRATION_DEADLINE',
  ]);
  const originalUserFindOne = User.findOne;
  const originalUserFindById = User.findById;
  const originalSessionCreate = Session.create;
  const originalSessionFindOne = Session.findOne;
  const originalSessionUpdateOne = Session.updateOne;
  const user = {
    _id: USER_ID,
    name: 'Cookie User',
    email: 'cookie@example.test',
    password: await bcrypt.hash('correct-password', 10),
    providers: ['local'],
    deletedAt: null,
    onboardingComplete: true,
    profile: {},
    preferences: {},
    twoFactor: { enabled: false },
  };
  const sessionsByJti = new Map();
  const updates = [];

  setCookieModeEnv();
  User.findOne = async (query) => query?.email === user.email ? user : null;
  User.findById = () => selectable(user);
  Session.create = async (payload) => {
    const session = {
      _id: `session-${sessionsByJti.size + 1}`,
      ...payload,
      revokedAt: null,
      save: async function saveSession() {
        return this;
      },
    };
    sessionsByJti.set(session.jti, session);
    return session;
  };
  Session.findOne = async (query) => {
    const session = sessionsByJti.get(query?.jti);

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
  Session.updateOne = async (query, update) => {
    updates.push({ query, update });
    const session = sessionsByJti.get(query?.jti);

    if (session && update?.$set?.revokedAt) {
      session.revokedAt = update.$set.revokedAt;
      session.revokedReason = update.$set.revokedReason;
    }

    return { matchedCount: session ? 1 : 0, modifiedCount: session ? 1 : 0 };
  };

  try {
    return await fn({ user, sessionsByJti, updates });
  } finally {
    User.findOne = originalUserFindOne;
    User.findById = originalUserFindById;
    Session.create = originalSessionCreate;
    Session.findOne = originalSessionFindOne;
    Session.updateOne = originalSessionUpdateOne;
    restoreEnv(previousEnv);
  }
}

test('public login sets a host-only HttpOnly secure cookie and omits token from JSON', async () => {
  await withPublicAuthStubs(async () => {
    const server = await listen();

    try {
      const login = await request(server, {
        method: 'POST',
        path: '/api/auth/login',
        headers: { Origin: PUBLIC_APP_ORIGIN },
        body: {
          email: 'cookie@example.test',
          password: 'correct-password',
        },
      });

      assert.equal(login.statusCode, 200);
      assert.equal(login.body.token, undefined);
      assert.equal(login.body.user.email, 'cookie@example.test');
      assert.equal(login.headers['access-control-allow-origin'], PUBLIC_APP_ORIGIN);
      assert.equal(login.headers['access-control-allow-credentials'], 'true');

      const sessionCookie = [].concat(login.headers['set-cookie'] || [])
        .find((cookie) => String(cookie).startsWith(`${SESSION_COOKIE_NAME}=`));

      assert.ok(sessionCookie);
      assert.match(sessionCookie, /HttpOnly/i);
      assert.match(sessionCookie, /Secure/i);
      assert.match(sessionCookie, /Path=\//i);
      assert.match(sessionCookie, /SameSite=Lax/i);
      assert.match(sessionCookie, /Max-Age=/i);
      assert.doesNotMatch(sessionCookie, /Domain=/i);
    } finally {
      await close(server);
    }
  });
});

test('/api/auth/me works with the public session cookie', async () => {
  await withPublicAuthStubs(async () => {
    const server = await listen();

    try {
      const login = await request(server, {
        method: 'POST',
        path: '/api/auth/login',
        headers: { Origin: PUBLIC_APP_ORIGIN },
        body: {
          email: 'cookie@example.test',
          password: 'correct-password',
        },
      });
      const cookie = cookieHeaderFromSetCookie(login.headers['set-cookie']);
      const me = await request(server, {
        path: '/api/auth/me',
        headers: { Cookie: cookie },
      });

      assert.equal(me.statusCode, 200);
      assert.equal(me.body.user.email, 'cookie@example.test');
    } finally {
      await close(server);
    }
  });
});

test('logout validates CSRF, revokes the session and clears public cookies', async () => {
  await withPublicAuthStubs(async ({ updates }) => {
    const server = await listen();

    try {
      const login = await request(server, {
        method: 'POST',
        path: '/api/auth/login',
        headers: { Origin: PUBLIC_APP_ORIGIN },
        body: {
          email: 'cookie@example.test',
          password: 'correct-password',
        },
      });
      const sessionCookie = cookieHeaderFromSetCookie(login.headers['set-cookie']);
      const csrf = await request(server, {
        path: '/api/auth/csrf',
        headers: { Cookie: sessionCookie },
      });
      const csrfCookie = cookieHeaderFromSetCookie(csrf.headers['set-cookie']);
      const logout = await request(server, {
        method: 'POST',
        path: '/api/auth/logout',
        headers: {
          Origin: PUBLIC_APP_ORIGIN,
          Cookie: `${sessionCookie}; ${csrfCookie}`,
          'X-CSRF-Token': csrf.body.csrfToken,
        },
      });

      assert.equal(logout.statusCode, 200);
      assert.equal(logout.body.ok, true);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].update.$set.revokedReason, 'logout');

      const clearedSessionCookie = [].concat(logout.headers['set-cookie'] || [])
        .find((cookie) => String(cookie).startsWith(`${SESSION_COOKIE_NAME}=`));

      assert.ok(clearedSessionCookie);
      assert.match(clearedSessionCookie, /Max-Age=0/i);
      assert.match(clearedSessionCookie, /HttpOnly/i);
      assert.doesNotMatch(clearedSessionCookie, /Domain=/i);
    } finally {
      await close(server);
    }
  });
});

test('bearer migration endpoint exchanges a valid legacy bearer for a cookie without returning a token', async () => {
  await withPublicAuthStubs(async ({ sessionsByJti, user }) => {
    const server = await listen();
    const jti = 'legacy-session-jti';
    const token = jwt.sign(
      { id: user._id, jti },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '10m' }
    );

    sessionsByJti.set(jti, {
      _id: 'legacy-session-id',
      userId: user._id,
      jti,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      save: async function saveSession() {
        return this;
      },
    });

    try {
      const migrated = await request(server, {
        method: 'POST',
        path: '/api/auth/session/migrate',
        headers: {
          Origin: PUBLIC_APP_ORIGIN,
          Authorization: `Bearer ${token}`,
        },
      });

      assert.equal(migrated.statusCode, 200);
      assert.equal(migrated.body.token, undefined);
      assert.equal(migrated.body.migrationDeadline, '2026-08-15');
      assert.ok([].concat(migrated.headers['set-cookie'] || [])
        .some((cookie) => String(cookie).startsWith(`${SESSION_COOKIE_NAME}=`)));
    } finally {
      await close(server);
    }
  });
});

test('legacy bearer works only while PUBLIC_BEARER_AUTH_LEGACY_ENABLED is true', async () => {
  await withPublicAuthStubs(async ({ sessionsByJti, user }) => {
    const jti = 'bearer-session-jti';
    const token = jwt.sign(
      { id: user._id, jti },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '10m' }
    );
    sessionsByJti.set(jti, {
      _id: 'bearer-session-id',
      userId: user._id,
      jti,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      save: async function saveSession() {
        return this;
      },
    });

    process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'true';
    const allowedRes = createResponse();
    let allowedNext = false;
    await authMiddleware(
      {
        method: 'GET',
        originalUrl: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      },
      allowedRes,
      () => { allowedNext = true; }
    );
    assert.equal(allowedNext, true);
    assert.equal(allowedRes.headers['x-public-bearer-auth-legacy'], 'true');

    process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'false';
    const deniedRes = createResponse();
    let deniedNext = false;
    await authMiddleware(
      {
        method: 'GET',
        originalUrl: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      },
      deniedRes,
      () => { deniedNext = true; }
    );
    assert.equal(deniedNext, false);
    assert.equal(deniedRes.statusCode, 401);
    assert.equal(deniedRes.body.code, 'PUBLIC_BEARER_AUTH_DISABLED');
  });
});

test('malicious public origins and missing CSRF token are blocked, while Stripe webhook is exempt', () => {
  const previousEnv = snapshotEnv([
    'JWT_SECRET',
    'PUBLIC_COOKIE_AUTH_ENABLED',
    'PUBLIC_APP_ORIGIN',
  ]);
  setCookieModeEnv();

  try {
    const maliciousReq = {
      method: 'POST',
      originalUrl: '/api/projects',
      url: '/api/projects',
      path: '/api/projects',
      headers: { origin: 'https://evil.example' },
      header(name) {
        return this.headers[String(name).toLowerCase()];
      },
    };
    const maliciousRes = createResponse();
    let maliciousNext = false;

    publicAuthHelpers.publicCsrfProtection(maliciousReq, maliciousRes, () => {
      maliciousNext = true;
    });
    assert.equal(maliciousNext, false);
    assert.equal(maliciousRes.statusCode, 403);
    assert.equal(maliciousRes.body.code, 'PUBLIC_ORIGIN_FORBIDDEN');

    const missingTokenReq = {
      ...maliciousReq,
      headers: { origin: PUBLIC_APP_ORIGIN },
    };
    const missingTokenRes = createResponse();
    let missingTokenNext = false;

    publicAuthHelpers.publicCsrfProtection(missingTokenReq, missingTokenRes, () => {
      missingTokenNext = true;
    });
    assert.equal(missingTokenNext, false);
    assert.equal(missingTokenRes.statusCode, 403);
    assert.equal(missingTokenRes.body.code, 'CSRF_TOKEN_INVALID');

    const webhookReq = {
      ...maliciousReq,
      originalUrl: '/api/billing/webhook',
      path: '/api/billing/webhook',
    };
    const webhookRes = createResponse();
    let webhookNext = false;

    publicAuthHelpers.publicCsrfProtection(webhookReq, webhookRes, () => {
      webhookNext = true;
    });
    assert.equal(webhookNext, true);
  } finally {
    restoreEnv(previousEnv);
  }
});

test('public CORS credentials are only allowed for the configured app origin', () => {
  const previousEnv = snapshotEnv(['PUBLIC_APP_ORIGIN']);
  process.env.PUBLIC_APP_ORIGIN = PUBLIC_APP_ORIGIN;

  try {
    previewIsolationHelpers.corsOptions({
      path: '/api/auth/me',
      header(name) {
        return name === 'Origin' ? PUBLIC_APP_ORIGIN : undefined;
      },
    }, (error, options) => {
      assert.ifError(error);
      assert.equal(options.origin, PUBLIC_APP_ORIGIN);
      assert.equal(options.credentials, true);
    });

    previewIsolationHelpers.corsOptions({
      path: '/api/auth/me',
      header(name) {
        return name === 'Origin' ? 'https://preview.askfluid.now' : undefined;
      },
    }, (error, options) => {
      assert.ifError(error);
      assert.equal(options.origin, false);
      assert.equal(options.credentials, false);
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test('OAuth callback source does not redirect with public token material', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'routes', 'authRoutes.js'), 'utf8');

  assert.equal(source.includes('auth-callback.html#token='), false);
  assert.equal(source.includes('#token='), false);
});

test('preview host refuses public session cookies on API routes', async () => {
  await withPublicAuthStubs(async () => {
    const server = await listen();

    try {
      const response = await request(server, {
        path: '/api/auth/me',
        headers: {
          Host: 'preview.askfluid.now',
          Cookie: `${SESSION_COOKIE_NAME}=opaque`,
          Origin: 'https://preview.askfluid.now',
        },
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    } finally {
      await close(server);
    }
  });
});
