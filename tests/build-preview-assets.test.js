const assert = require('assert/strict');
const test = require('node:test');

const { createBuildPreviewToken, verifyBuildPreviewToken } = require('../utils/buildPreviewAccess');
const {
  assertJavaScriptParses,
  injectBuildPreviewTokenIntoCodeAssets,
  injectBuildPreviewTokenIntoCssAssets,
  injectBuildPreviewTokenIntoHtmlAssets,
  withBuildPreviewTokenOnAssetUrl,
} = require('../utils/buildAssetCapabilities');

const parsedPath = {
  projectId: '64f000000000000000000001',
  buildKey: '64f000000000000000000002',
};

test('preview token is bound to one project/build pair', () => {
  process.env.BUILD_PREVIEW_SECRET = 'test-secret';
  const token = createBuildPreviewToken(parsedPath.projectId, parsedPath.buildKey, 1000);

  assert.equal(verifyBuildPreviewToken(token, parsedPath.projectId, parsedPath.buildKey, 1000), true);
  assert.equal(verifyBuildPreviewToken(token, '64f000000000000000000099', parsedPath.buildKey, 1000), false);
  assert.equal(verifyBuildPreviewToken(token, parsedPath.projectId, '64f000000000000000000099', 1000), false);
});

test('private build index propagates capability only to same-build assets', () => {
  const html = [
    '<link rel="stylesheet" href="./assets/index.css">',
    '<script type="module" src="/builds/64f000000000000000000001/64f000000000000000000002/assets/index.js"></script>',
    '<img src="assets/logo.png#v1">',
    '<a href="/builds/64f000000000000000000001/other-build/assets/leak.js">other</a>',
    '<script src="https://cdn.example/app.js"></script>',
    '<style>.hero{background:url("./assets/bg.webp")}</style>',
  ].join('\n');

  const rewritten = injectBuildPreviewTokenIntoHtmlAssets(html, parsedPath, 'token.value');

  assert.match(rewritten, /href="\.\/assets\/index\.css\?previewToken=token\.value"/);
  assert.match(rewritten, /src="\/builds\/64f000000000000000000001\/64f000000000000000000002\/assets\/index\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /src="assets\/logo\.png\?previewToken=token\.value#v1"/);
  assert.match(rewritten, /url\("\.\/assets\/bg\.webp\?previewToken=token\.value"\)/);
  assert.match(rewritten, /href="\/builds\/64f000000000000000000001\/other-build\/assets\/leak\.js"/);
  assert.match(rewritten, /src="https:\/\/cdn\.example\/app\.js"/);
});

test('asset capability rewrite is idempotent and ignores non-fetch URLs', () => {
  assert.equal(
    withBuildPreviewTokenOnAssetUrl('./assets/index.js?previewToken=existing', parsedPath, 'new-token'),
    './assets/index.js?previewToken=existing'
  );
  assert.equal(
    withBuildPreviewTokenOnAssetUrl('data:text/javascript,alert(1)', parsedPath, 'new-token'),
    'data:text/javascript,alert(1)'
  );
  assert.equal(
    withBuildPreviewTokenOnAssetUrl('#section', parsedPath, 'new-token'),
    '#section'
  );
});

test('asset capability rewrite supports artifact-relative and same-origin generated URLs', () => {
  const assetParsedPath = {
    ...parsedPath,
    artifactPath: 'assets/app.js',
  };
  const options = {
    baseOrigin: 'https://pv-0123456789abcdef0123456789abcdef.fluidapps.dev',
    allowedOrigins: ['https://pv-0123456789abcdef0123456789abcdef.fluidapps.dev'],
  };

  assert.equal(
    withBuildPreviewTokenOnAssetUrl('../images/logo.png?size=1#hero', assetParsedPath, 'new-token', options),
    '../images/logo.png?size=1&previewToken=new-token#hero'
  );
  assert.equal(
    withBuildPreviewTokenOnAssetUrl(
      'https://pv-0123456789abcdef0123456789abcdef.fluidapps.dev/builds/64f000000000000000000001/64f000000000000000000002/assets/app.css#sheet',
      assetParsedPath,
      'new-token',
      options
    ),
    'https://pv-0123456789abcdef0123456789abcdef.fluidapps.dev/builds/64f000000000000000000001/64f000000000000000000002/assets/app.css?previewToken=new-token#sheet'
  );
  assert.equal(
    withBuildPreviewTokenOnAssetUrl(
      'https://preview.askfluid.now/builds/64f000000000000000000001/64f000000000000000000002/assets/app.css',
      assetParsedPath,
      'new-token',
      options
    ),
    'https://preview.askfluid.now/builds/64f000000000000000000001/64f000000000000000000002/assets/app.css'
  );
});

test('private build code assets propagate capability to Vite dynamic assets', () => {
  const assetParsedPath = {
    ...parsedPath,
    artifactPath: 'assets/app.js',
  };
  const code = [
    'import "./chunk.js";',
    'import"./minified-static.js";',
    'import("./dynamic.js").then(run);',
    'export { value } from "./shared.js";',
    'export{value as minified}from"./minified-shared.js";',
    'const workerUrl = new URL("./worker.js", import.meta.url);',
    'const minifiedWorker = new Worker(new URL("worker-B7T9.js",import.meta.url),{type:"module"});',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/charts-rVXgnjvt.js","assets/icons-AbCdEf12.js","./assets/from-dot.js","../images/logo.png#img","/builds/64f000000000000000000001/64f000000000000000000002/assets/root.js?mode=prod#root","/builds/64f000000000000000000001/other-build/assets/leak.js","/builds/64f000000000000000000099/64f000000000000000000002/assets/leak.js","https://cdn.example/preload.js","https://preview.askfluid.now/builds/64f000000000000000000001/64f000000000000000000002/assets/legacy.js","data:text/javascript,alert(1)","#section","ready"])))=>i.map(i=>d[i]);',
    'const external = "https://cdn.example/external.js";',
    'const escapedExternal = "https:\\/\\/cdn.example\\/escaped.js";',
    'const ordinary = "assets/not-a-fetch.js";',
    'const template = `assets/template.js`;',
    'const regex = /assets\\/regex\\.js/;',
    'const adjacent = ok?"assets/ternary.js":"./literal.js";',
  ].join('\n');

  const rewritten = injectBuildPreviewTokenIntoCodeAssets(code, assetParsedPath, 'token.value');

  assert.doesNotThrow(() => assertJavaScriptParses(rewritten, 'assets/app.js'));
  assert.match(rewritten, /import "\.\/chunk\.js\?previewToken=token\.value";/);
  assert.match(rewritten, /import"\.\/minified-static\.js\?previewToken=token\.value";/);
  assert.match(rewritten, /import\("\.\/dynamic\.js\?previewToken=token\.value"\)/);
  assert.match(rewritten, /from "\.\/shared\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /from"\.\/minified-shared\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /new URL\("\.\/worker\.js\?previewToken=token\.value", import\.meta\.url\)/);
  assert.match(rewritten, /new URL\("worker-B7T9\.js\?previewToken=token\.value",import\.meta\.url\)/);
  assert.match(rewritten, /"assets\/charts-rVXgnjvt\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /"assets\/icons-AbCdEf12\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /"\.\/assets\/from-dot\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /"\.\.\/images\/logo\.png\?previewToken=token\.value#img"/);
  assert.match(rewritten, /"\/builds\/64f000000000000000000001\/64f000000000000000000002\/assets\/root\.js\?mode=prod&previewToken=token\.value#root"/);
  assert.match(rewritten, /"\/builds\/64f000000000000000000001\/other-build\/assets\/leak\.js"/);
  assert.match(rewritten, /"\/builds\/64f000000000000000000099\/64f000000000000000000002\/assets\/leak\.js"/);
  assert.match(rewritten, /"https:\/\/preview\.askfluid\.now\/builds\/64f000000000000000000001\/64f000000000000000000002\/assets\/legacy\.js"/);
  assert.match(rewritten, /"data:text\/javascript,alert\(1\)"/);
  assert.match(rewritten, /"#section"/);
  assert.match(rewritten, /"ready"/);
  assert.doesNotMatch(rewritten, /ready\?previewToken/);
  assert.match(rewritten, /https:\/\/cdn\.example\/external\.js/);
  assert.equal(rewritten.includes('const escapedExternal = "https:\\/\\/cdn.example\\/escaped.js";'), true);
  assert.equal(rewritten.includes('const ordinary = "assets/not-a-fetch.js";'), true);
  assert.equal(rewritten.includes('const template = `assets/template.js`;'), true);
  assert.match(rewritten, /const regex = \/assets\\\/regex\\\.js\/;/);
  assert.equal(rewritten.includes('const adjacent = ok?"assets/ternary.js":"./literal.js";'), true);
  assert.doesNotMatch(rewritten, /https:\/\/cdn\.example\/external\.js\?previewToken/);
  assert.doesNotMatch(rewritten, /escaped\.js\?previewToken/);
  assert.doesNotMatch(rewritten, /cdn\.example\/preload\.js\?previewToken/);
});

test('private build CSS assets propagate capability only in CSS fetch contexts', () => {
  const assetParsedPath = {
    ...parsedPath,
    artifactPath: 'assets/app.css',
  };
  const css = [
    '@import "./imported.css";',
    '.hero{background:url("./bg.svg")}@font-face{src:url("./font.woff2")}',
    '.external{background:url("https://cdn.example/bg.png")}',
  ].join('\n');

  const rewritten = injectBuildPreviewTokenIntoCssAssets(css, assetParsedPath, 'token.value');

  assert.match(rewritten, /@import "\.\/imported\.css\?previewToken=token\.value";/);
  assert.match(rewritten, /url\("\.\/bg\.svg\?previewToken=token\.value"\)/);
  assert.match(rewritten, /url\("\.\/font\.woff2\?previewToken=token\.value"\)/);
  assert.match(rewritten, /url\("https:\/\/cdn\.example\/bg\.png"\)/);
  assert.doesNotMatch(rewritten, /cdn\.example\/bg\.png\?previewToken/);
});

test('transformed JavaScript parse validation rejects corrupted output', () => {
  assert.throws(
    () => assertJavaScriptParses('const broken = "assets/charts-rVXgnjvt.js"?previewToken=redacted;', 'assets/charts-rVXgnjvt.js'),
    /Transformed build JavaScript failed to parse/
  );
});
