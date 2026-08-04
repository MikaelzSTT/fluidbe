const assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const test = require('node:test');

const adminRoutes = require('../routes/adminRoutes');
const availabilityRoutes = require('../routes/fluidAvailabilityRoutes');
const AdminAuditLog = require('../models/AdminAuditLog');
const ChatMessage = require('../models/ChatMessage');
const FluidAvailability = require('../models/FluidAvailability');
const Project = require('../models/Project');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const Session = require('../models/Session');
const User = require('../models/User');
const chatRoutes = require('../routes/chatRoutes');
const projectRoutes = require('../routes/projectRoutes');

const FLUID_OFFLINE_RESPONSE = {
  ok: false,
  code: 'FLUID_OFFLINE',
  message: 'Fluid is temporarily unavailable. Please check back soon.',
};

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

function routeHandler(router, pathname, method) {
  const route = getRouteLayer(router, pathname, method);
  return route.stack[route.stack.length - 1].handle;
}

function createProjectQuery(document) {
  return {
    select() { return this; },
    lean: async () => document,
    then(resolve, reject) {
      return Promise.resolve(document).then(resolve, reject);
    },
  };
}

function createMessagesQuery(documents) {
  return {
    sort() { return this; },
    select() { return this; },
    limit() { return this; },
    lean: async () => documents,
  };
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

test('offline rejects new project creation before partial project writes', async () => {
  const originalCreate = Project.create;
  let createCalled = false;
  Project.create = async () => {
    createCalled = true;
  };

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const res = await callHandler(routeHandler(projectRoutes, '/', 'post'), {
        method: 'POST',
        originalUrl: '/api/projects',
        userId: USER_ID,
        body: {
          name: 'Blocked',
          prompt: 'Build a landing page for handmade candles.',
        },
      });

      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, FLUID_OFFLINE_RESPONSE);
      assert.equal(createCalled, false);
    });
  } finally {
    Project.create = originalCreate;
  }
});

test('offline rejects first build/chat generation without consuming messages', async () => {
  const originalChatCreate = ChatMessage.create;
  const originalProjectMessageCreate = ProjectMessage.create;
  const originalChangeCreate = ProjectChangeRequest.create;
  const writes = [];

  ChatMessage.create = async (payload) => {
    writes.push(['chat', payload]);
  };
  ProjectMessage.create = async (payload) => {
    writes.push(['projectMessage', payload]);
  };
  ProjectChangeRequest.create = async (payload) => {
    writes.push(['changeRequest', payload]);
  };

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const res = await callHandler(routeHandler(chatRoutes, '/', 'post'), {
        method: 'POST',
        originalUrl: '/api/chat',
        userId: USER_ID,
        body: {
          projectFlow: 'new_project',
          message: 'Build a landing page for handmade candles.',
          mode: 'build',
        },
      });

      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, FLUID_OFFLINE_RESPONSE);
      assert.deepEqual(writes, []);
    });
  } finally {
    ChatMessage.create = originalChatCreate;
    ProjectMessage.create = originalProjectMessageCreate;
    ProjectChangeRequest.create = originalChangeCreate;
  }
});

test('offline rejects final briefing build before briefing completion mutation', async () => {
  const originalChatCreate = ChatMessage.create;
  let messageWrites = 0;
  ChatMessage.create = async () => {
    messageWrites += 1;
  };

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const res = await callHandler(routeHandler(chatRoutes, '/', 'post'), {
        method: 'POST',
        originalUrl: '/api/chat',
        userId: USER_ID,
        session: { _id: 'session-id' },
        body: {
          projectFlow: 'new_project',
          briefingSessionId: '64f0000000000000000000b1',
          message: 'Construir projeto',
          mode: 'build',
        },
      });

      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, FLUID_OFFLINE_RESPONSE);
      assert.equal(messageWrites, 0);
    });
  } finally {
    ChatMessage.create = originalChatCreate;
  }
});

test('offline leaves existing project message reads available', async () => {
  const originalProjectFindOne = Project.findOne;
  const originalProjectMessageFind = ProjectMessage.find;
  const projectId = '64f000000000000000000201';

  Project.findOne = () => ({
    select: async () => ({ _id: projectId }),
  });
  ProjectMessage.find = () => createMessagesQuery([
    { _id: '64f000000000000000000301', role: 'user', content: 'Existing prompt', createdAt: new Date() },
  ]);

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const res = await callHandler(routeHandler(projectRoutes, '/:id/messages', 'get'), {
        method: 'GET',
        originalUrl: `/api/projects/${projectId}/messages`,
        params: { id: projectId },
        query: {},
        userId: USER_ID,
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.messages[0].content, 'Existing prompt');
    });
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectMessage.find = originalProjectMessageFind;
  }
});

test('offline leaves existing active build previews available', async () => {
  const originalProjectFindOne = Project.findOne;
  const projectId = '64f000000000000000000202';

  Project.findOne = () => createProjectQuery({
    _id: projectId,
    userId: USER_ID,
    name: 'Existing build',
    status: 'in_progress',
    generationStatus: 'in_progress',
    generation_status: 'in_progress',
  });

  try {
    await withAvailabilityStore({ isOnline: false }, async () => {
      const res = await callHandler(routeHandler(projectRoutes, '/:id/build', 'get'), {
        method: 'GET',
        protocol: 'https',
        get: () => 'fluidbe.test',
        originalUrl: `/api/projects/${projectId}/build`,
        params: { id: projectId },
        query: {},
        userId: USER_ID,
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'in_progress');
    });
  } finally {
    Project.findOne = originalProjectFindOne;
  }
});

test('admin can toggle online again while offline', async () => {
  await withAvailabilityStore({ isOnline: false }, async () => {
    const res = await callHandler(adminAvailabilityHandler('patch'), {
      method: 'PATCH',
      originalUrl: '/api/admin/fluid-availability',
      body: { isOnline: true },
      adminAuth: { adminUserId: '64f000000000000000000011' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, isOnline: true });
  });
});

test('availability lookup failure fails closed only for new work with sanitized JSON', async () => {
  const originalFindOne = FluidAvailability.findOne;
  const originalCreate = Project.create;
  let createCalled = false;
  FluidAvailability.findOne = () => {
    throw new Error('mongo unavailable with internal details');
  };
  Project.create = async () => {
    createCalled = true;
  };

  try {
    const res = await callHandler(routeHandler(projectRoutes, '/', 'post'), {
      method: 'POST',
      originalUrl: '/api/projects',
      userId: USER_ID,
      body: { name: 'Blocked', prompt: 'Build a dashboard.' },
    });

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, FLUID_OFFLINE_RESPONSE);
    assert.equal(JSON.stringify(res.body).includes('mongo unavailable'), false);
    assert.equal(createCalled, false);
  } finally {
    FluidAvailability.findOne = originalFindOne;
    Project.create = originalCreate;
  }
});
