const assert = require('assert/strict');
const crypto = require('crypto');
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
const { assertJavaScriptParses } = require('../utils/buildAssetCapabilities');

const PROJECT_A_ID = '64f000000000000000000301';
const PROJECT_B_ID = '64f000000000000000000302';
const PROJECT_A_KEY = '0123456789abcdef0123456789abcdef';
const PROJECT_B_KEY = 'fedcba9876543210fedcba9876543210';
const BUILD_A_ID = '64f000000000000000000311';
const BUILD_A_NEWER_ID = '64f000000000000000000312';
const BUILD_B_ID = '64f000000000000000000321';
const PUBLIC_BUILDS_DIR = path.join(__dirname, '..', 'public', 'builds');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const MONGO_ENTRY_BODY = Buffer.from([
  'import "./mongo-chunk.js";',
  'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/mongo-vite-chunk.js","/builds/64f000000000000000000301/64f000000000000000000311/assets/mongo-root.js?from=mongo#root","/builds/64f000000000000000000301/other-build/assets/mongo-leak.js","https://cdn.example/mongo-preload.js"])))=>i.map(i=>d[i]);',
  'const logo = new URL("./mongo-logo.png?size=1#v", import.meta.url);',
  'const cdn = "https://cdn.example/mongo.js";',
  'export { logo, cdn };',
].join('\n'));

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
      {
        relativePath: 'mongo-entry.js',
        contentType: 'application/javascript; charset=utf-8',
        content: MONGO_ENTRY_BODY.toString('base64'),
        sha256: sha256(MONGO_ENTRY_BODY),
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
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: bodyBuffer.toString('utf8'),
            bodyBuffer,
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

function generatedPublishedHost(publicHostKey) {
  return `app-${publicHostKey}.fluidapps.dev`;
}

async function writeBuild(projectId, buildId, label) {
  const root = path.join(PUBLIC_BUILDS_DIR, projectId, buildId);
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets', 'images'), { recursive: true });
  await fs.mkdir(path.join(root, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'index.html'),
    [
      '<!doctype html><html><head>',
      `<link rel="stylesheet" href="./assets/app.css?theme=dark#sheet">`,
      '<link rel="stylesheet" href="/assets/app.css?root=1#rootsheet">',
      `<link rel="modulepreload" href="/builds/${projectId}/${buildId}/assets/chunk.js">`,
      `<script type="module" src="./assets/app.js"></script>`,
      '<script type="module" src="/assets/app.js?root=1#rootjs"></script>',
      `<script type="module" src="./assets/already.js?previewToken=existing#ready"></script>`,
      `<script type="module" src="/builds/${projectId}/${buildId}/assets/absolute.js?mode=prod#abs"></script>`,
      `<script type="module" src="https://pv-${PROJECT_A_KEY}.fluidapps.dev/builds/${projectId}/${buildId}/assets/generated-origin.js?x=1#origin"></script>`,
      `<script type="module" src="/builds/${projectId}/other-build/assets/leak.js"></script>`,
      `<script type="module" src="/builds/${PROJECT_B_ID}/${BUILD_B_ID}/assets/leak.js"></script>`,
      '<script type="module" src="https://cdn.example/app.js"></script>',
      '<script type="module" src="data:text/javascript,console.log(1)"></script>',
      '</head><body>',
      `<main>${label}</main>`,
      `<img src="./images/logo.png?size=small#hero">`,
      '<img src="/images/photo.jpg#rootphoto">',
      '</body></html>',
    ].join('')
  );
  await fs.writeFile(
    path.join(root, 'assets', 'app.js'),
    [
      'import "./chunk.js";',
      'import"./minified-static.js";',
      'import "./imported.css";',
      'import("./dynamic.js").then((mod) => mod.run());',
      'const chartLoader=()=>import("./charts-rVXgnjvt.js").then((mod)=>mod.render());',
      'export { value } from "./shared.js";',
      'export{icon}from"./icons-AbCdEf12.js";',
      'const workerUrl = new URL("./worker.js#worker", import.meta.url);',
      'const viteWorker = new Worker(new URL("worker-B7T9.js",import.meta.url),{type:"module"});',
      'const imageUrl = new URL("../images/logo.png?from=js#logo", import.meta.url);',
      'const rootPngUrl = new URL("/images/logo.png?root=1#root-logo", import.meta.url).href;',
      'const rootJpgUrl = new URL("/images/photo.jpg", import.meta.url).href;',
      'const rootWebpUrl = new URL("/images/card.webp", import.meta.url).href;',
      'const rootSvgUrl = new URL("/images/icon.svg", import.meta.url).href;',
      `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/charts-rVXgnjvt.js","assets/icons-AbCdEf12.js","./assets/from-dot.js","../images/logo.png#dep","/builds/${projectId}/${buildId}/assets/root.js?mode=prod#root","/builds/${projectId}/other-build/assets/leak.js","/builds/${PROJECT_B_ID}/${BUILD_B_ID}/assets/leak.js","https://cdn.example/preload.js","https://preview.askfluid.now/builds/${projectId}/${buildId}/assets/legacy.js","data:text/javascript,alert(1)","#section","ready"])))=>i.map(i=>d[i]);`,
      'const external = "https://cdn.example/external.js";',
      `document.body.dataset.build = "${label}";`,
      'export { workerUrl, viteWorker, imageUrl, rootPngUrl, rootJpgUrl, rootWebpUrl, rootSvgUrl, external, chartLoader };',
    ].join('\n')
  );
  await fs.writeFile(path.join(root, 'assets', 'chunk.js'), 'export const chunk = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'minified-static.js'), 'export const minifiedStatic = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'dynamic.js'), 'export function run() {}\n');
  await fs.writeFile(
    path.join(root, 'assets', 'charts-rVXgnjvt.js'),
    [
      'import{icon as i}from"./icons-AbCdEf12.js";',
      'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/icons-AbCdEf12.js","assets/not-fetched.js","ready"])))=>i.map(i=>d[i]);',
      'const ordinary="assets/charts-rVXgnjvt.js",escaped="assets\\/escaped.js",template=`assets/template.js`,regex=/assets\\/regex\\.js/,adjacent=i?"assets/ternary.js":"./literal.js";',
      'export function render(){return [i,ordinary,escaped,template,regex.source,adjacent,__vite__mapDeps([0])].join("|")}',
    ].join('\n')
  );
  await fs.writeFile(path.join(root, 'assets', 'shared.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'assets', 'icons-AbCdEf12.js'), 'export const icon = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'worker.js'), 'self.postMessage("ready");\n');
  await fs.writeFile(path.join(root, 'assets', 'worker-B7T9.js'), 'self.postMessage("vite-ready");\n');
  await fs.writeFile(path.join(root, 'assets', 'already.js'), 'export const already = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'absolute.js'), 'export const absolute = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'generated-origin.js'), 'export const origin = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'from-dot.js'), 'export const fromDot = true;\n');
  await fs.writeFile(path.join(root, 'assets', 'root.js'), 'export const root = true;\n');
  await fs.writeFile(
    path.join(root, 'assets', 'app.css'),
    [
      '@import "./imported.css";',
      '.hero{background:url("../images/logo.png?variant=hero#img")}',
      '.root-webp{background:url("/images/card.webp#card")}',
      '.root-svg{background:url("/images/icon.svg")}',
      '@font-face{font-family:"Test";src:url("./font.woff2#font") format("woff2")}',
      '@font-face{font-family:"TestWoff";src:url("./font.woff") format("woff")}',
      `.same-build{src:url("/builds/${projectId}/${buildId}/assets/root-font.woff2?mode=prod#font")}`,
      `.other-build{src:url("/builds/${projectId}/other-build/assets/leak.woff2")}`,
      `.other-project{src:url("/builds/${PROJECT_B_ID}/${BUILD_B_ID}/assets/leak.woff")}`,
      '.external{background:url("https://cdn.example/bg.png")}',
      '.data{background:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E)}',
    ].join('\n')
  );
  await fs.writeFile(
    path.join(root, 'assets', 'imported.css'),
    '.imported{background:url("../images/logo.png?from=imported")}\n'
  );
  await fs.writeFile(path.join(root, 'assets', 'font.woff2'), Buffer.from('font-bytes'));
  await fs.writeFile(path.join(root, 'assets', 'font.woff'), Buffer.from('font-woff-bytes'));
  await fs.writeFile(path.join(root, 'assets', 'root-font.woff2'), Buffer.from('root-font-bytes'));
  await fs.writeFile(path.join(root, 'images', 'logo.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]));
  await fs.writeFile(path.join(root, 'assets', 'images', 'logo.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]));
  await fs.writeFile(path.join(root, 'images', 'photo.jpg'), Buffer.from([
    0xff, 0xd8, 0xff, 0xd9,
  ]));
  await fs.writeFile(path.join(root, 'images', 'card.webp'), Buffer.from('RIFFxxxxWEBP'));
  await fs.writeFile(path.join(root, 'images', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
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

test('generated preview HTML tokenizes same-build assets and preserves URL boundaries', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const encodedToken = encodeURIComponent(token);
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${token}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(
    response.body,
    new RegExp(`href="\\.\\/assets\\/app\\.css\\?theme=dark&previewToken=${encodedToken}#sheet"`)
  );
  assert.match(
    response.body,
    new RegExp(`href="\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/app\\.css\\?root=1&previewToken=${encodedToken}#rootsheet"`)
  );
  assert.match(
    response.body,
    new RegExp(`href="\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/chunk\\.js\\?previewToken=${encodedToken}"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="\\.\\/assets\\/app\\.js\\?previewToken=${encodedToken}"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/app\\.js\\?root=1&previewToken=${encodedToken}#rootjs"`)
  );
  assert.match(
    response.body,
    /src="\.\/assets\/already\.js\?previewToken=existing#ready"/
  );
  assert.match(
    response.body,
    new RegExp(`src="\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/absolute\\.js\\?mode=prod&previewToken=${encodedToken}#abs"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="https:\\/\\/pv-${PROJECT_A_KEY}\\.fluidapps\\.dev\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/generated-origin\\.js\\?x=1&previewToken=${encodedToken}#origin"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="\\.\\/images\\/logo\\.png\\?size=small&previewToken=${encodedToken}#hero"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/photo\\.jpg\\?previewToken=${encodedToken}#rootphoto"`)
  );
  assert.match(response.body, /src="https:\/\/cdn\.example\/app\.js"/);
  assert.match(response.body, /src="data:text\/javascript,console\.log\(1\)"/);
  assert.match(
    response.body,
    new RegExp(`src="\\/builds\\/${PROJECT_A_ID}\\/other-build\\/assets\\/leak\\.js"`)
  );
  assert.match(
    response.body,
    new RegExp(`src="\\/builds\\/${PROJECT_B_ID}\\/${BUILD_B_ID}\\/assets\\/leak\\.js"`)
  );
  assert.equal((response.body.match(/previewToken=existing/g) || []).length, 1);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  assert.equal(response.headers['x-build-artifact-sha256'], sha256(response.bodyBuffer));
});

test('generated preview propagates capability through tokenized Vite entry to nested chunks', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const encodedToken = encodeURIComponent(token);
  const index = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${token}`,
  });

  assert.equal(index.statusCode, 200);
  assert.match(index.body, new RegExp(`src="\\.\\/assets\\/app\\.js\\?previewToken=${encodedToken}"`));

  const mainModule = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.js')}?previewToken=${token}`,
  });

  assert.equal(mainModule.statusCode, 200);
  assert.match(mainModule.body, new RegExp(`import\\("\\.\\/charts-rVXgnjvt\\.js\\?previewToken=${encodedToken}"\\)`));
  assert.match(mainModule.body, new RegExp(`"assets\\/charts-rVXgnjvt\\.js\\?previewToken=${encodedToken}"`));
  assert.match(mainModule.body, new RegExp(`"assets\\/icons-AbCdEf12\\.js\\?previewToken=${encodedToken}"`));

  const nestedChunk = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/charts-rVXgnjvt.js')}?previewToken=${token}`,
  });
  const tokenlessNestedChunk = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/charts-rVXgnjvt.js'),
  });

  assert.equal(nestedChunk.statusCode, 200);
  assert.match(nestedChunk.body, /export function render/);
  assert.doesNotThrow(() => assertJavaScriptParses(nestedChunk.body, 'assets/charts-rVXgnjvt.js'));
  assert.match(nestedChunk.body, new RegExp(`from"\\.\\/icons-AbCdEf12\\.js\\?previewToken=${encodedToken}"`));
  assert.match(nestedChunk.body, new RegExp(`"assets\\/icons-AbCdEf12\\.js\\?previewToken=${encodedToken}"`));
  assert.match(nestedChunk.body, /"ready"/);
  assert.doesNotMatch(nestedChunk.body, /ready\?previewToken/);
  assert.match(nestedChunk.body, /ordinary="assets\/charts-rVXgnjvt\.js"/);
  assert.match(nestedChunk.body, /template=`assets\/template\.js`/);
  assert.match(nestedChunk.body, /regex=\/assets\\\/regex\\\.js\//);
  assert.match(nestedChunk.body, /adjacent=i\?"assets\/ternary\.js":"\.\/literal\.js"/);
  assert.equal(tokenlessNestedChunk.statusCode, 404);
});

test('generated preview disk JS propagates static, dynamic, CSS, worker, and asset URLs', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const encodedToken = encodeURIComponent(token);
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.js')}?previewToken=${token}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, new RegExp(`import "\\.\\/chunk\\.js\\?previewToken=${encodedToken}";`));
  assert.match(response.body, new RegExp(`import"\\.\\/minified-static\\.js\\?previewToken=${encodedToken}";`));
  assert.match(response.body, new RegExp(`import "\\.\\/imported\\.css\\?previewToken=${encodedToken}";`));
  assert.match(response.body, new RegExp(`import\\("\\.\\/dynamic\\.js\\?previewToken=${encodedToken}"\\)`));
  assert.match(response.body, new RegExp(`import\\("\\.\\/charts-rVXgnjvt\\.js\\?previewToken=${encodedToken}"\\)`));
  assert.match(response.body, new RegExp(`from "\\.\\/shared\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`from"\\.\\/icons-AbCdEf12\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`new URL\\("\\.\\/worker\\.js\\?previewToken=${encodedToken}#worker", import\\.meta\\.url\\)`));
  assert.match(response.body, new RegExp(`new URL\\("worker-B7T9\\.js\\?previewToken=${encodedToken}",import\\.meta\\.url\\)`));
  assert.match(response.body, new RegExp(`new URL\\("\\.\\.\\/images\\/logo\\.png\\?from=js&previewToken=${encodedToken}#logo", import\\.meta\\.url\\)`));
  assert.match(response.body, new RegExp(`new URL\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/logo\\.png\\?root=1&previewToken=${encodedToken}#root-logo", import\\.meta\\.url\\)\\.href`));
  assert.match(response.body, new RegExp(`new URL\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/photo\\.jpg\\?previewToken=${encodedToken}", import\\.meta\\.url\\)\\.href`));
  assert.match(response.body, new RegExp(`new URL\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/card\\.webp\\?previewToken=${encodedToken}", import\\.meta\\.url\\)\\.href`));
  assert.match(response.body, new RegExp(`new URL\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/icon\\.svg\\?previewToken=${encodedToken}", import\\.meta\\.url\\)\\.href`));
  assert.match(response.body, new RegExp(`"assets\\/charts-rVXgnjvt\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`"assets\\/icons-AbCdEf12\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`"\\.\\/assets\\/from-dot\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`"\\.\\.\\/images\\/logo\\.png\\?previewToken=${encodedToken}#dep"`));
  assert.match(response.body, new RegExp(`"\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/root\\.js\\?mode=prod&previewToken=${encodedToken}#root"`));
  assert.match(response.body, new RegExp(`"\\/builds\\/${PROJECT_A_ID}\\/other-build\\/assets\\/leak\\.js"`));
  assert.match(response.body, new RegExp(`"\\/builds\\/${PROJECT_B_ID}\\/${BUILD_B_ID}\\/assets\\/leak\\.js"`));
  assert.match(response.body, new RegExp(`"https:\\/\\/preview\\.askfluid\\.now\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/legacy\\.js"`));
  assert.match(response.body, /"data:text\/javascript,alert\(1\)"/);
  assert.match(response.body, /"#section"/);
  assert.match(response.body, /"ready"/);
  assert.match(response.body, /https:\/\/cdn\.example\/external\.js/);
  assert.doesNotMatch(response.body, /https:\/\/cdn\.example\/external\.js\?previewToken/);
  assert.doesNotMatch(response.body, /cdn\.example\/preload\.js\?previewToken/);
});

test('generated preview disk CSS propagates imported CSS, image, and font URLs', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const encodedToken = encodeURIComponent(token);
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.css')}?previewToken=${token}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, new RegExp(`@import "\\.\\/imported\\.css\\?previewToken=${encodedToken}";`));
  assert.match(response.body, new RegExp(`url\\("\\.\\.\\/images\\/logo\\.png\\?variant=hero&previewToken=${encodedToken}#img"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/card\\.webp\\?previewToken=${encodedToken}#card"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/images\\/icon\\.svg\\?previewToken=${encodedToken}"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\.\\/font\\.woff2\\?previewToken=${encodedToken}#font"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\.\\/font\\.woff\\?previewToken=${encodedToken}"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/root-font\\.woff2\\?mode=prod&previewToken=${encodedToken}#font"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\/builds\\/${PROJECT_A_ID}\\/other-build\\/assets\\/leak\\.woff2"\\)`));
  assert.match(response.body, new RegExp(`url\\("\\/builds\\/${PROJECT_B_ID}\\/${BUILD_B_ID}\\/assets\\/leak\\.woff"\\)`));
  assert.match(response.body, /url\("https:\/\/cdn\.example\/bg\.png"\)/);
  assert.match(response.body, /url\(data:image\/svg\+xml,%3Csvg%3E%3C\/svg%3E\)/);
  assert.doesNotMatch(response.body, /cdn\.example\/bg\.png\?previewToken/);
  assert.doesNotMatch(response.body, /other-build\/assets\/leak\.woff2\?previewToken/);
  assert.doesNotMatch(response.body, /000000000302\/64f000000000000000000321\/assets\/leak\.woff\?previewToken/);
});

test('generated preview serves same-build fonts only with preview capability', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const fontWoff2 = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/font.woff2')}?previewToken=${token}`,
  });
  const fontWoff = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/font.woff')}?previewToken=${token}`,
  });
  const rootFont = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/root-font.woff2')}?previewToken=${token}`,
  });
  const tokenlessFont = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/font.woff2'),
  });
  const missingFont = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/missing.woff2')}?previewToken=${token}`,
  });
  const rootAssetsRoute = await request({
    path: `/assets/font.woff2?previewToken=${token}`,
  });
  const crossProjectFont = await request({
    path: `${buildPath(PROJECT_B_ID, BUILD_B_ID, 'assets/font.woff2')}?previewToken=${token}`,
  });

  assert.equal(fontWoff2.statusCode, 200);
  assert.deepEqual(fontWoff2.bodyBuffer, Buffer.from('font-bytes'));
  assert.equal(fontWoff2.headers['content-type'], 'font/woff2');
  assert.equal(fontWoff.statusCode, 200);
  assert.deepEqual(fontWoff.bodyBuffer, Buffer.from('font-woff-bytes'));
  assert.equal(fontWoff.headers['content-type'], 'font/woff');
  assert.equal(rootFont.statusCode, 200);
  assert.deepEqual(rootFont.bodyBuffer, Buffer.from('root-font-bytes'));
  assert.equal(tokenlessFont.statusCode, 404);
  assert.equal(missingFont.statusCode, 404);
  assert.equal(rootAssetsRoute.statusCode, 404);
  assert.equal(crossProjectFont.statusCode, 404);
});

test('generated preview Mongo textual artifacts transform after original SHA validation', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const encodedToken = encodeURIComponent(token);
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'mongo-entry.js')}?previewToken=${token}`,
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, new RegExp(`import "\\.\\/mongo-chunk\\.js\\?previewToken=${encodedToken}";`));
  assert.match(response.body, new RegExp(`"assets\\/mongo-vite-chunk\\.js\\?previewToken=${encodedToken}"`));
  assert.match(response.body, new RegExp(`"\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}\\/assets\\/mongo-root\\.js\\?from=mongo&previewToken=${encodedToken}#root"`));
  assert.match(response.body, new RegExp(`"\\/builds\\/${PROJECT_A_ID}\\/other-build\\/assets\\/mongo-leak\\.js"`));
  assert.doesNotMatch(response.body, /cdn\.example\/mongo-preload\.js\?previewToken/);
  assert.match(response.body, new RegExp(`new URL\\("\\.\\/mongo-logo\\.png\\?size=1&previewToken=${encodedToken}#v", import\\.meta\\.url\\)`));
  assert.match(response.body, /https:\/\/cdn\.example\/mongo\.js/);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  assert.equal(response.headers['x-build-artifact-sha256'], sha256(response.bodyBuffer));
  assert.equal(response.headers['x-build-artifact-expected-sha256'], sha256(MONGO_ENTRY_BODY));
  assert.equal(response.headers['x-build-artifact-original-sha256'], sha256(MONGO_ENTRY_BODY));
  assert.equal(response.headers['x-build-artifact-original-sha256-match'], 'true');
  assert.equal(response.headers['x-build-artifact-sha256-match'], undefined);
});

test('generated preview binary artifacts are unchanged', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const original = await fs.readFile(
    path.join(PUBLIC_BUILDS_DIR, PROJECT_A_ID, BUILD_A_ID, 'images', 'logo.png')
  );
  const response = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'images/logo.png')}?previewToken=${token}`,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.bodyBuffer, original);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['content-length'], String(original.length));
  assert.equal(response.headers['x-build-artifact-sha256'], sha256(original));
});

test('generated preview artifact serving does not log preview capabilities', async () => {
  const token = validToken(PROJECT_A_ID, BUILD_A_ID);
  const previousConsoleInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);

  try {
    const index = await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID)}?previewToken=${token}`,
    });
    const image = await request({
      path: `${buildPath(PROJECT_A_ID, BUILD_A_ID, 'images/logo.png')}?previewToken=${token}`,
    });

    assert.equal(index.statusCode, 200);
    assert.equal(image.statusCode, 200);
    assert.equal(JSON.stringify(logs).includes(token), false);
    assert.equal(JSON.stringify(logs).includes('previewToken'), false);
  } finally {
    console.info = previousConsoleInfo;
  }
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
  assert.match(setCookie, /SameSite=None/i);
  assert.match(
    setCookie,
    new RegExp(`Path=\\/builds\\/${PROJECT_A_ID}\\/${BUILD_A_ID}`)
  );
  assert.doesNotMatch(setCookie, /Domain=/i);

  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const jsAsset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.js'),
    headers: { Cookie: cookie },
  });
  const cssAsset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.css'),
    headers: { Cookie: cookie },
  });
  const pngAsset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'images/logo.png'),
    headers: { Cookie: cookie },
  });
  const fontAsset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/font.woff2'),
    headers: { Cookie: cookie },
  });
  const otherBuildAsset = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_NEWER_ID, 'assets/app.js'),
    headers: { Cookie: cookie },
  });
  const otherProjectAsset = await request({
    path: buildPath(PROJECT_B_ID, BUILD_B_ID, 'assets/app.js'),
    headers: {
      Host: generatedPreviewHost(PROJECT_B_KEY),
      Cookie: cookie,
    },
  });

  assert.equal(jsAsset.statusCode, 200);
  assert.match(jsAsset.body, /project-a-requested/);
  assert.equal(cssAsset.statusCode, 200);
  assert.match(cssAsset.body, /font\.woff2/);
  assert.equal(pngAsset.statusCode, 200);
  assert.equal(pngAsset.headers['content-type'], 'image/png');
  assert.equal(fontAsset.statusCode, 200);
  assert.equal(fontAsset.headers['content-type'], 'font/woff2');
  assert.equal(otherBuildAsset.statusCode, 404);
  assert.equal(otherProjectAsset.statusCode, 404);
});

test('invalid and expired preview capability cookies remain denied', async () => {
  const expiredStart =
    Math.floor(Date.now() / 1000) - BUILD_PREVIEW_TTL_SECONDS - 10;
  const expiredToken = createBuildPreviewToken(
    PROJECT_A_ID,
    BUILD_A_ID,
    expiredStart
  );

  for (const cookie of [
    'fluid_build_preview=invalid-token',
    `fluid_build_preview=${encodeURIComponent(expiredToken)}`,
  ]) {
    const response = await request({
      path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'images/logo.png'),
      headers: { Cookie: cookie },
    });

    assert.equal(response.statusCode, 404);
  }
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

test('generated published host serves only the exact latest published build', async () => {
  const index = await request({
    path: '/',
    headers: { Host: generatedPublishedHost(PROJECT_A_KEY) },
  });
  const jsAsset = await request({
    path: '/assets/app.js',
    headers: { Host: generatedPublishedHost(PROJECT_A_KEY) },
  });
  const nestedImageAlias = await request({
    path: '/assets/images/logo.png',
    headers: { Host: generatedPublishedHost(PROJECT_A_KEY) },
  });
  const explicitLatest = await request({
    path: buildPath(PROJECT_A_ID, BUILD_A_ID, 'assets/app.js'),
    headers: { Host: generatedPublishedHost(PROJECT_A_KEY) },
  });
  const oldBuild = await request({
    path: `${buildPath(PROJECT_A_ID, BUILD_A_NEWER_ID, 'assets/app.js')}?previewToken=${validToken(PROJECT_A_ID, BUILD_A_NEWER_ID)}`,
    headers: { Host: generatedPublishedHost(PROJECT_A_KEY) },
  });
  const unpublishedProject = await request({
    path: '/',
    headers: { Host: generatedPublishedHost(PROJECT_B_KEY) },
  });
  const controlRoute = await request({
    path: '/api/auth/me',
    headers: {
      Host: generatedPublishedHost(PROJECT_A_KEY),
      Cookie: 'fluid_session=owner-session',
    },
  });

  assert.equal(index.statusCode, 200);
  assert.match(index.body, /project-a-requested/);
  assert.equal((index.body.match(/previewToken=existing/g) || []).length, 1);
  assert.equal(index.headers['set-cookie'], undefined);
  assert.match(index.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(jsAsset.statusCode, 200);
  assert.match(jsAsset.body, /project-a-requested/);
  assert.doesNotMatch(jsAsset.body, /previewToken=/);
  assert.equal(nestedImageAlias.statusCode, 200);
  assert.equal(nestedImageAlias.headers['content-type'], 'image/png');
  assert.equal(explicitLatest.statusCode, 200);
  assert.equal(oldBuild.statusCode, 404);
  assert.equal(unpublishedProject.statusCode, 404);
  assert.equal(controlRoute.statusCode, 404);
});

test('unknown and malformed generated hosts return uniform 404 responses', async () => {
  const unknownKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hosts = [
    generatedPreviewHost(unknownKey),
    'pv-abc.fluidapps.dev',
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
  const legacyToken = validToken(PROJECT_B_ID, BUILD_B_ID);
  const legacyPreview = await request({
    path: `${buildPath(PROJECT_B_ID, BUILD_B_ID)}?previewToken=${legacyToken}`,
    headers: {
      Host: 'preview.askfluid.now',
    },
  });
  const legacyCookie = legacyPreview.headers['set-cookie'][0].split(';')[0];
  const legacyCss = await request({
    path: buildPath(PROJECT_B_ID, BUILD_B_ID, 'assets/app.css'),
    headers: {
      Host: 'preview.askfluid.now',
      Cookie: legacyCookie,
    },
  });
  const legacyFont = await request({
    path: buildPath(PROJECT_B_ID, BUILD_B_ID, 'assets/font.woff2'),
    headers: {
      Host: 'preview.askfluid.now',
      Cookie: legacyCookie,
    },
  });
  const legacyTokenlessFont = await request({
    path: buildPath(PROJECT_B_ID, BUILD_B_ID, 'assets/font.woff2'),
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
  assert.match(String(legacyPreview.headers['set-cookie'] || ''), /SameSite=Lax/i);
  assert.doesNotMatch(legacyPreview.body, new RegExp(`previewToken=${encodeURIComponent(legacyToken)}`));
  assert.equal(legacyCss.statusCode, 200);
  assert.match(legacyCss.body, /url\("\.\/font\.woff2#font"\)/);
  assert.doesNotMatch(legacyCss.body, /previewToken=/);
  assert.equal(legacyFont.statusCode, 200);
  assert.deepEqual(legacyFont.bodyBuffer, Buffer.from('font-bytes'));
  assert.equal(legacyTokenlessFont.statusCode, 404);
  assert.equal(publishedBuild.statusCode, 200);
  assert.match(publishedBuild.body, /project-a-requested/);
  assert.equal(publishedBuild.headers.deprecation, 'true');
});
