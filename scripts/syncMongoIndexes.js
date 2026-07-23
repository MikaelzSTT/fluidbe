const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { MONGO_INDEX_MODELS } = require('../utils/mongoIndexModels');
const {
  ensureIndexes,
} = require('../utils/adminIndexManager');
const {
  assertMongoIndexReadiness,
  formatReadinessReport,
  validateMongoIndexReadiness,
} = require('../utils/mongoIndexReadiness');

dotenv.config();

function readOption(argv, names) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    for (const name of names) {
      if (arg === name) {
        return argv[index + 1];
      }

      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }

  return undefined;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    help: argv.includes('--help') || argv.includes('-h'),
    collectionName: readOption(argv, ['--collection', '--collection-name']),
    indexName: readOption(argv, ['--index', '--index-name', '--name']),
  };
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/syncMongoIndexes.js',
      '  node scripts/syncMongoIndexes.js --apply',
      '  node scripts/syncMongoIndexes.js --collection users --index stripeCustomerId_1',
      '',
      'Default mode is dry-run: it lists missing or incompatible indexes and makes no changes.',
      '--apply creates only missing schema indexes and verifies them.',
      '--collection limits work to one collection name.',
      '--index limits work to one expected index name.',
      'This script never drops, renames, or recreates existing indexes.',
    ].join('\n')
  );
}

function summarize(results) {
  return results.reduce((summary, result) => {
    summary[result.action] = (summary[result.action] || 0) + 1;
    return summary;
  }, {});
}

function countUnresolvedIncompatibilities(results) {
  return results.filter((result) => (
    result.action === 'dry-run-incompatible'
    || result.action === 'incompatible'
  )).length;
}

async function run({
  apply = false,
  logger = console,
  collectionName,
  indexName,
} = {}) {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const readiness = await validateMongoIndexReadiness();
  formatReadinessReport(readiness).forEach((line) => logger.log(line));
  assertMongoIndexReadiness(readiness);

  const results = await ensureIndexes(MONGO_INDEX_MODELS, {
    logger,
    dryRun: !apply,
    failOnIncompatible: false,
    filters: {
      collectionName,
      indexName,
    },
  });
  const summary = summarize(results);
  const unresolvedIncompatibleCount = countUnresolvedIncompatibilities(results);

  logger.log(`Mongo index sync ${apply ? 'apply' : 'dry-run'} summary: ${JSON.stringify(summary)}`);
  if (!apply) {
    logger.log('No changes made. Re-run with --apply in a controlled maintenance window to create missing indexes.');
  }

  if (unresolvedIncompatibleCount > 0) {
    logger.log(`Unresolved incompatible indexes: ${unresolvedIncompatibleCount}. Resolve them manually using the migration plans above.`);
  }

  return { readiness, results, summary, unresolvedIncompatibleCount };
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    usage();
    return;
  }

  const result = await run(args);

  if (result.unresolvedIncompatibleCount > 0) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  countUnresolvedIncompatibilities,
  parseArgs,
  run,
  summarize,
};
