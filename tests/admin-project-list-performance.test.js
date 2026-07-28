const assert = require('assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

process.env.BUILD_PREVIEW_SECRET = 'admin-project-list-performance-secret';
process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';

const Project = require('../models/Project');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const adminRoutes = require('../routes/adminRoutes');
const { requireAdmin, getRouteMetadata } = require('../middleware/adminAuth');
const { verifyBuildPreviewToken } = require('../utils/buildPreviewAccess');

const PROJECT_ID = '64f000000000000000000301';
const USER_ID = '64f000000000000000000302';
const BUILD_ID = '64f000000000000000000303';
const PUBLIC_HOST_KEY = 'cccccccccccccccccccccccccccccccc';
const PREVIEW_PATH = `/builds/${PROJECT_ID}/${BUILD_ID}/index.html`;
const HEAVY_TEXT = 'x'.repeat(3 * 1024 * 1024);
const HEAVY_FIELDS = [
  'build',
  'response',
  'html',
  'css',
  'js',
  'fullHtml',
  'latestFullHtml',
  'pages',
  'components',
  'files',
  'artifactFiles',
  'sourceFiles',
  'artifactFilesSource',
  'indexedFiles',
  'logs',
  'sourceZipUrl',
];

function getRouteLayer(pathname, method) {
  const layer = adminRoutes.stack.find((item) => (
    item.route?.path === pathname && item.route?.methods?.[method]
  ));

  assert.ok(layer, `Missing ${method.toUpperCase()} ${pathname}`);
  return layer;
}

function getFinalRouteHandler(pathname, method) {
  const layer = getRouteLayer(pathname, method);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

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

function createQuery(result, capture = {}) {
  return {
    select(projection) {
      capture.projection = projection;
      return this;
    },
    lean() {
      capture.lean = true;
      return this;
    },
    sort(sort) {
      capture.sort = sort;
      return this;
    },
    limit(limit) {
      capture.limit = limit;
      return this;
    },
    then(resolve, reject) {
      const value = Array.isArray(result) && capture.limit
        ? result.slice(0, capture.limit)
        : result;
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function buildRequest(query = {}) {
  return {
    query,
    protocol: 'https',
    get: () => 'backend.example.test',
  };
}

function heavyProjectFixture(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(PROJECT_ID),
    userId: new mongoose.Types.ObjectId(USER_ID),
    name: 'Admin compact project',
    title: 'Admin compact title',
    appName: 'AdminCompact',
    appNameSource: 'generated',
    appNameLocked: false,
    slug: 'admin-compact-project',
    publishedAt: new Date('2026-07-28T12:00:00Z'),
    isPublished: true,
    runtimeEnabled: true,
    visibility: 'public',
    seo: { title: 'Admin SEO', description: 'SEO description' },
    description: 'Admin card description.',
    summary: 'Small admin summary.',
    prompt: 'Build an admin compact project.',
    type: 'web-app',
    status: 'done',
    buildMode: 'automatic',
    generationStatus: 'done',
    generation_status: 'done',
    publish: true,
    briefingSessionId: new mongoose.Types.ObjectId('64f000000000000000000304'),
    settings: { theme: 'light', primaryColor: '#2563eb', language: 'pt-BR' },
    deploy: {
      isPublished: true,
      url: 'https://preview.askfluid.now/p/admin-compact-project',
      provider: 'fluid',
      publishedAt: new Date('2026-07-28T12:00:00Z'),
    },
    distUrl: PREVIEW_PATH,
    previewUrl: PREVIEW_PATH,
    buildUrl: PREVIEW_PATH,
    deployUrl: PREVIEW_PATH,
    latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_ID),
    reactVite: true,
    requiredConnectors: [{ provider: 'stripe', status: 'connected' }],
    metadata: { lastBuildAt: new Date('2026-07-28T12:00:00Z'), buildCount: 4 },
    ownerDeleted: false,
    accountDeleted: false,
    createdAt: new Date('2026-07-27T12:00:00Z'),
    updatedAt: new Date('2026-07-28T12:00:00Z'),
    publicHostKey: PUBLIC_HOST_KEY,
    response: HEAVY_TEXT,
    html: HEAVY_TEXT,
    css: HEAVY_TEXT,
    js: HEAVY_TEXT,
    fullHtml: HEAVY_TEXT,
    latestFullHtml: HEAVY_TEXT,
    pages: [{ html: HEAVY_TEXT }],
    components: [{ code: HEAVY_TEXT }],
    files: [{ path: 'src/main.jsx', content: HEAVY_TEXT }],
    artifactFiles: [{ relativePath: 'assets/app.js', content: HEAVY_TEXT }],
    sourceFiles: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
    artifactFilesSource: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
    indexedFiles: [{ path: 'src/main.jsx', excerpt: HEAVY_TEXT }],
    logs: HEAVY_TEXT,
    sourceZipUrl: `/builds/${PROJECT_ID}/${BUILD_ID}/source.zip`,
    build: {
      _id: new mongoose.Types.ObjectId(BUILD_ID),
      type: 'react_vite',
      status: 'done',
      previewUrl: PREVIEW_PATH,
      artifactFiles: [{ relativePath: 'assets/app.js', content: HEAVY_TEXT }],
      sourceFiles: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
      artifactFilesSource: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
      indexedFiles: [{ path: 'src/main.jsx', excerpt: HEAVY_TEXT }],
      logs: HEAVY_TEXT,
      sourceZipUrl: `/builds/${PROJECT_ID}/${BUILD_ID}/source.zip`,
    },
    ...overrides,
  };
}

function assertCanonicalPreviewUrl(value) {
  const url = new URL(value);

  assert.equal(url.origin, `https://pv-${PUBLIC_HOST_KEY}.fluidapps.dev`);
  assert.equal(url.pathname, PREVIEW_PATH);
  assert.equal(
    verifyBuildPreviewToken(url.searchParams.get('previewToken'), PROJECT_ID, BUILD_ID),
    true
  );
}

test('GET /api/admin/projects uses a lean compact projection and preserves list compatibility', async () => {
  const handler = getFinalRouteHandler('/projects', 'get');
  const originalFind = Project.find;
  const originalAggregate = ProjectChangeRequest.aggregate;
  const capture = {};
  const heavyProject = heavyProjectFixture();
  const heavyPayloadBytes = Buffer.byteLength(JSON.stringify([heavyProject]));

  try {
    Project.find = (...args) => {
      capture.findArgs = args;
      return createQuery([
        heavyProject,
        heavyProjectFixture({ _id: new mongoose.Types.ObjectId('64f000000000000000000399') }),
      ], capture);
    };

    ProjectChangeRequest.aggregate = async (pipeline) => {
      capture.pipeline = pipeline;
      return [{ _id: heavyProject._id, count: 7 }];
    };

    const res = createResponse();
    await handler(buildRequest({ limit: '1', status: 'done', $where: 'sleep(1000)' }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(capture.findArgs, []);
    assert.equal(capture.lean, true);
    assert.equal(capture.limit, 1);
    assert.deepEqual(capture.sort, { updatedAt: -1, createdAt: -1 });
    assert.match(capture.projection, /\buserId\b/);
    assert.match(capture.projection, /\bmetadata\b/);
    assert.match(capture.projection, /\+publicHostKey\b/);
    assert.doesNotMatch(
      capture.projection,
      /\bbuild\b|\bresponse\b|\bhtml\b|\bfullHtml\b|\bsourceFiles\b|\bartifactFiles\b|\blogs\b|\bsourceZipUrl\b/
    );
    assert.deepEqual(capture.pipeline, [
      {
        $match: {
          status: 'pending',
          projectId: { $in: [heavyProject._id] },
        },
      },
      {
        $group: {
          _id: '$projectId',
          count: { $sum: 1 },
        },
      },
    ]);

    assert.equal(res.body.success, true);
    assert.equal(res.body.limit, 1);
    assert.equal(res.body.projects.length, 1);

    const project = res.body.projects[0];
    assert.equal(project.id, PROJECT_ID);
    assert.equal(String(project._id), PROJECT_ID);
    assert.equal(String(project.userId), USER_ID);
    assert.equal(project.name, 'Admin compact project');
    assert.equal(project.title, 'Admin compact title');
    assert.equal(project.appName, 'AdminCompact');
    assert.equal(project.description, 'Admin card description.');
    assert.equal(project.summary, 'Small admin summary.');
    assert.equal(project.prompt, 'Build an admin compact project.');
    assert.equal(project.status, 'done');
    assert.equal(project.buildMode, 'automatic');
    assert.equal(project.generationStatus, 'done');
    assert.equal(project.generation_status, 'done');
    assert.equal(project.isPublished, true);
    assert.equal(project.publicUrl, 'https://preview.askfluid.now/p/admin-compact-project');
    assert.equal(project.pendingChangeRequestCount, 7);
    assert.deepEqual(project.requiredConnectors, [{ provider: 'stripe', status: 'connected' }]);
    assert.deepEqual(project.settings, { theme: 'light', primaryColor: '#2563eb', language: 'pt-BR' });
    assert.deepEqual(project.metadata.buildCount, 4);
    assert.equal(Object.hasOwn(project, 'publicHostKey'), false);
    assertCanonicalPreviewUrl(project.previewUrl);
    assertCanonicalPreviewUrl(project.buildUrl);
    assertCanonicalPreviewUrl(project.distUrl);
    assertCanonicalPreviewUrl(project.deployUrl);

    for (const field of HEAVY_FIELDS) {
      assert.equal(Object.hasOwn(project, field), false, `${field} must be excluded`);
    }

    const responseBytes = Buffer.byteLength(JSON.stringify(res.body));
    assert.ok(heavyPayloadBytes > 35 * 1024 * 1024);
    assert.ok(responseBytes < 8 * 1024);
    assert.equal(JSON.stringify(res.body).includes(HEAVY_TEXT.slice(0, 100)), false);
  } finally {
    Project.find = originalFind;
    ProjectChangeRequest.aggregate = originalAggregate;
  }
});

test('GET /api/admin/projects route still uses admin auth and admin:read metadata', () => {
  const layer = getRouteLayer('/projects', 'get');
  const metadata = getRouteMetadata({
    method: 'GET',
    originalUrl: '/api/admin/projects',
    url: '/projects',
    params: {},
  });

  assert.equal(layer.route.stack[0].handle, requireAdmin);
  assert.equal(metadata.permission, 'admin:read');
  assert.equal(metadata.resourceType, 'project');
  assert.equal(metadata.critical, false);
  assert.equal(metadata.recentReauthRequired, false);
});
