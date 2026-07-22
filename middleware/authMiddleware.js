const jwt = require('jsonwebtoken');
const Session = require('../models/Session');
const User = require('../models/User');
const {
  getPublicAuthMigrationDeadline,
  getPublicSessionCookieValue,
  isPublicBearerAuthLegacyEnabled,
  isPublicCookieAuthEnabled,
} = require('../utils/publicAuthCookies');

const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

function isLegacyTokenAllowed(req) {
  return req.method === 'GET' && req.originalUrl.split('?')[0] === '/api/auth/me';
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return '';
  }

  const [scheme, token] = authHeader.split(/\s+/);

  if (scheme !== 'Bearer' || !token) {
    return '';
  }

  return token;
}

function getRequestToken(req) {
  const cookieToken = isPublicCookieAuthEnabled() ? getPublicSessionCookieValue(req) : '';

  if (cookieToken) {
    return {
      token: cookieToken,
      source: 'cookie',
    };
  }

  const bearerToken = getBearerToken(req);

  if (bearerToken && isPublicBearerAuthLegacyEnabled()) {
    return {
      token: bearerToken,
      source: 'bearer',
    };
  }

  if (bearerToken) {
    return {
      token: '',
      source: 'disabled_bearer',
    };
  }

  return {
    token: '',
    source: 'missing',
  };
}

async function authMiddleware(req, res, next) {
  const parsedToken = getRequestToken(req);

  if (!parsedToken.token) {
    if (parsedToken.source === 'disabled_bearer') {
      return res.status(401).json({
        code: 'PUBLIC_BEARER_AUTH_DISABLED',
        message: 'Bearer público legado desativado.',
      });
    }

    return res.status(401).json({ message: 'Token não enviado.' });
  }

  if (parsedToken.source === 'bearer') {
    res.setHeader('X-Public-Bearer-Auth-Legacy', 'true');
    res.setHeader('X-Public-Auth-Migration-Deadline', getPublicAuthMigrationDeadline());
  }

  try {
    const decoded = jwt.verify(parsedToken.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    if (!decoded.id || decoded.runtimeUserId) {
      return res.status(401).json({ message: 'Token inválido.' });
    }

    if (!decoded.jti) {
      if (parsedToken.source === 'bearer' && isLegacyTokenAllowed(req)) {
        const legacyUser = await User.findById(decoded.id).select('deletedAt');

        if (legacyUser?.deletedAt) {
          return res.status(401).json({
            code: 'ACCOUNT_DELETED',
            message: 'ACCOUNT_DELETED',
          });
        }

        req.userId = decoded.id;
        req.authLegacyToken = true;
        req.authSource = parsedToken.source;
        return next();
      }

      return res.status(401).json({
        code: 'SESSION_REFRESH_REQUIRED',
        message: 'Faça login novamente para atualizar sua sessão.',
      });
    }

    const now = new Date();
    const session = await Session.findOne({
      jti: decoded.jti,
      userId: decoded.id,
      revokedAt: null,
      expiresAt: { $gt: now },
    });

    if (!session) {
      return res.status(401).json({
        code: 'SESSION_INVALID',
        message: 'Sessão inválida ou expirada.',
      });
    }

    const user = await User.findById(decoded.id).select('deletedAt');

    if (user?.deletedAt) {
      return res.status(401).json({
        code: 'ACCOUNT_DELETED',
        message: 'ACCOUNT_DELETED',
      });
    }

    req.userId = decoded.id;
    req.session = session;
    req.authSource = parsedToken.source;

    if (!session.lastSeenAt || now - session.lastSeenAt >= LAST_SEEN_UPDATE_INTERVAL_MS) {
      session.lastSeenAt = now;
      session.save().catch(() => {});
    }

    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
}

module.exports = authMiddleware;
