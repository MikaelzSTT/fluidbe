const COMPARED_OPTION_FIELDS = [
  'unique',
  'sparse',
  'partialFilterExpression',
  'expireAfterSeconds',
];

const STRIPE_UNIQUE_PARTIAL_INDEX_FIELDS = new Set([
  'stripeCustomerId',
  'stripeTestCustomerId',
  'stripeLiveCustomerId',
  'stripeSubscriptionId',
  'stripeTestSubscriptionId',
  'stripeLiveSubscriptionId',
]);

function clonePlain(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function sortPlain(value) {
  if (Array.isArray(value)) {
    return value.map(sortPlain);
  }

  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = sortPlain(value[key]);
      return result;
    }, {});
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortPlain(value));
}

function keyStringify(value) {
  return JSON.stringify(value);
}

function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

function comparableIndexSpec(index) {
  const comparable = {
    key: clonePlain(index.key),
    name: index.name,
  };

  if (index.unique === true) {
    comparable.unique = true;
  }

  if (index.sparse === true) {
    comparable.sparse = true;
  }

  if (index.partialFilterExpression !== undefined) {
    comparable.partialFilterExpression = clonePlain(index.partialFilterExpression);
  }

  if (index.expireAfterSeconds !== undefined) {
    comparable.expireAfterSeconds = Number(index.expireAfterSeconds);
  }

  return comparable;
}

function expectedIndexFromSchema(schemaIndex) {
  const [key, options = {}] = schemaIndex;
  const name = options.name || defaultIndexName(key);

  return {
    key: clonePlain(key),
    name,
    options: clonePlain(options),
    comparable: comparableIndexSpec({ key, name, ...options }),
  };
}

function getExpectedIndexes(model) {
  return model.schema.indexes().map(expectedIndexFromSchema);
}

function matchesIndexFilters({ collectionName, indexName }, filters = {}) {
  const targetCollection = filters.collectionName || filters.collection;
  const targetIndex = filters.indexName || filters.index;

  if (targetCollection && collectionName !== targetCollection) {
    return false;
  }

  if (targetIndex && indexName !== targetIndex) {
    return false;
  }

  return true;
}

function compareIndexSpecs(existingIndex, expectedIndex) {
  const existing = comparableIndexSpec(existingIndex);
  const expected = expectedIndex.comparable || comparableIndexSpec(expectedIndex);
  const differences = [];

  if (keyStringify(existing.key) !== keyStringify(expected.key)) {
    differences.push({ field: 'key', existing: existing.key, expected: expected.key });
  }

  if (existing.name !== expected.name) {
    differences.push({ field: 'name', existing: existing.name, expected: expected.name });
  }

  for (const field of COMPARED_OPTION_FIELDS) {
    if (stableStringify(existing[field]) !== stableStringify(expected[field])) {
      differences.push({ field, existing: existing[field], expected: expected[field] });
    }
  }

  return {
    equivalent: differences.length === 0,
    existing,
    expected,
    differences,
  };
}

async function listIndexes(model) {
  return model.collection.listIndexes().toArray();
}

function getCollectionName(model) {
  return model.collection.collectionName || model.collection.name || model.collection.modelName;
}

function describeIndex(index) {
  return JSON.stringify(comparableIndexSpec(index), null, 2);
}

function mongoLiteral(value) {
  return JSON.stringify(value);
}

function collectionExpression(collectionName) {
  return `db.getCollection(${mongoLiteral(collectionName)})`;
}

function createIndexCommand(collectionName, key, options) {
  return `${collectionExpression(collectionName)}.createIndex(${mongoLiteral(key)}, ${mongoLiteral(options)})`;
}

function dropIndexCommand(collectionName, indexName) {
  return `${collectionExpression(collectionName)}.dropIndex(${mongoLiteral(indexName)})`;
}

function getSingleIndexField(key) {
  const entries = Object.entries(key || {});
  return entries.length === 1 ? entries[0][0] : null;
}

function expectedCreateOptions(expectedIndex) {
  return {
    name: expectedIndex.name,
    ...(expectedIndex.options || {}),
  };
}

function buildIndexMigrationPlan({ collectionName, existingIndex, expectedIndex, differences = [] }) {
  const currentIndex = comparableIndexSpec(existingIndex);
  const desiredIndex = expectedIndex.comparable || comparableIndexSpec(expectedIndex);
  const indexName = desiredIndex.name;
  const fieldName = getSingleIndexField(desiredIndex.key);
  const basePlan = {
    collectionName,
    indexName,
    currentIndex,
    desiredIndex,
    differences: clonePlain(differences),
    canIgnore: false,
    requiresDropRecreate: true,
    dropRecreateDetail: 'Changing these index options requires a manual drop and recreate if the final index must keep the same name.',
    blockingRisk: 'Moderate: building or rebuilding an index can add load to the collection and may briefly take metadata locks at the start/end of the operation.',
    impact: 'Changes the index definition used by queries and writes.',
    commands: [
      dropIndexCommand(collectionName, indexName),
      createIndexCommand(collectionName, desiredIndex.key, expectedCreateOptions(expectedIndex)),
    ],
  };

  if (
    collectionName === 'briefingsessions'
    && indexName === 'expiresAt_1'
    && desiredIndex.expireAfterSeconds === 0
  ) {
    return {
      ...basePlan,
      canIgnore: false,
      requiresDropRecreate: false,
      dropRecreateDetail: 'Use collMod on MongoDB 5.1+ to add or change expireAfterSeconds without rebuilding the index. On older versions, use manual drop/recreate in a maintenance window.',
      blockingRisk: 'Low for collMod itself because it does not rebuild the index. Operational risk comes from TTL deletes: lowering the TTL can make existing expired documents eligible for deletion immediately.',
      impact: 'Turns the existing expiresAt index into an absolute TTL index; sessions whose expiresAt date is in the past become eligible for TTL deletion.',
      commands: [
        `db.runCommand(${mongoLiteral({ collMod: collectionName, index: { keyPattern: desiredIndex.key, expireAfterSeconds: desiredIndex.expireAfterSeconds } })})`,
      ],
      fallbackCommands: [
        dropIndexCommand(collectionName, indexName),
        createIndexCommand(collectionName, desiredIndex.key, expectedCreateOptions(expectedIndex)),
      ],
    };
  }

  if (collectionName === 'projects' && indexName === 'briefingSessionId_1') {
    return {
      ...basePlan,
      canIgnore: true,
      requiresDropRecreate: true,
      dropRecreateDetail: 'MongoDB cannot change sparse on an existing normal index in place; changing it requires manual drop/recreate.',
      blockingRisk: 'Moderate if recreated. There is no correctness gap for this non-unique lookup index, but queries on briefingSessionId can be slower while the canonical index is absent.',
      impact: 'Sparse only reduces index entries for documents without briefingSessionId. Because the index is not unique, sparse is not required for functional correctness.',
    };
  }

  if (collectionName === 'users' && STRIPE_UNIQUE_PARTIAL_INDEX_FIELDS.has(fieldName)) {
    const temporaryName = `${indexName}_unique_partial_tmp`;
    const temporaryOptions = {
      name: temporaryName,
      unique: true,
      partialFilterExpression: desiredIndex.partialFilterExpression,
    };

    return {
      ...basePlan,
      canIgnore: false,
      requiresDropRecreate: true,
      dropRecreateDetail: 'Keeping the canonical name requires dropping the old index name, but the unique partial index can be built first with a temporary name so the collection is never left without an index on this field.',
      blockingRisk: 'Moderate: unique index creation scans indexed non-empty string values and can fail on duplicates; while building, writes continue but receive additional index-build load.',
      impact: 'Adds uniqueness only for non-empty string Stripe IDs. Missing, null, empty, and non-string values remain outside the partial unique constraint.',
      temporaryIndexName: temporaryName,
      commands: [
        createIndexCommand(collectionName, desiredIndex.key, temporaryOptions),
        `${collectionExpression(collectionName)}.getIndexes().filter((index) => index.name === ${mongoLiteral(temporaryName)})`,
        dropIndexCommand(collectionName, indexName),
        createIndexCommand(collectionName, desiredIndex.key, expectedCreateOptions(expectedIndex)),
        `${collectionExpression(collectionName)}.getIndexes().filter((index) => index.name === ${mongoLiteral(indexName)} || index.name === ${mongoLiteral(temporaryName)})`,
        dropIndexCommand(collectionName, temporaryName),
      ],
    };
  }

  return basePlan;
}

function formatIndexMigrationPlan(plan) {
  const lines = [
    `Migration plan for ${plan.collectionName}.${plan.indexName}:`,
    `Current index: ${JSON.stringify(plan.currentIndex)}`,
    `Desired index: ${JSON.stringify(plan.desiredIndex)}`,
    `Impact: ${plan.impact}`,
    `Drop/recreate needed: ${plan.requiresDropRecreate ? 'yes' : 'no'}. ${plan.dropRecreateDetail}`,
    `Blocking risk: ${plan.blockingRisk}`,
    `Can ignore: ${plan.canIgnore ? 'yes' : 'no'}`,
    'Commands to run manually; this script does not execute them:',
    ...plan.commands.map((command) => `  ${command}`),
  ];

  if (plan.fallbackCommands?.length) {
    lines.push('Fallback commands for MongoDB versions that do not support the preferred command:');
    lines.push(...plan.fallbackCommands.map((command) => `  ${command}`));
  }

  return lines;
}

async function findExistingIndexesByName(models, indexName) {
  const matches = [];

  for (const model of models) {
    const collectionName = getCollectionName(model);
    const existingIndexes = await listIndexes(model);
    const existingIndex = existingIndexes.find((index) => index.name === indexName);

    if (existingIndex) {
      matches.push({
        collectionName,
        index: comparableIndexSpec(existingIndex),
      });
    }
  }

  return matches;
}

function logExistingIndexMatches({ logger, indexName, matches }) {
  if (matches.length === 0) {
    logger.log(`Existing index named ${indexName}: not found in loaded model collections.`);
    return;
  }

  for (const match of matches) {
    logger.log(`Existing index named ${indexName} found on collection ${match.collectionName}:`);
    logger.log(JSON.stringify(match.index, null, 2));
  }
}

function logIndexComparison({ logger, collectionName, existingIndex, expectedIndex, comparison }) {
  if (existingIndex) {
    logger.log(`Existing index ${collectionName}.${expectedIndex.name}:`);
    logger.log(describeIndex(existingIndex));
  } else {
    logger.log(`Existing index ${collectionName}.${expectedIndex.name}: not found`);
  }

  logger.log(`Expected index ${collectionName}.${expectedIndex.name}:`);
  logger.log(JSON.stringify(expectedIndex.comparable, null, 2));

  if (!comparison) {
    return;
  }

  if (comparison.equivalent) {
    logger.log(`Index ${collectionName}.${expectedIndex.name} is functionally equivalent.`);
    return;
  }

  logger.log(`Index ${collectionName}.${expectedIndex.name} differs:`);
  logger.log(JSON.stringify(comparison.differences, null, 2));
}

async function ensureModelIndexes(model, {
  logger = console,
  dryRun = false,
  failOnIncompatible = !dryRun,
  filters = {},
} = {}) {
  const collectionName = getCollectionName(model);
  const existingIndexes = await listIndexes(model);
  const expectedIndexes = getExpectedIndexes(model).filter((expectedIndex) => matchesIndexFilters({
    collectionName,
    indexName: expectedIndex.name,
  }, filters));
  const results = [];

  for (const expectedIndex of expectedIndexes) {
    const existingIndex = existingIndexes.find((index) => index.name === expectedIndex.name);

    if (!existingIndex) {
      logIndexComparison({ logger, collectionName, expectedIndex });
      if (dryRun) {
        logger.log(`Would create index ${collectionName}.${expectedIndex.name}.`);
        results.push({ collectionName, expectedIndex, action: 'dry-run-create' });
        continue;
      }

      await model.collection.createIndex(expectedIndex.key, expectedIndex.options);
      const refreshedIndexes = await listIndexes(model);
      const createdIndex = refreshedIndexes.find((index) => index.name === expectedIndex.name);
      const comparison = createdIndex
        ? compareIndexSpecs(createdIndex, expectedIndex)
        : { equivalent: false, differences: [{ field: 'name', existing: undefined, expected: expectedIndex.name }] };

      if (!comparison.equivalent) {
        throw new Error(`Failed to create expected index ${collectionName}.${expectedIndex.name}.`);
      }

      logger.log(`Created index ${collectionName}.${expectedIndex.name}.`);
      results.push({ collectionName, expectedIndex, action: 'created' });
      continue;
    }

    const comparison = compareIndexSpecs(existingIndex, expectedIndex);
    logIndexComparison({ logger, collectionName, existingIndex, expectedIndex, comparison });

    if (!comparison.equivalent) {
      const migrationPlan = buildIndexMigrationPlan({
        collectionName,
        existingIndex,
        expectedIndex,
        differences: comparison.differences,
      });

      if (dryRun) {
        logger.log(`Would fail index ${collectionName}.${expectedIndex.name}: incompatible options; no index would be dropped or recreated.`);
        formatIndexMigrationPlan(migrationPlan).forEach((line) => logger.log(line));
        results.push({
          collectionName,
          expectedIndex,
          action: 'dry-run-incompatible',
          differences: comparison.differences,
          existingIndex: comparison.existing,
          migrationPlan,
        });
        continue;
      }

      if (!failOnIncompatible) {
        logger.log(`Skipping incompatible index ${collectionName}.${expectedIndex.name}; no index was dropped or recreated.`);
        formatIndexMigrationPlan(migrationPlan).forEach((line) => logger.log(line));
        results.push({
          collectionName,
          expectedIndex,
          action: 'incompatible',
          differences: comparison.differences,
          existingIndex: comparison.existing,
          migrationPlan,
        });
        continue;
      }

      const error = new Error(
        [
          `Index ${collectionName}.${expectedIndex.name} exists with incompatible options.`,
          'No index was dropped or recreated.',
          `Review and run: node scripts/migrateAdminIndex.js --collection ${collectionName} --index ${expectedIndex.name} --confirm`,
        ].join(' ')
      );
      error.code = 'INCOMPATIBLE_INDEX';
      error.collectionName = collectionName;
      error.indexName = expectedIndex.name;
      error.existing = comparison.existing;
      error.expected = comparison.expected;
      error.differences = comparison.differences;
      throw error;
    }

    results.push({ collectionName, expectedIndex, action: 'equivalent' });
  }

  return results;
}

async function ensureIndexes(models, options = {}) {
  const results = [];

  for (const model of models) {
    results.push(...await ensureModelIndexes(model, options));
  }

  return results;
}

async function validateDateFieldValues(model, fieldName, { sampleLimit = 5 } = {}) {
  const collectionName = getCollectionName(model);
  const pipeline = [
    {
      $project: {
        _id: 1,
        fieldType: { $type: `$${fieldName}` },
        value: `$${fieldName}`,
      },
    },
    {
      $match: {
        fieldType: { $ne: 'date' },
      },
    },
    {
      $limit: sampleLimit,
    },
  ];
  const invalidSamples = await model.collection.aggregate(pipeline).toArray();

  if (invalidSamples.length > 0) {
    const error = new Error(`${collectionName}.${fieldName} contains non-Date values.`);
    error.collectionName = collectionName;
    error.fieldName = fieldName;
    error.invalidSamples = invalidSamples;
    throw error;
  }

  return { collectionName, fieldName, valid: true };
}

function findExpectedIndex(models, collectionName, indexName) {
  for (const model of models) {
    const modelCollectionName = getCollectionName(model);

    if (modelCollectionName !== collectionName) {
      continue;
    }

    const expectedIndex = getExpectedIndexes(model).find((index) => index.name === indexName);

    if (expectedIndex) {
      return { model, collectionName: modelCollectionName, expectedIndex };
    }
  }

  return null;
}

async function migrateIndex(models, { collectionName, indexName, confirm = false, logger = console }) {
  const target = findExpectedIndex(models, collectionName, indexName);

  if (!target) {
    throw new Error(`No expected index named ${collectionName}.${indexName} was found in the loaded schemas.`);
  }

  const { model, expectedIndex } = target;
  const existingIndexes = await listIndexes(model);
  const existingIndex = existingIndexes.find((index) => index.name === indexName);

  if (!existingIndex) {
    logger.log(`Existing index ${collectionName}.${indexName}: not found`);

    if (!confirm) {
      logger.log('No changes made. Re-run with --confirm to create the missing index.');
      return { action: 'dry-run-missing', collectionName, indexName };
    }

    await model.collection.createIndex(expectedIndex.key, expectedIndex.options);
    const finalIndex = (await listIndexes(model)).find((index) => index.name === indexName);
    const finalComparison = finalIndex && compareIndexSpecs(finalIndex, expectedIndex);

    if (!finalComparison || !finalComparison.equivalent) {
      throw new Error(`Failed to create expected index ${collectionName}.${indexName}.`);
    }

    logger.log(`Created index ${collectionName}.${indexName}.`);
    return { action: 'created', collectionName, indexName };
  }

  const comparison = compareIndexSpecs(existingIndex, expectedIndex);
  logIndexComparison({ logger, collectionName, existingIndex, expectedIndex, comparison });

  if (comparison.equivalent) {
    logger.log(`No migration needed for ${collectionName}.${indexName}.`);
    return { action: 'already-equivalent', collectionName, indexName };
  }

  logger.log(`Migration target ${collectionName}.${indexName}:`);
  logger.log(`Old index:\n${JSON.stringify(comparison.existing, null, 2)}`);
  logger.log(`New index:\n${JSON.stringify(comparison.expected, null, 2)}`);

  if (!confirm) {
    logger.log('No changes made. Re-run with --confirm to drop and recreate only this index.');
    return { action: 'dry-run-incompatible', collectionName, indexName, differences: comparison.differences };
  }

  await model.collection.dropIndex(indexName);
  await model.collection.createIndex(expectedIndex.key, expectedIndex.options);

  const finalIndexes = await listIndexes(model);
  const finalIndex = finalIndexes.find((index) => index.name === indexName);
  const finalComparison = finalIndex && compareIndexSpecs(finalIndex, expectedIndex);

  if (!finalComparison || !finalComparison.equivalent) {
    throw new Error(`Migration verification failed for ${collectionName}.${indexName}.`);
  }

  logger.log(`Migrated and verified index ${collectionName}.${indexName}.`);
  return { action: 'migrated', collectionName, indexName };
}

module.exports = {
  COMPARED_OPTION_FIELDS,
  STRIPE_UNIQUE_PARTIAL_INDEX_FIELDS,
  buildIndexMigrationPlan,
  comparableIndexSpec,
  compareIndexSpecs,
  defaultIndexName,
  ensureIndexes,
  ensureModelIndexes,
  findExistingIndexesByName,
  findExpectedIndex,
  formatIndexMigrationPlan,
  getCollectionName,
  getExpectedIndexes,
  logExistingIndexMatches,
  matchesIndexFilters,
  migrateIndex,
  validateDateFieldValues,
};
