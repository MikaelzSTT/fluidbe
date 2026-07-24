const assert = require('assert/strict');
const test = require('node:test');
const BriefingSession = require('../models/BriefingSession');
const BuildJob = require('../models/BuildJob');
const ChatMessage = require('../models/ChatMessage');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const RuntimeDocument = require('../models/RuntimeDocument');
const Session = require('../models/Session');
const AdminSession = require('../models/AdminSession');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const User = require('../models/User');
const { ensureIndexes } = require('../utils/adminIndexManager');
const {
  STRIPE_UNIQUE_PARTIAL_FIELDS,
  findDuplicateNonEmptyStrings,
  validateMongoIndexReadiness,
} = require('../utils/mongoIndexReadiness');
const {
  countUnresolvedIncompatibilities,
  parseArgs,
  summarize,
} = require('../scripts/syncMongoIndexes');

function indexMatchesKey(index, key) {
  return JSON.stringify(index[0]) === JSON.stringify(key);
}

function findSchemaIndex(model, key) {
  return model.schema.indexes().find((index) => indexMatchesKey(index, key));
}

function assertSchemaIndex(model, key, options = {}) {
  const index = findSchemaIndex(model, key);
  assert.ok(index, `Expected ${model.modelName} index ${JSON.stringify(key)}`);

  for (const [optionName, expectedValue] of Object.entries(options)) {
    assert.deepEqual(index[1][optionName], expectedValue, `${model.modelName}.${optionName}`);
  }
}

function assertNoDuplicateSchemaIndexes(model) {
  const seen = new Set();

  for (const [key, options] of model.schema.indexes()) {
    const signature = JSON.stringify({
      key,
      unique: options.unique === true,
      sparse: options.sparse === true,
      partialFilterExpression: options.partialFilterExpression,
      expireAfterSeconds: options.expireAfterSeconds,
    });

    assert.equal(seen.has(signature), false, `${model.modelName} has duplicate index ${signature}`);
    seen.add(signature);
  }
}

function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function createMockModel({
  collectionName = 'projects',
  indexes = [],
  schemaIndexes = [[{ userId: 1, createdAt: -1, _id: -1 }, {}]],
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

function createAggregateModel(collectionName, handler) {
  return {
    collection: {
      collectionName,
      aggregate: (pipeline) => ({
        toArray: async () => handler(pipeline),
      }),
    },
  };
}

test('critical Mongo indexes are declared for primary query paths', () => {
  assertSchemaIndex(Project, { userId: 1, createdAt: -1, _id: -1 });
  assertSchemaIndex(Project, { userId: 1, isPublished: 1 });
  assertSchemaIndex(Project, { updatedAt: -1, createdAt: -1, _id: -1 });

  assertSchemaIndex(ProjectBuild, { projectId: 1, status: 1, createdAt: -1, updatedAt: -1, _id: -1 });
  assertSchemaIndex(ProjectBuild, { projectId: 1, createdAt: -1, updatedAt: -1, _id: -1 });
  assertSchemaIndex(ProjectBuild, { projectId: 1, updatedAt: -1, createdAt: -1, _id: -1 });

  assertSchemaIndex(ProjectMessage, { projectId: 1, createdAt: 1, _id: 1 });
  assertSchemaIndex(ChatMessage, { userId: 1, sessionId: 1, createdAt: 1, _id: 1 });
  assertSchemaIndex(BriefingSession, { userId: 1, conversationId: 1, status: 1, updatedAt: -1, _id: -1, expiresAt: 1 });
  assertSchemaIndex(BuildJob, { status: 1, queuedAt: 1, _id: 1 });
  assertSchemaIndex(BuildJob, { projectBuildId: 1, createdAt: -1, _id: -1 });
  assertSchemaIndex(ProjectChangeRequest, { projectId: 1, status: 1, createdAt: -1, _id: -1 });
  assertSchemaIndex(ProjectChangeRequest, { projectId: 1, createdAt: -1, _id: -1 });
  assertSchemaIndex(ProjectChangeRequest, { status: 1, createdAt: -1, _id: -1 });
  assertSchemaIndex(ProjectChangeRequest, { createdAt: -1, _id: -1 });
  assertSchemaIndex(RuntimeDocument, { projectId: 1, collection: 1, ownerId: 1, createdAt: -1 });
});

test('TTL indexes are declared only on expiry/transient date fields', () => {
  assertSchemaIndex(Session, { expiresAt: 1 }, { expireAfterSeconds: 0 });
  assertSchemaIndex(AdminSession, { expiresAt: 1 }, { expireAfterSeconds: 0 });
  assertSchemaIndex(BriefingSession, { expiresAt: 1 }, { expireAfterSeconds: 0 });
  assertSchemaIndex(StripeWebhookEvent, { receivedAt: 1 }, {
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { status: 'processed' },
  });
});

test('unique indexes are declared for identity and billing lookup fields', () => {
  assertSchemaIndex(User, { email: 1 }, { unique: true });
  assertSchemaIndex(User, { googleId: 1 }, { unique: true, sparse: true });
  assertSchemaIndex(User, { githubId: 1 }, { unique: true, sparse: true });
  assertSchemaIndex(User, { 'profile.username': 1 }, { unique: true, sparse: true });
  assertSchemaIndex(Session, { jti: 1 }, { unique: true });
  assertSchemaIndex(AdminSession, { jti: 1 }, { unique: true });
  assertSchemaIndex(StripeWebhookEvent, { eventId: 1 }, { unique: true });

  for (const fieldName of [
    'stripeCustomerId',
    'stripeTestCustomerId',
    'stripeLiveCustomerId',
    'stripeSubscriptionId',
    'stripeTestSubscriptionId',
    'stripeLiveSubscriptionId',
  ]) {
    assertSchemaIndex(User, { [fieldName]: 1 }, {
      unique: true,
      partialFilterExpression: {
        [fieldName]: { $type: 'string', $gt: '' },
      },
    });
  }
});

test('schemas do not declare exact duplicate indexes', () => {
  [
    AdminSession,
    BriefingSession,
    BuildJob,
    ChatMessage,
    Project,
    ProjectBuild,
    ProjectChangeRequest,
    ProjectMessage,
    RuntimeDocument,
    Session,
    StripeWebhookEvent,
    User,
  ].forEach(assertNoDuplicateSchemaIndexes);
});

test('index sync dry-run is idempotent and does not create or drop indexes', async () => {
  const { model, state } = createMockModel({
    indexes: [
      {
        key: { userId: 1, createdAt: -1, _id: -1 },
        name: 'userId_1_createdAt_-1__id_-1',
      },
    ],
  });
  const logger = { log() {} };

  const first = await ensureIndexes([model], { logger, dryRun: true });
  const second = await ensureIndexes([model], { logger, dryRun: true });

  assert.deepEqual(first.map((result) => result.action), ['equivalent']);
  assert.deepEqual(second.map((result) => result.action), ['equivalent']);
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
});

test('index sync dry-run reports missing indexes without mutating collections', async () => {
  const { model, state } = createMockModel();
  const logger = { log() {} };
  const results = await ensureIndexes([model], { logger, dryRun: true });

  assert.deepEqual(results.map((result) => result.action), ['dry-run-create']);
  assert.deepEqual(summarize(results), { 'dry-run-create': 1 });
  assert.equal(state.createCalls.length, 0);
  assert.equal(state.dropCalls.length, 0);
  assert.deepEqual(state.indexes, []);
});

test('Stripe readiness detects duplicate non-empty values with masked output', async () => {
  const userModel = createAggregateModel('users', (pipeline) => {
    const fieldName = Object.keys(pipeline[0].$match)[0];
    if (fieldName === 'stripeCustomerId') {
      return [{ value: 'cus_duplicate_sensitive_value', count: 2 }];
    }
    return [];
  });
  const ttlModel = createAggregateModel('sessions', () => []);

  const result = await validateMongoIndexReadiness({
    userModel,
    stripeFields: ['stripeCustomerId', 'stripeSubscriptionId'],
    ttlChecks: [{ collectionName: 'sessions', model: ttlModel, fieldName: 'expiresAt' }],
  });

  assert.equal(result.clean, false);
  assert.equal(result.summary.duplicateFieldCount, 1);
  assert.equal(result.summary.duplicateValueCount, 1);
  assert.equal(result.summary.duplicateDocumentCount, 2);
  assert.equal(result.duplicateFields[0].fieldName, 'stripeCustomerId');
  assert.match(result.duplicateFields[0].duplicates[0].maskedValue, /^cus\.\.\.ue#[a-f0-9]{12}$/);
  assert.equal(result.duplicateFields[0].duplicates[0].maskedValue.includes('duplicate_sensitive'), false);
});

test('Stripe readiness passes when database is clean', async () => {
  const cleanModel = createAggregateModel('users', () => []);

  const result = await validateMongoIndexReadiness({
    userModel: cleanModel,
    stripeFields: STRIPE_UNIQUE_PARTIAL_FIELDS,
    ttlChecks: [
      { collectionName: 'sessions', model: cleanModel, fieldName: 'expiresAt' },
    ],
  });

  assert.equal(result.clean, true);
  assert.deepEqual(result.summary, {
    duplicateFieldCount: 0,
    duplicateValueCount: 0,
    duplicateDocumentCount: 0,
    invalidTtlFieldCount: 0,
    invalidTtlDocumentCount: 0,
  });
});

test('Stripe duplicate query ignores empty and non-string values per partial index filter', async () => {
  let matchStage = null;
  const userModel = createAggregateModel('users', (pipeline) => {
    matchStage = pipeline[0].$match;
    return [];
  });

  const duplicates = await findDuplicateNonEmptyStrings(userModel, 'stripeCustomerId');

  assert.deepEqual(duplicates, []);
  assert.deepEqual(matchStage, {
    stripeCustomerId: { $type: 'string', $gt: '' },
  });
});

test('TTL readiness detects missing and non-Date values', async () => {
  const userModel = createAggregateModel('users', () => []);
  const ttlModel = createAggregateModel('sessions', () => [
    { _id: 'missing', count: 3 },
    { _id: 'string', count: 2 },
  ]);

  const result = await validateMongoIndexReadiness({
    userModel,
    stripeFields: ['stripeCustomerId'],
    ttlChecks: [{ collectionName: 'sessions', model: ttlModel, fieldName: 'expiresAt' }],
  });

  assert.equal(result.clean, false);
  assert.equal(result.summary.invalidTtlFieldCount, 1);
  assert.equal(result.summary.invalidTtlDocumentCount, 5);
  assert.deepEqual(result.invalidTtlFields, [
    {
      collectionName: 'sessions',
      fieldName: 'expiresAt',
      invalidCount: 5,
      invalidTypeCounts: {
        missing: 3,
        string: 2,
      },
    },
  ]);
});

test('index sync apply creates only expected missing indexes', async () => {
  const { model, state } = createMockModel({
    schemaIndexes: [
      [{ userId: 1, createdAt: -1, _id: -1 }, {}],
      [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
    ],
  });
  const logger = { log() {} };

  const results = await ensureIndexes([model], { logger, dryRun: false });

  assert.deepEqual(results.map((result) => result.action), ['created', 'created']);
  assert.deepEqual(state.createCalls, [
    { key: { userId: 1, createdAt: -1, _id: -1 }, options: {} },
    { key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]);
  assert.deepEqual(state.dropCalls, []);
  assert.equal(state.indexes.length, 2);
});

test('index sync filters by collection and index name', async () => {
  const { model: projectModel, state: projectState } = createMockModel({
    collectionName: 'projects',
    schemaIndexes: [
      [{ userId: 1, createdAt: -1, _id: -1 }, {}],
      [{ briefingSessionId: 1 }, { sparse: true }],
    ],
  });
  const { model: userModel, state: userState } = createMockModel({
    collectionName: 'users',
    schemaIndexes: [
      [{ stripeCustomerId: 1 }, {
        unique: true,
        partialFilterExpression: {
          stripeCustomerId: { $type: 'string', $gt: '' },
        },
      }],
    ],
  });
  const logger = { log() {} };

  const results = await ensureIndexes([projectModel, userModel], {
    logger,
    dryRun: false,
    filters: {
      collectionName: 'projects',
      indexName: 'briefingSessionId_1',
    },
  });

  assert.deepEqual(results.map((result) => result.action), ['created']);
  assert.deepEqual(projectState.createCalls, [
    { key: { briefingSessionId: 1 }, options: { sparse: true } },
  ]);
  assert.deepEqual(userState.createCalls, []);
});

test('index sync apply can skip incompatible indexes and continue creating compatible ones', async () => {
  const { model, state } = createMockModel({
    collectionName: 'briefingsessions',
    indexes: [
      {
        key: { expiresAt: 1 },
        name: 'expiresAt_1',
      },
    ],
    schemaIndexes: [
      [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
      [{ userId: 1, conversationId: 1 }, {}],
    ],
  });
  const logger = { log() {} };

  const results = await ensureIndexes([model], {
    logger,
    dryRun: false,
    failOnIncompatible: false,
  });

  assert.deepEqual(results.map((result) => result.action), ['incompatible', 'created']);
  assert.deepEqual(state.createCalls, [
    { key: { userId: 1, conversationId: 1 }, options: {} },
  ]);
  assert.deepEqual(state.dropCalls, []);
  assert.equal(countUnresolvedIncompatibilities(results), 1);
});

test('syncMongoIndexes argument parsing accepts collection and index filters', () => {
  assert.deepEqual(parseArgs([
    '--apply',
    '--collection',
    'users',
    '--index=stripeCustomerId_1',
  ]), {
    apply: true,
    help: false,
    collectionName: 'users',
    indexName: 'stripeCustomerId_1',
  });
});
