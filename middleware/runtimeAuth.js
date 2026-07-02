const mongoose = require('mongoose');
const { runtimeError } = require('../utils/runtimeErrors');
const { runtimeFindOne } = require('../utils/runtimeStore');
const {
  RUNTIME_USER_COLLECTION,
  verifyRuntimeAuthToken,
} = require('../utils/runtimeAuth');

function parseRuntimeBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return { missing: true };
  }

  const [scheme, token] = authHeader.split(/\s+/);

  if (scheme !== 'Bearer' || !token) {
    return { invalid: true };
  }

  return { token };
}

async function loadRuntimeAuth(req, token) {
  const decoded = verifyRuntimeAuthToken(token);
  const routeProjectId = String(req.runtimeProjectId);

  if (
    !decoded.runtimeUserId ||
    !mongoose.Types.ObjectId.isValid(decoded.runtimeUserId) ||
    String(decoded.projectId) !== routeProjectId
  ) {
    return { forbidden: true };
  }

  const user = await runtimeFindOne(req.runtimeProjectId, RUNTIME_USER_COLLECTION, {
    _id: decoded.runtimeUserId,
  });

  if (!user) {
    return { invalid: true };
  }

  req.runtimeUser = user;
  req.runtimeUserId = String(user._id);
  req.runtimeUserRole = user.data?.role || decoded.role || 'user';

  return { authenticated: true };
}

async function requireRuntimeAuth(req, res, next) {
  const parsedToken = parseRuntimeBearerToken(req);

  if (parsedToken.missing) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
  }

  if (parsedToken.invalid) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
  }

  try {
    const auth = await loadRuntimeAuth(req, parsedToken.token);

    if (auth.forbidden) {
      return runtimeError(res, 403, 'RUNTIME_AUTH_FORBIDDEN', 'Runtime auth token is not valid for this project.');
    }

    if (!auth.authenticated) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
    }

    return next();
  } catch (error) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid or expired.');
  }
}

async function optionalRuntimeAuth(req, res, next) {
  const parsedToken = parseRuntimeBearerToken(req);

  if (parsedToken.missing) {
    return next();
  }

  if (parsedToken.invalid) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
  }

  try {
    const auth = await loadRuntimeAuth(req, parsedToken.token);

    if (auth.forbidden) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
    }

    if (!auth.authenticated) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
    }

    return next();
  } catch (error) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid or expired.');
  }
}

module.exports = {
  optionalRuntimeAuth,
  requireRuntimeAuth,
};
