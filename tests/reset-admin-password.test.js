const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const test = require('node:test');

const {
  ADMIN_PASSWORD_BCRYPT_ROUNDS,
  CONFIRMATION_TOKEN,
  main,
  resetAdminPassword,
  validateEmail,
  validateStrongPassword,
} = require('../scripts/resetAdminPassword');

const ADMIN_USER_ID = '64f000000000000000000011';

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

test('validateStrongPassword requires an admin-grade password', () => {
  assert.equal(validateEmail('operator@example.com'), true);
  assert.equal(validateEmail('not-an-email'), false);

  const weak = validateStrongPassword('short-pass', 'operator@example.com');
  assert.equal(weak.valid, false);
  assert.ok(weak.failures.includes('at least 14 characters'));
  assert.ok(weak.failures.includes('an uppercase letter'));
  assert.ok(weak.failures.includes('a digit'));

  const strong = validateStrongPassword('Reset!Password2026', 'operator@example.com');
  assert.equal(strong.valid, true);
  assert.deepEqual(strong.failures, []);

  const containsEmail = validateStrongPassword('Operator!Password2026', 'operator@example.com');
  assert.equal(containsEmail.valid, false);
  assert.ok(containsEmail.failures.includes('must not contain the email local part'));
});

test('resetAdminPassword updates only an existing AdminUser and revokes active AdminSessions', async () => {
  const now = new Date('2026-07-20T12:00:00.000Z');
  const state = {
    createCalls: 0,
    findOneQueries: [],
    adminUpdates: [],
    sessionUpdates: [],
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
      return { modifiedCount: 3 };
    },
  };

  const result = await resetAdminPassword({
    email: 'operator@example.com',
    password: 'Reset!Password2026',
    now,
    AdminUserModel,
    AdminSessionModel,
  });

  assert.deepEqual(state.findOneQueries, [{ email: 'operator@example.com' }]);
  assert.equal(state.createCalls, 0);
  assert.equal(state.adminUpdates.length, 1);
  assert.deepEqual(state.adminUpdates[0].query, { _id: ADMIN_USER_ID });
  assert.equal(state.adminUpdates[0].update.$set.passwordChangedAt, now);
  assert.equal(state.adminUpdates[0].update.$set.failedLoginCount, 0);
  assert.equal(state.adminUpdates[0].update.$set.lockedUntil, null);
  assert.notEqual(state.adminUpdates[0].update.$set.passwordHash, 'Reset!Password2026');
  assert.equal(
    await bcrypt.compare('Reset!Password2026', state.adminUpdates[0].update.$set.passwordHash),
    true
  );

  assert.deepEqual(state.sessionUpdates, [
    {
      query: {
        adminUserId: ADMIN_USER_ID,
        revokedAt: null,
      },
      update: {
        $set: {
          revokedAt: now,
          revokedReason: 'password_reset',
        },
      },
    },
  ]);
  assert.deepEqual(result, {
    adminUserId: ADMIN_USER_ID,
    email: 'operator@example.com',
    sessionsRevoked: 3,
  });
});

test('resetAdminPassword rejects missing AdminUser without creating one or revoking sessions', async () => {
  let createCalled = false;
  let updateOneCalled = false;
  let updateManyCalled = false;

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

  await assert.rejects(
    resetAdminPassword({
      email: 'operator@example.com',
      password: 'Reset!Password2026',
      AdminUserModel,
      AdminSessionModel,
    }),
    /AdminUser with this email does not exist/
  );

  assert.equal(createCalled, false);
  assert.equal(updateOneCalled, false);
  assert.equal(updateManyCalled, false);
});

test('main reads password only from ADMIN_RESET_PASSWORD and never logs it', async () => {
  const logger = createLogger();
  const secretPassword = 'Reset!Password2026';
  let connectUri = null;
  let hashRounds = null;

  const AdminUserModel = {
    findOne() {
      return selectable({
        _id: ADMIN_USER_ID,
        email: 'operator@example.com',
      });
    },
    async updateOne(query, update) {
      assert.equal(query._id, ADMIN_USER_ID);
      assert.notEqual(update.$set.passwordHash, secretPassword);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  const AdminSessionModel = {
    async updateMany() {
      return { modifiedCount: 1 };
    },
  };

  const bcryptLib = {
    async hash(password, rounds) {
      assert.equal(password, secretPassword);
      hashRounds = rounds;
      return 'hashed-admin-password';
    },
  };

  const exitCode = await main({
    argv: [
      '--email',
      'OPERATOR@example.com',
      '--confirm',
      CONFIRMATION_TOKEN,
      '--password',
      'Ignored!Password2026',
    ],
    env: {
      ADMIN_RESET_PASSWORD: secretPassword,
      MONGODB_URI: 'mongodb://127.0.0.1:27017/fluidbe-test',
    },
    logger,
    mongooseClient: {
      async connect(uri) {
        connectUri = uri;
      },
    },
    AdminUserModel,
    AdminSessionModel,
    bcryptLib,
  });

  assert.equal(exitCode, 0);
  assert.equal(connectUri, 'mongodb://127.0.0.1:27017/fluidbe-test');
  assert.equal(hashRounds, ADMIN_PASSWORD_BCRYPT_ROUNDS);
  assert.equal(logger.lines.some((line) => line.includes(secretPassword)), false);
  assert.equal(logger.lines.some((line) => line.includes('Ignored!Password2026')), false);
});

test('main refuses invalid confirmation before connecting', async () => {
  const logger = createLogger();
  let connectCalled = false;

  const exitCode = await main({
    argv: ['--email', 'operator@example.com', '--confirm', 'WRONG'],
    env: {
      ADMIN_RESET_PASSWORD: 'Reset!Password2026',
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
  assert.ok(logger.lines.join('\n').includes('RESET_ADMIN_PASSWORD'));
});

test('resetAdminPassword script does not import the public User model', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resetAdminPassword.js');
  const source = fs.readFileSync(scriptPath, 'utf8');

  assert.equal(source.includes("require('../models/User')"), false);
  assert.equal(source.includes('require("../models/User")'), false);
});
