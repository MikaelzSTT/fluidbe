const assert = require('assert/strict');
const test = require('node:test');

const { createBuildPreviewToken, verifyBuildPreviewToken } = require('../utils/buildPreviewAccess');
const {
  injectBuildPreviewTokenIntoCodeAssets,
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
  const code = [
    'import "./chunk.js";',
    'import("./dynamic.js").then(run);',
    'export { value } from "./shared.js";',
    'const workerUrl = new URL("./worker.js", import.meta.url);',
    'const external = "https://cdn.example/external.js";',
    '.hero{background:url("./bg.svg")}@font-face{src:url("./font.woff2")}',
  ].join('\n');

  const rewritten = injectBuildPreviewTokenIntoCodeAssets(code, parsedPath, 'token.value');

  assert.match(rewritten, /import "\.\/chunk\.js\?previewToken=token\.value";/);
  assert.match(rewritten, /import\("\.\/dynamic\.js\?previewToken=token\.value"\)/);
  assert.match(rewritten, /from "\.\/shared\.js\?previewToken=token\.value"/);
  assert.match(rewritten, /new URL\("\.\/worker\.js\?previewToken=token\.value", import\.meta\.url\)/);
  assert.match(rewritten, /url\("\.\/bg\.svg\?previewToken=token\.value"\)/);
  assert.match(rewritten, /url\("\.\/font\.woff2\?previewToken=token\.value"\)/);
  assert.match(rewritten, /https:\/\/cdn\.example\/external\.js/);
  assert.doesNotMatch(rewritten, /https:\/\/cdn\.example\/external\.js\?previewToken/);
});
