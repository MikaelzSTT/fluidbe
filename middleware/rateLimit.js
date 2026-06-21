const crypto = require('crypto');

const RATE_LIMIT_MESSAGE = 'Muitas requisições. Tente novamente em instantes.';

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getAdminTokenKey(req) {
  const token = req.headers['x-admin-token'];

  if (!token) {
    return 'anonymous';
  }

  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createRateLimit({ windowMs, max, keyGenerator = getClientIp }) {
  const requests = new Map();
  let lastCleanupAt = 0;

  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }

    const now = Date.now();

    if (now - lastCleanupAt >= windowMs) {
      for (const [storedKey, storedRecord] of requests) {
        if (storedRecord.resetAt <= now) {
          requests.delete(storedKey);
        }
      }
      lastCleanupAt = now;
    }

    const key = keyGenerator(req);
    const record = requests.get(key);

    if (!record || record.resetAt <= now) {
      requests.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (record.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ message: RATE_LIMIT_MESSAGE });
    }

    record.count += 1;
    return next();
  };
}

module.exports = {
  RATE_LIMIT_MESSAGE,
  createRateLimit,
  getAdminTokenKey,
  getClientIp,
};
