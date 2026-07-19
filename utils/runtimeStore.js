const RuntimeDocument = require('../models/RuntimeDocument');
const mongoose = require('mongoose');
const {
  containsUnsafeMongoKey,
  isPlainObject,
} = require('./mongoSafety');

const SAFE_RUNTIME_DATA_PATH = /^data\.[A-Za-z0-9_-]+$/;

function assertProjectId(projectId) {
  if (!projectId) {
    throw new Error('Runtime projectId is required.');
  }
}

function assertCollection(collection) {
  if (!collection) {
    throw new Error('Runtime collection is required.');
  }
}

function assertNoProjectOverride(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(value, 'projectId')) {
    throw new Error('Runtime projectId overrides are not allowed.');
  }
}

function assertNoOwnerOverride(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(value, 'ownerId')) {
    throw new Error('Runtime ownerId overrides are not allowed.');
  }
}

function toRuntimeObjectId(value, fieldName) {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error(`Runtime ${fieldName} is invalid.`);
  }

  return new mongoose.Types.ObjectId(value);
}

function isSafeRuntimeFilterValue(value) {
  return (
    value instanceof mongoose.Types.ObjectId ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function normalizeRuntimeFilter(filter = {}) {
  if (!isPlainObject(filter) || containsUnsafeMongoKey(filter, { allowDots: true })) {
    throw new Error('Runtime filter contains unsafe keys.');
  }

  const normalizedFilter = {};

  for (const [key, value] of Object.entries(filter)) {
    if (key === 'projectId' || key === 'collection') {
      throw new Error('Runtime scope overrides are not allowed.');
    }

    if (key === '_id' || key === 'ownerId') {
      normalizedFilter[key] = toRuntimeObjectId(value, key);
      continue;
    }

    if (!SAFE_RUNTIME_DATA_PATH.test(key)) {
      throw new Error('Runtime filter contains unsupported fields.');
    }

    if (!isSafeRuntimeFilterValue(value)) {
      throw new Error('Runtime filter values must be primitive.');
    }

    normalizedFilter[key] = value;
  }

  return normalizedFilter;
}

function scopedQuery(projectId, collection, filter = {}) {
  assertProjectId(projectId);
  assertCollection(collection);
  const normalizedFilter = normalizeRuntimeFilter(filter);

  return {
    ...normalizedFilter,
    projectId: toRuntimeObjectId(projectId, 'projectId'),
    collection,
  };
}

function runtimeFind(projectId, collection, filter = {}, options = {}) {
  const query = RuntimeDocument.find(scopedQuery(projectId, collection, filter));

  if (Number.isInteger(options.skip) && options.skip > 0) {
    query.skip(options.skip);
  }

  if (Number.isInteger(options.limit)) {
    query.limit(Math.min(Math.max(options.limit, 1), 100));
  }

  return query.sort({ createdAt: -1 });
}

function runtimeFindOne(projectId, collection, filter = {}) {
  return RuntimeDocument.findOne(scopedQuery(projectId, collection, filter));
}

function runtimeCreate(projectId, collection, data = {}, options = {}) {
  assertProjectId(projectId);
  assertCollection(collection);

  if (!isPlainObject(data) || containsUnsafeMongoKey(data, { blockOwnerId: true, blockProjectId: true })) {
    throw new Error('Runtime document body contains unsafe keys.');
  }

  assertNoProjectOverride(data);
  assertNoOwnerOverride(data);

  const document = {
    projectId: toRuntimeObjectId(projectId, 'projectId'),
    collection,
    data,
  };

  if (options.ownerId) {
    if (!mongoose.Types.ObjectId.isValid(options.ownerId)) {
      throw new Error('Runtime ownerId is invalid.');
    }

    document.ownerId = options.ownerId;
  }

  return RuntimeDocument.create(document);
}

function runtimeUpdate(projectId, collection, filter = {}, update = {}) {
  if (!isPlainObject(update) || containsUnsafeMongoKey(update, { blockOwnerId: true, blockProjectId: true })) {
    throw new Error('Runtime document update contains unsafe keys.');
  }

  assertNoProjectOverride(update);
  assertNoOwnerOverride(update);

  const set = {};

  for (const [key, value] of Object.entries(update)) {
    set[`data.${key}`] = value;
  }

  return RuntimeDocument.findOneAndUpdate(
    scopedQuery(projectId, collection, filter),
    { $set: set },
    { new: true }
  );
}

function runtimeDelete(projectId, collection, filter = {}) {
  return RuntimeDocument.findOneAndDelete(scopedQuery(projectId, collection, filter));
}

module.exports = {
  runtimeCreate,
  runtimeDelete,
  runtimeFind,
  runtimeFindOne,
  runtimeUpdate,
};
