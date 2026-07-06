const jwt = require('jsonwebtoken');
const Session = require('../models/Session');

const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

function isLegacyTokenAllowed(req) {
  return req.method === 'GET' && req.originalUrl.split('?')[0] === '/api/auth/me';
}

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Token não enviado.' });
  }

  const [scheme, token] = authHeader.split(/\s+/);

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Token inválido.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.id || decoded.runtimeUserId) {
      return res.status(401).json({ message: 'Token inválido ou expirado.' });
    }

    if (!decoded.jti) {
      if (isLegacyTokenAllowed(req)) {
        req.userId = decoded.id;
        req.authLegacyToken = true;
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

    req.userId = decoded.id;
    req.session = session;

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
