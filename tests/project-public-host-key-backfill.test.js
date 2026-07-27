const assert = require('assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');

const Project = require('../models/Project');
const {
  ensureIndexes,
} = require('../utils/adminIndexManager');
const {
  backfillProjectPublicHostKeys,
  buildProjectPublicHostKeySummary,
  classifyPublicHostKey,
} = require('../utils/projectPublicHostKeyBackfill');
const {
  isValidPublicHostKey,
} = require('../utils/publicHostKey');

function clone(value) {
  if (value instanceof mongoose.Types.ObjectId) {
    return new mongoose.Types.ObjectId(value.toHexString());
  }

  if (Array.isArray(value)) {
    return value.map(clone);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clone(entry)])
    );
  }

  return value;
}

function isObjectId(value) {
  return value instanceof mongoose.Types.ObjectId;
}

function sameRawMongoValue(left, right) {
  if (isObjectId(left) || isObjectId(right)) {
    return isObjectId(left) && isObjectId(right) && left.equals(right);
  }

  return Object.is(left, right);
}

function isMissingPublicHostKey(doc) {
  return !Object.prototype.hasOwnProperty.call(doc, 'publicHostKey')
    || doc.publicHostKey === null
    || doc.publicHostKey === '';
}

function matchesFilter(doc, filter = {}) {
  if (filter._id !== undefined && !sameRawMongoValue(doc._id, filter._id)) {
    return false;
  }

  if (filter.publicHostKey !== undefined && doc.publicHostKey !== filter.publicHostKey) {
    return false;
  }

  if (filter.$or) {
    return filter.$or.some((condition) => {
      if (condition.publicHostKey === null) {
        return !Object.prototype.hasOwnProperty.call(doc, 'publicHostKey')
          || doc.publicHostKey === null;
      }

      if (condition.publicHostKey === '') {
        return doc.publicHostKey === '';
      }

      if (condition.publicHostKey?.$exists === false) {
        return !Object.prototype.hasOwnProperty.call(doc, 'publicHostKey');
      }

      return false;
    });
  }

  return true;
}

function createMemoryProjectModel(initialDocs, {
  beforeUpdateOne,
  duplicateKeyOn = new Set(),
} = {}) {
  const state = {
    docs: initialDocs.map(clone),
    updateCalls: [],
    findCalls: [],
    findOneCalls: [],
  };

  const model = {
    collection: {
      collectionName: 'projects',
      find: (filter = {}) => {
        state.findCalls.push(clone(filter));
        return {
          toArray: async () => state.docs
            .filter((doc) => matchesFilter(doc, filter))
            .map((doc) => ({
              _id: doc._id,
              ...(Object.prototype.hasOwnProperty.call(doc, 'publicHostKey')
                ? { publicHostKey: doc.publicHostKey }
                : {}),
            })),
        };
      },
      findOne: async (filter = {}) => {
        state.findOneCalls.push(clone(filter));
        const doc = state.docs.find((candidate) => matchesFilter(candidate, filter));
        return doc ? clone(doc) : null;
      },
      updateOne: async (filter, update) => {
        state.updateCalls.push({ filter: clone(filter), update: clone(update) });

        if (beforeUpdateOne) {
          beforeUpdateOne({ state, filter, update });
        }

        const nextKey = update.$set?.publicHostKey;
        if (duplicateKeyOn.has(nextKey)) {
          const error = new Error('duplicate key');
          error.code = 11000;
          throw error;
        }

        const index = state.docs.findIndex((doc) => matchesFilter(doc, filter));
        if (index < 0) {
          return { matchedCount: 0, modifiedCount: 0 };
        }

        state.docs[index] = {
          ...state.docs[index],
          ...clone(update.$set || {}),
        };
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  };

  return { model, state };
}

function createIndexMockProjectModel() {
  const state = {
    indexes: [],
    createCalls: [],
  };
  const model = {
    schema: {
      indexes: () => Project.schema.indexes().filter(([key]) => (
        JSON.stringify(key) === JSON.stringify({ publicHostKey: 1 })
      )),
    },
    collection: {
      collectionName: 'projects',
      listIndexes: () => ({
        toArray: async () => clone(state.indexes),
      }),
      createIndex: async (key, options) => {
        state.createCalls.push({ key, options });
        state.indexes.push({
          key,
          name: options.name || 'publicHostKey_1',
          ...options,
        });
      },
    },
  };

  return { model, state };
}

test('dry-run identifies missing legacy keys and performs zero writes', async () => {
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a', name: 'Legacy A' },
    { _id: 'project-b', publicHostKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  ]);

  const result = await backfillProjectPublicHostKeys({ projectModel: model });

  assert.equal(result.dryRun, true);
  assert.equal(result.missingUnset, 1);
  assert.equal(result.alreadyValid, 1);
  assert.equal(result.wouldUpdate, 1);
  assert.equal(result.updated, 0);
  assert.equal(state.updateCalls.length, 0);
});

test('apply assigns valid canonical keys to missing projects', async () => {
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a' },
  ]);

  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  assert.equal(result.updated, 1);
  assert.equal(state.docs[0].publicHostKey, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(isValidPublicHostKey(state.docs[0].publicHostKey), true);
});

test('apply uses raw ObjectId targets for legacy absent, null, and empty publicHostKey values', async () => {
  const ids = [
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
  ];
  const keys = [
    '01010101010101010101010101010101',
    '02020202020202020202020202020202',
    '03030303030303030303030303030303',
  ];
  const { model, state } = createMemoryProjectModel([
    { _id: ids[0], name: 'Legacy absent' },
    { _id: ids[1], name: 'Legacy null', publicHostKey: null },
    { _id: ids[2], name: 'Legacy empty', publicHostKey: '' },
  ]);

  const dryRun = await backfillProjectPublicHostKeys({ projectModel: model });
  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => keys.shift(),
  });

  assert.equal(dryRun.missingUnset, 3);
  assert.equal(dryRun.wouldUpdate, 3);
  assert.equal(result.updated, 3);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.conditionalUpdateMatched, 3);
  assert.equal(result.conditionalUpdateModified, 3);
  assert.equal(result.conditionalUpdateZeroMatched, 0);
  assert.deepEqual(state.docs.map((doc) => doc.publicHostKey), [
    '01010101010101010101010101010101',
    '02020202020202020202020202020202',
    '03030303030303030303030303030303',
  ]);
  assert.equal(state.updateCalls.length, 3);
  assert.equal(state.updateCalls.every((call) => call.filter._id instanceof mongoose.Types.ObjectId), true);
  assert.equal(state.updateCalls.every((call, index) => call.filter._id.equals(ids[index])), true);
});

test('existing valid publicHostKey remains unchanged', async () => {
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a', publicHostKey: 'cccccccccccccccccccccccccccccccc' },
  ]);

  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => 'dddddddddddddddddddddddddddddddd',
  });

  assert.equal(result.updated, 0);
  assert.equal(state.docs[0].publicHostKey, 'cccccccccccccccccccccccccccccccc');
  assert.equal(state.updateCalls.length, 0);
});

test('second apply is idempotent', async () => {
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a' },
  ]);

  await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  });
  const second = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => 'ffffffffffffffffffffffffffffffff',
  });

  assert.equal(second.updated, 0);
  assert.equal(state.docs[0].publicHostKey, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  assert.equal(state.updateCalls.length, 1);
});

test('two missing projects receive distinct keys', async () => {
  const keys = [
    '11111111111111111111111111111111',
    '22222222222222222222222222222222',
  ];
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a' },
    { _id: 'project-b', publicHostKey: null },
  ]);

  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => keys.shift(),
  });

  assert.equal(result.updated, 2);
  assert.notEqual(state.docs[0].publicHostKey, state.docs[1].publicHostKey);
  assert.equal(isValidPublicHostKey(state.docs[0].publicHostKey), true);
  assert.equal(isValidPublicHostKey(state.docs[1].publicHostKey), true);
});

test('malformed existing publicHostKey blocks apply rather than being replaced', async () => {
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a', publicHostKey: 'not-valid' },
    { _id: 'project-b' },
  ]);

  await assert.rejects(
    backfillProjectPublicHostKeys({
      projectModel: model,
      apply: true,
      generateKey: () => '33333333333333333333333333333333',
    }),
    /blocked/
  );

  assert.equal(state.docs[0].publicHostKey, 'not-valid');
  assert.equal(state.docs[1].publicHostKey, undefined);
  assert.equal(state.updateCalls.length, 0);
});

test('duplicate existing publicHostKey values are detected before unique-index application', () => {
  const summary = buildProjectPublicHostKeySummary([
    { _id: 'project-a', publicHostKey: '44444444444444444444444444444444' },
    { _id: 'project-b', publicHostKey: '44444444444444444444444444444444' },
  ]);

  assert.equal(summary.readyForUniqueIndex, false);
  assert.equal(summary.duplicateValueCount, 1);
  assert.deepEqual(summary.duplicateKeys[0].projectIds, ['project-a', 'project-b']);
});

test('conditional update cannot overwrite a concurrently assigned key', async () => {
  let updatedByConcurrentWorker = false;
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-a' },
  ], {
    beforeUpdateOne: ({ state: memoryState }) => {
      if (!updatedByConcurrentWorker) {
        memoryState.docs[0].publicHostKey = '55555555555555555555555555555555';
        updatedByConcurrentWorker = true;
      }
    },
  });

  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => '66666666666666666666666666666666',
  });

  assert.equal(result.updated, 0);
  assert.equal(result.concurrentAlreadyUpdated, 1);
  assert.equal(state.docs[0].publicHostKey, '55555555555555555555555555555555');
});

test('generated-key collision retry path does not overwrite another project', async () => {
  const keys = [
    '77777777777777777777777777777777',
    '88888888888888888888888888888888',
  ];
  const { model, state } = createMemoryProjectModel([
    { _id: 'project-existing', publicHostKey: '77777777777777777777777777777777' },
    { _id: 'project-missing' },
  ]);

  const result = await backfillProjectPublicHostKeys({
    projectModel: model,
    apply: true,
    generateKey: () => keys.shift(),
  });

  const missingProject = state.docs.find((doc) => doc._id === 'project-missing');
  assert.equal(result.updated, 1);
  assert.equal(result.collisionRetries, 1);
  assert.equal(missingProject.publicHostKey, '88888888888888888888888888888888');
});

test('publicHostKey readiness classifies valid, missing, malformed, and non-string values', () => {
  assert.deepEqual(classifyPublicHostKey('99999999999999999999999999999999'), { state: 'valid' });
  assert.equal(classifyPublicHostKey(undefined).missing, true);
  assert.equal(classifyPublicHostKey('').missing, true);
  assert.equal(classifyPublicHostKey('INVALID').state, 'invalid');
  assert.equal(classifyPublicHostKey(123).reason, 'non-string');
});

test('expected partial unique publicHostKey index is discoverable by index sync', async () => {
  const { model, state } = createIndexMockProjectModel();
  const logger = { log() {} };

  const results = await ensureIndexes([model], {
    logger,
    dryRun: true,
    filters: {
      collectionName: 'projects',
      indexName: 'publicHostKey_1',
    },
  });

  assert.deepEqual(results.map((result) => result.action), ['dry-run-create']);
  assert.equal(state.createCalls.length, 0);
  assert.deepEqual(results[0].expectedIndex.key, { publicHostKey: 1 });
  assert.equal(results[0].expectedIndex.options.unique, true);
  assert.deepEqual(results[0].expectedIndex.options.partialFilterExpression, {
    publicHostKey: { $type: 'string', $gt: '' },
  });
});
