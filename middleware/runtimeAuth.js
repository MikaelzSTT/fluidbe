const mongoose = require('mongoose');
const { runtimeError } = require('../utils/runtimeErrors');
const { runtimeFindOne } = require('../utils/runtimeStore');
const {
  RUNTIME_USER_COLLECTION,
  verifyRuntimeAuthToken,
} = require('../utils/runtimeAuth');

async function requireRuntimeAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
  }

  const [scheme, token] = authHeader.split(/\s+/);

  if (scheme !== 'Bearer' || !token) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
  }

  try {
    const decoded = verifyRuntimeAuthToken(token);
    const routeProjectId = String(req.runtimeProjectId);

    if (
      !decoded.runtimeUserId ||
      !mongoose.Types.ObjectId.isValid(decoded.runtimeUserId) ||
      String(decoded.projectId) !== routeProjectId
    ) {
      return runtimeError(res, 403, 'RUNTIME_AUTH_FORBIDDEN', 'Runtime auth token is not valid for this project.');
    }

    const user = await runtimeFindOne(req.runtimeProjectId, RUNTIME_USER_COLLECTION, {
      _id: decoded.runtimeUserId,
    });

    if (!user) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid.');
    }

    req.runtimeUser = user;
    req.runtimeUserId = String(user._id);
    req.runtimeUserRole = user.data?.role || decoded.role || 'user';

    return next();
  } catch (error) {
    return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID', 'Runtime auth token invalid or expired.');
  }
}

module.exports = {
  requireRuntimeAuth,
};
