const crypto = require('crypto');
const { createClient } = require('redis');

const RATE_LIMIT_MESSAGE = 'Muitas requisições. Tente novamente em instantes.';
const APP_RATE_LIMIT_PREFIX = 'fluidbe:rate-limit';
const REDIS_FALLBACK_LOG_INTERVAL_MS = 60 * 1000;
const configuredRedisConnectTimeoutMs = Number(process.env.REDIS_RATE_LIMIT_CONNECT_TIMEOUT_MS || 500);
const REDIS_CONNECT_TIMEOUT_MS = Number.isFinite(configuredRedisConnectTimeoutMs) && configuredRedisConnectTimeoutMs > 0
  ? configuredRedisConnectTimeoutMs
  : 500;
const RATE_LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])

if current <= 0 or ttl < 0 then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  return {1, tonumber(ARGV[1]), 0}
end

if current >= tonumber(ARGV[2]) then
  return {current, ttl, 1}
end

current = redis.call('INCR', KEYS[1])
ttl = redis.call('PTTL', KEYS[1])

if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

return {current, ttl, 0}
`;

let redisClient = null;
let redisConnectPromise = null;
let lastRedisFallbackLogAt = 0;

function getCookieValue(req, name) {
  const header = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const cookieName = part.slice(0, separator).trim();
    if (cookieName !== name) continue;
    return part.slice(separator + 1).trim();
  }

  return '';
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getAdminTokenKey(req) {
  const token = req.headers['x-admin-token'];

  if (!token) {
    const adminCookieName = process.env.ADMIN_SESSION_COOKIE_NAME || 'fluid_admin_session';
    const adminCookie = getCookieValue(req, adminCookieName);

    if (adminCookie) {
      return `admin-cookie:${crypto.createHash('sha256').update(String(adminCookie)).digest('hex')}`;
    }

    const authHeader = req.headers.authorization;
    const [scheme, bearerToken] = typeof authHeader === 'string' ? authHeader.split(/\s+/) : [];

    if (scheme === 'Bearer' && bearerToken) {
      return `bearer:${crypto.createHash('sha256').update(String(bearerToken)).digest('hex')}`;
    }

    return 'anonymous';
  }

  return `legacy:${crypto.createHash('sha256').update(String(token)).digest('hex')}`;
}

function getRateLimitKeySecret() {
  return process.env.RATE_LIMIT_KEY_SECRET
    || process.env.JWT_SECRET
    || 'fluidbe-rate-limit-key-v1';
}

function hmacSha256(value) {
  return crypto
    .createHmac('sha256', getRateLimitKeySecret())
    .update(String(value))
    .digest('hex');
}

function getEmailRateLimitKey(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  return normalizedEmail ? `email:${hmacSha256(normalizedEmail)}` : 'email:anonymous';
}

function normalizeLimiterName(name) {
  const normalized = String(name || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return normalized || 'default';
}

function buildRateLimitRedisKey(limiterName, identityKey) {
  return `${APP_RATE_LIMIT_PREFIX}:${normalizeLimiterName(limiterName)}:${hmacSha256(identityKey)}`;
}

function createLocalStore(windowMs, max) {
  const requests = new Map();
  let lastCleanupAt = 0;

  return {
    hit(key) {
      const now = Date.now();

      if (now - lastCleanupAt >= windowMs) {
        for (const [storedKey, storedRecord] of requests) {
          if (storedRecord.resetAt <= now) {
            requests.delete(storedKey);
          }
        }
        lastCleanupAt = now;
      }

      const record = requests.get(key);

      if (!record || record.resetAt <= now) {
        requests.set(key, { count: 1, resetAt: now + windowMs });
        return { count: 1, limited: false, retryAfterMs: windowMs };
      }

      if (record.count >= max) {
        return { count: record.count, limited: true, retryAfterMs: Math.max(1, record.resetAt - now) };
      }

      record.count += 1;
      return { count: record.count, limited: false, retryAfterMs: Math.max(1, record.resetAt - now) };
    },
  };
}

function logRedisFallback(error) {
  const now = Date.now();

  if (now - lastRedisFallbackLogAt < REDIS_FALLBACK_LOG_INTERVAL_MS) {
    return;
  }

  lastRedisFallbackLogAt = now;
  console.warn('Rate limiter Redis unavailable; using local fallback.', {
    name: error?.name || 'Error',
    code: error?.code || null,
  });
}

async function getConnectedRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (redisClient?.isReady) {
    return redisClient;
  }

  if (redisClient && !redisClient.isOpen) {
    redisClient = null;
    redisConnectPromise = null;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: false,
      },
    });
    redisClient.on('error', logRedisFallback);
    redisConnectPromise = redisClient.connect();
  }

  try {
    await redisConnectPromise;
    return redisClient?.isReady ? redisClient : null;
  } catch (error) {
    logRedisFallback(error);

    if (redisClient) {
      const client = redisClient;
      redisClient = null;
      redisConnectPromise = null;
      await client.destroy?.();
    }

    return null;
  }
}

async function hitRedisRateLimit(clientProvider, redisKey, windowMs, max) {
  const client = await clientProvider();

  if (!client) {
    return null;
  }

  const result = await client.eval(RATE_LIMIT_SCRIPT, {
    keys: [redisKey],
    arguments: [String(windowMs), String(max)],
  });

  return {
    count: Number(result?.[0] || 0),
    limited: Number(result?.[2] || 0) === 1,
    retryAfterMs: Math.max(1, Number(result?.[1] || windowMs)),
  };
}

async function resetRedisClientIfUnready() {
  if (!redisClient || redisClient.isReady) {
    return;
  }

  const client = redisClient;
  redisClient = null;
  redisConnectPromise = null;
  await client.destroy?.();
}

function sendRateLimitResponse(res, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ message: RATE_LIMIT_MESSAGE });
}

function createRateLimit({
  name = 'default',
  windowMs,
  max,
  keyGenerator = getClientIp,
  redisClientProvider = getConnectedRedisClient,
}) {
  const limiterName = normalizeLimiterName(name);
  const localStore = createLocalStore(windowMs, max);

  return async (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }

    const identityKey = keyGenerator(req);
    const storageKey = buildRateLimitRedisKey(limiterName, identityKey);
    let result = null;

    try {
      result = await hitRedisRateLimit(redisClientProvider, storageKey, windowMs, max);
    } catch (error) {
      logRedisFallback(error);
      await resetRedisClientIfUnready().catch(() => {});
    }

    if (!result) {
      result = localStore.hit(storageKey);
    }

    if (result.limited) {
      return sendRateLimitResponse(res, result.retryAfterMs);
    }

    return next();
  };
}

async function closeRateLimitRedis() {
  if (!redisClient) {
    return;
  }

  const client = redisClient;
  redisClient = null;
  redisConnectPromise = null;

  if (!client.isOpen) {
    await client.destroy?.();
    return;
  }

  await client.quit().catch(async () => {
    await client.destroy?.();
  });
}

module.exports = {
  RATE_LIMIT_MESSAGE,
  buildRateLimitRedisKey,
  closeRateLimitRedis,
  createRateLimit,
  getEmailRateLimitKey,
  getConnectedRedisClient,
  getAdminTokenKey,
  getClientIp,
  hitRedisRateLimit,
};
