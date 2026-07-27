const assert = require('assert/strict');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const test = require('node:test');

process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';
process.env.PREVIEW_ALLOWED_ORIGIN = 'https://preview.askfluid.now';
process.env.BUILD_PREVIEW_SECRET = 'generated-preview-route-test-secret';

const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const { app } = require('../server');
const {
  BUILD_PREVIEW_TTL_SECONDS,
  createBuildPreviewToken,
} = require('../utils/buildPreviewAccess');

const PROJECT_A_ID = '64f000000000000000000301';
const PROJECT_B_ID = '64f000000000000000000302';
const PROJECT_A_KEY = '0123456789abcdef0123456789abcdef';
const PROJECT_B_KEY = 'fedcba9876543210fedcba9876543210';
const BUILD_A_ID = '64f000000000000000000311';
const BUILD_A_NEWER_ID = '64f000000000000000000312';
const BUILD_B_ID = '64f000000000000000000321';
const PUBLIC_BUILDS_DIR = path.join(__dirname, '..', 'public', 'builds');

const projectA = {
  _id: PROJECT_A_ID,
  publicHostKey: PROJECT_A_KEY,
  userId: '64f000000000000000000391',
  isPublished: true,
  latestPublishedBuildId: BUILD_A_ID,
  runtimeEnabled: false,
};
const projectB = {
  _id: PROJECT_B_ID,
  publicHostKey: PROJECT_B_KEY,
  userId: '64f000000000000000000392',
  isPublished: false,
  latestPublishedBuildId: null,
  runtimeEnabled: false,
};
const builds = [
  {
    _id: BUILD_A_ID,
    projectId: PROJECT_A_ID,
    status: 'done',
    buildUrl: `/builds/${PROJECT_A_ID}/${BUILD_A_ID}/index.html`,
    artifactFiles: [
      {
        relativePath: 'mongo-only.txt',
        contentType: 'text/plain; charset=utf-8',
        content: Buffer.from('project-a-mongo-fallback').toString('base64'),
      },
    ],
  },
  {
    _id: BUILD_A_NEWER_ID,
    projectId: PROJECT_A_ID,
    status: 'done',
    buildUrl: `/builds/${PROJECT_A_ID}/${BUILD_A_NEWER_ID}/index.html`,
  },
  {
    _id: BUILD_B_ID,
    projectId: PROJECT_B_ID,
    status: 'draft',
    buildUrl: `/builds/${PROJECT_B_ID}/${BUILD_B_ID}/index.html`,
  },
];

const originalProjectFindOne = Project.findOne;
const originalProjectFindById = Project.findById;
const originalProjectBuildFindOne = ProjectBuild.findOne;
const originalProjectBuildFind = ProjectBuild.find;
const originalGeneratedAppDomain = process.env.GENERATED_APP_DOMAIN;
let server;
let projectLookupError = null;
let projectFindByIdCalls = 0;
let buildQueries = [];

function listen() {
  return new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
}

function close(listeningServer) {
  return new Promise((resolve, reject) => {
    listeningServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        path: '/',
        ...options,
        headers: {
          Host: `pv-${PROJECT_A_KEY}.fluidapps.dev`,
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function matchesBuildUrlQuery(build, query) {
  return (query.$or || []).some((condition) => {
    const [[field, expected]] = Object.entries(condition);
    const actual = build[field];

    if (expected instanceof RegExp) {
      return expected.test(String(actual || ''));
    }

    return actual === expected;
  });
}

function findBuild(query) {
  return builds.find((build) => (
    String(build.projectId) === String(query.projectId)
    && (!query._id || String(build._id) === String(query._id))
    && matchesBuildUrlQuery(build, query)
  )) || null;
}

function queryResult(valueFactory) {
  return {
    sort() {
      return this;
    },
    select() {
      return this;
    },
    lean: async () => valueFactory(),
  };
}

function validToken(projectId, buildId) {
  return createBuildPreviewToken(projectId, buildId);
}

function buildPath(projectId, buildId, artifactPath = 'index.html') {
  return `/builds/${projectId}/${buildId}/${artifactPath}`;
}

function generatedPreviewHost(publicHostKey) {
  return `pv-${publicHostKey}.fluidapps.dev`;
}

async function writeBuild(projectId, buildId, label) {
  const root = path.join(PUBLIC_BUILDS_DIR, projectId, buildId);
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'index.html'),
    `<!doctype html><main>${label}</main><script src="./assets/app.js"></script>`
  );
  await fs.writeFile(
    path.join(root, 'assets', 'app.js'),
    `document.body.dataset.build = "${label}";`
  );
}

test.before(async () => {
  Project.findOne = (filter) => queryResult(() => {
    if (projectLookupError) {
      throw projectLookupError;
    }

    return [projectA, projectB].find((project) => (
      project.publicHostKey === filter.publicHostKey
    )) || null;
  });

  Project.findById = (projectId) => {
    projectFindByIdCalls += 1;
    return queryResult(() => (
      [projectA, projectB].find((project) => String(project._id) === String(projectId)) || null
    ));
  };

  ProjectBuild.findOne = (query) => {
    buildQueries.push(query);
    return queryResult(() => findBuild(query));
  };

  ProjectBuild.find = (query) => ({
    sort: async () => builds.filter((build) => (
      String(build.projectId) === String(query.projectId)
      && (!query._id || String(build._id) === String(query._id))
      && matchesBuildUrlQuery(build, query)
    )),
  });

  await writeBuild(PROJECT_A_ID, BUILD_A_ID, 'project-a-requested');
  await writeBuild(PROJECT_A_ID, BUILD_A_NEWER_ID, 'project-a-newer');
  await writeBuild(PROJECT_B_ID, BUILD_B_ID, 'project-b');
  server = await listen();
});

test.beforeEach(() => {
  process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
  projectLookupError = null;
  projectFindByIdCalls = 0;
  buildQueries = [];
});

test.after(async () => {
  if (server) {
    await close(server);
  }

  Project.findOne = originalProjectFindOne;
  Project.findById = originalProjectFindById;
  ProjectBuild.findOne = originalProjectBuildFindOne;
  ProjectBuild.find = originalProjectBuildFind;

  if (originalGeneratedAppDomain === undefined) {
    delete process.env.GENERATED_APP_DOMAIN;
  } else {
    process.env.GENERATED_APP_DOMAIN = originalGeneratedAppDomain;
  }

  await fs.rm(path.join(PUBLIC_BUILDS_DIR, PROJECT_A_ID), { recursive: true, force: true });
  await fs.rm(path.join(PUBLIC_BUILDS_DIR, PROJECT_B_ID), { recursive: true, force: true });
});

test('Project A preview host serves Project A build with its exact capability', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /project-a-requested/);
  assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.equal(projectFindByIdCalls, 0);
});

test('Project A host denies Project B path even with a valid Project B capability', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_B_ID, BUILD_B_ID)}?previewToken=${validToken(PROJECT_B_ID, BUILD_B_ID)}`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(buildQueries.length, 0);
});

test('Project A path rejects Project B and wrong-build capabilities', async () => {
  for (const token of [
    validToken(PROJECT_B_ID, BUILD_B_ID),
    validToken(PROJECT_A_ID, BUILD_A_NEWER_ID),
  ]) {
    const response = await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${token}`,
    });

    assert.equal(response.statusCode, 404);
  }
});

test('Project A preview host denies missing and expired capabilities', async () => {
  const expiredStart =
    Math.floor(Date.now() / 1000) - BUILD_PREVIEW_TTL_SECONDS - 10;
  const expiredToken = createBuildPreviewToken(
    PROJECT_A_ID,
    BUILD_A_ID,
    expiredStart
  );

  for (const suffix of ['', `?previewToken=${expiredToken}`]) {
    const response = await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}${suffix}`,
    });

    assert.equal(response.statusCode, 404);
  }
});

test('valid query capability establishes a secure host-only build-scoped cookie', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });
  const setCookie = String(response.headers['set-cookie'] || '');

  assert.equal(response.statusCode, 200);
  assert.match(setCookie, /fluid_build_preview=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(
    setCookie,
    new RegExp(`Path=\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}`)
  );
  assert.doesNotMatch(setCookie, /Domain=/i);

  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const asset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.js'),
    headers: { Cookie: cookie },
  });

  assert.equal(asset.statusCode, 200);
  assert.match(asset.body, /project-a-requested/);
});

test('Project A preview cookie cannot authorize Project B host', async () => {
  const projectAResponse = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });
  const cookie = projectAResponse.headers['set-cookie'][0].split(';')[0];
  const projectBResponse = await request({
    path: buildPath(PROJECT_B_ID, BUILD_B_ID),
    headers: {
      Host: generatedPreviewHost(PROJECT_B_KEY),
      Cookie: cookie,
    },
  });

  assert.equal(projectBResponse.statusCode, 404);
  assert.doesNotMatch(projectBResponse.body, /project-b/);
});

test('published build on pv host still requires preview capability', async () => {
  const response = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID),
  });

  assert.equal(projectA.isPublished, true);
  assert.equal(String(projectA.latestPublishedBuildId), BUILD_A_ID);
  assert.equal(response.statusCode, 404);
  assert.equal(projectFindByIdCalls, 0);
});

test('unknown, malformed, and app generated hosts return uniform 404 responses', async () => {
  const unknownKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hosts = [
    generatedPreviewHost(unknownKey),
    'pv-abc.fluidapps.dev',
    `app-${PROJECT_A_KEY}.fluidapps.dev`,
  ];
  const responses = [];

  for (const host of hosts) {
    responses.push(await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
      headers: { Host: host },
    }));
  }

  for (const response of responses) {
    assert.equal(response.statusCode, 404);
    assert.equal(response.body, 'Not Found');
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  }
});

test('generated preview host denies all control-plane and publication paths', async () => {
  for (const deniedPath of [
    '/api/runtime/project-a',
    '/api/auth/me',
    '/api/projects',
    '/api/admin/projects',
    '/settings/account',
    '/p/clean-app',
    '/oauth/callback',
    '/',
  ]) {
    const response = await request({
      path: deniedPath,
      headers: {
        Cookie: 'fluid_session=owner-session',
        Authorization: 'Bearer owner-token',
      },
    });

    assert.equal(response.statusCode, 404, deniedPath);
    assert.doesNotMatch(response.body, /Token|database|Projeto|FluidBE/i);
  }
});

test('requested older build is served instead of a newer done build', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /project-a-requested/);
  assert.doesNotMatch(response.body, /project-a-newer/);
  assert.equal(
    buildQueries[0].$or.some((condition) => (
      condition.buildUrl === `/builds/${PROJECT_A_ID}/${BUILD_A_ID}/index.html`
    )),
    true
  );
});

test('generated preview preserves exact-build Mongo artifact fallback', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'mongo-only.txt')}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'project-a-mongo-fallback');
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
});

test('generated preview preserves traversal protection', async () => {
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, '%2e%2e%2fsecret.txt')}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(buildQueries.length, 0);
});

test('project lookup failure has the same public response as an unknown generated host', async () => {
  const previousConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    projectLookupError = new Error('database unavailable');
    const failedLookup = await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
    });

    projectLookupError = null;
    const unknownHost = await request({
      path: buildPath(PROJECT_A_ID, BUILD_A_ID),
      headers: {
        Host: generatedPreviewHost('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      },
    });

    assert.equal(failedLookup.statusCode, 404);
    assert.equal(failedLookup.body, unknownHost.body);
    assert.equal(
      failedLookup.headers['content-security-policy'],
      unknownHost.headers['content-security-policy']
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].code, 'GENERATED_APP_PROJECT_LOOKUP_FAILED');
  } finally {
    console.error = previousConsoleError;
  }
});

test('missing generated domain disables generated preview serving', async () => {
  delete process.env.GENERATED_APP_DOMAIN;

  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_ID)}`,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(buildQueries.length, 0);
});

test('legacy preview host and normal build publication access remain unchanged', async () => {
  const legacyPreview = await request({
    path: `${buildPath(PROJECT_B_ID, BUILD_B_ID)}?previewToken=${validToken(PROJECT_B_ID, BUILD_B_ID)}`,
    headers: {
      Host: 'preview.askfluid.now',
    },
  });
  const publishedBuild = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID),
    headers: {
      Host: 'apps.askfluid.now',
    },
  });

  assert.equal(legacyPreview.statusCode, 200);
  assert.match(legacyPreview.body, /project-b/);
  assert.equal(publishedBuild.statusCode, 200);
  assert.match(publishedBuild.body, /project-a-requested/);
  assert.equal(publishedBuild.headers.deprecation, 'true');
});
