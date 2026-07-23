const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ quiet: true });

const COLLECTION_NAME = 'briefingsessions';
const INDEX_NAME = 'expiresAt_1';
const CONFIRMATION_TOKEN = 'BRIEFING_TTL';
const TARGET_EXPIRE_AFTER_SECONDS = 0;
const MIN_MONGO_VERSION = [5, 1, 0];

function readInlineOption(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  return undefined;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    confirmApply: readInlineOption(argv, '--confirm-apply') || '',
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/migrateBriefingSessionTtl.js',
      `  node scripts/migrateBriefingSessionTtl.js --apply --confirm-apply=${CONFIRMATION_TOKEN}`,
      '',
      'Default mode is dry-run and read-only.',
      'Apply mode only runs collMod for briefingsessions.expiresAt_1 and never drops or recreates indexes.',
    ].join('\n')
  );
}

function parseMongoVersion(version) {
  return String(version || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isMongoVersionAtLeast(version, minimum = MIN_MONGO_VERSION) {
  const current = parseMongoVersion(version);

  for (let index = 0; index < minimum.length; index += 1) {
    const currentPart = current[index] || 0;
    const minimumPart = minimum[index] || 0;

    if (currentPart > minimumPart) {
      return true;
    }

    if (currentPart < minimumPart) {
      return false;
    }
  }

  return true;
}

async function getMongoVersion(db) {
  const buildInfo = await db.admin().command({ buildInfo: 1 });
  return String(buildInfo.version || '');
}

function sanitizeIndexConfig(index) {
  if (!index) {
    return null;
  }

  return {
    name: index.name,
    key: index.key,
    expireAfterSeconds: index.expireAfterSeconds ?? null,
  };
}

async function getBriefingSessionTtlIndex(collection) {
  const indexes = await collection.listIndexes().toArray();
  return indexes.find((index) => index.name === INDEX_NAME) || null;
}

function hasTargetTtl(index) {
  return index
    && index.expireAfterSeconds !== null
    && index.expireAfterSeconds !== undefined
    && Number(index.expireAfterSeconds) === TARGET_EXPIRE_AFTER_SECONDS;
}

async function getBriefingSessionStats(collection, now = new Date()) {
  const [stats = {}] = await collection.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        expiresAtInPast: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: '$expiresAt' }, 'date'] },
                  { $lt: ['$expiresAt', now] },
                ],
              },
              1,
              0,
            ],
          },
        },
        expiresAtMissing: {
          $sum: {
            $cond: [{ $eq: [{ $type: '$expiresAt' }, 'missing'] }, 1, 0],
          },
        },
        expiresAtInvalidOrWrongType: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $type: '$expiresAt' }, 'date'] },
                  { $ne: [{ $type: '$expiresAt' }, 'missing'] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        expiresAtInPast: 1,
        expiresAtMissing: 1,
        expiresAtInvalidOrWrongType: 1,
      },
    },
  ]).toArray();

  return {
    total: Number(stats.total || 0),
    expiresAtInPast: Number(stats.expiresAtInPast || 0),
    expiresAtMissing: Number(stats.expiresAtMissing || 0),
    expiresAtInvalidOrWrongType: Number(stats.expiresAtInvalidOrWrongType || 0),
  };
}

function getAction(index) {
  if (!index) {
    return `abort: ${COLLECTION_NAME}.${INDEX_NAME} was not found; collMod cannot create indexes`;
  }

  if (hasTargetTtl(index)) {
    return `${COLLECTION_NAME}.${INDEX_NAME} is already configured with expireAfterSeconds=0`;
  }

  return `would run collMod on ${COLLECTION_NAME}.${INDEX_NAME} setting expireAfterSeconds=0`;
}

function logReport(logger, { mongoVersion, index, stats, action }) {
  logger.log(`MongoDB version: ${mongoVersion}`);
  logger.log(`Current ${COLLECTION_NAME}.${INDEX_NAME}: ${JSON.stringify(sanitizeIndexConfig(index))}`);
  logger.log(`Total briefing sessions: ${stats.total}`);
  logger.log(`Briefing sessions with expiresAt in the past: ${stats.expiresAtInPast}`);
  logger.log(`Briefing sessions with expiresAt missing: ${stats.expiresAtMissing}`);
  logger.log(`Briefing sessions with invalid/non-Date expiresAt: ${stats.expiresAtInvalidOrWrongType}`);
  logger.log(`Action: ${action}`);
}

async function verifyTtlIndex(collection) {
  const index = await getBriefingSessionTtlIndex(collection);

  if (!hasTargetTtl(index)) {
    throw new Error(`${COLLECTION_NAME}.${INDEX_NAME} verification failed: expireAfterSeconds is not 0.`);
  }

  return index;
}

async function run({
  apply = false,
  confirmApply = '',
  db,
  logger = console,
  now = new Date(),
} = {}) {
  if (!db) {
    throw new Error('A MongoDB database handle is required.');
  }

  if (apply && confirmApply !== CONFIRMATION_TOKEN) {
    throw new Error(`Apply requires exactly --apply --confirm-apply=${CONFIRMATION_TOKEN}.`);
  }

  const collection = db.collection(COLLECTION_NAME);
  const [mongoVersion, index, stats] = await Promise.all([
    getMongoVersion(db),
    getBriefingSessionTtlIndex(collection),
    getBriefingSessionStats(collection, now),
  ]);
  const action = getAction(index);

  logReport(logger, { mongoVersion, index, stats, action });

  if (!apply) {
    return {
      applied: false,
      alreadyConfigured: hasTargetTtl(index),
      mongoVersion,
      index: sanitizeIndexConfig(index),
      stats,
      action,
    };
  }

  if (stats.expiresAtInvalidOrWrongType > 0) {
    throw new Error(`${COLLECTION_NAME}.expiresAt contains invalid or non-Date values. Aborting before collMod.`);
  }

  if (hasTargetTtl(index)) {
    logger.log(`${COLLECTION_NAME}.${INDEX_NAME} was already configured with expireAfterSeconds=0. No changes made.`);
    return {
      applied: false,
      alreadyConfigured: true,
      mongoVersion,
      index: sanitizeIndexConfig(index),
      stats,
      action,
    };
  }

  if (!index) {
    throw new Error(`${COLLECTION_NAME}.${INDEX_NAME} was not found. collMod cannot create indexes.`);
  }

  if (!isMongoVersionAtLeast(mongoVersion)) {
    throw new Error(`MongoDB ${mongoVersion} is incompatible. collMod TTL changes require MongoDB >= 5.1.`);
  }

  await db.command({
    collMod: COLLECTION_NAME,
    index: {
      keyPattern: { expiresAt: 1 },
      expireAfterSeconds: TARGET_EXPIRE_AFTER_SECONDS,
    },
  });

  const verifiedIndex = await verifyTtlIndex(collection);
  logger.log(`${COLLECTION_NAME}.${INDEX_NAME} updated and verified with expireAfterSeconds=0.`);

  return {
    applied: true,
    alreadyConfigured: false,
    mongoVersion,
    index: sanitizeIndexConfig(verifiedIndex),
    stats,
    action,
  };
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    usage();
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  await run({
    apply: args.apply,
    confirmApply: args.confirmApply,
    db: mongoose.connection.db,
  });
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
  COLLECTION_NAME,
  CONFIRMATION_TOKEN,
  INDEX_NAME,
  TARGET_EXPIRE_AFTER_SECONDS,
  getBriefingSessionStats,
  isMongoVersionAtLeast,
  parseArgs,
  run,
  sanitizeIndexConfig,
};
