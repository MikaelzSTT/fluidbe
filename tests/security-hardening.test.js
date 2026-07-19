const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Stripe = require('stripe');

const authMiddleware = require('../middleware/authMiddleware');
const authRoutes = require('../routes/authRoutes');
const adminRoutes = require('../routes/adminRoutes');
const billingRoutes = require('../routes/billingRoutes');
const projectRoutes = require('../routes/projectRoutes');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const User = require('../models/User');
const {
  publishProjectBuild,
} = require('../utils/projectPublication');
const {
  buildRuntimeEqualityFilter,
} = require('../utils/runtimeValidation');
const {
  runtimeUpdate,
} = require('../utils/runtimeStore');
const { verifyRuntimeAuthToken } = require('../utils/runtimeAuth');
const { assertSafeRuntimeBody } = require('../utils/runtimeValidation');
const { timingSafeEqualString } = require('../utils/timingSafe');

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
    set(name, value) {
      this.headers = {
        ...(this.headers || {}),
        [name]: value,
      };
      return this;
    },
  };
}

function getAuthRouteHandler(pathname, method) {
  const layer = authRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getBillingRouteStack(pathname, method) {
  const layer = billingRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack.map((item) => item.handle);
}

function getRouteHandler(router, pathname, method) {
  const layer = router.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function runHandler(handler, req) {
  const res = createResponse();
  await handler(req, res, () => {});
  return res;
}

function createSignedStripeRequest(event, secret = 'whsec_test_secret') {
  const payload = JSON.stringify(event);
  const stripe = new Stripe('sk_test_unit');
  return {
    method: 'POST',
    originalUrl: '/api/billing/webhook',
    ip: '203.0.113.10',
    headers: {
      'stripe-signature': stripe.webhooks.generateTestHeaderString({
        payload,
        secret,
      }),
    },
    body: Buffer.from(payload),
  };
}

test('Shopify credential validation only normalizes tenant myshopify.com hosts', () => {
  const normalize = projectRoutes.normalizeShopifyStoreUrl;

  assert.equal(normalize('https://safe-store.myshopify.com/admin'), 'safe-store.myshopify.com');
  assert.equal(normalize('safe-store.myshopify.com'), 'safe-store.myshopify.com');
  assert.equal(normalize('https://127.0.0.1/internal'), '');
  assert.equal(normalize('https://safe-store.myshopify.com.evil.example'), '');
  assert.equal(normalize('https://safe-store.myshopify.com@127.0.0.1/internal'), '');
  assert.equal(normalize('http://safe-store.myshopify.com'), '');
});

test('runtime body validation rejects prototype-pollution keys at any depth', () => {
  const constructorPayload = JSON.parse('{"nested":{"constructor":{"prototype":{"polluted":true}}}}');
  const protoPayload = JSON.parse('{"__proto__":{"polluted":true}}');

  assert.equal(assertSafeRuntimeBody({ nested: { safe: true } }), true);
  assert.equal(assertSafeRuntimeBody(constructorPayload), false);
  assert.equal(assertSafeRuntimeBody(protoPayload), false);
});

test('runtime query validation rejects Mongo selector, regex and code operators', () => {
  assert.equal(buildRuntimeEqualityFilter({ email: 'person@example.test' })['data.email'], 'person@example.test');
  assert.equal(buildRuntimeEqualityFilter({ $or: [{ role: 'admin' }] }), null);
  assert.equal(buildRuntimeEqualityFilter({ $where: 'sleep(1000)' }), null);
  assert.equal(buildRuntimeEqualityFilter({ email: { $regex: '(a+)+$' } }), null);
  assert.equal(buildRuntimeEqualityFilter({ 'email.$ne': 'x' }), null);
});

test('runtime store rejects update operators, owner/project swaps and aggregate-style payloads', () => {
  assert.throws(
    () => runtimeUpdate(
      '64f000000000000000000001',
      'orders',
      { _id: '64f000000000000000000002' },
      { $set: { userId: '64f000000000000000000099' } }
    ),
    /unsafe keys/
  );

  assert.throws(
    () => runtimeUpdate(
      '64f000000000000000000001',
      'orders',
      { _id: '64f000000000000000000002' },
      { projectId: '64f000000000000000000099' }
    ),
    /unsafe keys/
  );

  assert.throws(
    () => runtimeUpdate(
      '64f000000000000000000001',
      'orders',
      { $match: { projectId: { $ne: null } } },
      { status: 'paid' }
    ),
    /unsafe keys/
  );
});

test('timing-safe string comparison fails closed for malformed and unequal values', () => {
  assert.equal(timingSafeEqualString('same-secret', 'same-secret'), true);
  assert.equal(timingSafeEqualString('same-secreu', 'same-secret'), false);
  assert.equal(timingSafeEqualString('short', 'much-longer'), false);
  assert.equal(timingSafeEqualString(undefined, 'secret'), false);
});

test('main auth middleware rejects a validly signed JWT using a non-allowlisted algorithm', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'security-hardening-test-secret';

  try {
    const token = jwt.sign(
      { id: '64f000000000000000000001', jti: 'test-session' },
      process.env.JWT_SECRET,
      { algorithm: 'HS384', expiresIn: '5m' }
    );
    const res = createResponse();
    let nextCalled = false;

    await authMiddleware(
      { method: 'GET', originalUrl: '/api/projects', headers: { authorization: `Bearer ${token}` } },
      res,
      () => { nextCalled = true; }
    );

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('runtime auth rejects a validly signed JWT using a non-allowlisted algorithm', () => {
  const previousSecret = process.env.RUNTIME_JWT_SECRET;
  process.env.RUNTIME_JWT_SECRET = 'runtime-security-hardening-test-secret';

  try {
    const token = jwt.sign(
      { runtimeUserId: '64f000000000000000000001', projectId: '64f000000000000000000002' },
      process.env.RUNTIME_JWT_SECRET,
      { algorithm: 'HS384', expiresIn: '5m' }
    );

    assert.throws(() => verifyRuntimeAuthToken(token), /invalid algorithm/);
  } finally {
    if (previousSecret === undefined) delete process.env.RUNTIME_JWT_SECRET;
    else process.env.RUNTIME_JWT_SECRET = previousSecret;
  }
});

test('login does not disclose whether an account is missing or provider-only', async () => {
  const User = require('../models/User');
  const originalFindOne = User.findOne;
  const handler = getAuthRouteHandler('/login', 'post');

  try {
    const responses = [];

    for (const user of [null, { email: 'oauth@example.test', providers: ['google'] }]) {
      User.findOne = async () => user;
      const res = createResponse();
      await handler({ body: { email: 'person@example.test', password: 'not-the-password' } }, res);
      responses.push({ statusCode: res.statusCode, body: res.body });
    }

    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[0], {
      statusCode: 401,
      body: { message: 'E-mail ou senha inválidos.' },
    });
  } finally {
    User.findOne = originalFindOne;
  }
});

test('login rejects Mongo selector injection before querying users', async () => {
  const originalFindOne = User.findOne;
  const handler = getAuthRouteHandler('/login', 'post');
  let queried = false;

  User.findOne = async () => {
    queried = true;
    return null;
  };

  try {
    const res = createResponse();
    await handler({
      body: {
        email: { $ne: null },
        password: 'not-the-password',
      },
    }, res);

    assert.equal(res.statusCode, 400);
    assert.equal(queried, false);
  } finally {
    User.findOne = originalFindOne;
  }
});

test('admin project aggregate pipeline is static and ignores request filters', async () => {
  const originalFind = Project.find;
  const originalAggregate = require('../models/ProjectChangeRequest').aggregate;
  const ProjectChangeRequest = require('../models/ProjectChangeRequest');
  const handler = getRouteHandler(adminRoutes, '/projects', 'get');
  let pipeline;

  Project.find = () => ({
    sort: async () => [{
      _id: new mongoose.Types.ObjectId('64f000000000000000000001'),
      toObject: () => ({ _id: '64f000000000000000000001' }),
    }],
  });
  ProjectChangeRequest.aggregate = async (capturedPipeline) => {
    pipeline = capturedPipeline;
    return [];
  };

  try {
    const res = createResponse();
    await handler({
      query: {
        $match: { projectId: { $ne: null } },
        pipeline: [{ $where: 'sleep(1000)' }],
      },
      protocol: 'https',
      get: () => 'backend.example.test',
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(pipeline, [
      {
        $match: {
          status: 'pending',
          projectId: { $in: [new mongoose.Types.ObjectId('64f000000000000000000001')] },
        },
      },
      {
        $group: {
          _id: '$projectId',
          count: { $sum: 1 },
        },
      },
    ]);
  } finally {
    Project.find = originalFind;
    ProjectChangeRequest.aggregate = originalAggregate;
  }
});

test('login rejects oversized passwords before querying the database', async () => {
  const User = require('../models/User');
  const originalFindOne = User.findOne;
  const handler = getAuthRouteHandler('/login', 'post');
  let queried = false;

  User.findOne = async () => {
    queried = true;
    return null;
  };

  try {
    const res = createResponse();
    await handler({ body: { email: 'person@example.test', password: 'x'.repeat(73) } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(queried, false);
  } finally {
    User.findOne = originalFindOne;
  }
});

test('server source keeps low-risk perimeter hardening enabled', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(source, /app\.disable\('x-powered-by'\)/);
  assert.match(source, /app\.use\('\/api\/auth\/register', registerRateLimit\)/);
  assert.match(source, /function apiRateLimitUnlessStripeWebhook/);
  assert.match(source, /app\.use\('\/api', apiRateLimitUnlessStripeWebhook\)/);
  assert.match(source, /res\.setHeader\('Referrer-Policy', 'no-referrer'\)/);
  assert.match(source, /if \(process\.env\.NODE_ENV === 'production'\) \{\s+return res\.sendStatus\(404\)/);
});

test('Stripe webhook route has its own permissive limiter and invalid signatures are rejected', async () => {
  const previousSecretKey = process.env.STRIPE_SECRET_KEY;
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalCreate = StripeWebhookEvent.create;
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

  try {
    let claimed = false;
    StripeWebhookEvent.create = async () => {
      claimed = true;
    };
    const [webhookLimiter, , webhookHandler] = getBillingRouteStack('/webhook', 'post');

    for (let i = 0; i < 305; i += 1) {
      const res = await runHandler(webhookLimiter, {
        method: 'POST',
        originalUrl: '/api/billing/webhook',
        ip: '198.51.100.7',
      });
      assert.notEqual(res.statusCode, 429);
    }

    const res = await runHandler(webhookHandler, {
      method: 'POST',
      originalUrl: '/api/billing/webhook',
      headers: {
        'stripe-signature': 'bad-signature',
      },
      body: Buffer.from(JSON.stringify({ id: 'evt_bad', type: 'invoice.paid' })),
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { message: 'Webhook signature verification failed.' });
    assert.equal(claimed, false);
  } finally {
    StripeWebhookEvent.create = originalCreate;
    if (previousSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecretKey;
    if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  }
});

test('Stripe webhook idempotency prevents a repeated event from processing twice', async () => {
  const previousSecretKey = process.env.STRIPE_SECRET_KEY;
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const previousProPrice = process.env.STRIPE_PRO_PRICE_ID;
  const originalCreate = StripeWebhookEvent.create;
  const originalFindOne = StripeWebhookEvent.findOne;
  const originalFindOneAndUpdate = StripeWebhookEvent.findOneAndUpdate;
  const originalUpdateOne = StripeWebhookEvent.updateOne;
  const originalUserFindOneAndUpdate = User.findOneAndUpdate;
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_unit';

  try {
    let eventStatus = null;
    let processedCount = 0;
    StripeWebhookEvent.create = async () => {
      if (eventStatus) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      eventStatus = 'processing';
    };
    StripeWebhookEvent.findOne = () => ({
      select: async () => (eventStatus ? { status: eventStatus } : null),
    });
    StripeWebhookEvent.findOneAndUpdate = () => ({
      select: async () => null,
    });
    StripeWebhookEvent.updateOne = async (query, update) => {
      if (update?.$set?.status) {
        eventStatus = update.$set.status;
      }
    };
    User.findOneAndUpdate = async () => {
      processedCount += 1;
      return { _id: '64f000000000000000000001', plan: 'pro' };
    };

    const [, , webhookHandler] = getBillingRouteStack('/webhook', 'post');
    const event = {
      id: 'evt_repeat_unit',
      type: 'invoice.paid',
      data: {
        object: {
          customer: 'cus_unit',
          subscription: 'sub_unit',
          subscription_details: {
            metadata: {
              userId: '64f000000000000000000001',
            },
          },
          lines: {
            data: [
              {
                price: {
                  id: 'price_pro_unit',
                },
                period: {
                  end: 1784337137,
                },
              },
            ],
          },
        },
      },
    };

    const first = await runHandler(webhookHandler, createSignedStripeRequest(event));
    const second = await runHandler(webhookHandler, createSignedStripeRequest(event));

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(processedCount, 1);
    assert.equal(eventStatus, 'processed');
  } finally {
    StripeWebhookEvent.create = originalCreate;
    StripeWebhookEvent.findOne = originalFindOne;
    StripeWebhookEvent.findOneAndUpdate = originalFindOneAndUpdate;
    StripeWebhookEvent.updateOne = originalUpdateOne;
    User.findOneAndUpdate = originalUserFindOneAndUpdate;
    if (previousSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousSecretKey;
    if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
    if (previousProPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
    else process.env.STRIPE_PRO_PRICE_ID = previousProPrice;
  }
});

test('publication blocks critical secret findings without leaking the secret or publishing build', async () => {
  const originalProjectBuildFindOneAndUpdate = ProjectBuild.findOneAndUpdate;
  const originalProjectFindByIdAndUpdate = Project.findByIdAndUpdate;
  const secret = 'sk-proj-criticalunitsecret123456';
  let buildPublished = false;
  let projectPublished = false;
  const logLines = [];
  const originalError = console.error;
  console.error = (...args) => {
    logLines.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    ProjectBuild.findOneAndUpdate = async () => {
      buildPublished = true;
      throw new Error('build should not be published');
    };
    Project.findByIdAndUpdate = async () => {
      projectPublished = true;
      throw new Error('project should not be published');
    };

    await assert.rejects(
      publishProjectBuild({
        req: {
          protocol: 'https',
          get: () => 'backend.example.test',
        },
        project: {
          _id: '64f000000000000000000010',
          slug: 'clean-slug',
        },
        projectBuild: {
          _id: '64f000000000000000000011',
          projectId: '64f000000000000000000010',
          status: 'draft',
          type: 'html',
          previewUrl: '/builds/64f000000000000000000010/build-a/index.html',
          html: `<script>const leaked = "${secret}";</script>`,
        },
        body: {
          visibility: 'public',
        },
      }),
      (error) => {
        const payloadText = JSON.stringify(error.payload);
        assert.equal(error.statusCode, 409);
        assert.equal(error.payload.code, 'BUILD_SECURITY_BLOCKED');
        assert.equal(payloadText.includes(secret), false);
        return true;
      }
    );

    assert.equal(buildPublished, false);
    assert.equal(projectPublished, false);
    assert.equal(logLines.join('\n').includes(secret), false);
  } finally {
    console.error = originalError;
    ProjectBuild.findOneAndUpdate = originalProjectBuildFindOneAndUpdate;
    Project.findByIdAndUpdate = originalProjectFindByIdAndUpdate;
  }
});

test('clean publication still marks the selected draft build as done', async () => {
  const originalProjectBuildFindOne = ProjectBuild.findOne;
  const originalProjectBuildFindOneAndUpdate = ProjectBuild.findOneAndUpdate;
  const originalProjectFindByIdAndUpdate = Project.findByIdAndUpdate;
  const originalProjectExists = Project.exists;
  const originalBuildJobFindOne = BuildJob.findOne;
  const projectId = '64f000000000000000000020';
  const buildId = '64f000000000000000000021';
  const project = {
    _id: projectId,
    slug: 'clean-app',
  };
  const publishedBuild = {
    _id: buildId,
    projectId,
    status: 'done',
    type: 'html',
    previewUrl: `/builds/${projectId}/build-clean/index.html`,
    buildUrl: `/builds/${projectId}/build-clean/index.html`,
    fullHtml: '<main>clean</main>',
  };

  try {
    ProjectBuild.findOne = () => ({
      select: async () => ({ fullHtml: '<main>clean</main>' }),
    });
    ProjectBuild.findOneAndUpdate = async (query, update) => {
      assert.equal(String(query._id), buildId);
      assert.equal(query.status, 'draft');
      assert.equal(update.$set.status, 'done');
      return publishedBuild;
    };
    Project.findByIdAndUpdate = async (id, update) => {
      assert.equal(String(id), projectId);
      assert.equal(update.isPublished, true);
      assert.equal(String(update.latestPublishedBuildId), buildId);
      return {
        ...project,
        ...update,
        publicUrl: 'https://apps.askfluid.now/p/clean-app',
      };
    };
    Project.exists = async () => false;
    BuildJob.findOne = () => ({
      sort: () => ({
        select: async () => null,
      }),
    });

    const result = await publishProjectBuild({
      req: {
        protocol: 'https',
        get: () => 'backend.example.test',
      },
      project,
      projectBuild: {
        _id: buildId,
        projectId,
        status: 'draft',
        type: 'html',
        previewUrl: `/builds/${projectId}/build-clean/index.html`,
        buildUrl: `/builds/${projectId}/build-clean/index.html`,
        fullHtml: '<main>clean</main>',
      },
      body: {
        visibility: 'public',
      },
    });

    assert.equal(result.alreadyPublished, false);
    assert.equal(result.publishedBuild.status, 'done');
    assert.equal(result.publishedProject.isPublished, true);
  } finally {
    ProjectBuild.findOne = originalProjectBuildFindOne;
    ProjectBuild.findOneAndUpdate = originalProjectBuildFindOneAndUpdate;
    Project.findByIdAndUpdate = originalProjectFindByIdAndUpdate;
    Project.exists = originalProjectExists;
    BuildJob.findOne = originalBuildJobFindOne;
  }
});
