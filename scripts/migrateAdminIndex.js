const dotenv = require('dotenv');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const Session = require('../models/Session');
const User = require('../models/User');
const { migrateIndex, validateDateFieldValues } = require('../utils/adminIndexManager');

dotenv.config();

const ADMIN_INDEX_MODELS = [
  AdminAuditLog,
  Session,
  User,
];

function getArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function usage() {
  console.error(
    [
      'Usage:',
      '  node scripts/migrateAdminIndex.js --collection sessions --index expiresAt_1',
      '  node scripts/migrateAdminIndex.js --collection sessions --index expiresAt_1 --confirm',
      '',
      'Without --confirm this script only prints the current and expected index definitions.',
      'With --confirm it drops only the named index, recreates it from the schema, and verifies the result.',
    ].join('\n')
  );
}

async function main() {
  const collectionName = String(getArg('--collection') || '').trim();
  const indexName = String(getArg('--index') || '').trim();
  const confirm = process.argv.includes('--confirm');

  if (!collectionName || !indexName) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  if (collectionName === 'sessions' && indexName === 'expiresAt_1') {
    await validateDateFieldValues(Session, 'expiresAt');
    console.log('Verified sessions.expiresAt contains Date values in all existing documents.');
  }

  await migrateIndex(ADMIN_INDEX_MODELS, {
    collectionName,
    indexName,
    confirm,
  });
}

main()
  .catch((error) => {
    console.error(error.message);

    if (error.invalidSamples) {
      console.error(JSON.stringify(error.invalidSamples, null, 2));
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
