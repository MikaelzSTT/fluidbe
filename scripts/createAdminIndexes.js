const dotenv = require('dotenv');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const Session = require('../models/Session');
const User = require('../models/User');

dotenv.config();

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  await Promise.all([
    AdminAuditLog.createIndexes(),
    Session.createIndexes(),
    User.createIndexes(),
  ]);

  console.log('Admin, session, and user indexes created or already present.');
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
