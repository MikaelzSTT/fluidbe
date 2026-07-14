const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { createRateLimit, getClientIp } = require('../middleware/rateLimit');
const { optionalRuntimeAuth, requireRuntimeAuth } = require('../middleware/runtimeAuth');
const { validateRuntimeProject } = require('../middleware/runtimeProject');
const { runtimeError } = require('../utils/runtimeErrors');
const {
  canCreateRuntimeDocument,
  canDeleteRuntimeDocument,
  canReadRuntimeCollection,
  canReadRuntimeDocument,
  canUpdateRuntimeDocument,
  getRuntimeCollectionPolicy,
  runtimeUserIsAdmin,
} = require('../utils/runtimePolicies');
const {
  assertSafeRuntimeBody,
  buildRuntimeEqualityFilter,
  parsePagination,
  validateCollectionName,
} = require('../utils/runtimeValidation');
const {
  runtimeCreate,
  runtimeDelete,
  runtimeFind,
  runtimeFindOne,
  runtimeUpdate,
} = require('../utils/runtimeStore');
const {
  RUNTIME_USER_COLLECTION,
  normalizeRuntimeEmail,
  normalizeRuntimeRole,
  serializeRuntimeUser,
  signRuntimeAuthToken,
} = require('../utils/runtimeAuth');

const router = express.Router({ mergeParams: true });
const MAX_RUNTIME_PASSWORD_BYTES = 72;
const runtimeRateLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `${req.params.projectId || 'unknown'}:${getClientIp(req)}`,
});
const runtimeAuthRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.params.projectId || 'unknown'}:${getClientIp(req)}`,
});

function logRuntimeError(context, error) {
  console.error(context, {
    name: error?.name || 'Error',
    code: error?.code || null,
  });
}

function serializeRuntimeDocument(document) {
  if (!document) {
    return null;
  }

  return {
    id: String(document._id),
    projectId: String(document.projectId),
    collection: document.collection,
    ownerId: document.ownerId ? String(document.ownerId) : undefined,
    data: document.data || {},
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function validateRuntimeCollection(req, res, next) {
  const collection = validateCollectionName(req.params.collection);

  if (!collection) {
    return runtimeError(res, 400, 'RUNTIME_INVALID_COLLECTION', 'Invalid runtime collection.');
  }

  req.runtimeCollection = collection;
  return next();
}

function validateRuntimeDocumentId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return runtimeError(res, 400, 'RUNTIME_BAD_REQUEST', 'Invalid runtime document id.');
  }

  return next();
}

function validateRuntimeBody(req, res, next) {
  if (!assertSafeRuntimeBody(req.body)) {
    return runtimeError(res, 400, 'RUNTIME_VALIDATION_ERROR', 'Invalid runtime document body.');
  }

  return next();
}

function requireRuntimeUserForPolicy(req, res, policy) {
  if (policy.publicWrite || req.runtimeUserId) {
    return false;
  }

  runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
  return true;
}

function buildPolicyReadFilter(req, policy, filter) {
  if (policy.ownerScopedRead && !runtimeUserIsAdmin(req)) {
    return {
      ...filter,
      ownerId: req.runtimeUserId,
    };
  }

  return filter;
}

router.use(validateRuntimeProject);
router.use(runtimeRateLimit);

router.post('/auth/register', runtimeAuthRateLimit, async (req, res) => {
  try {
    const email = normalizeRuntimeEmail(req.body?.email);
    const password = req.body?.password;
    const role = normalizeRuntimeRole(req.body?.role);

    if (!email) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_EMAIL', 'Invalid email.');
    }

    if (
      typeof password !== 'string'
      || password.length < 6
      || Buffer.byteLength(password, 'utf8') > MAX_RUNTIME_PASSWORD_BYTES
    ) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_PASSWORD', 'Password must be 6 to 72 bytes.');
    }

    if (!role) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_ROLE', 'Invalid runtime user role.');
    }

    if (role === 'seller') {
      return runtimeError(res, 403, 'RUNTIME_AUTH_ROLE_FORBIDDEN', 'Privileged roles cannot be self-assigned.');
    }

    const existingUser = await runtimeFindOne(req.runtimeProjectId, RUNTIME_USER_COLLECTION, {
      'data.email': email,
    });

    if (existingUser) {
      return runtimeError(res, 409, 'RUNTIME_AUTH_EMAIL_EXISTS', 'Email already registered for this project.');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await runtimeCreate(req.runtimeProjectId, RUNTIME_USER_COLLECTION, {
      email,
      passwordHash,
      role,
      createdAt: new Date(),
    });

    return res.status(201).json({
      user: serializeRuntimeUser(user),
      token: signRuntimeAuthToken(user),
    });
  } catch (error) {
    logRuntimeError('Runtime auth register failed.', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime auth request failed.');
  }
});

router.post('/auth/login', runtimeAuthRateLimit, async (req, res) => {
  try {
    const email = normalizeRuntimeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || typeof password !== 'string') {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const user = await runtimeFindOne(req.runtimeProjectId, RUNTIME_USER_COLLECTION, {
      'data.email': email,
    });

    if (!user?.data?.passwordHash) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const passwordIsValid = await bcrypt.compare(password, user.data.passwordHash);

    if (!passwordIsValid) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    return res.json({
      user: serializeRuntimeUser(user),
      token: signRuntimeAuthToken(user),
    });
  } catch (error) {
    logRuntimeError('Runtime auth login failed.', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime auth request failed.');
  }
});

router.get('/auth/me', requireRuntimeAuth, (req, res) => {
  return res.json({
    user: serializeRuntimeUser(req.runtimeUser),
  });
});

router.get('/collections/:collection', validateRuntimeCollection, optionalRuntimeAuth, async (req, res) => {
  try {
    const policy = getRuntimeCollectionPolicy(req.runtimeCollection);

    if (!canReadRuntimeCollection(req, policy)) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
    }

    const filter = buildRuntimeEqualityFilter(req.query);

    if (!filter) {
      return runtimeError(res, 400, 'RUNTIME_VALIDATION_ERROR', 'Invalid runtime query filter.');
    }

    const { limit, skip } = parsePagination(req.query);
    const documents = await runtimeFind(
      req.runtimeProjectId,
      req.runtimeCollection,
      buildPolicyReadFilter(req, policy, filter),
      { limit, skip }
    );

    return res.json({
      data: documents.map(serializeRuntimeDocument),
      pagination: {
        limit,
        skip,
        count: documents.length,
      },
    });
  } catch (error) {
    logRuntimeError('Runtime collection query failed.', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
  }
});

router.get(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  optionalRuntimeAuth,
  async (req, res) => {
    try {
      const policy = getRuntimeCollectionPolicy(req.runtimeCollection);

      if (!canReadRuntimeCollection(req, policy)) {
        return runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
      }

      const document = await runtimeFindOne(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      if (!document) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      if (!canReadRuntimeDocument(req, policy, document)) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      logRuntimeError('Runtime document lookup failed.', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

router.post('/collections/:collection', validateRuntimeCollection, optionalRuntimeAuth, validateRuntimeBody, async (req, res) => {
  try {
    const policy = getRuntimeCollectionPolicy(req.runtimeCollection);

    if (!canCreateRuntimeDocument(req, policy)) {
      return runtimeError(res, 401, 'RUNTIME_AUTH_REQUIRED', 'Runtime auth token required.');
    }

    const createOptions = {};

    if (policy.assignOwnerOnCreate && req.runtimeUserId) {
      createOptions.ownerId = req.runtimeUserId;
    }

    const document = await runtimeCreate(req.runtimeProjectId, req.runtimeCollection, req.body, createOptions);
    return res.status(201).json({ data: serializeRuntimeDocument(document) });
  } catch (error) {
    logRuntimeError('Runtime document create failed.', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
  }
});

router.patch(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  optionalRuntimeAuth,
  validateRuntimeBody,
  async (req, res) => {
    try {
      const policy = getRuntimeCollectionPolicy(req.runtimeCollection);

      if (requireRuntimeUserForPolicy(req, res, policy)) {
        return null;
      }

      const existingDocument = await runtimeFindOne(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      if (!existingDocument) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      if (!canUpdateRuntimeDocument(req, policy, existingDocument)) {
        return runtimeError(res, 403, 'RUNTIME_FORBIDDEN', 'Runtime document access denied.');
      }

      const document = await runtimeUpdate(
        req.runtimeProjectId,
        req.runtimeCollection,
        { _id: req.params.id },
        req.body
      );

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      logRuntimeError('Runtime document update failed.', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

router.delete(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  optionalRuntimeAuth,
  async (req, res) => {
    try {
      const policy = getRuntimeCollectionPolicy(req.runtimeCollection);

      if (requireRuntimeUserForPolicy(req, res, policy)) {
        return null;
      }

      const existingDocument = await runtimeFindOne(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      if (!existingDocument) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      if (!canDeleteRuntimeDocument(req, policy, existingDocument)) {
        return runtimeError(res, 403, 'RUNTIME_FORBIDDEN', 'Runtime document access denied.');
      }

      const document = await runtimeDelete(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      logRuntimeError('Runtime document delete failed.', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

module.exports = router;
