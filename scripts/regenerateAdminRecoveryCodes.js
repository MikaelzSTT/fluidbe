const dotenv = require('dotenv');
const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');
const AdminSession = require('../models/AdminSession');
const AdminUser = require('../models/AdminUser');
const {
  generateRecoveryCodes,
  hashAdminRecoveryCodes,
} = require('../utils/adminIdentity');

dotenv.config({ quiet: true });

const CONFIRMATION_TOKEN = 'REGENERATE_ADMIN_RECOVERY_CODES';
const DEFAULT_RECOVERY_CODE_COUNT = 10;
const AUDIT_ACTION = 'admin.recovery_codes.regenerate';
const AUDIT_RESOURCE_TYPE = 'admin_user';
const SCRIPT_USER_AGENT = 'scripts/regenerateAdminRecoveryCodes.js';

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

function usage(logger = console) {
  logger.error(
    [
      'Usage:',
      '  node scripts/regenerateAdminRecoveryCodes.js --email operator@example.com --confirm REGENERATE_ADMIN_RECOVERY_CODES',
      '',
      'This script regenerates recovery codes for an existing AdminUser only. It never modifies public User accounts and never creates AdminUser documents.',
    ].join('\n')
  );
}

function generateUniqueAdminRecoveryCodes(
  count = DEFAULT_RECOVERY_CODE_COUNT,
  generateCodes = generateRecoveryCodes
) {
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error('Recovery code count must be an integer between 1 and 50.');
  }

  const codes = new Set();
  let attempts = 0;

  while (codes.size < count) {
    attempts += 1;
    if (attempts > 100) {
      throw new Error('Unable to generate unique recovery codes.');
    }

    for (const code of generateCodes(count - codes.size)) {
      if (typeof code === 'string' && code.trim()) {
        codes.add(code);
      }
    }
  }

  return [...codes];
}

function buildOperationalAudit({
  adminUserId,
  now,
  requestId,
}) {
  return {
    adminUserId,
    actorType: 'admin_user',
    action: AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: String(adminUserId),
    result: 'success',
    statusCode: 0,
    requestId: requestId || `admin-recovery-codes-${now.getTime()}`,
    ip: 'local',
    userAgent: SCRIPT_USER_AGENT,
  };
}

async function regenerateAdminRecoveryCodes({
  email,
  now = new Date(),
  requestId,
  codeCount = DEFAULT_RECOVERY_CODE_COUNT,
  AdminUserModel = AdminUser,
  AdminSessionModel = AdminSession,
  AdminAuditLogModel = AdminAuditLog,
  generateCodes = generateUniqueAdminRecoveryCodes,
  hashRecoveryCodes = hashAdminRecoveryCodes,
} = {}) {
  const adminUser = await AdminUserModel.findOne({ email }).select('_id email');

  if (!adminUser) {
    throw new Error('AdminUser with this email does not exist.');
  }

  const recoveryCodes = generateCodes(codeCount);
  const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);

  const updateResult = await AdminUserModel.updateOne(
    { _id: adminUser._id },
    {
      $set: {
        'mfa.recoveryCodes': hashedRecoveryCodes,
      },
    }
  );

  const matchedCount = updateResult.matchedCount ?? updateResult.n ?? 0;
  if (matchedCount !== 1) {
    throw new Error('AdminUser recovery codes were not updated.');
  }

  const sessionResult = await AdminSessionModel.updateMany(
    {
      adminUserId: adminUser._id,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: now,
        revokedReason: 'recovery_codes_regenerated',
      },
    }
  );

  await AdminAuditLogModel.create(buildOperationalAudit({
    adminUserId: adminUser._id,
    now,
    requestId,
  }));

  return {
    adminUserId: adminUser._id,
    email: adminUser.email || email,
    recoveryCodes,
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
  AdminAuditLogModel = AdminAuditLog,
  generateCodes = generateUniqueAdminRecoveryCodes,
  hashRecoveryCodes = hashAdminRecoveryCodes,
} = {}) {
  const email = normalizeEmail(getArg('--email', argv));
  const confirm = String(getArg('--confirm', argv) || '').trim();

  if (confirm !== CONFIRMATION_TOKEN || !validateEmail(email)) {
    usage(logger);
    return 1;
  }

  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required.');
  }

  await mongooseClient.connect(env.MONGODB_URI);

  const result = await regenerateAdminRecoveryCodes({
    email,
    AdminUserModel,
    AdminSessionModel,
    AdminAuditLogModel,
    generateCodes,
    hashRecoveryCodes,
  });

  logger.log('AdminUser recovery codes regenerated.');
  logger.log(`id=${result.adminUserId}`);
  logger.log(`email=${result.email}`);
  logger.log(`adminSessionsRevoked=${result.sessionsRevoked}`);
  logger.log('recoveryCodes=');
  for (const recoveryCode of result.recoveryCodes) {
    logger.log(recoveryCode);
  }

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
  AUDIT_ACTION,
  CONFIRMATION_TOKEN,
  DEFAULT_RECOVERY_CODE_COUNT,
  buildOperationalAudit,
  generateUniqueAdminRecoveryCodes,
  getArg,
  main,
  normalizeEmail,
  regenerateAdminRecoveryCodes,
  usage,
  validateEmail,
};
