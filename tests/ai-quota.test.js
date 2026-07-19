const assert = require('assert/strict');
const test = require('node:test');

const {
  AI_QUOTA_EXCEEDED_CODE,
  APP_AI_QUOTA_PREFIX,
  createAiQuotaExceededError,
  createAiQuotaService,
  DEFAULT_PLAN_LIMITS,
  sendAiQuotaError,
} = require('../utils/aiQuota');

function withEnv(values, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
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

class FakeRedis {
  constructor(nowProvider) {
    this.nowProvider = nowProvider;
    this.counters = new Map();
    this.requests = new Map();
    this.keys = [];
  }

  expireCounters(nowMs) {
    for (const [key, record] of this.counters) {
      if (record.expiresAt <= nowMs) {
        this.counters.delete(key);
      }
    }

    for (const [key, record] of this.requests) {
      if (record.expiresAt <= nowMs) {
        this.requests.delete(key);
      }
    }
  }

  getCounter(key, ttlMs, nowMs) {
    const current = this.counters.get(key);

    if (!current || current.expiresAt <= nowMs) {
      return { count: 0, expiresAt: nowMs + ttlMs };
    }

    return current;
  }

  async eval(script, options) {
    const command = options.arguments[0];
    const keys = options.keys;
    const nowMs = this.nowProvider().getTime();
    this.expireCounters(nowMs);
    keys.forEach((key) => this.keys.push(key));

    if (command === 'commit') {
      const request = this.requests.get(keys[0]);
      if (request?.state === 'reserved') {
        request.state = 'committed';
        return [1, 'committed'];
      }
      return [0, request?.state || 'missing'];
    }

    if (command === 'refund') {
      const request = this.requests.get(keys[0]);
      if (!request || request.state !== 'reserved') {
        return [0, request?.state || 'missing'];
      }

      keys.slice(1).forEach((key) => {
        const counter = this.counters.get(key);
        if (counter && counter.count > 0) {
          counter.count -= 1;
        }
      });
      request.state = 'refunded';
      return [1, 'refunded'];
    }

    const dayTtl = Number(options.arguments[1]);
    const monthTtl = Number(options.arguments[2]);
    const dailyLimit = Number(options.arguments[3]);
    const monthlyLimit = Number(options.arguments[4]);
    const globalDailyLimit = Number(options.arguments[5]);
    const globalMonthlyLimit = Number(options.arguments[6]);
    const ipDailyLimit = Number(options.arguments[7]);
    const requestTtl = Number(options.arguments[8]);

    const existing = this.requests.get(keys[0]);
    if (existing && existing.expiresAt > nowMs && existing.state !== 'refunded') {
      return [
        2,
        existing.state,
        this.counters.get(keys[1])?.count || 0,
        this.counters.get(keys[2])?.count || 0,
        this.counters.get(keys[3])?.count || 0,
        this.counters.get(keys[4])?.count || 0,
        this.counters.get(keys[5])?.count || 0,
      ];
    }

    const daily = this.getCounter(keys[1], dayTtl, nowMs);
    if (daily.count >= dailyLimit) return [0, 'daily', daily.count, dailyLimit, 0];

    const monthly = this.getCounter(keys[2], monthTtl, nowMs);
    if (monthly.count >= monthlyLimit) return [0, 'monthly', monthly.count, monthlyLimit, 0];

    const globalDaily = this.getCounter(keys[3], dayTtl, nowMs);
    if (globalDaily.count >= globalDailyLimit) return [0, 'daily', globalDaily.count, globalDailyLimit, 1];

    const globalMonthly = this.getCounter(keys[4], monthTtl, nowMs);
    if (globalMonthly.count >= globalMonthlyLimit) return [0, 'monthly', globalMonthly.count, globalMonthlyLimit, 1];

    const ipDaily = this.getCounter(keys[5], dayTtl, nowMs);
    if (ipDailyLimit > 0 && ipDaily.count >= ipDailyLimit) {
      return [0, 'daily', ipDaily.count, ipDailyLimit, 0];
    }

    daily.count += 1;
    monthly.count += 1;
    globalDaily.count += 1;
    globalMonthly.count += 1;
    if (ipDailyLimit > 0) ipDaily.count += 1;

    this.counters.set(keys[1], daily);
    this.counters.set(keys[2], monthly);
    this.counters.set(keys[3], globalDaily);
    this.counters.set(keys[4], globalMonthly);
    this.counters.set(keys[5], ipDaily);
    this.requests.set(keys[0], {
      state: 'reserved',
      expiresAt: nowMs + requestTtl,
    });

    return [1, 'reserved', daily.count, monthly.count, globalDaily.count, globalMonthly.count, ipDaily.count];
  }
}

function createService({ nowProvider, redis } = {}) {
  return createAiQuotaService({
    nowProvider,
    redisClientProvider: async () => redis,
  });
}

async function callProviderWithQuota(service, reservationInput, provider) {
  const reservation = await service.reserve(reservationInput);
  await provider();
  await service.commit(reservation);
  return reservation;
}

test('usuário free para exatamente no limite e a próxima requisição bloqueia antes do provider', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '2',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '10',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '100',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '100',
  }, async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });
    let providerCalls = 0;

    await callProviderWithQuota(service, { userId: 'u-free', plan: 'free', route: 'chat', requestId: 'r1', ip: '203.0.113.10' }, async () => {
      providerCalls += 1;
    });
    const second = await callProviderWithQuota(service, { userId: 'u-free', plan: 'free', route: 'chat', requestId: 'r2', ip: '203.0.113.10' }, async () => {
      providerCalls += 1;
    });

    assert.equal(second.usage.daily.current, 2);
    assert.equal(second.usage.daily.remaining, 0);

    await assert.rejects(
      async () => callProviderWithQuota(service, { userId: 'u-free', plan: 'free', route: 'chat', requestId: 'r3', ip: '203.0.113.10' }, async () => {
        providerCalls += 1;
      }),
      (error) => {
        assert.equal(error.code, AI_QUOTA_EXCEEDED_CODE);
        assert.equal(error.period, 'daily');
        assert.equal(error.limit, 2);
        assert.equal(error.current, 2);
        return true;
      }
    );
    assert.equal(providerCalls, 2);
  });
});

test('30 requisições simultâneas não ultrapassam quota atômica', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '20',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '100',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '100',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '100',
  }, async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => (
      service.reserve({
        userId: 'parallel-user',
        plan: 'free',
        route: 'chat',
        requestId: `parallel-${index}`,
        ip: '203.0.113.11',
      })
    )));

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 20);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 10);
    assert.equal(redis.counters.get(results.find((result) => result.status === 'fulfilled').value.keys.dailyKey).count, 20);
  });
});

test('usuários diferentes têm contadores separados', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '1',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '10',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '100',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '100',
  }, async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });

    await service.reserve({ userId: 'user-a', plan: 'free', route: 'chat', requestId: 'a1', ip: '203.0.113.12' });
    await service.reserve({ userId: 'user-b', plan: 'free', route: 'chat', requestId: 'b1', ip: '203.0.113.12' });

    await assert.rejects(
      () => service.reserve({ userId: 'user-a', plan: 'free', route: 'chat', requestId: 'a2', ip: '203.0.113.12' }),
      { code: AI_QUOTA_EXCEEDED_CODE }
    );
  });
});

test('planos diferentes recebem limites diferentes reais do backend', () => {
  assert.deepEqual(DEFAULT_PLAN_LIMITS, {
    free: { daily: 20, monthly: 100 },
    pro: { daily: 100, monthly: 1000 },
    business: { daily: 500, monthly: 10000 },
  });
});

test('variáveis opcionais de quota com espaços usam fallback em vez de zero', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '   ',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '   ',
  }, async () => {
    const service = createAiQuotaService({
      nowProvider: () => new Date('2026-07-18T12:00:00.000Z'),
      redisClientProvider: () => null,
    });

    const reservation = await service.reserve({
      userId: 'space-env-user',
      plan: 'free',
      route: 'chat',
      requestId: 'space-env',
      ip: '203.0.113.21',
    });

    assert.equal(reservation.usage.daily.limit, 3);
    assert.equal(reservation.usage.monthly.limit, 10);
  });
});

test('troca de dia e mês reseta os contadores por TTL', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '1',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '2',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '100',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '100',
  }, async () => {
    let now = new Date('2026-07-31T23:59:59.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });

    await service.reserve({ userId: 'period-user', plan: 'free', route: 'chat', requestId: 'p1', ip: '203.0.113.13' });
    await assert.rejects(
      () => service.reserve({ userId: 'period-user', plan: 'free', route: 'chat', requestId: 'p2', ip: '203.0.113.13' }),
      { period: 'daily' }
    );

    now = new Date('2026-08-01T00:00:01.000Z');
    await service.reserve({ userId: 'period-user', plan: 'free', route: 'chat', requestId: 'p3', ip: '203.0.113.13' });
    await assert.rejects(
      () => service.reserve({ userId: 'period-user', plan: 'free', route: 'chat', requestId: 'p4', ip: '203.0.113.13' }),
      { period: 'daily' }
    );

    const augustKeys = [...redis.counters.keys()].filter((key) => key.includes(':m:2026-08'));
    assert.equal(augustKeys.length > 0, true);
  });
});

test('idempotência evita cobrança dupla com a mesma chave', async () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const redis = new FakeRedis(() => now);
  const service = createService({ nowProvider: () => now, redis });

  const first = await service.reserve({ userId: 'idem-user', plan: 'pro', route: 'chat', requestId: 'same-key', ip: '203.0.113.14' });
  const second = await service.reserve({ userId: 'idem-user', plan: 'pro', route: 'chat', requestId: 'same-key', ip: '203.0.113.14' });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(redis.counters.get(first.keys.dailyKey).count, 1);
});

test('falha do provider estorna quando não houve resposta útil', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '1',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '10',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '100',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '100',
  }, async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });
    const reservation = await service.reserve({ userId: 'refund-user', plan: 'free', route: 'chat', requestId: 'fail-1', ip: '203.0.113.15' });

    await service.refund(reservation);
    assert.equal(redis.counters.get(reservation.keys.dailyKey).count, 0);

    await service.reserve({ userId: 'refund-user', plan: 'free', route: 'chat', requestId: 'retry-1', ip: '203.0.113.15' });
  });
});

test('commit e refund aceitam redisClientProvider síncrono em testes/stubs', async () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const redis = new FakeRedis(() => now);
  const service = createAiQuotaService({
    nowProvider: () => now,
    redisClientProvider: () => redis,
  });

  const committed = await service.reserve({
    userId: 'sync-provider-user',
    plan: 'free',
    route: 'chat',
    requestId: 'sync-commit',
    ip: '203.0.113.22',
  });
  await service.commit(committed);

  const refunded = await service.reserve({
    userId: 'sync-provider-user',
    plan: 'free',
    route: 'chat',
    requestId: 'sync-refund',
    ip: '203.0.113.22',
  });
  await service.refund(refunded);

  assert.equal(redis.requests.get(committed.keys.requestKey).state, 'committed');
  assert.equal(redis.requests.get(refunded.keys.requestKey).state, 'refunded');
});

test('Redis indisponível não libera uso ilimitado', async () => {
  await withEnv({
    NODE_ENV: 'production',
    AI_QUOTA_REDIS_FALLBACK_PAID_DAILY_LIMIT: '2',
    AI_QUOTA_REDIS_FALLBACK_PAID_MONTHLY_LIMIT: '2',
  }, async () => {
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      const now = new Date('2026-07-18T12:00:00.000Z');
      const service = createAiQuotaService({
        nowProvider: () => now,
        redisClientProvider: async () => {
          throw Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
        },
      });

      await assert.rejects(
        () => service.reserve({ userId: 'free-prod', plan: 'free', route: 'chat', requestId: 'f1', ip: '203.0.113.16' }),
        { code: AI_QUOTA_EXCEEDED_CODE }
      );

      await service.reserve({ userId: 'paid-prod', plan: 'pro', route: 'chat', requestId: 'p1', ip: '203.0.113.16' });
      await service.reserve({ userId: 'paid-prod', plan: 'pro', route: 'chat', requestId: 'p2', ip: '203.0.113.16' });
      await assert.rejects(
        () => service.reserve({ userId: 'paid-prod', plan: 'pro', route: 'chat', requestId: 'p3', ip: '203.0.113.16' }),
        { code: AI_QUOTA_EXCEEDED_CODE }
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('resposta de quota não vaza prompt, token ou e-mail', () => {
  const res = createResponse();
  const error = createAiQuotaExceededError({
    period: 'monthly',
    limit: 1,
    current: 1,
    resetAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  error.prompt = 'segredo no prompt';
  error.token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  error.email = 'person@example.test';

  sendAiQuotaError(res, error);

  const payload = JSON.stringify(res.body);
  assert.equal(res.statusCode, 429);
  assert.equal(payload.includes('segredo no prompt'), false);
  assert.equal(payload.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.equal(payload.includes('person@example.test'), false);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'limit', 'message', 'period', 'remaining', 'resetAt', 'usage'].sort());
});

test('circuit breaker global bloqueia novas chamadas', async () => {
  await withEnv({
    AI_QUOTA_FREE_DAILY_LIMIT: '10',
    AI_QUOTA_FREE_MONTHLY_LIMIT: '10',
    AI_QUOTA_GLOBAL_DAILY_LIMIT: '2',
    AI_QUOTA_GLOBAL_MONTHLY_LIMIT: '10',
  }, async () => {
    const now = new Date('2026-07-18T12:00:00.000Z');
    const redis = new FakeRedis(() => now);
    const service = createService({ nowProvider: () => now, redis });

    await service.reserve({ userId: 'global-a', plan: 'free', route: 'chat', requestId: 'g1', ip: '203.0.113.17' });
    await service.reserve({ userId: 'global-b', plan: 'free', route: 'chat', requestId: 'g2', ip: '203.0.113.18' });
    await assert.rejects(
      () => service.reserve({ userId: 'global-c', plan: 'free', route: 'chat', requestId: 'g3', ip: '203.0.113.19' }),
      (error) => {
        assert.equal(error.code, AI_QUOTA_EXCEEDED_CODE);
        assert.equal(error.scope, 'global');
        assert.equal(error.period, 'daily');
        return true;
      }
    );
  });
});

test('chaves Redis usam prefixo e hash, sem IP/e-mail/token/prompt bruto', async () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const redis = new FakeRedis(() => now);
  const service = createService({ nowProvider: () => now, redis });
  const rawIp = '203.0.113.20';
  const rawToken = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
  const rawEmail = 'person@example.test';
  const rawPrompt = 'prompt secreto';

  await service.reserve({
    userId: rawEmail,
    plan: 'pro',
    route: 'chat',
    requestId: `${rawToken}:${rawPrompt}`,
    ip: rawIp,
  });

  for (const key of redis.keys) {
    assert.match(key, new RegExp(`^${APP_AI_QUOTA_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    assert.equal(key.includes(rawIp), false);
    assert.equal(key.includes(rawEmail), false);
    assert.equal(key.includes(rawEmail.toLowerCase()), false);
    assert.equal(key.includes(rawToken), false);
    assert.equal(key.includes(rawPrompt), false);
  }
});
