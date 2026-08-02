const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const test = require('node:test');

const authRoutes = require('../routes/authRoutes');
const Session = require('../models/Session');
const User = require('../models/User');
const {
  buildAccountCreatedAlert,
  dispatchAccountCreatedAlert,
  dispatchOnboardingCompletedAlert,
  drainOperatorAlertJobs,
  maskEmail,
  safePromptPreview,
  setOperatorAlertSender,
} = require('../utils/operatorAlerts');

const JWT_SECRET = 'operator-alerts-test-secret';
const USER_ID = '64f000000000000000000501';
const GOOGLE_REDIRECT_URI = 'https://apps.askfluid.now/api/auth/google/callback';
const GITHUB_REDIRECT_URI = 'https://apps.askfluid.now/api/auth/github/callback';

function getAuthRouteHandler(pathname, method) {
  const layer = authRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    cookies: [],
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookies.push({ name, options });
      return this;
    },
    redirect(location) {
      this.statusCode = 302;
      this.headers.location = location;
      return this;
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

function withModelStubs(stubs, fn) {
  const originals = {};

  Object.entries(stubs).forEach(([modelName, methods]) => {
    const model = modelName === 'User' ? User : Session;
    originals[modelName] = {};
    Object.entries(methods).forEach(([methodName, implementation]) => {
      originals[modelName][methodName] = model[methodName];
      model[methodName] = implementation;
    });
  });

  return Promise.resolve()
    .then(fn)
    .finally(async () => {
      await drainOperatorAlertJobs();
      Object.entries(originals).forEach(([modelName, methods]) => {
        const model = modelName === 'User' ? User : Session;
        Object.entries(methods).forEach(([methodName, original]) => {
          model[methodName] = original;
        });
      });
      setOperatorAlertSender(null);
    });
}

async function runHandler(pathname, method, req) {
  const handler = getAuthRouteHandler(pathname, method);
  const res = createResponse();
  await handler(req, res, () => {});
  return res;
}

function makeUser(overrides = {}) {
  return {
    _id: USER_ID,
    name: 'Fluid User',
    email: 'member@example.test',
    password: '',
    providers: ['local'],
    onboardingComplete: false,
    deletedAt: null,
    profile: {},
    preferences: {},
    twoFactor: { enabled: false },
    save: async function saveUser() {
      return this;
    },
    ...overrides,
  };
}

function makeSessionCreate() {
  return async (payload) => ({
    _id: 'session-1',
    revokedAt: null,
    expiresAt: payload.expiresAt || new Date(Date.now() + 60 * 60 * 1000),
    save: async function saveSession() {
      return this;
    },
    ...payload,
  });
}

function makeSingleMarkerUpdate() {
  let marked = false;

  return async () => {
    if (marked) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    marked = true;
    return { matchedCount: 1, modifiedCount: 1 };
  };
}

function setupAlertCapture() {
  const alerts = [];
  setOperatorAlertSender(async (text) => {
    alerts.push(text);
    return true;
  });
  return alerts;
}

async function withEnv(values, fn) {
  const previousEnv = snapshotEnv(Object.keys(values));

  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });

  try {
    return await fn();
  } finally {
    restoreEnv(previousEnv);
  }
}

function oauthState(provider) {
  const now = Math.floor(Date.now() / 1000);
  const payload = provider === 'github'
    ? {
        purpose: 'github_oauth_state',
        nonce: 'test-nonce',
        redirect: '/projects.html',
        createdAt: now,
        expiresAt: now + 600,
      }
    : {
        purpose: 'google_oauth_state',
        nonce: 'test-nonce',
        redirect: '/projects.html',
      };

  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: 600 });
}

async function runOAuthCallback(provider, options = {}) {
  const state = oauthState(provider);
  const path = provider === 'google' ? '/google/callback' : '/github/callback';

  return runHandler(path, 'get', {
    query: { code: `${provider}-code`, state },
    headers: {
      host: 'apps.askfluid.now',
      cookie: `fluid_oauth_state_${provider}=${encodeURIComponent(state)}`,
    },
    body: {},
    originalUrl: `/api/auth/${provider}/callback?code=${provider}-code&state=${encodeURIComponent(state)}`,
    ...options,
  });
}

function setupOAuthFetch() {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'google-access-token' }) };
    }

    if (String(url) === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return {
        ok: true,
        json: async () => ({
          sub: 'google-id-1',
          email: 'google.user@example.test',
          email_verified: true,
          name: 'Google User',
          picture: 'https://cdn.example.test/google.png',
        }),
      };
    }

    if (String(url) === 'https://github.com/login/oauth/access_token') {
      return { ok: true, json: async () => ({ access_token: 'github-access-token' }) };
    }

    if (String(url) === 'https://api.github.com/user') {
      return {
        ok: true,
        json: async () => ({
          id: 123,
          login: 'github-user',
          name: 'GitHub User',
          avatar_url: 'https://cdn.example.test/github.png',
        }),
      };
    }

    if (String(url) === 'https://api.github.com/user/emails') {
      return {
        ok: true,
        json: async () => ([{
          email: 'github.user@example.test',
          primary: true,
          verified: true,
        }]),
      };
    }

    return { ok: false, json: async () => ({}) };
  };

  return () => {
    global.fetch = originalFetch;
  };
}

test('email registration creates user and sends one account-created alert', async () => {
  const alerts = setupAlertCapture();
  let createdUser = null;

  await withModelStubs({
    User: {
      findOne: async () => null,
      exists: async () => null,
      create: async (payload) => {
        createdUser = makeUser({ ...payload, _id: USER_ID, password: payload.password });
        return createdUser;
      },
      updateOne: makeSingleMarkerUpdate(),
    },
  }, async () => {
    const res = await runHandler('/register', 'post', {
      body: {
        name: 'New Member',
        email: 'Member@Example.test',
        password: 'correct-horse-battery-staple',
      },
    });

    assert.equal(res.statusCode, 201);
    await drainOperatorAlertJobs();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /New Fluid user/);
    assert.match(alerts[0], /Email: me\*\*\*@example\.test/);
    assert.match(alerts[0], /Provider: email/);
    assert.notEqual(createdUser.password, 'correct-horse-battery-staple');
  });
});

test('repeated login sends no creation alert', async () => {
  const alerts = setupAlertCapture();
  const user = makeUser({
    email: 'member@example.test',
    password: await bcrypt.hash('correct-password', 10),
  });

  await withEnv({ JWT_SECRET }, async () => {
    await withModelStubs({
      User: {
        findOne: async () => user,
      },
      Session: {
        create: makeSessionCreate(),
      },
    }, async () => {
      const res = await runHandler('/login', 'post', {
        body: { email: user.email, password: 'correct-password' },
        headers: {},
        ip: '203.0.113.10',
      });

      assert.equal(res.statusCode, 200);
      await drainOperatorAlertJobs();
      assert.equal(alerts.length, 0);
    });
  });
});

test('Google first signup sends one alert and returning login sends none', async () => {
  await withEnv({
    JWT_SECRET,
    NODE_ENV: 'production',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_REDIRECT_URI,
  }, async () => {
    const restoreFetch = setupOAuthFetch();
    const alerts = setupAlertCapture();
    const created = [];
    const existingUser = makeUser({
      email: 'google.user@example.test',
      googleId: 'google-id-1',
      providers: ['google'],
      save: async function saveUser() {
        return this;
      },
    });

    try {
      await withModelStubs({
        User: {
          findOne: async () => null,
          exists: async () => false,
          create: async (payload) => {
            const user = makeUser({ _id: 'google-new-user', ...payload });
            created.push(user);
            return user;
          },
          updateOne: makeSingleMarkerUpdate(),
        },
        Session: {
          create: makeSessionCreate(),
        },
      }, async () => {
        const res = await runOAuthCallback('google');
        assert.equal(res.statusCode, 302);
        await drainOperatorAlertJobs();
        assert.equal(created.length, 1);
        assert.equal(alerts.length, 1);
        assert.match(alerts[0], /Provider: google/);
      });

      setOperatorAlertSender(async (text) => {
        alerts.push(text);
        return true;
      });

      await withModelStubs({
        User: {
          findOne: async (query) => query?.googleId ? existingUser : null,
          exists: async () => false,
        },
        Session: {
          create: makeSessionCreate(),
        },
      }, async () => {
        const res = await runOAuthCallback('google');
        assert.equal(res.statusCode, 302);
        await drainOperatorAlertJobs();
        assert.equal(alerts.length, 1);
      });
    } finally {
      restoreFetch();
    }
  });
});

test('GitHub first signup sends one alert and returning login sends none', async () => {
  await withEnv({
    JWT_SECRET,
    NODE_ENV: 'production',
    GITHUB_CLIENT_ID: 'github-client-id',
    GITHUB_CLIENT_SECRET: 'github-client-secret',
    GITHUB_REDIRECT_URI,
  }, async () => {
    const restoreFetch = setupOAuthFetch();
    const alerts = setupAlertCapture();
    const created = [];
    const existingUser = makeUser({
      email: 'github.user@example.test',
      githubId: '123',
      providers: ['github'],
      save: async function saveUser() {
        return this;
      },
    });

    try {
      await withModelStubs({
        User: {
          findOne: async () => null,
          exists: async () => false,
          create: async (payload) => {
            const user = makeUser({ _id: 'github-new-user', ...payload });
            created.push(user);
            return user;
          },
          updateOne: makeSingleMarkerUpdate(),
        },
        Session: {
          create: makeSessionCreate(),
        },
      }, async () => {
        const res = await runOAuthCallback('github');
        assert.equal(res.statusCode, 302);
        await drainOperatorAlertJobs();
        assert.equal(created.length, 1);
        assert.equal(alerts.length, 1);
        assert.match(alerts[0], /Provider: github/);
      });

      setOperatorAlertSender(async (text) => {
        alerts.push(text);
        return true;
      });

      await withModelStubs({
        User: {
          findOne: async (query) => query?.githubId ? existingUser : null,
          exists: async () => false,
        },
        Session: {
          create: makeSessionCreate(),
        },
      }, async () => {
        const res = await runOAuthCallback('github');
        assert.equal(res.statusCode, 302);
        await drainOperatorAlertJobs();
        assert.equal(alerts.length, 1);
      });
    } finally {
      restoreFetch();
    }
  });
});

test('first onboarding completion sends one onboarding alert and repeats send none', async () => {
  const alerts = setupAlertCapture();
  const user = makeUser({ email: 'founder@example.test', onboardingComplete: false });

  await withModelStubs({
    User: {
      findById: async () => user,
      updateOne: makeSingleMarkerUpdate(),
    },
  }, async () => {
    const res = await runHandler('/onboarding', 'patch', {
      userId: USER_ID,
      body: {
        theme: 'clean',
        displayName: 'Founder',
        role: 'Founder',
        goal: 'Build a business',
      },
    });

    assert.equal(res.statusCode, 200);
    await drainOperatorAlertJobs();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Fluid onboarding completed/);
    assert.match(alerts[0], /Email: fo\*\*\*@example\.test/);

    const repeat = await runHandler('/onboarding', 'patch', {
      userId: USER_ID,
      body: {
        theme: 'clean',
        displayName: 'Founder',
        role: 'Founder',
        goal: 'Build a business',
      },
    });

    assert.equal(repeat.statusCode, 200);
    await drainOperatorAlertJobs();
    assert.equal(alerts.length, 1);
  });
});

test('Telegram failure does not fail registration', async () => {
  const originalError = console.error;
  console.error = () => {};
  setOperatorAlertSender(async () => {
    throw new Error('telegram token secret failed');
  });

  try {
    await withModelStubs({
      User: {
        findOne: async () => null,
        exists: async () => null,
        create: async (payload) => makeUser({ ...payload, _id: USER_ID }),
        updateOne: makeSingleMarkerUpdate(),
      },
    }, async () => {
      const res = await runHandler('/register', 'post', {
        body: {
          name: 'Failure Case',
          email: 'failure@example.test',
          password: 'correct-horse-battery-staple',
        },
      });

      assert.equal(res.statusCode, 201);
      await drainOperatorAlertJobs();
    });
  } finally {
    console.error = originalError;
  }
});

test('Telegram failure does not fail onboarding', async () => {
  const originalError = console.error;
  const user = makeUser({ onboardingComplete: false });
  console.error = () => {};
  setOperatorAlertSender(async () => {
    throw new Error('telegram credential failed');
  });

  try {
    await withModelStubs({
      User: {
        findById: async () => user,
        updateOne: makeSingleMarkerUpdate(),
      },
    }, async () => {
      const res = await runHandler('/onboarding', 'patch', {
        userId: USER_ID,
        body: {
          theme: 'clean',
          displayName: 'Founder',
          role: 'Founder',
          goal: 'Build a business',
        },
      });

      assert.equal(res.statusCode, 200);
      await drainOperatorAlertJobs();
    });
  } finally {
    console.error = originalError;
  }
});

test('alerts contain masked email and do not contain password, token, cookie or credential fields', () => {
  const alert = buildAccountCreatedAlert(
    makeUser({
      email: 'sensitive.user@example.test',
      password: 'plain-password',
      passwordHash: 'hash-value',
      token: 'jwt-token',
      cookie: 'session-cookie',
      credential: 'admin-credential',
    }),
    { provider: 'email' }
  );

  assert.match(alert, /Email: se\*\*\*@example\.test/);
  assert.equal(alert.includes('sensitive.user@example.test'), false);
  assert.equal(alert.includes('plain-password'), false);
  assert.equal(alert.includes('jwt-token'), false);
  assert.equal(alert.includes('session-cookie'), false);
  assert.equal(alert.includes('admin-credential'), false);
});

test('prompt preview is length-limited and redacted', () => {
  const raw = `Create a landing page with token=${'a'.repeat(40)} and cookie=session-secret ${'x'.repeat(220)}`;
  const preview = safePromptPreview(raw, 120);

  assert.ok(preview.length <= 120);
  assert.equal(preview.includes('a'.repeat(40)), false);
  assert.equal(preview.includes('session-secret'), false);
  assert.match(preview, /\[REDACTED\]/);
});

test('missing Telegram configuration skips safely', async () => {
  await withEnv({
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_CHAT_ID: undefined,
    NODE_ENV: 'production',
  }, async () => {
    setOperatorAlertSender(null);

    await withModelStubs({
      User: {
        updateOne: async () => {
          throw new Error('User.updateOne should not be called without Telegram config.');
        },
      },
    }, async () => {
      dispatchAccountCreatedAlert(makeUser(), { provider: 'email' });
      await drainOperatorAlertJobs();
    });
  });
});

test('concurrent repeated requests do not create duplicate alerts', async () => {
  const alerts = setupAlertCapture();
  const updateOne = makeSingleMarkerUpdate();
  const user = makeUser({
    onboardingComplete: true,
    preferences: {
      role: 'Founder',
      goal: 'Build a business',
      completedAt: new Date('2026-08-02T02:34:00Z'),
    },
  });

  await withModelStubs({
    User: { updateOne },
  }, async () => {
    dispatchOnboardingCompletedAlert(user);
    dispatchOnboardingCompletedAlert(user);
    await drainOperatorAlertJobs();
    assert.equal(alerts.length, 1);
  });
});

test('maskEmail keeps only a small local-part prefix', () => {
  assert.equal(maskEmail('mi.person@gmail.com'), 'mi***@gmail.com');
});
