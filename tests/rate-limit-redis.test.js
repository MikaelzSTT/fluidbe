const assert = require('assert/strict');
const test = require('node:test');

const {
  RATE_LIMIT_MESSAGE,
  buildRateLimitRedisKey,
  createRateLimit,
  getEmailRateLimitKey,
} = require('../middleware/rateLimit');

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

async function runLimiter(limiter, req = {}) {
  const res = createResponse();
  let nextCalled = false;
  await limiter(
    {
      method: 'GET',
      ip: '198.51.100.10',
      headers: {},
      ...req,
    },
    res,
    () => {
      nextCalled = true;
    }
  );

  return { res, nextCalled };
}

class FakeRedis {
  constructor(nowProvider) {
    this.entries = new Map();
    this.keys = [];
    this.nowProvider = nowProvider;
  }

  async eval(script, options) {
    const key = options.keys[0];
    const windowMs = Number(options.arguments[0]);
    const max = Number(options.arguments[1]);
    const now = this.nowProvider();
    const current = this.entries.get(key);

    this.keys.push(key);

    if (!current || current.expiresAt <= now) {
      this.entries.set(key, {
        count: 1,
        expiresAt: now + windowMs,
      });
      return [1, windowMs, 0];
    }

    const ttl = Math.max(1, current.expiresAt - now);

    if (current.count >= max) {
      return [current.count, ttl, 1];
    }

    current.count += 1;
    return [current.count, ttl, 0];
  }
}

test('Redis-backed limiters share counters across simulated instances', async () => {
  let now = 0;
  const redis = new FakeRedis(() => now);
  const provider = async () => redis;
  const options = {
    name: 'shared-login',
    windowMs: 60_000,
    max: 2,
    keyGenerator: (req) => req.ip,
    redisClientProvider: provider,
  };
  const instanceA = createRateLimit(options);
  const instanceB = createRateLimit(options);

  assert.equal((await runLimiter(instanceA)).nextCalled, true);
  assert.equal((await runLimiter(instanceB)).nextCalled, true);

  const third = await runLimiter(instanceA);
  assert.equal(third.nextCalled, false);
  assert.equal(third.res.statusCode, 429);

  now += 1;
});

test('Redis-backed limiter state survives a simulated backend restart', async () => {
  const redis = new FakeRedis(() => 0);
  const provider = async () => redis;
  const options = {
    name: 'restart-login',
    windowMs: 60_000,
    max: 1,
    keyGenerator: (req) => req.ip,
    redisClientProvider: provider,
  };

  assert.equal((await runLimiter(createRateLimit(options))).nextCalled, true);

  const afterRestart = await runLimiter(createRateLimit(options));
  assert.equal(afterRestart.nextCalled, false);
  assert.equal(afterRestart.res.statusCode, 429);
});

test('Redis-backed limiter TTL expires and allows a new window', async () => {
  let now = 10_000;
  const redis = new FakeRedis(() => now);
  const limiter = createRateLimit({
    name: 'ttl-login',
    windowMs: 1_000,
    max: 1,
    keyGenerator: (req) => req.ip,
    redisClientProvider: async () => redis,
  });

  assert.equal((await runLimiter(limiter)).nextCalled, true);
  assert.equal((await runLimiter(limiter)).res.statusCode, 429);

  now += 1_001;

  assert.equal((await runLimiter(limiter)).nextCalled, true);
});

test('rate limit 429 response preserves message and Retry-After header', async () => {
  const redis = new FakeRedis(() => 0);
  const limiter = createRateLimit({
    name: 'response-shape',
    windowMs: 5_000,
    max: 1,
    keyGenerator: (req) => req.ip,
    redisClientProvider: async () => redis,
  });

  assert.equal((await runLimiter(limiter)).nextCalled, true);
  const blocked = await runLimiter(limiter);

  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.deepEqual(blocked.res.body, { message: RATE_LIMIT_MESSAGE });
  assert.equal(blocked.res.headers['Retry-After'], '5');
});

test('Redis unavailable falls back locally without throwing', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args);
  };

  try {
    const limiter = createRateLimit({
      name: 'redis-unavailable',
      windowMs: 60_000,
      max: 1,
      keyGenerator: (req) => req.ip,
      redisClientProvider: async () => {
        throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
      },
    });

    assert.equal((await runLimiter(limiter)).nextCalled, true);
    const blocked = await runLimiter(limiter);

    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.equal(warnings.length, 1);
    assert.equal(String(warnings[0][0]).includes('REDIS_URL'), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('rate limit storage keys do not contain raw email, JWT, token, or IP material', async () => {
  const redis = new FakeRedis(() => 0);
  const rawEmail = 'Person@Example.com';
  const rawJwt = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  const rawToken = 'admin-secret-token';
  const rawIp = '203.0.113.55';
  const limiter = createRateLimit({
    name: 'sensitive-key',
    windowMs: 60_000,
    max: 3,
    keyGenerator: () => `${rawIp}:${rawEmail}:${rawJwt}:${rawToken}`,
    redisClientProvider: async () => redis,
  });

  assert.equal((await runLimiter(limiter)).nextCalled, true);

  const redisKey = redis.keys[0];
  assert.match(redisKey, /^fluidbe:rate-limit:sensitive-key:[a-f0-9]{64}$/);
  assert.equal(redisKey.includes(rawEmail), false);
  assert.equal(redisKey.includes(rawEmail.toLowerCase()), false);
  assert.equal(redisKey.includes(rawJwt), false);
  assert.equal(redisKey.includes(rawToken), false);
  assert.equal(redisKey.includes(rawIp), false);

  const emailKey = getEmailRateLimitKey(rawEmail);
  assert.match(emailKey, /^email:[a-f0-9]{64}$/);
  assert.equal(emailKey.includes(rawEmail), false);
  assert.equal(emailKey.includes(rawEmail.toLowerCase()), false);

  const builtKey = buildRateLimitRedisKey('email-login', rawEmail.toLowerCase());
  assert.equal(builtKey.includes(rawEmail.toLowerCase()), false);
});
