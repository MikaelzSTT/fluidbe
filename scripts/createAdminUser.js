const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const AdminUser = require('../models/AdminUser');
const {
  encryptAdminTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getAdminTotpAuthUrl,
  hashAdminRecoveryCodes,
} = require('../utils/adminIdentity');

dotenv.config();

const { ADMIN_PERMISSIONS } = AdminUser;

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
      '  ADMIN_BOOTSTRAP_PASSWORD="long random password" node scripts/createAdminUser.js --email operator@example.com --confirm CREATE_ADMIN_USER',
      '',
      'Optional:',
      '  --permissions admin:read,admin:write,admin:build,admin:users,admin:secrets',
      '',
      'This script creates a separate AdminUser. It never promotes or reuses public User accounts.',
    ].join('\n')
  );
}

function parsePermissions(value) {
  if (!value) {
    return [...ADMIN_PERMISSIONS];
  }

  const allowed = new Set(ADMIN_PERMISSIONS);
  const permissions = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (permissions.length === 0 || permissions.some((permission) => !allowed.has(permission))) {
    return null;
  }

  return [...new Set(permissions)];
}

async function main() {
  const email = String(getArg('--email') || '').trim().toLowerCase();
  const confirm = String(getArg('--confirm') || '').trim();
  const permissions = parsePermissions(getArg('--permissions'));
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || '';

  if (
    confirm !== 'CREATE_ADMIN_USER' ||
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !permissions ||
    typeof password !== 'string' ||
    password.length < 14 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  if (!process.env.ADMIN_TWO_FACTOR_SECRET_KEY) {
    throw new Error('ADMIN_TWO_FACTOR_SECRET_KEY is required.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const existingAdmin = await AdminUser.findOne({ email });

  if (existingAdmin) {
    throw new Error('AdminUser with this email already exists.');
  }

  const totpSecret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes(10);
  const now = new Date();
  const adminUser = await AdminUser.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    active: true,
    permissions,
    passwordChangedAt: now,
    mfa: {
      enabled: true,
      secretEnc: encryptAdminTotpSecret(totpSecret),
      enabledAt: now,
      recoveryCodes: await hashAdminRecoveryCodes(recoveryCodes),
    },
  });

  console.log('AdminUser created.');
  console.log(`id=${adminUser._id}`);
  console.log(`email=${email}`);
  console.log(`otpauthUrl=${getAdminTotpAuthUrl(email, totpSecret)}`);
  console.log(`totpSecret=${totpSecret}`);
  console.log('recoveryCodes=');
  for (const recoveryCode of recoveryCodes) {
    console.log(recoveryCode);
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
