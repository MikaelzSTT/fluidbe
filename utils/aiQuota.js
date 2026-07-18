const crypto = require('crypto');
const User = require('../models/User');
const { getClientIp, getConnectedRedisClient } = require('../middleware/rateLimit');

const AI_QUOTA_EXCEEDED_MESSAGE = 'Você atingiu o limite de uso do seu plano.';
const AI_QUOTA_EXCEEDED_CODE = 'AI_QUOTA_EXCEEDED';
const AI_QUOTA_DUPLICATE_CODE = 'AI_QUOTA_DUPLICATE_REQUEST';
const APP_AI_QUOTA_PREFIX = 'fluidbe:ai-quota:v1';
const REQUEST_TTL_EXTRA_MS = 7 * 24 * 60 * 60 * 1000;
const REDIS_FALLBACK_LOG_INTERVAL_MS = 60 * 1000;
const SUPPORTED_PLANS = Object.freeze(['free', 'pro', 'business']);
const DEFAULT_PLAN_LIMITS = Object.freeze({
  free: Object.freeze({ daily: 20, monthly: 100 }),
  pro: Object.freeze({ daily: 100, monthly: 1000 }),
  business: Object.freeze({ daily: 500, monthly: 10000 }),
});
const DEFAULT_GLOBAL_LIMITS = Object.freeze({
  daily: 5000,
  monthly: 100000,
});
const FALLBACK_PAID_LIMITS = Object.freeze({
  daily: 10,
  monthly: 50,
});

const AI_QUOTA_SCRIPT = `
local command = ARGV[1]

if command == 'commit' then
  local state = redis.call('HGET', KEYS[1], 'state')
  if state == 'reserved' then
    redis.call('HSET', KEYS[1], 'state', 'committed', 'updatedAt', ARGV[2])
    return {1, 'committed'}
  end
  return {0, state or 'missing'}
end

if command == 'refund' then
  local state = redis.call('HGET', KEYS[1], 'state')
  if state ~= 'reserved' then
    return {0, state or 'missing'}
  end

  for i = 2, #KEYS do
    local value = tonumber(redis.call('GET', KEYS[i]) or '0')
    if value > 0 then
      redis.call('DECR', KEYS[i])
    end
  end

  redis.call('HSET', KEYS[1], 'state', 'refunded', 'updatedAt', ARGV[2])
  return {1, 'refunded'}
end

local dayTtl = tonumber(ARGV[2])
local monthTtl = tonumber(ARGV[3])
local dailyLimit = tonumber(ARGV[4])
local monthlyLimit = tonumber(ARGV[5])
local globalDailyLimit = tonumber(ARGV[6])
local globalMonthlyLimit = tonumber(ARGV[7])
local ipDailyLimit = tonumber(ARGV[8])
local requestTtl = tonumber(ARGV[9])
local nowIso = ARGV[10]

local existingState = redis.call('HGET', KEYS[1], 'state')
if existingState and existingState ~= 'refunded' then
  return {
    2,
    existingState,
    tonumber(redis.call('GET', KEYS[2]) or '0'),
    tonumber(redis.call('GET', KEYS[3]) or '0'),
    tonumber(redis.call('GET', KEYS[4]) or '0'),
    tonumber(redis.call('GET', KEYS[5]) or '0'),
    tonumber(redis.call('GET', KEYS[6]) or '0')
  }
end

local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
if daily >= dailyLimit then
  return {0, 'daily', daily, dailyLimit, 0}
end

local monthly = tonumber(redis.call('GET', KEYS[3]) or '0')
if monthly >= monthlyLimit then
  return {0, 'monthly', monthly, monthlyLimit, 0}
end

local globalDaily = tonumber(redis.call('GET', KEYS[4]) or '0')
if globalDaily >= globalDailyLimit then
  return {0, 'daily', globalDaily, globalDailyLimit, 1}
end

local globalMonthly = tonumber(redis.call('GET', KEYS[5]) or '0')
if globalMonthly >= globalMonthlyLimit then
  return {0, 'monthly', globalMonthly, globalMonthlyLimit, 1}
end

local ipDaily = tonumber(redis.call('GET', KEYS[6]) or '0')
if ipDailyLimit > 0 and ipDaily >= ipDailyLimit then
  return {0, 'daily', ipDaily, ipDailyLimit, 0}
end

daily = redis.call('INCR', KEYS[2])
if redis.call('PTTL', KEYS[2]) < 0 then
  redis.call('PEXPIRE', KEYS[2], dayTtl)
end

monthly = redis.call('INCR', KEYS[3])
if redis.call('PTTL', KEYS[3]) < 0 then
  redis.call('PEXPIRE', KEYS[3], monthTtl)
end

globalDaily = redis.call('INCR', KEYS[4])
if redis.call('PTTL', KEYS[4]) < 0 then
  redis.call('PEXPIRE', KEYS[4], dayTtl)
end

globalMonthly = redis.call('INCR', KEYS[5])
if redis.call('PTTL', KEYS[5]) < 0 then
  redis.call('PEXPIRE', KEYS[5], monthTtl)
end

if ipDailyLimit > 0 then
  ipDaily = redis.call('INCR', KEYS[6])
  if redis.call('PTTL', KEYS[6]) < 0 then
    redis.call('PEXPIRE', KEYS[6], dayTtl)
  end
end

redis.call(
  'HSET',
  KEYS[1],
  'state',
  'reserved',
  'dayKey',
  KEYS[2],
  'monthKey',
  KEYS[3],
  'globalDayKey',
  KEYS[4],
  'globalMonthKey',
  KEYS[5],
  'ipDayKey',
  KEYS[6],
  'createdAt',
  nowIso,
  'updatedAt',
  nowIso
)
redis.call('PEXPIRE', KEYS[1], requestTtl)

return {1, 'reserved', daily, monthly, globalDaily, globalMonthly, ipDaily}
`;

let lastFallbackLogAt = 0;

function parseIntegerEnv(name, fallback, { allowZero = true } = {}) {
  const value = process.env[name];

  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    return fallback;
  }

  return parsed;
}

function getAiQuotaKeySecret() {
  return process.env.AI_QUOTA_KEY_SECRET
    || process.env.RATE_LIMIT_KEY_SECRET
    || process.env.JWT_SECRET
    || 'fluidbe-ai-quota-key-v1';
}

function hmacSha256(value) {
  return crypto
    .createHmac('sha256', getAiQuotaKeySecret())
    .update(String(value))
    .digest('hex');
}

function normalizeAiPlan(plan) {
  return SUPPORTED_PLANS.includes(plan) ? plan : 'free';
}

function envPlanLimitName(plan, period) {
  return `AI_QUOTA_${plan.toUpperCase()}_${period.toUpperCase()}_LIMIT`;
}

function getAiQuotaPlanLimits(plan) {
  const normalizedPlan = normalizeAiPlan(plan);
  const defaults = DEFAULT_PLAN_LIMITS[normalizedPlan] || DEFAULT_PLAN_LIMITS.free;

  return {
    daily: parseIntegerEnv(envPlanLimitName(normalizedPlan, 'daily'), defaults.daily),
    monthly: parseIntegerEnv(envPlanLimitName(normalizedPlan, 'monthly'), defaults.monthly),
  };
}

function getAiQuotaConfig(plan) {
  return {
    plan: normalizeAiPlan(plan),
    limits: getAiQuotaPlanLimits(plan),
    globalLimits: {
      daily: parseIntegerEnv('AI_QUOTA_GLOBAL_DAILY_LIMIT', DEFAULT_GLOBAL_LIMITS.daily, { allowZero: false }),
      monthly: parseIntegerEnv('AI_QUOTA_GLOBAL_MONTHLY_LIMIT', DEFAULT_GLOBAL_LIMITS.monthly, { allowZero: false }),
    },
    ipDailyLimit: parseIntegerEnv('AI_QUOTA_IP_DAILY_LIMIT', 0),
    fallbackPaidLimits: {
      daily: parseIntegerEnv('AI_QUOTA_REDIS_FALLBACK_PAID_DAILY_LIMIT', FALLBACK_PAID_LIMITS.daily),
      monthly: parseIntegerEnv('AI_QUOTA_REDIS_FALLBACK_PAID_MONTHLY_LIMIT', FALLBACK_PAID_LIMITS.monthly),
    },
  };
}

function getUtcPeriodInfo(now = new Date()) {
  const current = new Date(now);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();
  const dayStart = Date.UTC(year, month, day);
  const nextDayStart = Date.UTC(year, month, day + 1);
  const monthStart = Date.UTC(year, month, 1);
  const nextMonthStart = Date.UTC(year, month + 1, 1);

  return {
    day: new Date(dayStart).toISOString().slice(0, 10),
    month: new Date(monthStart).toISOString().slice(0, 7),
    dayResetAt: new Date(nextDayStart),
    monthResetAt: new Date(nextMonthStart),
    dayTtlMs: Math.max(1000, nextDayStart - current.getTime()),
    monthTtlMs: Math.max(1000, nextMonthStart - current.getTime()),
  };
}

function buildAiQuotaRedisKeys({ userId, plan, route, requestId, ip, now = new Date() }) {
  const normalizedPlan = normalizeAiPlan(plan);
  const period = getUtcPeriodInfo(now);
  const hashedUser = hmacSha256(`user:${userId}`);
  const hashedRequest = hmacSha256(`request:${userId}:${route}:${requestId}`);
  const hashedIp = hmacSha256(`ip:${ip || 'unknown'}`);

  return {
    period,
    requestKey: `${APP_AI_QUOTA_PREFIX}:req:${hashedRequest}`,
    dailyKey: `${APP_AI_QUOTA_PREFIX}:u:${hashedUser}:p:${normalizedPlan}:d:${period.day}`,
    monthlyKey: `${APP_AI_QUOTA_PREFIX}:u:${hashedUser}:p:${normalizedPlan}:m:${period.month}`,
    globalDailyKey: `${APP_AI_QUOTA_PREFIX}:global:d:${period.day}`,
    globalMonthlyKey: `${APP_AI_QUOTA_PREFIX}:global:m:${period.month}`,
    ipDailyKey: `${APP_AI_QUOTA_PREFIX}:ip:${hashedIp}:d:${period.day}`,
  };
}

function safeRequestId(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return '';
  }

  return normalized.slice(0, 160);
}

function getAiQuotaRequestId(req, route) {
  const headerValue = req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key'];
  const bodyValue = req.body?.idempotencyKey || req.body?.requestId;
  const provided = safeRequestId(headerValue || bodyValue);

  if (provided) {
    return provided;
  }

  if (!req.aiQuotaRequestIds) {
    req.aiQuotaRequestIds = {};
  }

  if (!req.aiQuotaRequestIds[route]) {
    req.aiQuotaRequestIds[route] = crypto.randomUUID();
  }

  return req.aiQuotaRequestIds[route];
}

function createAiQuotaExceededError({ period, limit, current, resetAt, scope }) {
  const error = new Error(AI_QUOTA_EXCEEDED_MESSAGE);
  error.code = AI_QUOTA_EXCEEDED_CODE;
  error.period = period;
  error.limit = limit;
  error.current = current;
  error.remaining = Math.max(0, limit - current);
  error.resetAt = resetAt instanceof Date ? resetAt.toISOString() : resetAt;
  error.scope = scope || 'user';
  error.status = 429;
  return error;
}

function createAiQuotaDuplicateError() {
  const error = new Error('Requisição de IA duplicada.');
  error.code = AI_QUOTA_DUPLICATE_CODE;
  error.status = 409;
  return error;
}

function parseReserveResult(result, config, keys, requestId) {
  const status = Number(result?.[0] || 0);

  if (status === 0) {
    const period = result?.[1] === 'monthly' ? 'monthly' : 'daily';
    const current = Number(result?.[2] || 0);
    const limit = Number(result?.[3] || 0);
    const scope = Number(result?.[4] || 0) === 1 ? 'global' : 'user';
    throw createAiQuotaExceededError({
      period,
      limit,
      current,
      resetAt: period === 'monthly' ? keys.period.monthResetAt : keys.period.dayResetAt,
      scope,
    });
  }

  if (status === 2) {
    return {
      ok: true,
      duplicate: true,
      state: String(result?.[1] || 'reserved'),
      requestId,
      keys,
      plan: config.plan,
    };
  }

  const dailyUsage = Number(result?.[2] || 0);
  const monthlyUsage = Number(result?.[3] || 0);

  return {
    ok: true,
    duplicate: false,
    state: 'reserved',
    requestId,
    keys,
    refundKeys: [
      keys.dailyKey,
      keys.monthlyKey,
      keys.globalDailyKey,
      keys.globalMonthlyKey,
      ...(config.ipDailyLimit > 0 ? [keys.ipDailyKey] : []),
    ],
    plan: config.plan,
    usage: {
      daily: {
        limit: config.limits.daily,
        current: dailyUsage,
        remaining: Math.max(0, config.limits.daily - dailyUsage),
        resetAt: keys.period.dayResetAt.toISOString(),
      },
      monthly: {
        limit: config.limits.monthly,
        current: monthlyUsage,
        remaining: Math.max(0, config.limits.monthly - monthlyUsage),
        resetAt: keys.period.monthResetAt.toISOString(),
      },
    },
  };
}

function logAiQuotaRedisFallback(error) {
  const now = Date.now();

  if (now - lastFallbackLogAt < REDIS_FALLBACK_LOG_INTERVAL_MS) {
    return;
  }

  lastFallbackLogAt = now;
  console.warn('AI quota Redis unavailable; using constrained fallback.', {
    name: error?.name || 'Error',
    code: error?.code || null,
  });
}

function createLocalFallbackStore() {
  const counters = new Map();
  const requests = new Map();

  function cleanup(nowMs) {
    for (const [key, record] of counters) {
      if (record.expiresAt <= nowMs) {
        counters.delete(key);
      }
    }

    for (const [key, record] of requests) {
      if (record.expiresAt <= nowMs) {
        requests.delete(key);
      }
    }
  }

  function getCounter(key, ttlMs, nowMs) {
    const current = counters.get(key);

    if (!current || current.expiresAt <= nowMs) {
      return { count: 0, expiresAt: nowMs + ttlMs };
    }

    return current;
  }

  return {
    reserve({ keys, config, requestId, now }) {
      const nowMs = now.getTime();
      cleanup(nowMs);

      const existingRequest = requests.get(keys.requestKey);
      if (existingRequest && existingRequest.expiresAt > nowMs && existingRequest.state !== 'refunded') {
        return {
          ok: true,
          duplicate: true,
          state: existingRequest.state,
          requestId,
          keys,
          plan: config.plan,
        };
      }

      if (process.env.NODE_ENV === 'production' && config.plan === 'free') {
        throw createAiQuotaExceededError({
          period: 'daily',
          limit: 0,
          current: 0,
          resetAt: keys.period.dayResetAt,
          scope: 'redis_unavailable',
        });
      }

      const limits = config.plan === 'free'
        ? {
            daily: Math.min(config.limits.daily, 3),
            monthly: Math.min(config.limits.monthly, 10),
          }
        : {
            daily: Math.min(config.limits.daily, config.fallbackPaidLimits.daily),
            monthly: Math.min(config.limits.monthly, config.fallbackPaidLimits.monthly),
          };
      const daily = getCounter(keys.dailyKey, keys.period.dayTtlMs, nowMs);
      const monthly = getCounter(keys.monthlyKey, keys.period.monthTtlMs, nowMs);

      if (daily.count >= limits.daily) {
        throw createAiQuotaExceededError({
          period: 'daily',
          limit: limits.daily,
          current: daily.count,
          resetAt: keys.period.dayResetAt,
          scope: 'fallback',
        });
      }

      if (monthly.count >= limits.monthly) {
        throw createAiQuotaExceededError({
          period: 'monthly',
          limit: limits.monthly,
          current: monthly.count,
          resetAt: keys.period.monthResetAt,
          scope: 'fallback',
        });
      }

      daily.count += 1;
      monthly.count += 1;
      counters.set(keys.dailyKey, daily);
      counters.set(keys.monthlyKey, monthly);
      requests.set(keys.requestKey, {
        state: 'reserved',
        expiresAt: nowMs + Math.max(keys.period.monthTtlMs, keys.period.dayTtlMs) + REQUEST_TTL_EXTRA_MS,
      });

      return {
        ok: true,
        duplicate: false,
        state: 'reserved',
        requestId,
        keys,
        refundKeys: [keys.dailyKey, keys.monthlyKey],
        plan: config.plan,
        fallback: true,
        usage: {
          daily: {
            limit: limits.daily,
            current: daily.count,
            remaining: Math.max(0, limits.daily - daily.count),
            resetAt: keys.period.dayResetAt.toISOString(),
          },
          monthly: {
            limit: limits.monthly,
            current: monthly.count,
            remaining: Math.max(0, limits.monthly - monthly.count),
            resetAt: keys.period.monthResetAt.toISOString(),
          },
        },
      };
    },
    commit(reservation, now) {
      const record = requests.get(reservation.keys.requestKey);
      if (record?.state === 'reserved') {
        record.state = 'committed';
        record.updatedAt = now.toISOString();
      }
    },
    refund(reservation, now) {
      const record = requests.get(reservation.keys.requestKey);
      if (!record || record.state !== 'reserved') {
        return;
      }

      (reservation.refundKeys || [reservation.keys.dailyKey, reservation.keys.monthlyKey]).forEach((key) => {
        const counter = counters.get(key);
        if (counter && counter.count > 0) {
          counter.count -= 1;
        }
      });
      record.state = 'refunded';
      record.updatedAt = now.toISOString();
    },
  };
}

function createAiQuotaService({
  redisClientProvider = getConnectedRedisClient,
  nowProvider = () => new Date(),
  fallbackStore = createLocalFallbackStore(),
} = {}) {
  async function reserve({ userId, plan, route = 'chat', requestId, ip }) {
    if (!userId) {
      throw createAiQuotaExceededError({
        period: 'daily',
        limit: 0,
        current: 0,
        resetAt: getUtcPeriodInfo(nowProvider()).dayResetAt,
        scope: 'anonymous',
      });
    }

    const now = new Date(nowProvider());
    const config = getAiQuotaConfig(plan);
    const effectiveRequestId = safeRequestId(requestId) || crypto.randomUUID();
    const keys = buildAiQuotaRedisKeys({
      userId,
      plan: config.plan,
      route,
      requestId: effectiveRequestId,
      ip,
      now,
    });

    let client = null;

    try {
      client = await redisClientProvider();
    } catch (error) {
      logAiQuotaRedisFallback(error);
    }

    if (!client) {
      return fallbackStore.reserve({
        keys,
        config,
        requestId: effectiveRequestId,
        now,
      });
    }

    try {
      const result = await client.eval(AI_QUOTA_SCRIPT, {
        keys: [
          keys.requestKey,
          keys.dailyKey,
          keys.monthlyKey,
          keys.globalDailyKey,
          keys.globalMonthlyKey,
          keys.ipDailyKey,
        ],
        arguments: [
          'reserve',
          String(keys.period.dayTtlMs),
          String(keys.period.monthTtlMs),
          String(config.limits.daily),
          String(config.limits.monthly),
          String(config.globalLimits.daily),
          String(config.globalLimits.monthly),
          String(config.ipDailyLimit),
          String(Math.max(keys.period.monthTtlMs, keys.period.dayTtlMs) + REQUEST_TTL_EXTRA_MS),
          now.toISOString(),
        ],
      });

      return parseReserveResult(result, config, keys, effectiveRequestId);
    } catch (error) {
      if (error?.code === AI_QUOTA_EXCEEDED_CODE) {
        throw error;
      }

      logAiQuotaRedisFallback(error);
      return fallbackStore.reserve({
        keys,
        config,
        requestId: effectiveRequestId,
        now,
      });
    }
  }

  async function commit(reservation) {
    if (!reservation || reservation.duplicate) {
      return;
    }

    const now = new Date(nowProvider());

    if (reservation.fallback) {
      fallbackStore.commit(reservation, now);
      return;
    }

    const client = await redisClientProvider().catch((error) => {
      logAiQuotaRedisFallback(error);
      return null;
    });

    if (!client) {
      return;
    }

    await client.eval(AI_QUOTA_SCRIPT, {
      keys: [reservation.keys.requestKey],
      arguments: ['commit', now.toISOString()],
    }).catch(logAiQuotaRedisFallback);
  }

  async function refund(reservation) {
    if (!reservation || reservation.duplicate) {
      return;
    }

    const now = new Date(nowProvider());

    if (reservation.fallback) {
      fallbackStore.refund(reservation, now);
      return;
    }

    const client = await redisClientProvider().catch((error) => {
      logAiQuotaRedisFallback(error);
      return null;
    });

    if (!client) {
      return;
    }

    await client.eval(AI_QUOTA_SCRIPT, {
      keys: [
        reservation.keys.requestKey,
        ...(reservation.refundKeys || [
          reservation.keys.dailyKey,
          reservation.keys.monthlyKey,
          reservation.keys.globalDailyKey,
          reservation.keys.globalMonthlyKey,
          reservation.keys.ipDailyKey,
        ]),
      ],
      arguments: ['refund', now.toISOString()],
    }).catch(logAiQuotaRedisFallback);
  }

  return {
    commit,
    refund,
    reserve,
  };
}

const defaultAiQuotaService = createAiQuotaService();

async function resolveBackendPlan(userId) {
  const user = await User.findById(userId).select('plan');
  return normalizeAiPlan(user?.plan);
}

function createAiQuotaContext(req, { route = 'chat' } = {}) {
  return {
    req,
    route,
    reservation: null,
    providerUsefulResponse: false,
  };
}

async function ensureAiQuotaReserved(context, service = defaultAiQuotaService) {
  if (!context) {
    return null;
  }

  if (context.reservation) {
    return context.reservation;
  }

  const req = context.req;
  const plan = await resolveBackendPlan(req.userId);
  const requestId = getAiQuotaRequestId(req, context.route);
  const reservation = await service.reserve({
    userId: req.userId,
    plan,
    route: context.route,
    requestId,
    ip: getClientIp(req),
  });

  if (reservation.duplicate) {
    throw createAiQuotaDuplicateError();
  }

  context.reservation = reservation;
  return reservation;
}

async function commitAiQuotaContext(context, service = defaultAiQuotaService) {
  if (!context?.reservation) {
    return;
  }

  await service.commit(context.reservation);
}

async function refundAiQuotaContext(context, service = defaultAiQuotaService) {
  if (!context?.reservation || context.providerUsefulResponse) {
    return;
  }

  await service.refund(context.reservation);
}

function sendAiQuotaError(res, error) {
  if (error?.code === AI_QUOTA_DUPLICATE_CODE) {
    return res.status(409).json({
      message: 'Requisição de IA duplicada.',
      code: AI_QUOTA_DUPLICATE_CODE,
    });
  }

  return res.status(error?.status || 429).json({
    message: AI_QUOTA_EXCEEDED_MESSAGE,
    code: AI_QUOTA_EXCEEDED_CODE,
    period: error?.period === 'monthly' ? 'monthly' : 'daily',
    limit: Number(error?.limit || 0),
    usage: Number(error?.current || 0),
    remaining: Math.max(0, Number(error?.remaining || 0)),
    resetAt: error?.resetAt || getUtcPeriodInfo().dayResetAt.toISOString(),
  });
}

module.exports = {
  AI_QUOTA_DUPLICATE_CODE,
  AI_QUOTA_EXCEEDED_CODE,
  AI_QUOTA_EXCEEDED_MESSAGE,
  APP_AI_QUOTA_PREFIX,
  buildAiQuotaRedisKeys,
  commitAiQuotaContext,
  createAiQuotaContext,
  createAiQuotaExceededError,
  createAiQuotaService,
  DEFAULT_PLAN_LIMITS,
  ensureAiQuotaReserved,
  getAiQuotaConfig,
  getAiQuotaPlanLimits,
  getUtcPeriodInfo,
  normalizeAiPlan,
  refundAiQuotaContext,
  sendAiQuotaError,
};
