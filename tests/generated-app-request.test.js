const assert = require('assert/strict');
const test = require('node:test');

const { app } = require('../server');
const {
  GENERATED_APP_PROJECT_PROJECTION,
  GeneratedAppProjectLookupError,
  parseHostAuthority,
  resolveGeneratedAppRequest,
  resolveTrustedRequestHostname,
} = require('../utils/generatedAppRequest');

const PROJECT_A_KEY = '0123456789abcdef0123456789abcdef';
const PROJECT_B_KEY = 'fedcba9876543210fedcba9876543210';
const PROJECT_A_ID = '64f000000000000000000201';
const PROJECT_B_ID = '64f000000000000000000202';
const PUBLISHED_BUILD_ID = '64f000000000000000000203';
const TRUSTED_PROXY_APP = app;
const UNTRUSTED_PROXY_APP = {
  get(name) {
    return name === 'trust proxy fn' ? () => false : undefined;
  },
};

const previousGeneratedAppDomain = process.env.GENERATED_APP_DOMAIN;

test.beforeEach(() => {
  process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
});

test.after(() => {
  if (previousGeneratedAppDomain === undefined) {
    delete process.env.GENERATED_APP_DOMAIN;
  } else {
    process.env.GENERATED_APP_DOMAIN = previousGeneratedAppDomain;
  }
});

function buildRequest({
  host = 'apps.askfluid.now',
  forwardedHost,
  proxyApp = UNTRUSTED_PROXY_APP,
  rawHeaders,
} = {}) {
  const headers = {};

  if (host !== undefined) {
    headers.host = host;
  }

  if (forwardedHost !== undefined) {
    headers['x-forwarded-host'] = forwardedHost;
  }

  const requestRawHeaders = rawHeaders || [];

  if (!rawHeaders) {
    if (host !== undefined) {
      requestRawHeaders.push('Host', host);
    }

    if (Array.isArray(forwardedHost)) {
      for (const value of forwardedHost) {
        requestRawHeaders.push('X-Forwarded-Host', value);
      }
    } else if (forwardedHost !== undefined) {
      requestRawHeaders.push('X-Forwarded-Host', forwardedHost);
    }
  }

  return {
    app: proxyApp,
    headers,
    rawHeaders: requestRawHeaders,
    socket: {
      remoteAddress: '203.0.113.10',
    },
  };
}

function createProjectModel(projects = [], { lookupError } = {}) {
  const calls = [];

  return {
    calls,
    findOne(filter, projection) {
      calls.push({ filter, projection });

      return {
        lean: async () => {
          if (lookupError) {
            throw lookupError;
          }

          return projects.find((project) => (
            project.publicHostKey === filter.publicHostKey
          )) || null;
        },
      };
    },
  };
}

function projectA(overrides = {}) {
  return {
    _id: PROJECT_A_ID,
    publicHostKey: PROJECT_A_KEY,
    isPublished: true,
    latestPublishedBuildId: PUBLISHED_BUILD_ID,
    runtimeEnabled: true,
    ...overrides,
  };
}

test('valid preview host resolves to Project A', async () => {
  const projectModel = createProjectModel([projectA()]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.context, {
    type: 'preview',
    hostname: `pv-${PROJECT_A_KEY}.fluidapps.dev`,
    publicHostKey: PROJECT_A_KEY,
    projectId: PROJECT_A_ID,
    isPublished: true,
    latestPublishedBuildId: PUBLISHED_BUILD_ID,
    runtimeEnabled: true,
  });
});

test('valid published host resolves identity without treating publication as authorization', async () => {
  const projectModel = createProjectModel([
    projectA({
      isPublished: false,
      latestPublishedBuildId: null,
    }),
  ]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `app-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.equal(result.status, 'resolved');
  assert.equal(result.context.type, 'published');
  assert.equal(result.context.projectId, PROJECT_A_ID);
  assert.equal(result.context.isPublished, false);
  assert.equal(result.context.latestPublishedBuildId, null);
});

test('Project A hostname never resolves a mismatched Project B record', async () => {
  const projectModel = {
    findOne: () => ({
      lean: async () => ({
        _id: PROJECT_B_ID,
        publicHostKey: PROJECT_B_KEY,
        isPublished: true,
        latestPublishedBuildId: PUBLISHED_BUILD_ID,
        runtimeEnabled: true,
      }),
    }),
  };
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.deepEqual(result, {
    status: 'not-found',
    context: null,
  });
});

test('valid generated key with no project returns uniform not-found', async () => {
  const projectModel = createProjectModel();
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.deepEqual(result, {
    status: 'not-found',
    context: null,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('malformed generated hostname is rejected before project lookup', async () => {
  const projectModel = createProjectModel([projectA()]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: 'pv-abc.fluidapps.dev' }),
    { projectModel }
  );

  assert.deepEqual(result, {
    status: 'invalid-host',
    context: null,
  });
  assert.equal(projectModel.calls.length, 0);
});

test('normal Fluid host is non-generated and does not query projects', async () => {
  const projectModel = createProjectModel([projectA()]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: 'apps.askfluid.now' }),
    { projectModel }
  );

  assert.deepEqual(result, {
    status: 'not-generated',
    context: null,
  });
  assert.equal(projectModel.calls.length, 0);
});

test('suffix-confusion hostname is rejected before project lookup', async () => {
  const projectModel = createProjectModel([projectA()]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev.evil.com` }),
    { projectModel }
  );

  assert.equal(result.status, 'invalid-host');
  assert.equal(projectModel.calls.length, 0);
});

test('direct Host authority safely removes a valid port', async () => {
  const projectModel = createProjectModel([projectA()]);
  const request = buildRequest({
    host: `pv-${PROJECT_A_KEY}.fluidapps.dev:443`,
  });

  assert.deepEqual(resolveTrustedRequestHostname(request), {
    hostname: `pv-${PROJECT_A_KEY}.fluidapps.dev`,
    source: 'host',
  });

  const result = await resolveGeneratedAppRequest(request, { projectModel });
  assert.equal(result.status, 'resolved');
});

test('untrusted X-Forwarded-Host cannot override direct Host', async () => {
  const projectModel = createProjectModel([projectA()]);
  const request = buildRequest({
    host: 'apps.askfluid.now',
    forwardedHost: `pv-${PROJECT_A_KEY}.fluidapps.dev`,
    proxyApp: UNTRUSTED_PROXY_APP,
  });

  assert.deepEqual(resolveTrustedRequestHostname(request), {
    hostname: 'apps.askfluid.now',
    source: 'host',
  });

  const result = await resolveGeneratedAppRequest(request, { projectModel });
  assert.equal(result.status, 'not-generated');
  assert.equal(projectModel.calls.length, 0);
});

test('repository trust proxy configuration accepts one forwarded host from the immediate peer', async () => {
  const projectModel = createProjectModel([projectA()]);
  const request = buildRequest({
    host: 'apps.askfluid.now',
    forwardedHost: `pv-${PROJECT_A_KEY}.fluidapps.dev:443`,
    proxyApp: TRUSTED_PROXY_APP,
  });

  assert.equal(app.get('trust proxy'), 1);
  assert.equal(app.get('trust proxy fn')(request.socket.remoteAddress, 0), true);
  assert.deepEqual(resolveTrustedRequestHostname(request), {
    hostname: `pv-${PROJECT_A_KEY}.fluidapps.dev`,
    source: 'x-forwarded-host',
  });

  const result = await resolveGeneratedAppRequest(request, { projectModel });
  assert.equal(result.status, 'resolved');
  assert.equal(result.context.projectId, PROJECT_A_ID);
});

test('trusted comma-separated or duplicate forwarded hosts are rejected', async () => {
  for (const forwardedHost of [
    `pv-${PROJECT_A_KEY}.fluidapps.dev,evil.example`,
    [`pv-${PROJECT_A_KEY}.fluidapps.dev`, 'evil.example'],
  ]) {
    const projectModel = createProjectModel([projectA()]);
    const request = buildRequest({
      forwardedHost,
      proxyApp: TRUSTED_PROXY_APP,
    });

    assert.equal(resolveTrustedRequestHostname(request), null);

    const result = await resolveGeneratedAppRequest(request, { projectModel });
    assert.equal(result.status, 'invalid-host');
    assert.equal(projectModel.calls.length, 0);
  }
});

test('malformed and ambiguous authorities are rejected', async () => {
  for (const authority of [
    '',
    ' apps.askfluid.now',
    'apps.askfluid.now ',
    'user@apps.askfluid.now',
    'https://apps.askfluid.now',
    'apps.askfluid.now/path',
    'apps.askfluid.now?query',
    'apps.askfluid.now#fragment',
    'apps.askfluid.now:abc',
    'apps.askfluid.now:0',
    'apps.askfluid.now:65536',
    '[::1',
    '::1',
    '[not-ipv6]:443',
    '[::1]garbage',
  ]) {
    assert.equal(parseHostAuthority(authority), null, authority);
  }

  const duplicateHostRequest = buildRequest({
    rawHeaders: [
      'Host',
      `pv-${PROJECT_A_KEY}.fluidapps.dev`,
      'Host',
      'apps.askfluid.now',
    ],
  });
  const projectModel = createProjectModel([projectA()]);
  const result = await resolveGeneratedAppRequest(
    duplicateHostRequest,
    { projectModel }
  );

  assert.equal(result.status, 'invalid-host');
  assert.equal(projectModel.calls.length, 0);
});

test('database failures throw a typed lookup error and never return context', async () => {
  const databaseError = new Error('database unavailable');
  const projectModel = createProjectModel([], { lookupError: databaseError });

  await assert.rejects(
    resolveGeneratedAppRequest(
      buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
      { projectModel }
    ),
    (error) => {
      assert.equal(error instanceof GeneratedAppProjectLookupError, true);
      assert.equal(error.code, 'GENERATED_APP_PROJECT_LOOKUP_FAILED');
      assert.equal(error.cause, databaseError);
      assert.doesNotMatch(error.message, new RegExp(PROJECT_A_KEY));
      return true;
    }
  );
});

test('resolved result and context are immutable and contain no owner identity', async () => {
  const projectModel = createProjectModel([
    {
      ...projectA(),
      userId: '64f000000000000000000299',
      billingCustomerId: 'secret',
    },
  ]);
  const result = await resolveGeneratedAppRequest(
    buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.context), true);
  assert.equal(result.context.userId, undefined);
  assert.equal(result.context.billingCustomerId, undefined);

  result.context.projectId = PROJECT_B_ID;
  assert.equal(result.context.projectId, PROJECT_A_ID);
});

test('publicHostKey lookup is exact and uses only the minimal projection', async () => {
  const projectModel = createProjectModel([projectA()]);
  await resolveGeneratedAppRequest(
    buildRequest({ host: `app-${PROJECT_A_KEY}.fluidapps.dev` }),
    { projectModel }
  );

  assert.deepEqual(projectModel.calls, [
    {
      filter: { publicHostKey: PROJECT_A_KEY },
      projection: GENERATED_APP_PROJECT_PROJECTION,
    },
  ]);
});

test('missing or malformed domain configuration does not classify normal Fluid hosts', async () => {
  for (const configuredDomain of [undefined, 'https://fluidapps.dev']) {
    if (configuredDomain === undefined) {
      delete process.env.GENERATED_APP_DOMAIN;
    } else {
      process.env.GENERATED_APP_DOMAIN = configuredDomain;
    }

    const projectModel = createProjectModel([projectA()]);
    const normalResult = await resolveGeneratedAppRequest(
      buildRequest({ host: 'apps.askfluid.now' }),
      { projectModel }
    );
    const generatedResult = await resolveGeneratedAppRequest(
      buildRequest({ host: `pv-${PROJECT_A_KEY}.fluidapps.dev` }),
      { projectModel }
    );

    assert.equal(normalResult.status, 'not-generated');
    assert.equal(generatedResult.status, 'invalid-host');
    assert.equal(projectModel.calls.length, 0);
  }
});
