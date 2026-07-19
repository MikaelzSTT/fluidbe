const dotenv = require('dotenv');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const Session = require('../models/Session');
const User = require('../models/User');
const {
  ensureIndexes,
  findExistingIndexesByName,
  logExistingIndexMatches,
  validateDateFieldValues,
} = require('../utils/adminIndexManager');

dotenv.config();

const TARGET_INDEX_NAME = 'expiresAt_1';

const ADMIN_INDEX_MODELS = [
  AdminAuditLog,
  Session,
  User,
];

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const existingTargetIndexes = await findExistingIndexesByName(ADMIN_INDEX_MODELS, TARGET_INDEX_NAME);
  logExistingIndexMatches({
    logger: console,
    indexName: TARGET_INDEX_NAME,
    matches: existingTargetIndexes,
  });

  await validateDateFieldValues(Session, 'expiresAt');
  console.log('Verified sessions.expiresAt contains Date values in all existing documents.');

  await ensureIndexes(ADMIN_INDEX_MODELS);

  console.log('Admin, session, and user indexes are created or already functionally equivalent.');
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
