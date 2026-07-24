const assert = require('assert/strict');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const test = require('node:test');

process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';
process.env.PREVIEW_ALLOWED_ORIGIN = 'https://preview.askfluid.now';
process.env.BUILD_PREVIEW_SECRET = 'preview-origin-test-secret';

const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const { app, previewIsolationHelpers } = require('../server');
const {
  buildPreviewUrl,
  buildPublishedProjectUrl,
  parseBuildPathFromUrl,
  toDedicatedPreviewUrl,
} = require('../utils/previewOrigin');
const { withAbsoluteBuildUrls } = require('../utils/projectPublication');

const projectId = '64f000000000000000000101';
const buildId = '64f000000000000000000102';
const buildPath = `/builds/${projectId}/${buildId}/index.html`;
const publicBuildRoot = path.join(__dirname, '..', 'public', 'builds', projectId, buildId);
const { buildPreviewContentSecurityPolicy } = previewIsolationHelpers;

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(server, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        ...options,
        headers: {
          Host: 'preview.askfluid.now',
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

function parseCspDirectives(csp) {
  const directives = new Map();

  for (const directive of String(csp || '').split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);

    if (parts.length > 0) {
      directives.set(parts[0], parts.slice(1));
    }
  }

  return directives;
}

function withPreviewImgSrcAllowlist(value, fn) {
  const previousValue = process.env.PREVIEW_IMG_SRC_ALLOWLIST;

  if (value === undefined) {
    delete process.env.PREVIEW_IMG_SRC_ALLOWLIST;
  } else {
    process.env.PREVIEW_IMG_SRC_ALLOWLIST = value;
  }

  try {
    return fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env.PREVIEW_IMG_SRC_ALLOWLIST;
    } else {
      process.env.PREVIEW_IMG_SRC_ALLOWLIST = previousValue;
    }
  }
}

function stubPublishedBuild() {
  const originalProjectBuildFindOne = ProjectBuild.findOne;
  const originalProjectFindById = Project.findById;

  ProjectBuild.findOne = () => ({
    sort() {
      return this;
    },
    select() {
      return this;
    },
    lean: async () => ({
      _id: buildId,
      projectId,
      status: 'done',
    }),
  });
  Project.findById = () => ({
    select() {
      return {
        lean: async () => ({
          _id: projectId,
          userId: '64f000000000000000000103',
          isPublished: true,
          latestPublishedBuildId: buildId,
        }),
      };
    },
  });

  return () => {
    ProjectBuild.findOne = originalProjectBuildFindOne;
    Project.findById = originalProjectFindById;
  };
}

function stubPublishedProjectPage() {
  const originalProjectFindOne = Project.findOne;
  const originalProjectBuildFindOne = ProjectBuild.findOne;

  Project.findOne = async () => ({
    _id: projectId,
    slug: 'clean-app',
    isPublished: true,
    appName: 'Clean App',
    seo: {
      title: 'Clean App',
      description: 'Published preview page',
    },
  });

  ProjectBuild.findOne = () => ({
    sort: async () => ({
      _id: buildId,
      projectId,
      status: 'done',
      fullHtml: '<!doctype html><html><head><title>Old</title></head><body><main>published ok</main></body></html>',
    }),
  });

  return () => {
    Project.findOne = originalProjectFindOne;
    ProjectBuild.findOne = originalProjectBuildFindOne;
  };
}

test('preview and published URLs use the dedicated preview origin', () => {
  assert.equal(
    buildPreviewUrl(projectId, buildId),
    `https://preview.askfluid.now${buildPath}`
  );
  assert.equal(
    buildPublishedProjectUrl('clean-app'),
    'https://preview.askfluid.now/p/clean-app'
  );

  const payload = withAbsoluteBuildUrls(
    {
      protocol: 'https',
      get: () => 'apps.askfluid.now.evil.example',
    },
    {
      distUrl: buildPath,
      previewUrl: `https://apps.askfluid.now${buildPath}`,
      buildUrl: `https://evil.example${buildPath}`,
      deployUrl: '',
    }
  );

  assert.match(payload.distUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
  assert.match(payload.previewUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
  assert.match(payload.buildUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
  assert.doesNotMatch(payload.distUrl, /apps\.askfluid\.now/);
  assert.doesNotMatch(payload.previewUrl, /apps\.askfluid\.now/);
  assert.doesNotMatch(payload.buildUrl, /evil\.example/);

  const dedicatedPayload = withAbsoluteBuildUrls(
    {
      protocol: 'https',
      get: () => 'apps.askfluid.now',
    },
    {
      previewUrl: `https://preview.askfluid.now${buildPath}`,
    }
  );

  assert.match(dedicatedPayload.previewUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
  assert.match(dedicatedPayload.previewUrl, /\/index\.html\?previewToken=/);
});

test('preview URL parsing rejects host injection and unsafe build paths', () => {
  assert.equal(parseBuildPathFromUrl('/builds/not-an-object-id/build/index.html'), null);
  assert.equal(parseBuildPathFromUrl(`/builds/${projectId}/../index.html`), null);
  assert.equal(parseBuildPathFromUrl(`/builds/${projectId}/build.key/index.html`), null);
  assert.equal(
    toDedicatedPreviewUrl(`https://apps.askfluid.now.evil.example${buildPath}`),
    `https://preview.askfluid.now${buildPath}`
  );
});

test('preview CSP allows safe image sources and keeps script/connect restricted', () => {
  withPreviewImgSrcAllowlist('https://images.unsplash.com,https://plus.unsplash.com', () => {
    const directives = parseCspDirectives(buildPreviewContentSecurityPolicy());

    assert.deepEqual(directives.get('default-src'), ["'none'"]);
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('connect-src'), ["'self'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ['https://askfluid.now']);

    const imgSrc = directives.get('img-src');
    assert.ok(imgSrc.includes("'self'"));
    assert.ok(imgSrc.includes('data:'));
    assert.ok(imgSrc.includes('blob:'));
    assert.ok(imgSrc.includes('https://images.unsplash.com'));
    assert.ok(imgSrc.includes('https://plus.unsplash.com'));
    assert.equal(imgSrc.includes('https://cdn.example.com'), false);
  });
});

test('preview CSP keeps image allowlist empty by default', () => {
  withPreviewImgSrcAllowlist(undefined, () => {
    const directives = parseCspDirectives(buildPreviewContentSecurityPolicy());

    assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:']);
  });
});

test('preview CSP rejects unsafe image allowlist entries with safe logs', () => {
  const previousWarn = console.warn;
  const warnings = [];

  console.warn = (...args) => {
    warnings.push(args);
  };

  try {
    withPreviewImgSrcAllowlist(
      'http://images.unsplash.com,https://*.example.com,javascript:alert(1),https://images.unsplash.com/path,https://plus.unsplash.com',
      () => {
        const directives = parseCspDirectives(buildPreviewContentSecurityPolicy());
        const imgSrc = directives.get('img-src');

        assert.ok(imgSrc.includes('https://plus.unsplash.com'));
        assert.equal(imgSrc.includes('http://images.unsplash.com'), false);
        assert.equal(imgSrc.includes('https://*.example.com'), false);
        assert.equal(imgSrc.includes('javascript:alert(1)'), false);
        assert.equal(imgSrc.includes('https://images.unsplash.com/path'), false);
      }
    );
  } finally {
    console.warn = previousWarn;
  }

  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((warning) => warning[0] === 'Invalid PREVIEW_IMG_SRC_ALLOWLIST entry ignored'));

  const renderedWarnings = warnings.map((warning) => JSON.stringify(warning)).join('\n');
  assert.doesNotMatch(renderedWarnings, /https:\/\/images\.unsplash\.com\/path/);
  assert.doesNotMatch(renderedWarnings, /javascript:alert\(1\)/);
  assert.doesNotMatch(renderedWarnings, /http:\/\/images\.unsplash\.com/);
});

test('preview host only exposes builds and published pages', async () => {
  const server = await listen();

  try {
    const root = await request(server, { path: '/' });
    assert.equal(root.statusCode, 404);
    assert.doesNotMatch(root.body, /FLUIDBE backend rodando/);
    assert.doesNotMatch(root.body, /database/);
    assert.match(root.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(root.headers['referrer-policy'], 'no-referrer');

    const api = await request(server, { path: '/api/auth/me' });
    assert.equal(api.statusCode, 404);
    assert.doesNotMatch(api.body, /Token/);

    const admin = await request(server, { path: '/admin.html' });
    assert.equal(admin.statusCode, 404);

    const login = await request(server, { path: '/login.html' });
    assert.equal(login.statusCode, 404);
  } finally {
    await close(server);
  }
});

test('preview host refuses API routes and credentialed CORS', async () => {
  const server = await listen();

  try {
    const api = await request(server, {
      path: '/api/auth/me',
      headers: {
        Origin: 'https://preview.askfluid.now',
        Cookie: 'fluid_session=test',
        Authorization: 'Bearer user.jwt',
      },
    });
    assert.equal(api.statusCode, 404);
    assert.equal(api.headers['access-control-allow-credentials'], undefined);

    const preflight = await request(server, {
      method: 'OPTIONS',
      path: buildPath,
      headers: {
        Origin: 'https://preview.askfluid.now',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://preview.askfluid.now');
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  } finally {
    await close(server);
  }
});

test('normal host keeps health root and API routes available', async () => {
  const server = await listen();

  try {
    const root = await request(server, {
      path: '/',
      headers: {
        Host: 'api.askfluid.now',
      },
    });
    assert.equal(root.statusCode, 200);
    assert.deepEqual(JSON.parse(root.body), {
      message: 'FLUIDBE backend rodando',
      database: 'conectada',
    });

    const api = await request(server, {
      path: '/api/auth/me',
      headers: {
        Host: 'api.askfluid.now',
      },
    });
    assert.equal(api.statusCode, 401);
    assert.match(api.body, /Token não enviado/);
  } finally {
    await close(server);
  }
});

test('preview host serves static build files without setting cookies', async () => {
  const restore = stubPublishedBuild();
  const server = await listen();

  try {
    await fs.mkdir(path.join(publicBuildRoot, 'assets'), { recursive: true });
    await fs.writeFile(path.join(publicBuildRoot, 'index.html'), '<!doctype html><div id="root"></div>');
    await fs.writeFile(path.join(publicBuildRoot, 'assets', 'app.js'), 'document.body.dataset.ready = "true";');

    const index = await request(server, { path: buildPath });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /id="root"/);
    assert.match(index.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(index.headers['set-cookie'], undefined);
    assert.equal(index.headers['access-control-allow-credentials'], undefined);

    const asset = await request(server, { path: `/builds/${projectId}/${buildId}/assets/app.js` });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /dataset\.ready/);
    assert.match(asset.headers['cache-control'], /immutable/);
  } finally {
    restore();
    await close(server);
    await fs.rm(path.join(__dirname, '..', 'public', 'builds', projectId), { recursive: true, force: true });
  }
});

test('preview host serves published project pages', async () => {
  const restore = stubPublishedProjectPage();
  const server = await listen();

  try {
    const published = await request(server, { path: '/p/clean-app' });

    assert.equal(published.statusCode, 200);
    assert.match(published.body, /published ok/);
    assert.match(published.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(published.headers['referrer-policy'], 'no-referrer');
    assert.equal(published.headers['access-control-allow-credentials'], undefined);
  } finally {
    restore();
    await close(server);
  }
});

test('legacy app/API build route remains temporarily available with migration headers', async () => {
  const restore = stubPublishedBuild();
  const server = await listen();

  try {
    await fs.mkdir(publicBuildRoot, { recursive: true });
    await fs.writeFile(path.join(publicBuildRoot, 'index.html'), '<main>legacy ok</main>');

    const legacy = await request(server, {
      path: buildPath,
      headers: {
        Host: 'apps.askfluid.now',
      },
    });

    assert.equal(legacy.statusCode, 200);
    assert.match(legacy.body, /legacy ok/);
    assert.equal(legacy.headers.deprecation, 'true');
    assert.equal(legacy.headers.sunset, '2026-08-31');
    assert.match(legacy.headers.link, /^<https:\/\/preview\.askfluid\.now\/builds\//);
  } finally {
    restore();
    await close(server);
    await fs.rm(path.join(__dirname, '..', 'public', 'builds', projectId), { recursive: true, force: true });
  }
});
