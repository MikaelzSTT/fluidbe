const COMPARED_OPTION_FIELDS = [
  'unique',
  'sparse',
  'partialFilterExpression',
  'expireAfterSeconds',
];

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

async function ensureModelIndexes(model, { logger = console } = {}) {
  const collectionName = getCollectionName(model);
  const existingIndexes = await listIndexes(model);
  const expectedIndexes = getExpectedIndexes(model);
  const results = [];

  for (const expectedIndex of expectedIndexes) {
    const existingIndex = existingIndexes.find((index) => index.name === expectedIndex.name);

    if (!existingIndex) {
      logIndexComparison({ logger, collectionName, expectedIndex });
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
  comparableIndexSpec,
  compareIndexSpecs,
  defaultIndexName,
  ensureIndexes,
  ensureModelIndexes,
  findExistingIndexesByName,
  findExpectedIndex,
  getCollectionName,
  getExpectedIndexes,
  logExistingIndexMatches,
  migrateIndex,
  validateDateFieldValues,
};
