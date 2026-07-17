const assert = require('assert/strict');
const test = require('node:test');

const Project = require('../models/Project');
const RuntimeDocument = require('../models/RuntimeDocument');
const adminRoutes = require('../routes/adminRoutes');
const projectRoutes = require('../routes/projectRoutes');
const { runtimeFindOne } = require('../utils/runtimeStore');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function getRouteHandler(router, pathname, method) {
  const layer = router.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('every project route starts with the main auth boundary', () => {
  const routeLayers = projectRoutes.stack.filter((layer) => layer.route);

  assert.ok(routeLayers.length > 0);
  for (const layer of routeLayers) {
    assert.equal(
      layer.route.stack[0].handle.name,
      'authMiddleware',
      `${layer.route.path} must start with authMiddleware`
    );
  }
});

test('every admin route starts with the admin boundary', () => {
  const routeLayers = adminRoutes.stack.filter((layer) => layer.route);

  assert.ok(routeLayers.length > 0);
  for (const layer of routeLayers) {
    assert.equal(
      layer.route.stack[0].handle.name,
      'requireAdmin',
      `${layer.route.path} must start with requireAdmin`
    );
  }
});

test('project detail lookup scopes an attacker-supplied id to the authenticated user', async () => {
  const originalFindOne = Project.findOne;
  const handler = getRouteHandler(projectRoutes, '/:id', 'get');
  let query;

  Project.findOne = async (capturedQuery) => {
    query = capturedQuery;
    return null;
  };

  try {
    const res = createResponse();
    await handler({
      params: { id: '64f000000000000000000099' },
      userId: '64f000000000000000000001',
    }, res);

    assert.deepEqual(query, {
      _id: '64f000000000000000000099',
      userId: '64f000000000000000000001',
    });
    assert.equal(res.statusCode, 404);
  } finally {
    Project.findOne = originalFindOne;
  }
});

test('project CRUD rejects malformed ids before reaching ownership queries', () => {
  for (const method of ['get', 'put', 'delete']) {
    const layer = projectRoutes.stack.find((item) => (
      item.route?.path === '/:id' && item.route?.methods?.[method]
    ));
    const validation = layer.route.stack[1].handle;
    const res = createResponse();
    let nextCalled = false;

    validation({ params: { id: 'not-an-object-id' } }, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Projeto não encontrado.' });
  }
});

test('project delete fails closed before cascading when ownership does not match', async () => {
  const originalFindOne = Project.findOne;
  const handler = getRouteHandler(projectRoutes, '/:id', 'delete');
  let query;

  Project.findOne = async (capturedQuery) => {
    query = capturedQuery;
    return null;
  };

  try {
    const res = createResponse();
    await handler({
      params: { id: '64f000000000000000000099' },
      userId: '64f000000000000000000001',
    }, res);

    assert.deepEqual(query, {
      _id: '64f000000000000000000099',
      userId: '64f000000000000000000001',
    });
    assert.equal(res.statusCode, 404);
  } finally {
    Project.findOne = originalFindOne;
  }
});

test('runtime storage always adds project and collection scope', async () => {
  const originalFindOne = RuntimeDocument.findOne;
  let query;

  RuntimeDocument.findOne = (capturedQuery) => {
    query = capturedQuery;
    return null;
  };

  try {
    runtimeFindOne(
      '64f000000000000000000001',
      'orders',
      { _id: '64f000000000000000000099' }
    );

    assert.deepEqual(query, {
      _id: '64f000000000000000000099',
      projectId: '64f000000000000000000001',
      collection: 'orders',
    });
    assert.throws(
      () => runtimeFindOne('64f000000000000000000001', 'orders', { projectId: 'attacker-project' }),
      /overrides are not allowed/
    );
  } finally {
    RuntimeDocument.findOne = originalFindOne;
  }
});
