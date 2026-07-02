const RuntimeDocument = require('../models/RuntimeDocument');
const mongoose = require('mongoose');

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

function scopedQuery(projectId, collection, filter = {}) {
  assertProjectId(projectId);
  assertCollection(collection);
  assertNoProjectOverride(filter);

  return {
    ...filter,
    projectId,
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
  assertNoProjectOverride(data);
  assertNoOwnerOverride(data);

  const document = {
    projectId,
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
