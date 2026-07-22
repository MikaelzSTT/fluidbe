const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  AUDIT_ACTION,
  CONFIRMATION_TOKEN,
  DEFAULT_RECOVERY_CODE_COUNT,
  generateUniqueAdminRecoveryCodes,
  main,
  regenerateAdminRecoveryCodes,
  validateEmail,
} = require('../scripts/regenerateAdminRecoveryCodes');

const ADMIN_USER_ID = '64f000000000000000000011';
const NEW_CODES = [
  'AAAA-BBBB-0001',
  'AAAA-BBBB-0002',
  'AAAA-BBBB-0003',
  'AAAA-BBBB-0004',
  'AAAA-BBBB-0005',
  'AAAA-BBBB-0006',
  'AAAA-BBBB-0007',
  'AAAA-BBBB-0008',
  'AAAA-BBBB-0009',
  'AAAA-BBBB-0010',
];

function selectable(document) {
  return {
    select: async () => document,
  };
}

function createLogger() {
  return {
    lines: [],
    log(message) {
      this.lines.push(String(message));
    },
    error(message) {
      this.lines.push(String(message));
    },
  };
}

function createFakes(now, codes = NEW_CODES) {
  const state = {
    createCalls: 0,
    findOneQueries: [],
    adminUpdates: [],
    sessionUpdates: [],
    audits: [],
  };

  const AdminUserModel = {
    findOne(query) {
      state.findOneQueries.push(query);
      return selectable({
        _id: ADMIN_USER_ID,
        email: 'operator@example.com',
      });
    },
    create() {
      state.createCalls += 1;
      throw new Error('AdminUser.create must not be called');
    },
    async updateOne(query, update) {
      state.adminUpdates.push({ query, update });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  const AdminSessionModel = {
    async updateMany(query, update) {
      state.sessionUpdates.push({ query, update });
      return { modifiedCount: 2 };
    },
  };

  const AdminAuditLogModel = {
    async create(payload) {
      state.audits.push(payload);
      return { _id: 'audit-id' };
    },
  };

  return {
    state,
    AdminUserModel,
    AdminSessionModel,
    AdminAuditLogModel,
    generateCodes() {
      return [...codes];
    },
    async hashRecoveryCodes(recoveryCodes) {
      return recoveryCodes.map((recoveryCode) => ({
        hash: `hash:${recoveryCode}`,
      }));
    },
    now,
  };
}

test('generateUniqueAdminRecoveryCodes returns unique admin recovery codes', () => {
  let calls = 0;
  const generated = generateUniqueAdminRecoveryCodes(3, (count) => {
    calls += 1;
    return calls === 1
      ? ['DUPL-ICAT-0001', 'DUPL-ICAT-0001', 'UNIQ-UE00-0002'].slice(0, count)
      : ['UNIQ-UE00-0003'].slice(0, count);
  });

  assert.deepEqual(generated, [
    'DUPL-ICAT-0001',
    'UNIQ-UE00-0002',
    'UNIQ-UE00-0003',
  ]);
});

test('regenerateAdminRecoveryCodes replaces old AdminUser recovery codes with hashes and revokes sessions', async () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const fakes = createFakes(now);

  const result = await regenerateAdminRecoveryCodes({
    email: 'operator@example.com',
    now,
    requestId: 'test-request-id',
    AdminUserModel: fakes.AdminUserModel,
    AdminSessionModel: fakes.AdminSessionModel,
    AdminAuditLogModel: fakes.AdminAuditLogModel,
    generateCodes: fakes.generateCodes,
    hashRecoveryCodes: fakes.hashRecoveryCodes,
  });

  assert.deepEqual(fakes.state.findOneQueries, [{ email: 'operator@example.com' }]);
  assert.equal(fakes.state.createCalls, 0);
  assert.equal(fakes.state.adminUpdates.length, 1);
  assert.deepEqual(fakes.state.adminUpdates[0], {
    query: { _id: ADMIN_USER_ID },
    update: {
      $set: {
        'mfa.recoveryCodes': NEW_CODES.map((code) => ({ hash: `hash:${code}` })),
      },
    },
  });
  assert.equal(
    JSON.stringify(fakes.state.adminUpdates[0].update).includes('old-recovery-code'),
    false
  );

  assert.deepEqual(fakes.state.sessionUpdates, [
    {
      query: {
        adminUserId: ADMIN_USER_ID,
        revokedAt: null,
      },
      update: {
        $set: {
          revokedAt: now,
          revokedReason: 'recovery_codes_regenerated',
        },
      },
    },
  ]);

  assert.deepEqual(result, {
    adminUserId: ADMIN_USER_ID,
    email: 'operator@example.com',
    recoveryCodes: NEW_CODES,
    sessionsRevoked: 2,
  });
});

test('regenerateAdminRecoveryCodes writes operational audit without secrets', async () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const fakes = createFakes(now);

  await regenerateAdminRecoveryCodes({
    email: 'operator@example.com',
    now,
    requestId: 'test-request-id',
    AdminUserModel: fakes.AdminUserModel,
    AdminSessionModel: fakes.AdminSessionModel,
    AdminAuditLogModel: fakes.AdminAuditLogModel,
    generateCodes: fakes.generateCodes,
    hashRecoveryCodes: fakes.hashRecoveryCodes,
  });

  assert.equal(fakes.state.audits.length, 1);
  assert.deepEqual(fakes.state.audits[0], {
    adminUserId: ADMIN_USER_ID,
    actorType: 'admin_user',
    action: AUDIT_ACTION,
    resourceType: 'admin_user',
    resourceId: ADMIN_USER_ID,
    result: 'success',
    statusCode: 0,
    requestId: 'test-request-id',
    ip: 'local',
    userAgent: 'scripts/regenerateAdminRecoveryCodes.js',
  });

  const auditJson = JSON.stringify(fakes.state.audits);
  for (const code of NEW_CODES) {
    assert.equal(auditJson.includes(code), false);
    assert.equal(auditJson.includes(`hash:${code}`), false);
  }
  assert.equal(auditJson.includes('totpSecret'), false);
  assert.equal(auditJson.includes('password'), false);
  assert.equal(auditJson.includes('token'), false);
});

test('regenerateAdminRecoveryCodes rejects missing AdminUser without creating one or changing sessions', async () => {
  let createCalled = false;
  let updateOneCalled = false;
  let updateManyCalled = false;
  let auditCalled = false;

  const AdminUserModel = {
    findOne() {
      return selectable(null);
    },
    create() {
      createCalled = true;
    },
    updateOne() {
      updateOneCalled = true;
    },
  };

  const AdminSessionModel = {
    updateMany() {
      updateManyCalled = true;
    },
  };

  const AdminAuditLogModel = {
    create() {
      auditCalled = true;
    },
  };

  await assert.rejects(
    regenerateAdminRecoveryCodes({
      email: 'operator@example.com',
      AdminUserModel,
      AdminSessionModel,
      AdminAuditLogModel,
    }),
    /AdminUser with this email does not exist/
  );

  assert.equal(createCalled, false);
  assert.equal(updateOneCalled, false);
  assert.equal(updateManyCalled, false);
  assert.equal(auditCalled, false);
});

test('main requires explicit confirmation before connecting', async () => {
  const logger = createLogger();
  let connectCalled = false;

  const exitCode = await main({
    argv: ['--email', 'operator@example.com', '--confirm', 'WRONG'],
    env: {
      MONGODB_URI: 'mongodb://127.0.0.1:27017/fluidbe-test',
    },
    logger,
    mongooseClient: {
      async connect() {
        connectCalled = true;
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(connectCalled, false);
  assert.ok(logger.lines.join('\n').includes(CONFIRMATION_TOKEN));
});

test('main prints new recovery codes exactly once and never logs other secrets', async () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const fakes = createFakes(now);
  const logger = createLogger();
  let connectUri = null;

  const exitCode = await main({
    argv: [
      '--email',
      'OPERATOR@example.com',
      '--confirm',
      CONFIRMATION_TOKEN,
      '--token',
      'secret-token',
      '--password',
      'secret-password',
      '--totpSecret',
      'secret-totp',
    ],
    env: {
      MONGODB_URI: 'mongodb://127.0.0.1:27017/fluidbe-test',
    },
    logger,
    mongooseClient: {
      async connect(uri) {
        connectUri = uri;
      },
    },
    AdminUserModel: fakes.AdminUserModel,
    AdminSessionModel: fakes.AdminSessionModel,
    AdminAuditLogModel: fakes.AdminAuditLogModel,
    generateCodes: fakes.generateCodes,
    hashRecoveryCodes: fakes.hashRecoveryCodes,
  });

  assert.equal(exitCode, 0);
  assert.equal(connectUri, 'mongodb://127.0.0.1:27017/fluidbe-test');
  for (const code of NEW_CODES) {
    assert.equal(logger.lines.filter((line) => line === code).length, 1);
  }

  const output = logger.lines.join('\n');
  assert.equal(output.includes('secret-token'), false);
  assert.equal(output.includes('secret-password'), false);
  assert.equal(output.includes('secret-totp'), false);
  assert.equal(output.includes('hash:'), false);
});

test('regenerate admin recovery code script validates email and does not import public User model', () => {
  assert.equal(validateEmail('operator@example.com'), true);
  assert.equal(validateEmail('not-an-email'), false);
  assert.equal(DEFAULT_RECOVERY_CODE_COUNT, 10);

  const scriptPath = path.join(__dirname, '..', 'scripts', 'regenerateAdminRecoveryCodes.js');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.equal(source.includes("require('../models/User')"), false);
  assert.equal(source.includes('require("../models/User")'), false);
});
