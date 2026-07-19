const dotenv = require('dotenv');
const mongoose = require('mongoose');
const User = require('../models/User');
const { ADMIN_PERMISSIONS } = require('../middleware/adminAuth');

dotenv.config();

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
      '  node scripts/promoteAdmin.js --email admin@example.com --confirm PROMOTE_ADMIN',
      '  node scripts/promoteAdmin.js --user-id 64f000000000000000000001 --confirm PROMOTE_ADMIN',
      '',
      'This script promotes one existing account. It never creates users or passwords.',
    ].join('\n')
  );
}

async function main() {
  const email = String(getArg('--email') || '').trim().toLowerCase();
  const userId = String(getArg('--user-id') || '').trim();
  const confirm = String(getArg('--confirm') || '').trim();

  if (confirm !== 'PROMOTE_ADMIN' || Boolean(email) === Boolean(userId)) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const query = email ? { email } : { _id: userId };
  const user = await User.findOne(query);

  if (!user || user.deletedAt) {
    throw new Error('Existing active user not found.');
  }

  user.role = 'admin';
  user.admin = {
    ...(user.admin?.toObject ? user.admin.toObject() : user.admin || {}),
    permissions: ADMIN_PERMISSIONS,
    grantedAt: user.admin?.grantedAt || new Date(),
    updatedAt: new Date(),
    revokedAt: undefined,
    revokedBy: undefined,
  };

  await user.save();

  console.log(`Promoted existing user ${user._id} to admin. Require MFA before using /api/admin.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
