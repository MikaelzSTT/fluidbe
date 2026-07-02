const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { createRateLimit, getClientIp } = require('../middleware/rateLimit');
const { requireRuntimeAuth } = require('../middleware/runtimeAuth');
const { validateRuntimeProject } = require('../middleware/runtimeProject');
const { runtimeError } = require('../utils/runtimeErrors');
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
const runtimeRateLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `${req.params.projectId || 'unknown'}:${getClientIp(req)}`,
});

function serializeRuntimeDocument(document) {
  if (!document) {
    return null;
  }

  return {
    id: String(document._id),
    projectId: String(document.projectId),
    collection: document.collection,
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

router.use(validateRuntimeProject);
router.use(runtimeRateLimit);

router.post('/auth/register', async (req, res) => {
  try {
    const email = normalizeRuntimeEmail(req.body?.email);
    const password = req.body?.password;
    const role = normalizeRuntimeRole(req.body?.role);

    if (!email) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_EMAIL', 'Invalid email.');
    }

    if (typeof password !== 'string' || password.length < 6) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_PASSWORD', 'Password must be at least 6 characters.');
    }

    if (!role) {
      return runtimeError(res, 400, 'RUNTIME_AUTH_INVALID_ROLE', 'Invalid runtime user role.');
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
    console.error('Runtime auth register failed:', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime auth request failed.');
  }
});

router.post('/auth/login', async (req, res) => {
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
    console.error('Runtime auth login failed:', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime auth request failed.');
  }
});

router.get('/auth/me', requireRuntimeAuth, (req, res) => {
  return res.json({
    user: serializeRuntimeUser(req.runtimeUser),
  });
});

router.get('/collections/:collection', validateRuntimeCollection, async (req, res) => {
  try {
    const filter = buildRuntimeEqualityFilter(req.query);

    if (!filter) {
      return runtimeError(res, 400, 'RUNTIME_VALIDATION_ERROR', 'Invalid runtime query filter.');
    }

    const { limit, skip } = parsePagination(req.query);
    const documents = await runtimeFind(
      req.runtimeProjectId,
      req.runtimeCollection,
      filter,
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
    console.error('Runtime collection query failed:', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
  }
});

router.get(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  async (req, res) => {
    try {
      const document = await runtimeFindOne(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      if (!document) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      console.error('Runtime document lookup failed:', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

router.post('/collections/:collection', validateRuntimeCollection, validateRuntimeBody, async (req, res) => {
  try {
    const document = await runtimeCreate(req.runtimeProjectId, req.runtimeCollection, req.body);
    return res.status(201).json({ data: serializeRuntimeDocument(document) });
  } catch (error) {
    console.error('Runtime document create failed:', error);
    return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
  }
});

router.patch(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  validateRuntimeBody,
  async (req, res) => {
    try {
      const document = await runtimeUpdate(
        req.runtimeProjectId,
        req.runtimeCollection,
        { _id: req.params.id },
        req.body
      );

      if (!document) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      console.error('Runtime document update failed:', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

router.delete(
  '/collections/:collection/:id',
  validateRuntimeCollection,
  validateRuntimeDocumentId,
  async (req, res) => {
    try {
      const document = await runtimeDelete(req.runtimeProjectId, req.runtimeCollection, {
        _id: req.params.id,
      });

      if (!document) {
        return runtimeError(res, 404, 'RUNTIME_NOT_FOUND', 'Runtime document not found.');
      }

      return res.json({ data: serializeRuntimeDocument(document) });
    } catch (error) {
      console.error('Runtime document delete failed:', error);
      return runtimeError(res, 500, 'RUNTIME_INTERNAL_ERROR', 'Runtime request failed.');
    }
  }
);

module.exports = router;
