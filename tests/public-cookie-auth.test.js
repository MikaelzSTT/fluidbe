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
const PUBLIC_OAUTH_API_ORIGIN = 'https://apps.askfluid.now';
const GOOGLE_REDIRECT_URI = `${PUBLIC_OAUTH_API_ORIGIN}/api/auth/google/callback`;
const GITHUB_REDIRECT_URI = `${PUBLIC_OAUTH_API_ORIGIN}/api/auth/github/callback`;
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

function setPublicOAuthEnv() {
  setCookieModeEnv();
  process.env.GOOGLE_CLIENT_ID = 'google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
  process.env.GOOGLE_REDIRECT_URI = GOOGLE_REDIRECT_URI;
  process.env.GITHUB_CLIENT_ID = 'github-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'github-client-secret';
  process.env.GITHUB_REDIRECT_URI = GITHUB_REDIRECT_URI;
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

async function withPublicOAuthStubs(fn) {
  const previousEnv = snapshotEnv([
    'JWT_SECRET',
    'NODE_ENV',
    'PUBLIC_COOKIE_AUTH_ENABLED',
    'PUBLIC_BEARER_AUTH_LEGACY_ENABLED',
    'PUBLIC_COOKIE_NAME',
    'PUBLIC_APP_ORIGIN',
    'PUBLIC_AUTH_MIGRATION_DEADLINE',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'GOOGLE_CALLBACK_URL',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_REDIRECT_URI',
    'GITHUB_OAUTH_CALLBACK_URL',
    'FRONTEND_URL',
  ]);
  const originalFetch = global.fetch;
  const originalUserFindOne = User.findOne;
  const originalUserFindById = User.findById;
  const originalUserCreate = User.create;
  const originalUserExists = User.exists;
  const originalSessionCreate = Session.create;
  const fetchCalls = [];
  const createdUsers = [];

  setPublicOAuthEnv();
  delete process.env.GOOGLE_CALLBACK_URL;
  delete process.env.GITHUB_OAUTH_CALLBACK_URL;
  User.findOne = async () => null;
  User.findById = () => selectable(createdUsers[0] || null);
  User.exists = async () => false;
  User.create = async (payload) => {
    const user = {
      _id: `oauth-user-${createdUsers.length + 1}`,
      deletedAt: null,
      profile: {},
      preferences: {},
      twoFactor: { enabled: false },
      save: async function saveUser() {
        return this;
      },
      ...payload,
    };
    createdUsers.push(user);
    return user;
  };
  Session.create = async (payload) => ({
    _id: `oauth-session-${createdUsers.length || 1}`,
    ...payload,
    revokedAt: null,
    expiresAt: payload.expiresAt || new Date(Date.now() + 60 * 60 * 1000),
    save: async function saveSession() {
      return this;
    },
  });
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });

    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'google-access-token' }),
      };
    }

    if (String(url) === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return {
        ok: true,
        json: async () => ({
          sub: 'google-user-id',
          email: 'google-oauth@example.test',
          email_verified: true,
          name: 'Google OAuth User',
          picture: 'https://cdn.example.test/google.png',
        }),
      };
    }

    if (String(url) === 'https://github.com/login/oauth/access_token') {
      return {
        ok: true,
        json: async () => ({ access_token: 'github-access-token' }),
      };
    }

    if (String(url) === 'https://api.github.com/user') {
      return {
        ok: true,
        json: async () => ({
          id: 12345,
          login: 'github-oauth-user',
          name: 'GitHub OAuth User',
          avatar_url: 'https://cdn.example.test/github.png',
        }),
      };
    }

    if (String(url) === 'https://api.github.com/user/emails') {
      return {
        ok: true,
        json: async () => ([{
          email: 'github-oauth@example.test',
          primary: true,
          verified: true,
        }]),
      };
    }

    return {
      ok: false,
      json: async () => ({}),
    };
  };

  try {
    return await fn({ fetchCalls, createdUsers });
  } finally {
    global.fetch = originalFetch;
    User.findOne = originalUserFindOne;
    User.findById = originalUserFindById;
    User.create = originalUserCreate;
    User.exists = originalUserExists;
    Session.create = originalSessionCreate;
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

function formBodyValue(fetchCall, name) {
  return new URLSearchParams(String(fetchCall?.options?.body || '')).get(name);
}

async function startOAuthFlow(server, provider, headers = {}) {
  const response = await request(server, {
    path: `/api/auth/${provider}?redirect=/projects.html`,
    headers: {
      Host: 'apps.askfluid.now',
      ...headers,
    },
  });

  assert.equal(response.statusCode, 302);
  return response;
}

async function callbackOAuthFlow(server, provider, startResponse, headers = {}) {
  const authUrl = new URL(startResponse.headers.location);
  const state = authUrl.searchParams.get('state');
  const cookie = cookieHeaderFromSetCookie(startResponse.headers['set-cookie']);

  assert.ok(state);
  assert.ok(cookie.includes(`fluid_oauth_state_${provider}=`));

  const response = await request(server, {
    path: `/api/auth/${provider}/callback?code=${provider}-code&state=${encodeURIComponent(state)}`,
    headers: {
      Host: 'apps.askfluid.now',
      Cookie: cookie,
      ...headers,
    },
  });

  assert.equal(response.statusCode, 302);
  return response;
}

test('Google OAuth start uses the canonical apps.askfluid.now callback URL in production', async () => {
  await withPublicOAuthStubs(async () => {
    const server = await listen();

    try {
      const response = await startOAuthFlow(server, 'google');
      const authUrl = new URL(response.headers.location);

      assert.equal(authUrl.origin, 'https://accounts.google.com');
      assert.equal(authUrl.searchParams.get('redirect_uri'), GOOGLE_REDIRECT_URI);
      assert.equal(response.headers.location.includes('onrender.com'), false);
    } finally {
      await close(server);
    }
  });
});

test('GitHub OAuth start uses the canonical apps.askfluid.now callback URL in production', async () => {
  await withPublicOAuthStubs(async () => {
    const server = await listen();

    try {
      const response = await startOAuthFlow(server, 'github');
      const authUrl = new URL(response.headers.location);

      assert.equal(authUrl.origin, 'https://github.com');
      assert.equal(authUrl.searchParams.get('redirect_uri'), GITHUB_REDIRECT_URI);
      assert.equal(response.headers.location.includes('onrender.com'), false);
    } finally {
      await close(server);
    }
  });
});

test('malicious Host and X-Forwarded-Host do not change the public OAuth redirect', async () => {
  await withPublicOAuthStubs(async () => {
    const server = await listen();

    try {
      const response = await request(server, {
        path: '/api/auth/google?redirect=/projects.html',
        headers: {
          Host: 'apps.askfluid.now',
          'X-Forwarded-Host': 'evil.example',
        },
      });

      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, 'https://apps.askfluid.now/api/auth/google?redirect=/projects.html');
      assert.equal(response.headers.location.includes('evil.example'), false);
      assert.equal(response.headers.location.includes('onrender.com'), false);
    } finally {
      await close(server);
    }
  });
});

test('production public OAuth does not fall back to onrender.com legacy callback envs', async () => {
  await withPublicOAuthStubs(async () => {
    const server = await listen();

    delete process.env.GOOGLE_REDIRECT_URI;
    delete process.env.GITHUB_REDIRECT_URI;
    process.env.GOOGLE_CALLBACK_URL = 'https://fluidbe.onrender.com/api/auth/google/callback';
    process.env.GITHUB_OAUTH_CALLBACK_URL = 'https://fluidbe.onrender.com/api/auth/github/callback';

    try {
      const google = await request(server, {
        path: '/api/auth/google',
        headers: { Host: 'apps.askfluid.now' },
      });
      const github = await request(server, {
        path: '/api/auth/github',
        headers: { Host: 'apps.askfluid.now' },
      });

      assert.equal(google.statusCode, 302);
      assert.equal(github.statusCode, 302);
      assert.equal(google.headers.location, 'https://askfluid.now/login.html?oauth_error=google');
      assert.equal(github.headers.location, 'https://askfluid.now/login.html?error=GITHUB_OAUTH_NOT_CONFIGURED');
      assert.equal(google.headers.location.includes('onrender.com'), false);
      assert.equal(github.headers.location.includes('onrender.com'), false);
    } finally {
      await close(server);
    }
  });
});

test('Google OAuth callback exchanges code with apps.askfluid.now and emits public session cookie', async () => {
  await withPublicOAuthStubs(async ({ fetchCalls }) => {
    const server = await listen();

    try {
      const start = await startOAuthFlow(server, 'google');
      const callback = await callbackOAuthFlow(server, 'google', start);
      const tokenExchange = fetchCalls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
      const sessionCookie = [].concat(callback.headers['set-cookie'] || [])
        .find((cookie) => String(cookie).startsWith(`${SESSION_COOKIE_NAME}=`));

      assert.equal(formBodyValue(tokenExchange, 'redirect_uri'), GOOGLE_REDIRECT_URI);
      assert.equal(callback.headers.location, 'https://askfluid.now/auth-callback.html?redirect=%2Fprojects.html');
      assert.equal(callback.headers.location.includes('token='), false);
      assert.ok(sessionCookie);
      assert.match(sessionCookie, /HttpOnly/i);
      assert.match(sessionCookie, /Secure/i);
      assert.match(sessionCookie, /Path=\//i);
      assert.match(sessionCookie, /SameSite=Lax/i);
      assert.doesNotMatch(sessionCookie, /Domain=/i);
    } finally {
      await close(server);
    }
  });
});

test('GitHub OAuth callback exchanges code with apps.askfluid.now and omits token from redirect', async () => {
  await withPublicOAuthStubs(async ({ fetchCalls }) => {
    const server = await listen();

    try {
      const start = await startOAuthFlow(server, 'github');
      const callback = await callbackOAuthFlow(server, 'github', start);
      const tokenExchange = fetchCalls.find((call) => call.url === 'https://github.com/login/oauth/access_token');

      assert.equal(formBodyValue(tokenExchange, 'redirect_uri'), GITHUB_REDIRECT_URI);
      assert.equal(callback.headers.location, 'https://askfluid.now/auth-callback.html?redirect=%2Fprojects.html');
      assert.equal(callback.headers.location.includes('token='), false);
      assert.equal(callback.headers.location.includes('onrender.com'), false);
    } finally {
      await close(server);
    }
  });
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
