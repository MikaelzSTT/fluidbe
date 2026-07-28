const assert = require('assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

process.env.BUILD_PREVIEW_SECRET = 'builder-build-state-preview-secret';
process.env.GENERATED_APP_DOMAIN = 'fluidapps.dev';
process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';

const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const projectRoutes = require('../routes/projectRoutes');
const adminRoutes = require('../routes/adminRoutes');
const { verifyBuildPreviewToken } = require('../utils/buildPreviewAccess');

const PROJECT_ID = '64f000000000000000000101';
const USER_ID = '64f000000000000000000102';
const OTHER_USER_ID = '64f000000000000000000103';
const BUILD_A_ID = '64f000000000000000000111';
const BUILD_B_ID = '64f000000000000000000112';
const BUILD_C_ID = '64f000000000000000000113';
const PUBLIC_HOST_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function getFinalRouteHandler(router, pathname, method) {
  const layer = router.stack.find((item) => (
    item.route?.path === pathname &&
    item.route?.methods?.[method]
  ));

  assert.ok(layer, `Missing ${method.toUpperCase()} ${pathname}`);
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

function buildDocument(buildId, label) {
  const previewUrl = `/builds/${PROJECT_ID}/${buildId}/index.html`;

  return {
    _id: new mongoose.Types.ObjectId(buildId),
    projectId: new mongoose.Types.ObjectId(PROJECT_ID),
    status: 'done',
    type: 'react_vite',
    fullHtml: `<main>${label}</main>`,
    distUrl: previewUrl,
    previewUrl,
    buildUrl: previewUrl,
    deployUrl: previewUrl,
  };
}

async function withGeneratedAppDomain(value, fn) {
  const previousValue = process.env.GENERATED_APP_DOMAIN;

  if (value === undefined) {
    delete process.env.GENERATED_APP_DOMAIN;
  } else {
    process.env.GENERATED_APP_DOMAIN = value;
  }

  try {
    return await fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env.GENERATED_APP_DOMAIN;
    } else {
      process.env.GENERATED_APP_DOMAIN = previousValue;
    }
  }
}

function assertGeneratedPreviewUrl(value, buildId) {
  const url = new URL(value);
  assert.equal(url.origin, `https://pv-${PUBLIC_HOST_KEY}.fluidapps.dev`);
  assert.equal(url.pathname, `/builds/${PROJECT_ID}/${buildId}/index.html`);
  const previewToken = url.searchParams.get('previewToken');
  assert.ok(previewToken);
  assert.equal(verifyBuildPreviewToken(previewToken, PROJECT_ID, buildId), true);
  return previewToken;
}

function assertLegacyPreviewUrl(value, buildId) {
  const url = new URL(value);
  assert.equal(url.origin, 'https://preview.askfluid.now');
  assert.equal(url.pathname, `/builds/${PROJECT_ID}/${buildId}/index.html`);
  assert.equal(verifyBuildPreviewToken(url.searchParams.get('previewToken'), PROJECT_ID, buildId), true);
}

function buildRequest(userId = USER_ID) {
  return {
    params: { id: PROJECT_ID },
    userId,
    protocol: 'https',
    get: () => 'backend.example.test',
  };
}

async function runBuilderBuild(handler, userId = USER_ID) {
  const res = createResponse();
  await handler(buildRequest(userId), res);
  return res;
}

test('Builder build contract supports repeated ready and loading transitions', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/:id/build', 'get');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;
  const builds = new Map([
    [BUILD_A_ID, buildDocument(BUILD_A_ID, 'A')],
    [BUILD_B_ID, buildDocument(BUILD_B_ID, 'B')],
    [BUILD_C_ID, buildDocument(BUILD_C_ID, 'C')],
  ]);
  const project = {
    _id: new mongoose.Types.ObjectId(PROJECT_ID),
    userId: new mongoose.Types.ObjectId(USER_ID),
    name: 'Repeated revisions',
    status: 'done',
    generationStatus: 'done',
    generation_status: 'done',
    latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_A_ID),
    publicHostKey: PUBLIC_HOST_KEY,
    reactVite: true,
    previewUrl: builds.get(BUILD_A_ID).previewUrl,
    buildUrl: builds.get(BUILD_A_ID).buildUrl,
    fullHtml: builds.get(BUILD_A_ID).fullHtml,
  };
  const buildQueries = [];

  try {
    Project.findOne = async (query) => (
      String(query._id) === PROJECT_ID && String(query.userId) === USER_ID
        ? project
        : null
    );
    ProjectBuild.findOne = async (query) => {
      buildQueries.push(query);
      return builds.get(String(query._id)) || null;
    };

    const readyA = await runBuilderBuild(handler);
    assert.equal(readyA.statusCode, 200);
    assert.equal(readyA.body.status, 'done');
    assert.equal(readyA.body.buildId, BUILD_A_ID);
    assert.equal(readyA.body.previewReady, true);
    assert.match(readyA.body.fullHtml, />A</);
    const tokenA = assertGeneratedPreviewUrl(readyA.body.previewUrl, BUILD_A_ID);
    assert.equal(builds.get(BUILD_A_ID).previewUrl, `/builds/${PROJECT_ID}/${BUILD_A_ID}/index.html`);

    project.status = 'in_progress';
    project.generationStatus = 'in_progress';
    project.generation_status = 'in_progress';
    const loadingAfterA = await runBuilderBuild(handler);
    assert.equal(loadingAfterA.body.status, 'in_progress');
    assert.equal(loadingAfterA.body.buildId, null);
    assert.equal(loadingAfterA.body.previewReady, false);
    assert.equal(Object.hasOwn(loadingAfterA.body, 'previewUrl'), false);
    assert.equal(buildQueries.length, 1);

    Object.assign(project, {
      status: 'done',
      generationStatus: 'done',
      generation_status: 'done',
      latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_B_ID),
      previewUrl: builds.get(BUILD_B_ID).previewUrl,
      buildUrl: builds.get(BUILD_B_ID).buildUrl,
      fullHtml: builds.get(BUILD_B_ID).fullHtml,
    });
    const readyB = await runBuilderBuild(handler);
    assert.equal(readyB.body.status, 'done');
    assert.equal(readyB.body.buildId, BUILD_B_ID);
    assert.notEqual(readyB.body.buildId, readyA.body.buildId);
    assert.match(readyB.body.fullHtml, />B</);
    const tokenB = assertGeneratedPreviewUrl(readyB.body.previewUrl, BUILD_B_ID);
    assert.notEqual(readyB.body.previewUrl, readyA.body.previewUrl);
    assert.notEqual(tokenB, tokenA);
    assert.equal(new URL(readyB.body.build.previewUrl).pathname, `/builds/${PROJECT_ID}/${BUILD_B_ID}/index.html`);

    project.status = 'in_progress';
    project.generationStatus = 'in_progress';
    project.generation_status = 'in_progress';
    const loadingAfterB = await runBuilderBuild(handler);
    assert.equal(loadingAfterB.body.status, 'in_progress');
    assert.equal(loadingAfterB.body.buildId, null);
    assert.equal(loadingAfterB.body.previewReady, false);
    assert.equal(buildQueries.length, 2);

    Object.assign(project, {
      status: 'done',
      generationStatus: 'done',
      generation_status: 'done',
      latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_C_ID),
      previewUrl: builds.get(BUILD_C_ID).previewUrl,
      buildUrl: builds.get(BUILD_C_ID).buildUrl,
      fullHtml: builds.get(BUILD_C_ID).fullHtml,
    });
    const readyC = await runBuilderBuild(handler);
    assert.equal(readyC.body.status, 'done');
    assert.equal(readyC.body.buildId, BUILD_C_ID);
    assert.notEqual(readyC.body.buildId, readyB.body.buildId);
    assert.match(readyC.body.fullHtml, />C</);

    assert.deepEqual(
      buildQueries.map((query) => String(query._id)),
      [BUILD_A_ID, BUILD_B_ID, BUILD_C_ID]
    );
    assert.ok(buildQueries.every((query) => (
      String(query.projectId) === PROJECT_ID && query.status === 'done'
    )));
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('Builder build contract falls back to legacy preview origin without generated domain', async () => {
  await withGeneratedAppDomain(undefined, async () => {
    const handler = getFinalRouteHandler(projectRoutes, '/:id/build', 'get');
    const originalProjectFindOne = Project.findOne;
    const originalBuildFindOne = ProjectBuild.findOne;

    try {
      Project.findOne = async () => ({
        _id: new mongoose.Types.ObjectId(PROJECT_ID),
        generationStatus: 'done',
        publicHostKey: PUBLIC_HOST_KEY,
        reactVite: true,
        latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_A_ID),
      });
      ProjectBuild.findOne = async () => buildDocument(BUILD_A_ID, 'A');

      const res = await runBuilderBuild(handler);
      assert.equal(res.statusCode, 200);
      assertLegacyPreviewUrl(res.body.previewUrl, BUILD_A_ID);
    } finally {
      Project.findOne = originalProjectFindOne;
      ProjectBuild.findOne = originalBuildFindOne;
    }
  });
});

test('Builder build contract falls back to legacy preview origin without valid publicHostKey', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/:id/build', 'get');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;

  try {
    Project.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(PROJECT_ID),
      generationStatus: 'done',
      publicHostKey: 'not-valid',
      reactVite: true,
      latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_A_ID),
    });
    ProjectBuild.findOne = async () => buildDocument(BUILD_A_ID, 'A');

    const res = await runBuilderBuild(handler);
    assert.equal(res.statusCode, 200);
    assertLegacyPreviewUrl(res.body.previewUrl, BUILD_A_ID);
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('Project hydration returns canonical generated preview URL without exposing publicHostKey', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/:id', 'get');
  const originalProjectFindOne = Project.findOne;

  try {
    Project.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(PROJECT_ID),
      userId: new mongoose.Types.ObjectId(USER_ID),
      publicHostKey: PUBLIC_HOST_KEY,
      reactVite: true,
      previewUrl: `/builds/${PROJECT_ID}/${BUILD_A_ID}/index.html`,
      buildUrl: `/builds/${PROJECT_ID}/${BUILD_A_ID}/index.html`,
      build: buildDocument(BUILD_A_ID, 'A'),
    });

    const res = createResponse();
    await handler({
      params: { id: PROJECT_ID },
      projectObjectId: new mongoose.Types.ObjectId(PROJECT_ID),
      userId: USER_ID,
      protocol: 'https',
      get: () => 'backend.example.test',
    }, res);

    assert.equal(res.statusCode, 200);
    assertGeneratedPreviewUrl(res.body.previewUrl, BUILD_A_ID);
    assert.equal(Object.hasOwn(res.body, 'publicHostKey'), false);
  } finally {
    Project.findOne = originalProjectFindOne;
  }
});

test('Project list response uses canonical generated preview URL for React/Vite thumbnails', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/', 'get');
  const originalProjectFind = Project.find;

  try {
    Project.find = () => ({
      select() {
        return this;
      },
      sort: async () => [{
        _id: new mongoose.Types.ObjectId(PROJECT_ID),
        userId: new mongoose.Types.ObjectId(USER_ID),
        publicHostKey: PUBLIC_HOST_KEY,
        reactVite: true,
        previewUrl: `/builds/${PROJECT_ID}/${BUILD_A_ID}/index.html`,
        build: buildDocument(BUILD_A_ID, 'A'),
      }],
    });

    const res = createResponse();
    await handler(buildRequest(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(Array.isArray(res.body), true);
    assertGeneratedPreviewUrl(res.body[0].previewUrl, BUILD_A_ID);
    assert.equal(Object.hasOwn(res.body[0], 'publicHostKey'), false);
  } finally {
    Project.find = originalProjectFind;
  }
});

test('Builder build contract does not replace an explicit published build with a newer done build', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/:id/build', 'get');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;
  let capturedBuildQuery;

  try {
    Project.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(PROJECT_ID),
      generationStatus: 'done',
      latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_A_ID),
    });
    ProjectBuild.findOne = async (query) => {
      capturedBuildQuery = query;
      return buildDocument(BUILD_A_ID, 'A');
    };

    const res = await runBuilderBuild(handler);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.buildId, BUILD_A_ID);
    assert.equal(String(capturedBuildQuery._id), BUILD_A_ID);
    assert.equal(capturedBuildQuery.createdAt, undefined);
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('Builder build contract preserves project ownership boundary', async () => {
  const handler = getFinalRouteHandler(projectRoutes, '/:id/build', 'get');
  const originalProjectFindOne = Project.findOne;
  const originalBuildFindOne = ProjectBuild.findOne;
  let buildQueried = false;

  try {
    Project.findOne = async (query) => (
      String(query.userId) === USER_ID
        ? { _id: new mongoose.Types.ObjectId(PROJECT_ID), generationStatus: 'done' }
        : null
    );
    ProjectBuild.findOne = () => {
      buildQueried = true;
      throw new Error('Build lookup must not run for another owner.');
    };

    const res = await runBuilderBuild(handler, OTHER_USER_ID);

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Projeto não encontrado.' });
    assert.equal(buildQueried, false);
  } finally {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});

test('Admin status handler supports repeated loading and done cycles with distinct build identities', async () => {
  const handler = getFinalRouteHandler(adminRoutes, '/projects/:id/status', 'patch');
  const originalFindById = Project.findById;
  const originalFindByIdAndUpdate = Project.findByIdAndUpdate;
  const originalBuildFindOne = ProjectBuild.findOne;
  const updates = [];
  const pendingBuilds = [
    buildDocument(BUILD_B_ID, 'B'),
    buildDocument(BUILD_C_ID, 'C'),
  ].map((build) => ({
    ...build,
    status: 'draft',
    async save() {
      return this;
    },
  }));
  let project = {
    _id: new mongoose.Types.ObjectId(PROJECT_ID),
    latestPublishedBuildId: new mongoose.Types.ObjectId(BUILD_A_ID),
    status: 'done',
    generationStatus: 'done',
    generation_status: 'done',
  };

  try {
    Project.findById = async () => project;
    Project.findByIdAndUpdate = async (id, update) => {
      updates.push(update);
      project = {
        ...project,
        _id: id,
        ...update,
      };
      return project;
    };
    ProjectBuild.findOne = () => ({
      sort: async () => pendingBuilds.shift() || null,
    });

    async function setAdminStatus(generationStatus) {
      const req = {
        params: { id: PROJECT_ID },
        body: { generationStatus },
      };
      const res = createResponse();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      return res.body.project;
    }

    const loadingAfterA = await setAdminStatus('in_progress');
    assert.equal(loadingAfterA.generationStatus, 'in_progress');
    assert.equal(String(loadingAfterA.latestPublishedBuildId), BUILD_A_ID);

    const readyB = await setAdminStatus('done');
    assert.equal(readyB.generationStatus, 'done');
    assert.equal(String(readyB.latestPublishedBuildId), BUILD_B_ID);

    const loadingAfterB = await setAdminStatus('in_progress');
    assert.equal(loadingAfterB.generationStatus, 'in_progress');
    assert.equal(String(loadingAfterB.latestPublishedBuildId), BUILD_B_ID);

    const readyC = await setAdminStatus('done');
    assert.equal(readyC.generationStatus, 'done');
    assert.equal(String(readyC.latestPublishedBuildId), BUILD_C_ID);

    assert.equal(updates.length, 4);
    assert.equal(updates[0].latestPublishedBuildId, undefined);
    assert.equal(String(updates[1].latestPublishedBuildId), BUILD_B_ID);
    assert.equal(updates[2].latestPublishedBuildId, undefined);
    assert.equal(String(updates[3].latestPublishedBuildId), BUILD_C_ID);
    assert.equal(updates[0].previewUrl, undefined);
    assert.equal(updates[2].previewUrl, undefined);
    assert.equal(pendingBuilds.length, 0);
  } finally {
    Project.findById = originalFindById;
    Project.findByIdAndUpdate = originalFindByIdAndUpdate;
    ProjectBuild.findOne = originalBuildFindOne;
  }
});
