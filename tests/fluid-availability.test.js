const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const test = require('node:test');

const adminRoutes = require('../routes/adminRoutes');
const availabilityRoutes = require('../routes/fluidAvailabilityRoutes');
const AdminAuditLog = require('../models/AdminAuditLog');
const FluidAvailability = require('../models/FluidAvailability');
const Session = require('../models/Session');
const User = require('../models/User');

const USER_ID = '64f000000000000000000001';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
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

function getRouteLayer(router, pathname, method) {
  const layer = router.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  assert.ok(layer, `${method.toUpperCase()} ${pathname} route should exist`);
  return layer.route;
}

function queryResult(document) {
  return {
    lean: async () => document,
    then(resolve, reject) {
      return Promise.resolve(document).then(resolve, reject);
    },
  };
}

async function callHandler(handler, req = {}) {
  const res = createResponse();
  await handler({
    method: 'GET',
    originalUrl: '/api/fluid/availability',
    url: '/availability',
    params: {},
    query: {},
    body: {},
    headers: {},
    ...req,
  }, res, () => {});
  return res;
}

function withAvailabilityStore(initialRecord, fn) {
  const originalFindOne = FluidAvailability.findOne;
  const originalFindOneAndUpdate = FluidAvailability.findOneAndUpdate;
  let record = initialRecord;
  const writes = [];

  FluidAvailability.findOne = () => queryResult(record);
  FluidAvailability.findOneAndUpdate = (query, update, options) => {
    writes.push({ query, update, options });
    record = {
      key: query.key,
      isOnline: update.$set.isOnline,
      updatedAt: update.$set.updatedAt,
      updatedBy: update.$set.updatedBy,
    };
    return queryResult(record);
  };

  return Promise.resolve()
    .then(() => fn({
      get record() {
        return record;
      },
      writes,
    }))
    .finally(() => {
      FluidAvailability.findOne = originalFindOne;
      FluidAvailability.findOneAndUpdate = originalFindOneAndUpdate;
    });
}

function publicAvailabilityHandler() {
  const route = getRouteLayer(availabilityRoutes, '/availability', 'get');
  assert.equal(route.stack[0].handle.name, 'authMiddleware');
  return route.stack[route.stack.length - 1].handle;
}

function adminAvailabilityHandler(method) {
  const route = getRouteLayer(adminRoutes, '/fluid-availability', method);
  assert.equal(route.stack[0].handle.name, 'requireAdmin');
  return route.stack[route.stack.length - 1].handle;
}

test('Fluid availability defaults online when no record exists', async () => {
  await withAvailabilityStore(null, async () => {
    const res = await callHandler(publicAvailabilityHandler(), { userId: USER_ID });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, isOnline: true });
  });
});

test('authenticated user can read Fluid availability', async () => {
  const previousEnv = {
    JWT_SECRET: process.env.JWT_SECRET,
    PUBLIC_BEARER_AUTH_LEGACY_ENABLED: process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED,
  };
  const originalSessionFindOne = Session.findOne;
  const originalUserFindById = User.findById;
  process.env.JWT_SECRET = 'fluid-availability-public-test-secret';
  process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'true';

  Session.findOne = async () => ({
    lastSeenAt: new Date(),
    save: async () => {},
  });
  User.findById = () => ({
    select: async () => ({ deletedAt: null }),
  });

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const route = getRouteLayer(availabilityRoutes, '/availability', 'get');
      const [authLayer, handlerLayer] = route.stack.map((item) => item.handle);
      const token = jwt.sign(
        { id: USER_ID, jti: 'public-session-jti' },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '10m' }
      );
      const req = {
        method: 'GET',
        originalUrl: '/api/fluid/availability',
        url: '/availability',
        params: {},
        query: {},
        body: {},
        headers: {
          authorization: `Bearer ${token}`,
        },
      };
      const res = createResponse();
      let nextCalled = false;

      await authLayer(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      await handlerLayer(req, res);
      assert.deepEqual(res.body, { ok: true, isOnline: false });
    });
  } finally {
    Session.findOne = originalSessionFindOne;
    User.findById = originalUserFindById;
    if (previousEnv.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousEnv.JWT_SECRET;
    if (previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED === undefined) delete process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
    else process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
  }
});

test('anonymous user cannot read Fluid availability', async () => {
  const route = getRouteLayer(availabilityRoutes, '/availability', 'get');
  const res = await callHandler(route.stack[0].handle);

  assert.equal(res.statusCode, 401);
});

test('Admin can set Fluid availability online and offline', async () => {
  await withAvailabilityStore(null, async ({ writes }) => {
    const handler = adminAvailabilityHandler('patch');
    const adminReq = {
      method: 'PATCH',
      originalUrl: '/api/admin/fluid-availability',
      body: { isOnline: false },
      adminAuth: {
        adminUserId: '64f000000000000000000011',
      },
    };

    const offlineRes = await callHandler(handler, adminReq);
    assert.equal(offlineRes.statusCode, 200);
    assert.deepEqual(offlineRes.body, { ok: true, isOnline: false });

    const onlineRes = await callHandler(handler, {
      ...adminReq,
      body: { isOnline: true },
    });
    assert.equal(onlineRes.statusCode, 200);
    assert.deepEqual(onlineRes.body, { ok: true, isOnline: true });
    assert.equal(writes.length, 2);
    assert.equal(writes[0].update.$set.isOnline, false);
    assert.equal(writes[1].update.$set.isOnline, true);
  });
});

test('non-Admin cannot update Fluid availability', async () => {
  const previousEnv = {
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    ADMIN_JWT_ISSUER: process.env.ADMIN_JWT_ISSUER,
    ADMIN_JWT_AUDIENCE: process.env.ADMIN_JWT_AUDIENCE,
    JWT_SECRET: process.env.JWT_SECRET,
  };
  process.env.ADMIN_JWT_SECRET = 'fluid-availability-admin-test-secret';
  process.env.ADMIN_JWT_ISSUER = 'fluid-admin-test';
  process.env.ADMIN_JWT_AUDIENCE = 'fluid-admin-api-test';
  process.env.JWT_SECRET = 'fluid-availability-public-test-secret';

  try {
    const route = getRouteLayer(adminRoutes, '/fluid-availability', 'patch');
    const token = jwt.sign(
      { id: USER_ID, jti: 'public-session-jti' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '10m' }
    );
    const res = await callHandler(route.stack[0].handle, {
      method: 'PATCH',
      originalUrl: '/api/admin/fluid-availability',
      url: '/fluid-availability',
      body: { isOnline: false },
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
  } finally {
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});

test('Fluid availability rejects invalid values', async () => {
  await withAvailabilityStore(null, async ({ writes }) => {
    const handler = adminAvailabilityHandler('patch');

    for (const value of ['false', 0, 1, null, undefined]) {
      const res = await callHandler(handler, {
        method: 'PATCH',
        originalUrl: '/api/admin/fluid-availability',
        body: { isOnline: value },
        adminAuth: { adminUserId: '64f000000000000000000011' },
      });

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'FLUID_AVAILABILITY_INVALID_VALUE');
    }

    assert.equal(writes.length, 0);
  });
});

test('Fluid availability value persists across subsequent reads', async () => {
  await withAvailabilityStore(null, async () => {
    const updateHandler = adminAvailabilityHandler('patch');
    const readHandler = publicAvailabilityHandler();

    await callHandler(updateHandler, {
      method: 'PATCH',
      originalUrl: '/api/admin/fluid-availability',
      body: { isOnline: false },
      adminAuth: { adminUserId: '64f000000000000000000011' },
    });

    const firstRead = await callHandler(readHandler, { userId: USER_ID });
    const secondRead = await callHandler(readHandler, { userId: USER_ID });

    assert.deepEqual(firstRead.body, { ok: true, isOnline: false });
    assert.deepEqual(secondRead.body, { ok: true, isOnline: false });
  });
});

test('Fluid availability responses do not expose Admin metadata', async () => {
  await withAvailabilityStore({
    isOnline: true,
    updatedBy: '64f000000000000000000011',
    updatedAt: new Date(),
    _id: '64f000000000000000000099',
  }, async () => {
    const publicRes = await callHandler(publicAvailabilityHandler(), { userId: USER_ID });
    const adminReadRes = await callHandler(adminAvailabilityHandler('get'), {
      method: 'GET',
      originalUrl: '/api/admin/fluid-availability',
      adminAuth: { adminUserId: '64f000000000000000000011' },
    });

    assert.deepEqual(Object.keys(publicRes.body).sort(), ['isOnline', 'ok']);
    assert.deepEqual(Object.keys(adminReadRes.body).sort(), ['isOnline', 'ok']);
    assert.equal(JSON.stringify(publicRes.body).includes('64f'), false);
    assert.equal(JSON.stringify(adminReadRes.body).includes('64f'), false);
  });
});
