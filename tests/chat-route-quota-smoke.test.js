const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Module = require('module');
const test = require('node:test');

const Session = require('../models/Session');
const User = require('../models/User');
const rateLimit = require('../middleware/rateLimit');

const ORIGINAL_MODULE_LOAD = Module._load;

class SmokeRedis {
  constructor() {
    this.counters = new Map();
    this.requests = new Map();
    this.reserveCalls = 0;
    this.commitCalls = 0;
    this.refundCalls = 0;
  }

  getCounter(key) {
    return this.counters.get(key) || 0;
  }

  setCounter(key, value) {
    this.counters.set(key, value);
  }

  async eval(script, options) {
    const command = options.arguments[0];
    const keys = options.keys;

    if (command === 'commit') {
      this.commitCalls += 1;
      const request = this.requests.get(keys[0]);
      if (request?.state === 'reserved') {
        request.state = 'committed';
        return [1, 'committed'];
      }
      return [0, request?.state || 'missing'];
    }

    if (command === 'refund') {
      this.refundCalls += 1;
      const request = this.requests.get(keys[0]);
      if (!request || request.state !== 'reserved') {
        return [0, request?.state || 'missing'];
      }

      keys.slice(1).forEach((key) => {
        const current = this.getCounter(key);
        if (current > 0) this.setCounter(key, current - 1);
      });
      request.state = 'refunded';
      return [1, 'refunded'];
    }

    this.reserveCalls += 1;

    const dailyLimit = Number(options.arguments[3]);
    const monthlyLimit = Number(options.arguments[4]);
    const globalDailyLimit = Number(options.arguments[5]);
    const globalMonthlyLimit = Number(options.arguments[6]);
    const ipDailyLimit = Number(options.arguments[7]);

    const existing = this.requests.get(keys[0]);
    if (existing && existing.state !== 'refunded') {
      return [
        2,
        existing.state,
        this.getCounter(keys[1]),
        this.getCounter(keys[2]),
        this.getCounter(keys[3]),
        this.getCounter(keys[4]),
        this.getCounter(keys[5]),
      ];
    }

    const daily = this.getCounter(keys[1]);
    if (daily >= dailyLimit) return [0, 'daily', daily, dailyLimit, 0];

    const monthly = this.getCounter(keys[2]);
    if (monthly >= monthlyLimit) return [0, 'monthly', monthly, monthlyLimit, 0];

    const globalDaily = this.getCounter(keys[3]);
    if (globalDaily >= globalDailyLimit) return [0, 'daily', globalDaily, globalDailyLimit, 1];

    const globalMonthly = this.getCounter(keys[4]);
    if (globalMonthly >= globalMonthlyLimit) return [0, 'monthly', globalMonthly, globalMonthlyLimit, 1];

    const ipDaily = this.getCounter(keys[5]);
    if (ipDailyLimit > 0 && ipDaily >= ipDailyLimit) {
      return [0, 'daily', ipDaily, ipDailyLimit, 0];
    }

    this.setCounter(keys[1], daily + 1);
    this.setCounter(keys[2], monthly + 1);
    this.setCounter(keys[3], globalDaily + 1);
    this.setCounter(keys[4], globalMonthly + 1);
    if (ipDailyLimit > 0) this.setCounter(keys[5], ipDaily + 1);
    this.requests.set(keys[0], { state: 'reserved' });

    return [
      1,
      'reserved',
      daily + 1,
      monthly + 1,
      globalDaily + 1,
      globalMonthly + 1,
      ipDailyLimit > 0 ? ipDaily + 1 : ipDaily,
    ];
  }
}

function clearRouteModules() {
  [
    '../routes/chatRoutes',
    '../utils/aiQuota',
  ].forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function createAnthropicMock(providerState) {
  return function AnthropicMock() {
    this.messages = {
      create: async () => {
        providerState.calls += 1;

        if (providerState.error) {
          throw providerState.error;
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                action: 'chat',
                reply: 'Resposta mockada do provider.',
              }),
            },
          ],
        };
      },
    };
  };
}

function createRequest(app, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        method: 'POST',
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/api/chat',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          server.close(() => {
            resolve({
              status: res.statusCode,
              body: raw ? JSON.parse(raw) : null,
            });
          });
        });
      });

      req.on('error', (error) => {
        server.close(() => reject(error));
      });
      req.end(payload);
    });
  });
}

async function withChatRouteSmoke({ redis, providerState, userPlan = 'free' }, fn) {
  const previousEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_BEARER_AUTH_LEGACY_ENABLED: process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED,
  };
  const previousLoad = Module._load;
  const previousFindOne = Session.findOne;
  const previousFindById = User.findById;
  const previousRedisProvider = rateLimit.getConnectedRedisClient;
  const previousConsoleInfo = console.info;
  const previousConsoleWarn = console.warn;
  const previousConsoleError = console.error;
  const errorLogs = [];

  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'true';
  delete process.env.NODE_ENV;

  Session.findOne = async () => ({ _id: 'session-id', lastSeenAt: new Date(), save: async () => {} });
  User.findById = () => ({
    select: async (fields) => (String(fields).includes('plan') ? { plan: userPlan } : { deletedAt: null }),
  });
  rateLimit.getConnectedRedisClient = async () => redis;
  console.info = () => {};
  console.warn = () => {};
  console.error = (...args) => {
    errorLogs.push(args);
  };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@anthropic-ai/sdk') {
      return createAnthropicMock(providerState);
    }
    return previousLoad.call(this, request, parent, isMain);
  };

  clearRouteModules();

  try {
    const chatRoutes = require('../routes/chatRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    const token = jwt.sign({ id: '64b7f0f0f0f0f0f0f0f0f0f0', jti: 'session-jti' }, process.env.JWT_SECRET, { algorithm: 'HS256' });

    await fn({ app, token, errorLogs });
  } finally {
    process.env.ANTHROPIC_API_KEY = previousEnv.ANTHROPIC_API_KEY;
    process.env.JWT_SECRET = previousEnv.JWT_SECRET;
    if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.NODE_ENV;
    if (previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED === undefined) delete process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
    else process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
    Session.findOne = previousFindOne;
    User.findById = previousFindById;
    rateLimit.getConnectedRedisClient = previousRedisProvider;
    console.info = previousConsoleInfo;
    console.warn = previousConsoleWarn;
    console.error = previousConsoleError;
    Module._load = previousLoad || ORIGINAL_MODULE_LOAD;
    clearRouteModules();
  }
}

test('POST /api/chat: usuário free passa, reserva quota, chama provider uma vez e commita', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0 };

  await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'happy-path',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reply, 'Resposta mockada do provider.');
    assert.equal(providerState.calls, 1);
    assert.equal(redis.reserveCalls, 1);
    assert.equal(redis.commitCalls, 1);
    assert.equal(redis.refundCalls, 0);
  });
});

test('POST /api/chat: erro do provider faz refund da reserva', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0, error: new Error('provider failed') };

  await withChatRouteSmoke({ redis, providerState }, async ({ app, token, errorLogs }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'provider-error',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: 'Erro interno do servidor.' });
    assert.equal(providerState.calls, 1);
    assert.equal(redis.reserveCalls, 1);
    assert.equal(redis.commitCalls, 0);
    assert.equal(redis.refundCalls, 1);
    assert.equal(errorLogs.length, 1);
    assert.equal(errorLogs[0][0], '[chat] error');
    assert.deepEqual(errorLogs[0][1], {
      name: 'Error',
      stage: 'provider_call',
      requestId: 'provider-error',
    });
    assert.equal(JSON.stringify(errorLogs).includes('provider failed'), false);
  });
});

test('POST /api/chat: Redis indisponível segue fallback e não retorna 500 no caminho feliz', async () => {
  const providerState = { calls: 0 };

  await withChatRouteSmoke({ redis: null, providerState }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'redis-fallback',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(providerState.calls, 1);
  });
});
