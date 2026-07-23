const assert = require('assert/strict');
const test = require('node:test');
const {
  buildIndexMigrationPlan,
  compareIndexSpecs,
  ensureModelIndexes,
  findExistingIndexesByName,
  formatIndexMigrationPlan,
  matchesIndexFilters,
  migrateIndex,
} = require('../utils/adminIndexManager');

function createLogger() {
  return {
    lines: [],
    log(message) {
      this.lines.push(String(message));
    },
  };
}

function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function createMockModel({
  collectionName = 'sessions',
  indexes = [],
  schemaIndexes = [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
} = {}) {
  const state = {
    indexes: indexes.map((index) => JSON.parse(JSON.stringify(index))),
    createCalls: [],
    dropCalls: [],
  };
  const model = {
    schema: {
      indexes: () => schemaIndexes,
    },
    collection: {
      collectionName,
      listIndexes: () => ({
        toArray: async () => state.indexes.map((index) => JSON.parse(JSON.stringify(index))),
      }),
      createIndex: async (key, options = {}) => {
        state.createCalls.push({ key, options });
        const name = options.name || defaultIndexName(key);
        state.indexes.push({ key, name, ...options });
        return name;
      },
      dropIndex: async (name) => {
        state.dropCalls.push(name);
        state.indexes = state.indexes.filter((index) => index.name !== name);
      },
    },
  };

  return { model, state };
}

test('ensureModelIndexes creates index when it does not exist', async () => {
  const { model, state } = createMockModel();
  const logger = createLogger();

  const result = await ensureModelIndexes(model, { logger });

  assert.equal(result[0].action, 'created');
  assert.deepEqual(state.createCalls, [
    { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]);
  assert.equal(state.dropCalls.length, 0);
  assert.equal(state.indexes.length, 1);
  assert.equal(state.indexes[0].name, 'expiresAt_1');
  assert.equal(state.indexes[0].expireAfterSeconds, 0);
});

test('ensureModelIndexes succeeds when existing index is functionally equivalent', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        v: 2,
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 0,
        background: true,
      },
    ],
  });
  const logger = createLogger();

  const result = await ensureModelIndexes(model, { logger });

  assert.equal(result[0].action, 'equivalent');
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
});

test('ensureModelIndexes rejects same index name with incompatible options', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 3600,
      },
    ],
  });

  await assert.rejects(
    ensureModelIndexes(model, { logger: createLogger() }),
    (error) => {
      assert.equal(error.code, 'INCOMPATIBLE_INDEX');
      assert.equal(error.collectionName, 'sessions');
      assert.equal(error.indexName, 'expiresAt_1');
      assert.deepEqual(error.differences, [
        { field: 'expireAfterSeconds', existing: 3600, expected: 0 },
      ]);
      return true;
    }
  );
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
});

test('findExistingIndexesByName identifies the collection that owns an index name', async () => {
  const { model: sessionModel } = createMockModel({
    collectionName: 'sessions',
    indexes: [
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 3600,
        background: true,
      },
    ],
  });
  const { model: auditModel } = createMockModel({
    collectionName: 'adminauditlogs',
    indexes: [
      {
        key: { action: 1 },
        name: 'action_1',
      },
    ],
  });

  const matches = await findExistingIndexesByName([auditModel, sessionModel], 'expiresAt_1');

  assert.deepEqual(matches, [
    {
      collectionName: 'sessions',
      index: {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 3600,
      },
    },
  ]);
});

test('compareIndexSpecs compares unique, sparse, partialFilterExpression, and expireAfterSeconds', () => {
  const comparison = compareIndexSpecs(
    {
      key: { idempotencyKey: 1, result: 1 },
      name: 'idempotencyKey_1_result_1',
      unique: false,
      sparse: true,
      partialFilterExpression: { result: { $in: ['pending'] } },
      expireAfterSeconds: 60,
    },
    {
      comparable: {
        key: { idempotencyKey: 1, result: 1 },
        name: 'idempotencyKey_1_result_1',
        unique: true,
        partialFilterExpression: { result: { $in: ['pending', 'success'] } },
        expireAfterSeconds: 0,
      },
    }
  );

  assert.equal(comparison.equivalent, false);
  assert.deepEqual(comparison.differences.map((difference) => difference.field), [
    'unique',
    'sparse',
    'partialFilterExpression',
    'expireAfterSeconds',
  ]);
});

test('compareIndexSpecs preserves key order for compound indexes', () => {
  const comparison = compareIndexSpecs(
    {
      key: { result: 1, idempotencyKey: 1 },
      name: 'idempotencyKey_1_result_1',
    },
    {
      comparable: {
        key: { idempotencyKey: 1, result: 1 },
        name: 'idempotencyKey_1_result_1',
      },
    }
  );

  assert.equal(comparison.equivalent, false);
  assert.deepEqual(comparison.differences, [
    {
      field: 'key',
      existing: { result: 1, idempotencyKey: 1 },
      expected: { idempotencyKey: 1, result: 1 },
    },
  ]);
});

test('buildIndexMigrationPlan prefers collMod for briefing session TTL mismatch', () => {
  const expectedIndex = {
    key: { expiresAt: 1 },
    name: 'expiresAt_1',
    options: { expireAfterSeconds: 0 },
    comparable: {
      key: { expiresAt: 1 },
      name: 'expiresAt_1',
      expireAfterSeconds: 0,
    },
  };

  const plan = buildIndexMigrationPlan({
    collectionName: 'briefingsessions',
    existingIndex: { key: { expiresAt: 1 }, name: 'expiresAt_1' },
    expectedIndex,
    differences: [{ field: 'expireAfterSeconds', existing: undefined, expected: 0 }],
  });

  assert.equal(plan.requiresDropRecreate, false);
  assert.equal(plan.canIgnore, false);
  assert.deepEqual(plan.commands, [
    'db.runCommand({"collMod":"briefingsessions","index":{"keyPattern":{"expiresAt":1},"expireAfterSeconds":0}})',
  ]);
  assert.deepEqual(plan.fallbackCommands, [
    'db.getCollection("briefingsessions").dropIndex("expiresAt_1")',
    'db.getCollection("briefingsessions").createIndex({"expiresAt":1}, {"name":"expiresAt_1","expireAfterSeconds":0})',
  ]);
});

test('buildIndexMigrationPlan marks non-unique briefingSessionId sparse mismatch as ignorable', () => {
  const expectedIndex = {
    key: { briefingSessionId: 1 },
    name: 'briefingSessionId_1',
    options: { sparse: true },
    comparable: {
      key: { briefingSessionId: 1 },
      name: 'briefingSessionId_1',
      sparse: true,
    },
  };

  const plan = buildIndexMigrationPlan({
    collectionName: 'projects',
    existingIndex: { key: { briefingSessionId: 1 }, name: 'briefingSessionId_1' },
    expectedIndex,
    differences: [{ field: 'sparse', existing: undefined, expected: true }],
  });

  assert.equal(plan.canIgnore, true);
  assert.equal(plan.requiresDropRecreate, true);
  assert.match(plan.impact, /not required for functional correctness/);
});

test('buildIndexMigrationPlan stages Stripe unique partial indexes with a temporary name', () => {
  const expectedIndex = {
    key: { stripeCustomerId: 1 },
    name: 'stripeCustomerId_1',
    options: {
      unique: true,
      partialFilterExpression: {
        stripeCustomerId: { $type: 'string', $gt: '' },
      },
    },
    comparable: {
      key: { stripeCustomerId: 1 },
      name: 'stripeCustomerId_1',
      unique: true,
      partialFilterExpression: {
        stripeCustomerId: { $type: 'string', $gt: '' },
      },
    },
  };

  const plan = buildIndexMigrationPlan({
    collectionName: 'users',
    existingIndex: { key: { stripeCustomerId: 1 }, name: 'stripeCustomerId_1' },
    expectedIndex,
    differences: [
      { field: 'unique', existing: undefined, expected: true },
      {
        field: 'partialFilterExpression',
        existing: undefined,
        expected: { stripeCustomerId: { $type: 'string', $gt: '' } },
      },
    ],
  });

  assert.equal(plan.temporaryIndexName, 'stripeCustomerId_1_unique_partial_tmp');
  assert.equal(plan.canIgnore, false);
  assert.deepEqual(plan.commands.slice(0, 3), [
    'db.getCollection("users").createIndex({"stripeCustomerId":1}, {"name":"stripeCustomerId_1_unique_partial_tmp","unique":true,"partialFilterExpression":{"stripeCustomerId":{"$type":"string","$gt":""}}})',
    'db.getCollection("users").getIndexes().filter((index) => index.name === "stripeCustomerId_1_unique_partial_tmp")',
    'db.getCollection("users").dropIndex("stripeCustomerId_1")',
  ]);
  assert.ok(formatIndexMigrationPlan(plan).some((line) => line.includes('Commands to run manually')));
});

test('matchesIndexFilters supports collection and index name filters', () => {
  assert.equal(matchesIndexFilters({
    collectionName: 'users',
    indexName: 'stripeCustomerId_1',
  }, {
    collectionName: 'users',
    indexName: 'stripeCustomerId_1',
  }), true);
  assert.equal(matchesIndexFilters({
    collectionName: 'users',
    indexName: 'stripeCustomerId_1',
  }, {
    collectionName: 'projects',
  }), false);
  assert.equal(matchesIndexFilters({
    collectionName: 'users',
    indexName: 'stripeCustomerId_1',
  }, {
    indexName: 'stripeSubscriptionId_1',
  }), false);
});

test('migrateIndex without --confirm does not change incompatible index', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 3600,
      },
    ],
  });

  const result = await migrateIndex([model], {
    collectionName: 'sessions',
    indexName: 'expiresAt_1',
    confirm: false,
    logger: createLogger(),
  });

  assert.equal(result.action, 'dry-run-incompatible');
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
  assert.deepEqual(state.indexes, [
    {
      key: { expiresAt: 1 },
      name: 'expiresAt_1',
      expireAfterSeconds: 3600,
    },
  ]);
});

test('migrateIndex with --confirm does not change equivalent index', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 0,
      },
    ],
  });

  const result = await migrateIndex([model], {
    collectionName: 'sessions',
    indexName: 'expiresAt_1',
    confirm: true,
    logger: createLogger(),
  });

  assert.equal(result.action, 'already-equivalent');
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
  assert.deepEqual(state.indexes, [
    {
      key: { expiresAt: 1 },
      name: 'expiresAt_1',
      expireAfterSeconds: 0,
    },
  ]);
});

test('migrateIndex with --confirm drops only target index and recreates expected index', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        key: { _id: 1 },
        name: '_id_',
      },
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
        expireAfterSeconds: 3600,
      },
    ],
  });

  const result = await migrateIndex([model], {
    collectionName: 'sessions',
    indexName: 'expiresAt_1',
    confirm: true,
    logger: createLogger(),
  });

  assert.equal(result.action, 'migrated');
  assert.deepEqual(state.dropCalls, ['expiresAt_1']);
  assert.deepEqual(state.createCalls, [
    { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]);
  assert.deepEqual(state.indexes, [
    {
      key: { _id: 1 },
      name: '_id_',
    },
    {
      key: { expiresAt: 1 },
      name: 'expiresAt_1',
      expireAfterSeconds: 0,
    },
  ]);
});
