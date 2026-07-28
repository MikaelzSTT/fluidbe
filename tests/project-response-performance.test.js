const assert = require('assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

process.env.BUILD_PREVIEW_SECRET = 'project-response-performance-secret';
process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';

const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectMessage = require('../models/ProjectMessage');
const projectRoutes = require('../routes/projectRoutes');
const { verifyBuildPreviewToken } = require('../utils/buildPreviewAccess');

const PROJECT_ID = '64f000000000000000000201';
const USER_ID = '64f000000000000000000202';
const OTHER_USER_ID = '64f000000000000000000203';
const BUILD_ID = '64f000000000000000000211';
const PUBLIC_HOST_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREVIEW_PATH = `/builds/${PROJECT_ID}/${BUILD_ID}/index.html`;
const HEAVY_TEXT = 'x'.repeat(3 * 1024 * 1024);
const HEAVY_FIELDS = [
  'artifactFiles',
  'sourceFiles',
  'indexedFiles',
  'artifactFilesSource',
  'logs',
  'sourceZipUrl',
];

function getFinalRouteHandler(pathname) {
  const layer = projectRoutes.stack.find((item) => (
    item.route?.path === pathname &&
    item.route?.methods?.get
  ));

  assert.ok(layer, `Missing GET ${pathname}`);
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
    catch(reject) {
      return this.then((value) => value).catch(reject);
    },
  };
}

function buildRequest(userId = USER_ID) {
  return {
    params: { id: PROJECT_ID },
    query: {},
    projectObjectId: new mongoose.Types.ObjectId(PROJECT_ID),
    userId,
    protocol: 'https',
    get: () => 'backend.example.test',
  };
}

function heavyProjectFixture() {
  return {
    _id: new mongoose.Types.ObjectId(PROJECT_ID),
    userId: new mongoose.Types.ObjectId(USER_ID),
    name: 'Compact project',
    title: 'Compact project title',
    appName: 'Compact',
    slug: 'compact-project',
    description: 'A compact project response.',
    prompt: 'Build a compact project.',
    type: 'web-app',
    status: 'done',
    buildMode: 'automatic',
    generationStatus: 'done',
    generation_status: 'done',
    isPublished: true,
    publishedAt: new Date('2026-07-28T12:00:00Z'),
    latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_ID),
    publicHostKey: PUBLIC_HOST_KEY,
    reactVite: true,
    previewUrl: PREVIEW_PATH,
    buildUrl: PREVIEW_PATH,
    requiredConnectors: [{ provider: 'stripe', status: 'connected' }],
    settings: { theme: 'light', primaryColor: '#2563eb', language: 'pt-BR' },
    metadata: { buildCount: 4 },
    createdAt: new Date('2026-07-27T12:00:00Z'),
    updatedAt: new Date('2026-07-28T12:00:00Z'),
    response: HEAVY_TEXT,
    html: HEAVY_TEXT,
    css: HEAVY_TEXT,
    js: HEAVY_TEXT,
    fullHtml: HEAVY_TEXT,
    latestFullHtml: HEAVY_TEXT,
    files: [{ path: 'src/main.jsx', content: HEAVY_TEXT }],
    pages: [{ html: HEAVY_TEXT }],
    build: {
      _id: new mongoose.Types.ObjectId(BUILD_ID),
      projectId: new mongoose.Types.ObjectId(PROJECT_ID),
      type: 'react_vite',
      status: 'done',
      previewUrl: PREVIEW_PATH,
      buildUrl: PREVIEW_PATH,
      artifactFiles: [{ relativePath: 'assets/app.js', content: HEAVY_TEXT }],
      sourceFiles: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
      indexedFiles: [{ path: 'src/main.jsx', excerpt: HEAVY_TEXT }],
      logs: HEAVY_TEXT,
    },
  };
}

function heavyBuildFixture() {
  return {
    _id: new mongoose.Types.ObjectId(BUILD_ID),
    projectId: new mongoose.Types.ObjectId(PROJECT_ID),
    buildJobId: new mongoose.Types.ObjectId('64f000000000000000000212'),
    type: 'react_vite',
    status: 'done',
    previewUrl: PREVIEW_PATH,
    buildUrl: PREVIEW_PATH,
    distUrl: PREVIEW_PATH,
    deployUrl: PREVIEW_PATH,
    fullHtml: HEAVY_TEXT,
    html: HEAVY_TEXT,
    css: HEAVY_TEXT,
    js: HEAVY_TEXT,
    artifactFiles: [{ relativePath: 'assets/app.js', content: HEAVY_TEXT }],
    sourceFiles: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
    indexedFiles: [{ path: 'src/main.jsx', excerpt: HEAVY_TEXT }],
    artifactFilesSource: [{ relativePath: 'src/main.jsx', content: HEAVY_TEXT }],
    logs: HEAVY_TEXT,
    sourceZipUrl: `/builds/${PROJECT_ID}/${BUILD_ID}/source.zip`,
    createdAt: new Date('2026-07-28T11:00:00Z'),
    updatedAt: new Date('2026-07-28T12:00:00Z'),
  };
}

function assertCompactProject(payload) {
  assert.equal(payload.name, 'Compact project');
  assert.equal(payload.title, 'Compact project title');
  assert.equal(payload.prompt, 'Build a compact project.');
  assert.equal(payload.status, 'done');
  assert.equal(payload.buildMode, 'automatic');
  assert.equal(payload.isPublished, true);
  assert.equal(String(payload.latestPublishedBuildId), BUILD_ID);
  assert.equal(Object.hasOwn(payload, 'publicHostKey'), false);

  for (const field of [
    'build',
    'response',
    'html',
    'css',
    'js',
    'fullHtml',
    'latestFullHtml',
    'files',
    'pages',
  ]) {
    assert.equal(Object.hasOwn(payload, field), false, `${field} must be excluded`);
  }
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

test('GET /api/projects uses a lean compact projection and keeps card fields and preview URL', async () => {
  const handler = getFinalRouteHandler('/');
  const originalFind = Project.find;
  const capture = {};

  try {
    Project.find = (query) => {
      capture.query = query;
      return createQuery([heavyProjectFixture()], capture);
    };

    const res = createResponse();
    await handler(buildRequest(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(String(capture.query.userId), USER_ID);
    assert.equal(capture.lean, true);
    assert.deepEqual(capture.sort, { createdAt: -1 });
    assert.match(capture.projection, /\bname\b/);
    assert.match(capture.projection, /\bprompt\b/);
    assert.match(capture.projection, /\bpreviewUrl\b/);
    assert.doesNotMatch(capture.projection, /\bfullHtml\b|\bsourceFiles\b|\bartifactFiles\b/);
    assertCompactProject(res.body[0]);
    assertCanonicalPreviewUrl(res.body[0].previewUrl);
    assert.ok(Buffer.byteLength(JSON.stringify(res.body)) < 8 * 1024);
  } finally {
    Project.find = originalFind;
  }
});

test('GET /api/projects/:id uses a lean compact detail projection', async () => {
  const handler = getFinalRouteHandler('/:id');
  const originalFindOne = Project.findOne;
  const capture = {};

  try {
    Project.findOne = (query) => {
      capture.query = query;
      return createQuery(heavyProjectFixture(), capture);
    };

    const res = createResponse();
    await handler(buildRequest(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(String(capture.query._id), PROJECT_ID);
    assert.equal(String(capture.query.userId), USER_ID);
    assert.equal(capture.lean, true);
    assert.match(capture.projection, /\brequiredConnectors\b/);
    assert.match(capture.projection, /\bsettings\b/);
    assert.doesNotMatch(capture.projection, /\bfullHtml\b|\bfiles\b|\bbuild\./);
    assertCompactProject(res.body);
    assert.deepEqual(res.body.requiredConnectors, [{ provider: 'stripe', status: 'connected' }]);
    assert.deepEqual(res.body.settings, {
      theme: 'light',
      primaryColor: '#2563eb',
      language: 'pt-BR',
    });
    assert.ok(Buffer.byteLength(JSON.stringify(res.body)) < 8 * 1024);
  } finally {
    Project.findOne = originalFindOne;
  }
});

test('GET /api/projects/:id/build returns a compact build summary without build output', async () => {
  const handler = getFinalRouteHandler('/:id/build');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;
  const projectCapture = {};
  const buildCapture = {};

  try {
    Project.findOne = (query) => {
      projectCapture.query = query;
      return createQuery(heavyProjectFixture(), projectCapture);
    };
    ProjectBuild.findOne = (query) => {
      buildCapture.query = query;
      return createQuery(heavyBuildFixture(), buildCapture);
    };

    const res = createResponse();
    await handler(buildRequest(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'done');
    assert.equal(res.body.buildId, BUILD_ID);
    assert.equal(res.body.previewReady, true);
    assert.equal(projectCapture.lean, true);
    assert.match(projectCapture.projection, /\bstatus\b/);
    assert.match(projectCapture.projection, /\blatestPublishedBuildId\b/);
    assert.doesNotMatch(projectCapture.projection, /\bfullHtml\b|\bsourceFiles\b|\bartifactFiles\b/);
    assert.equal(buildCapture.lean, true);
    assert.match(buildCapture.projection, /\bprojectId\b/);
    assert.match(buildCapture.projection, /\bpreviewUrl\b/);
    assert.doesNotMatch(
      buildCapture.projection,
      /\bfullHtml\b|\bartifactFiles\b|\bsourceFiles\b|\bindexedFiles\b|\blogs\b/
    );
    assertCompactProject(res.body.project);
    assertCanonicalPreviewUrl(res.body.previewUrl);
    assert.equal(res.body.fullHtml, '');
    assert.equal(res.body.html, '');
    assert.equal(res.body.css, '');
    assert.equal(res.body.js, '');

    for (const field of HEAVY_FIELDS) {
      assert.equal(Object.hasOwn(res.body, field), false, `${field} must not be top-level`);
      assert.equal(Object.hasOwn(res.body.build, field), false, `${field} must not be in build`);
    }

    assert.ok(Buffer.byteLength(JSON.stringify(res.body)) < 12 * 1024);
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('GET /api/projects/:id/build narrowly loads inline code only for URL-less legacy HTML builds', async () => {
  const handler = getFinalRouteHandler('/:id/build');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;
  const projections = [];
  let buildQueryCount = 0;

  try {
    Project.findOne = () => createQuery({
      _id: new mongoose.Types.ObjectId(PROJECT_ID),
      status: 'done',
      generationStatus: 'done',
      generation_status: 'done',
      latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_ID),
    });
    ProjectBuild.findOne = () => {
      buildQueryCount += 1;
      const result = buildQueryCount === 1
        ? {
            _id: new mongoose.Types.ObjectId(BUILD_ID),
            projectId: new mongoose.Types.ObjectId(PROJECT_ID),
            type: 'full_html',
            status: 'done',
          }
        : {
            _id: new mongoose.Types.ObjectId(BUILD_ID),
            projectId: new mongoose.Types.ObjectId(PROJECT_ID),
            type: 'full_html',
            status: 'done',
            fullHtml: '<main>Legacy inline preview</main>',
          };
      const capture = {};
      projections.push(capture);
      return createQuery(result, capture);
    };

    const res = createResponse();
    await handler(buildRequest(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(buildQueryCount, 2);
    assert.match(res.body.fullHtml, /Legacy inline preview/);
    assert.equal(res.body.previewReady, true);
    assert.doesNotMatch(projections[0].projection, /\bfullHtml\b|\bhtml\b|\bcss\b|\bjs\b/);
    assert.match(projections[1].projection, /\bfullHtml\b/);
    assert.doesNotMatch(
      projections[1].projection,
      /\bartifactFiles\b|\bsourceFiles\b|\bindexedFiles\b|\blogs\b/
    );
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('GET /api/projects/:id/messages applies a bounded latest-first query and returns ascending messages', async () => {
  const handler = getFinalRouteHandler('/:id/messages');
  const originalProjectFindOne = Project.findOne;
  const originalMessageFind = ProjectMessage.find;
  const capture = {};
  const messages = Array.from({ length: 250 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId((index + 1).toString(16).padStart(24, '0')),
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index + 1}`,
    createdAt: new Date(Date.UTC(2026, 6, 28, 0, 0, index)),
  })).reverse();

  try {
    Project.findOne = () => createQuery({
      _id: new mongoose.Types.ObjectId(PROJECT_ID),
    });
    ProjectMessage.find = (query) => {
      capture.query = query;
      return createQuery(messages, capture);
    };

    const req = buildRequest();
    req.query.limit = '999';
    const res = createResponse();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(capture.limit, 201);
    assert.deepEqual(capture.sort, { createdAt: -1, _id: -1 });
    assert.equal(res.body.messages.length, 200);
    assert.equal(res.body.messages[0].content, 'message-51');
    assert.equal(res.body.messages[199].content, 'message-250');
    assert.deepEqual(res.body.pagination, {
      limit: 200,
      hasMore: true,
      nextCursor: res.body.pagination.nextCursor,
    });
    assert.ok(res.body.pagination.nextCursor);
    assert.equal(Object.hasOwn(res.body.messages[0], '_id'), false);
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectMessage.find = originalMessageFind;
  }
});

test('compact project detail preserves ownership isolation', async () => {
  const handler = getFinalRouteHandler('/:id');
  const originalFindOne = Project.findOne;

  try {
    Project.findOne = (query) => createQuery(
      String(query.userId) === USER_ID ? heavyProjectFixture() : null
    );

    const res = createResponse();
    await handler(buildRequest(OTHER_USER_ID), res);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Projeto não encontrado.' });
  } finally {
    Project.findOne = originalFindOne;
  }
});
