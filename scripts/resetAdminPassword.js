const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const AdminUser = require('../models/AdminUser');
const AdminSession = require('../models/AdminSession');

dotenv.config({ quiet: true });

const CONFIRMATION_TOKEN = 'RESET_ADMIN_PASSWORD';
const ADMIN_PASSWORD_BCRYPT_ROUNDS = 12;

function getArg(name, argv = process.argv.slice(2)) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));

  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(email) {
  return Boolean(
    email
    && email.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function validateStrongPassword(password, email = '') {
  const failures = [];
  const value = typeof password === 'string' ? password : '';

  if (value.length < 14) failures.push('at least 14 characters');
  if (Buffer.byteLength(value, 'utf8') > 72) failures.push('at most 72 UTF-8 bytes');
  if (!/[a-z]/.test(value)) failures.push('a lowercase letter');
  if (!/[A-Z]/.test(value)) failures.push('an uppercase letter');
  if (!/[0-9]/.test(value)) failures.push('a digit');
  if (!/[^A-Za-z0-9\s]/.test(value)) failures.push('a symbol');
  if (/\s/.test(value)) failures.push('no whitespace');

  const normalizedEmail = normalizeEmail(email);
  const localPart = normalizedEmail.split('@')[0];
  if (localPart && localPart.length >= 4 && value.toLowerCase().includes(localPart)) {
    failures.push('must not contain the email local part');
  }

  return {
    valid: failures.length === 0,
    failures,
  };
}

function usage(logger = console) {
  logger.error(
    [
      'Usage:',
      '  ADMIN_RESET_PASSWORD="long random password" node scripts/resetAdminPassword.js --email operator@example.com --confirm RESET_ADMIN_PASSWORD',
      '',
      'This script resets an existing AdminUser password only. It never modifies public User accounts and never creates AdminUser documents.',
    ].join('\n')
  );
}

async function resetAdminPassword({
  email,
  password,
  now = new Date(),
  AdminUserModel = AdminUser,
  AdminSessionModel = AdminSession,
  bcryptLib = bcrypt,
}) {
  const adminUser = await AdminUserModel.findOne({ email }).select('_id email');

  if (!adminUser) {
    throw new Error('AdminUser with this email does not exist.');
  }

  const passwordHash = await bcryptLib.hash(password, ADMIN_PASSWORD_BCRYPT_ROUNDS);

  const updateResult = await AdminUserModel.updateOne(
    { _id: adminUser._id },
    {
      $set: {
        passwordHash,
        passwordChangedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }
  );

  const matchedCount = updateResult.matchedCount ?? updateResult.n ?? 0;
  if (matchedCount !== 1) {
    throw new Error('AdminUser password was not updated.');
  }

  const sessionResult = await AdminSessionModel.updateMany(
    {
      adminUserId: adminUser._id,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: now,
        revokedReason: 'password_reset',
      },
    }
  );

  return {
    adminUserId: adminUser._id,
    email: adminUser.email || email,
    sessionsRevoked: sessionResult.modifiedCount ?? sessionResult.nModified ?? 0,
  };
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  logger = console,
  mongooseClient = mongoose,
  AdminUserModel = AdminUser,
  AdminSessionModel = AdminSession,
  bcryptLib = bcrypt,
} = {}) {
  const email = normalizeEmail(getArg('--email', argv));
  const confirm = String(getArg('--confirm', argv) || '').trim();
  const password = env.ADMIN_RESET_PASSWORD || '';
  const passwordValidation = validateStrongPassword(password, email);

  if (
    confirm !== CONFIRMATION_TOKEN
    || !validateEmail(email)
    || typeof password !== 'string'
    || !passwordValidation.valid
  ) {
    usage(logger);
    if (!passwordValidation.valid) {
      logger.error(`ADMIN_RESET_PASSWORD must include: ${passwordValidation.failures.join(', ')}.`);
    }
    return 1;
  }

  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongooseClient.connect(env.MONGODB_URI);

  const result = await resetAdminPassword({
    email,
    password,
    AdminUserModel,
    AdminSessionModel,
    bcryptLib,
  });

  logger.log('AdminUser password reset.');
  logger.log(`id=${result.adminUserId}`);
  logger.log(`email=${result.email}`);
  logger.log(`adminSessionsRevoked=${result.sessionsRevoked}`);

  return 0;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  CONFIRMATION_TOKEN,
  getArg,
  main,
  normalizeEmail,
  resetAdminPassword,
  usage,
  validateEmail,
  validateStrongPassword,
};
