const assert = require('assert/strict');
const test = require('node:test');
const {
  COLLECTION_NAME,
  CONFIRMATION_TOKEN,
  INDEX_NAME,
  parseArgs,
  run,
} = require('../scripts/migrateBriefingSessionTtl');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockDb({
  version = '6.0.12',
  indexes = [{ name: INDEX_NAME, key: { expiresAt: 1 } }],
  stats = {
    total: 10,
    expiresAtInPast: 3,
    expiresAtMissing: 1,
    expiresAtInvalidOrWrongType: 0,
  },
} = {}) {
  const state = {
    commands: [],
    adminCommands: [],
    indexes: clone(indexes),
    aggregateCalls: [],
  };
  const collection = {
    listIndexes: () => ({
      toArray: async () => clone(state.indexes),
    }),
    aggregate: (pipeline) => {
      state.aggregateCalls.push(clone(pipeline));
      return {
        toArray: async () => [clone(stats)],
      };
    },
  };
  const db = {
    admin: () => ({
      command: async (command) => {
        state.adminCommands.push(clone(command));
        return { version };
      },
    }),
    collection: (name) => {
      assert.equal(name, COLLECTION_NAME);
      return collection;
    },
    command: async (command) => {
      state.commands.push(clone(command));
      if (command.collMod === COLLECTION_NAME) {
        const index = state.indexes.find((candidate) => candidate.name === INDEX_NAME);
        if (index) {
          index.expireAfterSeconds = command.index.expireAfterSeconds;
        }
      }
      return { ok: 1 };
    },
  };

  return { db, state };
}

function createLogger() {
  const lines = [];
  return {
    logger: {
      log: (line) => lines.push(String(line)),
    },
    lines,
  };
}

test('briefing session TTL migration defaults to dry-run and requires explicit apply confirmation', () => {
  assert.deepEqual(parseArgs([]), {
    apply: false,
    confirmApply: '',
    help: false,
  });
  assert.deepEqual(parseArgs(['--apply', `--confirm-apply=${CONFIRMATION_TOKEN}`]), {
    apply: true,
    confirmApply: CONFIRMATION_TOKEN,
    help: false,
  });
  assert.deepEqual(parseArgs(['--apply', '--confirm-apply', CONFIRMATION_TOKEN]), {
    apply: true,
    confirmApply: '',
    help: false,
  });
});

test('briefing session TTL dry-run does not alter indexes', async () => {
  const { db, state } = createMockDb();
  const { logger, lines } = createLogger();

  const result = await run({ db, logger });

  assert.equal(result.applied, false);
  assert.equal(state.commands.length, 0);
  assert.equal(state.indexes[0].expireAfterSeconds, undefined);
  assert.deepEqual(state.adminCommands, [{ buildInfo: 1 }]);
  assert.equal(lines.length, 7);
  assert.deepEqual(lines, [
    'MongoDB version: 6.0.12',
    `Current ${COLLECTION_NAME}.${INDEX_NAME}: {"name":"expiresAt_1","key":{"expiresAt":1},"expireAfterSeconds":null}`,
    'Total briefing sessions: 10',
    'Briefing sessions with expiresAt in the past: 3',
    'Briefing sessions with expiresAt missing: 1',
    'Briefing sessions with invalid/non-Date expiresAt: 0',
    `Action: would run collMod on ${COLLECTION_NAME}.${INDEX_NAME} setting expireAfterSeconds=0`,
  ]);
});

test('briefing session TTL apply aborts on incompatible MongoDB version', async () => {
  const { db, state } = createMockDb({ version: '5.0.15' });
  const { logger } = createLogger();

  await assert.rejects(
    run({ db, logger, apply: true, confirmApply: CONFIRMATION_TOKEN }),
    /MongoDB 5\.0\.15 is incompatible/
  );

  assert.equal(state.commands.length, 0);
});

test('briefing session TTL apply aborts on invalid expiresAt values', async () => {
  const { db, state } = createMockDb({
    stats: {
      total: 10,
      expiresAtInPast: 3,
      expiresAtMissing: 0,
      expiresAtInvalidOrWrongType: 2,
    },
  });
  const { logger } = createLogger();

  await assert.rejects(
    run({ db, logger, apply: true, confirmApply: CONFIRMATION_TOKEN }),
    /contains invalid or non-Date values/
  );

  assert.equal(state.commands.length, 0);
});

test('briefing session TTL apply aborts when confirmation is absent', async () => {
  const { db, state } = createMockDb();
  const { logger } = createLogger();

  await assert.rejects(
    run({ db, logger, apply: true }),
    /Apply requires exactly --apply --confirm-apply=BRIEFING_TTL/
  );

  assert.equal(state.commands.length, 0);
  assert.equal(state.adminCommands.length, 0);
  assert.equal(state.aggregateCalls.length, 0);
});

test('briefing session TTL apply runs the correct collMod and verifies it', async () => {
  const { db, state } = createMockDb();
  const { logger, lines } = createLogger();

  const result = await run({ db, logger, apply: true, confirmApply: CONFIRMATION_TOKEN });

  assert.equal(result.applied, true);
  assert.deepEqual(state.commands, [
    {
      collMod: COLLECTION_NAME,
      index: {
        keyPattern: { expiresAt: 1 },
        expireAfterSeconds: 0,
      },
    },
  ]);
  assert.equal(state.indexes[0].expireAfterSeconds, 0);
  assert.equal(lines.at(-1), `${COLLECTION_NAME}.${INDEX_NAME} updated and verified with expireAfterSeconds=0.`);
});

test('briefing session TTL apply is idempotent on second execution', async () => {
  const { db, state } = createMockDb();
  const firstLogger = createLogger();
  const secondLogger = createLogger();

  const first = await run({
    db,
    logger: firstLogger.logger,
    apply: true,
    confirmApply: CONFIRMATION_TOKEN,
  });
  const second = await run({
    db,
    logger: secondLogger.logger,
    apply: true,
    confirmApply: CONFIRMATION_TOKEN,
  });

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.alreadyConfigured, true);
  assert.equal(state.commands.length, 1);
  assert.match(secondLogger.lines.at(-1), /already configured with expireAfterSeconds=0\. No changes made\./);
});
