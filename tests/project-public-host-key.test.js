const assert = require('assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

const Project = require('../models/Project');
const projectRoutes = require('../routes/projectRoutes');
const {
  PUBLIC_HOST_KEY_LENGTH,
  generatePublicHostKey,
  isValidPublicHostKey,
} = require('../utils/publicHostKey');

const USER_ID = new mongoose.Types.ObjectId('64f000000000000000000001');

async function buildValidProject(overrides = {}) {
  const project = new Project({
    userId: USER_ID,
    name: 'LedgerFlow',
    ...overrides,
  });

  await project.validate();
  return project;
}

test('new Project documents receive a valid publicHostKey', async () => {
  const project = await buildValidProject();

  assert.equal(typeof project.publicHostKey, 'string');
  assert.equal(isValidPublicHostKey(project.publicHostKey), true);
});

test('new Project documents receive different publicHostKey values', async () => {
  const first = await buildValidProject({ name: 'LedgerFlow A' });
  const second = await buildValidProject({ name: 'LedgerFlow B' });

  assert.notEqual(first.publicHostKey, second.publicHostKey);
});

test('publicHostKey format is canonical lowercase DNS-safe hex with 128 bits of entropy', () => {
  const key = generatePublicHostKey();

  assert.equal(key.length, PUBLIC_HOST_KEY_LENGTH);
  assert.equal(PUBLIC_HOST_KEY_LENGTH, 32);
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(isValidPublicHostKey(key), true);
});

test('client supplied publicHostKey is ignored during Project creation', async () => {
  const project = await buildValidProject({
    publicHostKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });

  assert.equal(isValidPublicHostKey(project.publicHostKey), true);
  assert.notEqual(project.publicHostKey, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('generic project updates cannot replace publicHostKey', () => {
  assert.deepEqual(
    projectRoutes.buildProjectUpdate({
      name: 'Renamed LedgerFlow',
      publicHostKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
    { name: 'Renamed LedgerFlow' }
  );
});

test('renaming and slug changes do not change publicHostKey on an existing Project document', async () => {
  const project = Project.hydrate({
    _id: new mongoose.Types.ObjectId('64f000000000000000000010'),
    userId: USER_ID,
    name: 'LedgerFlow',
    publicHostKey: 'cccccccccccccccccccccccccccccccc',
    slug: 'ledgerflow',
  });

  project.name = 'LedgerFlow Renamed';
  project.slug = 'ledgerflow-renamed';
  project.publicHostKey = 'dddddddddddddddddddddddddddddddd';
  await project.validate();

  assert.equal(project.name, 'LedgerFlow Renamed');
  assert.equal(project.slug, 'ledgerflow-renamed');
  assert.equal(project.publicHostKey, 'cccccccccccccccccccccccccccccccc');
});

test('duplicating a Project document receives a new publicHostKey', async () => {
  const source = await buildValidProject({ name: 'LedgerFlow Source' });
  const sourceObject = source.toObject();
  delete sourceObject._id;

  const duplicate = new Project({
    ...sourceObject,
    name: 'LedgerFlow Copy',
    slug: undefined,
  });
  await duplicate.validate();

  assert.equal(isValidPublicHostKey(duplicate.publicHostKey), true);
  assert.notEqual(duplicate.publicHostKey, source.publicHostKey);
});

test('legacy Project documents without publicHostKey can still be hydrated and read', () => {
  const project = Project.hydrate({
    _id: new mongoose.Types.ObjectId('64f000000000000000000011'),
    userId: USER_ID,
    name: 'Legacy Project',
  });

  assert.equal(project.publicHostKey, undefined);
  assert.equal(project.name, 'Legacy Project');
});

test('publicHostKey is not exposed by default object or JSON serialization', async () => {
  const project = await buildValidProject();

  assert.equal(project.publicHostKey.length, PUBLIC_HOST_KEY_LENGTH);
  assert.equal(project.toObject().publicHostKey, undefined);
  assert.equal(project.toJSON().publicHostKey, undefined);
  assert.equal(Project.schema.path('publicHostKey').options.select, false);
});

test('publicHostKey validation rejects malformed keys', () => {
  for (const value of [
    '',
    'abc',
    'g'.repeat(32),
    'A'.repeat(32),
    'a'.repeat(31),
    'a'.repeat(33),
    'abc.def0123456789abcdef012345',
    'abc_def0123456789abcdef012345',
  ]) {
    assert.equal(isValidPublicHostKey(value), false, value);
  }
});

test('Project query update middleware strips publicHostKey mutations', async () => {
  const query = Project.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId('64f000000000000000000012') },
    {
      publicHostKey: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      $set: {
        name: 'Allowed',
        publicHostKey: 'ffffffffffffffffffffffffffffffff',
      },
      $setOnInsert: {
        publicHostKey: '11111111111111111111111111111111',
      },
    }
  );

  await Project.schema.s.hooks.execPre('findOneAndUpdate', query, []);

  const update = query.getUpdate();
  assert.equal(update.publicHostKey, undefined);
  assert.equal(update.$set.publicHostKey, undefined);
  assert.equal(update.$set.name, 'Allowed');
  assert.equal(update.$setOnInsert?.publicHostKey, undefined);
});

test('Project schema declares a controlled partial unique publicHostKey index', () => {
  const index = Project.schema.indexes().find(([key]) => (
    JSON.stringify(key) === JSON.stringify({ publicHostKey: 1 })
  ));

  assert.ok(index);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {
    publicHostKey: { $type: 'string', $gt: '' },
  });
});
