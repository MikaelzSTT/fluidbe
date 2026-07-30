const assert = require('assert/strict');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const mongoose = require('mongoose');

process.env.BUILD_WORKER_ENABLED = 'false';
process.env.PREVIEW_BASE_URL = 'https://preview.askfluid.now';

const adminRoutes = require('../routes/adminRoutes');
const AdminAuditLog = require('../models/AdminAuditLog');
const BuildJob = require('../models/BuildJob');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const { app } = require('../server');
const { publishProjectBuild } = require('../utils/projectPublication');
const {
  publishValidatedDist,
  validateDistDirectory,
} = adminRoutes.reactViteBuildHelpers;
const {
  INVALID_PRECOMPILED_DIST_CODE,
  assertPrecompiledDistSecurityAllowsPublication,
  extractPrecompiledDistZipSafely,
  inspectPrecompiledDistZip,
} = require('../utils/precompiledDist');

async function makeTempDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeZip(zipPath, entries) {
  const zip = new AdmZip();

  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || 'x'));
  }

  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => error ? reject(error) : resolve());
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function nodeCheck(filePath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--check', filePath], (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function writeFiles(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
  }
}

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
    const body = options.body || null;
    const headers = {
      Host: 'preview.askfluid.now',
      ...(options.headers || {}),
    };

    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        method: 'GET',
        ...options,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.end(body || undefined);
  });
}

function multipartZipBody(fieldName, fileName, fileContent) {
  const boundary = `fluid-precompiled-${crypto.randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
      'Content-Type: application/zip\r\n\r\n'
    ),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function selectableValue(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    lean() {
      return Promise.resolve(value && typeof value.toObject === 'function'
        ? value.toObject({ getters: true, virtuals: true })
        : value);
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

async function patchZipEntryName(zipPath, fromName, toName) {
  assert.equal(Buffer.byteLength(fromName), Buffer.byteLength(toName));
  const buffer = await fs.readFile(zipPath);
  const from = Buffer.from(fromName);
  const to = Buffer.from(toName);
  let offset = 0;
  let patches = 0;

  while ((offset = buffer.indexOf(from, offset)) !== -1) {
    to.copy(buffer, offset);
    offset += to.length;
    patches += 1;
  }

  assert.ok(patches >= 1);
  await fs.writeFile(zipPath, buffer);
}

async function patchZipExternalAttributes(zipPath, externalAttributes) {
  const buffer = await fs.readFile(zipPath);
  const centralDirectoryHeader = 0x02014b50;

  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) === centralDirectoryHeader) {
      buffer.writeUInt32LE(externalAttributes >>> 0, offset + 38);
    }
  }

  await fs.writeFile(zipPath, buffer);
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function getFinalRouteHandler(routePath) {
  const layer = adminRoutes.stack.find((item) => (
    item.route?.path === routePath && item.route?.methods?.post
  ));
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getFinalGetRouteHandler(routePath) {
  const layer = adminRoutes.stack.find((item) => (
    item.route?.path === routePath && item.route?.methods?.get
  ));
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getFinalAllRouteHandler(routePath) {
  const layer = adminRoutes.stack.find((item) => (
    item.route?.path === routePath && item.route?.methods?._all
  ));
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('valid precompiled dist ZIP is validated and published with the build worker disabled', async () => {
  const root = await makeTempDir('fluid-precompiled-valid');

  try {
    const zipPath = path.join(root, 'dist.zip');
    const extractedDir = path.join(root, 'isolated', 'dist');
    const publishedDir = path.join(root, 'public', 'builds', 'project', 'build');
    await writeZip(zipPath, [
      { name: 'index.html', content: '<div id="root"></div><script src="./assets/app.js"></script>' },
      { name: 'assets/app.js', content: 'document.querySelector("#root").textContent = "ok";' },
      { name: 'assets/app.css', content: 'body { color: #111; }' },
    ]);

    const manifest = await extractPrecompiledDistZipSafely(zipPath, extractedDir);
    const validation = await validateDistDirectory(extractedDir);
    const security = await assertPrecompiledDistSecurityAllowsPublication(validation);
    await publishValidatedDist(extractedDir, publishedDir);

    assert.equal(adminRoutes.reactViteBuildHelpers.buildWorkerEnabled, false);
    assert.equal(manifest.format, 'direct_dist');
    assert.equal(security.status, 'passed');
    assert.match(await fs.readFile(path.join(publishedDir, 'index.html'), 'utf8'), /id="root"/);
    assert.equal(
      await fs.readFile(path.join(publishedDir, 'assets', 'app.css'), 'utf8'),
      'body { color: #111; }'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled dist API creates a workerless draft that the publication flow publishes', async () => {
  const root = await makeTempDir('fluid-precompiled-handler');
  const projectId = new mongoose.Types.ObjectId();
  const uploadDir = path.join(root, 'isolated-upload');
  const zipPath = path.join(uploadDir, 'dist.zip');
  const originalBuildJobFindOne = BuildJob.findOne;
  const originalBuildFind = ProjectBuild.find;
  const originalBuildFindOne = ProjectBuild.findOne;
  const originalBuildUpdate = ProjectBuild.findOneAndUpdate;
  const originalProjectFindById = Project.findById;
  const originalSave = ProjectBuild.prototype.save;
  const originalProjectUpdate = Project.findByIdAndUpdate;
  const previousPreviewSecret = process.env.BUILD_PREVIEW_SECRET;
  let savedBuild = null;
  let server = null;
  let projectPublicationState = {
    isPublished: false,
    latestPublishedBuildId: null,
  };

  try {
    await fs.mkdir(uploadDir, { recursive: true });
    const originalFiles = {
      'index.html': Buffer.from([
        '<!doctype html>',
        '<html><head>',
        '<meta charset="UTF-8">',
        '<link rel="stylesheet" href="./assets/index-Df5xQ9.css">',
        '<script type="module" crossorigin src="./assets/index-DECovwbJ.js"></script>',
        '<link rel="icon" href="./favicon.svg">',
        '</head><body>',
        '<div id="root"></div>',
        '<img src="./images/logo.png">',
        '</body></html>',
      ].join('')),
      'assets/index-DECovwbJ.js': Buffer.from(
        [
          'import{createElement as e}from"./chunk-Bn9t.js";',
          'const label="São Paulo café";',
          'document.querySelector("#root").textContent=`ready ${label}`;',
          'export{label};',
        ].join('\n'),
        'utf8'
      ),
      'assets/chunk-Bn9t.js': Buffer.from('export const createElement = (name) => ({ name });\n'),
      'assets/index-Df5xQ9.css': Buffer.from(
        'body{margin:0;color:#123;font-family:"Inter",sans-serif}.logo{background:url("../images/logo.png")}\n'
      ),
      'images/logo.png': Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP5VhQAAAABJRU5ErkJggg==',
        'base64'
      ),
      'favicon.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'),
    };
    await writeZip(zipPath, [
      { name: 'index.html', content: originalFiles['index.html'] },
      { name: 'assets/index-DECovwbJ.js', content: originalFiles['assets/index-DECovwbJ.js'] },
      { name: 'assets/chunk-Bn9t.js', content: originalFiles['assets/chunk-Bn9t.js'] },
      { name: 'assets/index-Df5xQ9.css', content: originalFiles['assets/index-Df5xQ9.css'] },
      { name: 'images/logo.png', content: originalFiles['images/logo.png'] },
      { name: 'favicon.svg', content: originalFiles['favicon.svg'] },
    ]);
    process.env.BUILD_PREVIEW_SECRET = 'precompiled-dist-test-preview-secret';
    ProjectBuild.prototype.save = async function saveWithoutDatabase() {
      savedBuild = this;
      return this;
    };
    BuildJob.findOne = () => ({
      sort() {
        return this;
      },
      async select() {
        return null;
      },
    });
    ProjectBuild.find = () => ({
      sort: async () => savedBuild ? [savedBuild] : [],
    });
    ProjectBuild.findOne = () => ({
      sort() {
        return this;
      },
      select(fields) {
        if (String(fields || '').includes('artifactFiles')) {
          return Promise.resolve(savedBuild);
        }

        return this;
      },
      lean: async () => ({
        _id: savedBuild._id,
        projectId,
        status: savedBuild.status,
        distUrl: savedBuild.distUrl,
        previewUrl: savedBuild.previewUrl,
        buildUrl: savedBuild.buildUrl,
        deployUrl: savedBuild.deployUrl,
        artifactFiles: savedBuild.artifactFiles,
        fullHtml: savedBuild.fullHtml,
      }),
    });
    ProjectBuild.findOneAndUpdate = async () => {
      savedBuild.status = 'done';
      return savedBuild;
    };
    Project.findById = () => ({
      select() {
        return {
          lean: async () => ({
            _id: projectId,
            userId: new mongoose.Types.ObjectId(),
            isPublished: projectPublicationState.isPublished,
            latestPublishedBuildId: projectPublicationState.latestPublishedBuildId,
          }),
        };
      },
    });
    Project.findByIdAndUpdate = async (id, update) => {
      projectPublicationState = {
        isPublished: update.isPublished === true || update['deploy.isPublished'] === true,
        latestPublishedBuildId: update.latestPublishedBuildId || projectPublicationState.latestPublishedBuildId,
      };
      return {
        _id: id,
        ...update,
        isPublished: projectPublicationState.isPublished,
        latestPublishedBuildId: projectPublicationState.latestPublishedBuildId,
        publicUrl: update['deploy.url'] || '',
      };
    };

    const project = {
      _id: projectId,
      appName: 'Precompiled Test',
      isPublished: false,
      slug: 'precompiled-test',
    };
    const req = {
      file: { path: zipPath, originalname: 'dist.zip' },
      get: () => 'localhost',
      params: { id: String(projectId) },
      precompiledDistUploadDir: uploadDir,
      project,
      protocol: 'http',
    };
    const res = createResponse();
    await getFinalRouteHandler('/projects/:id/react-vite/dist')(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.flow, 'precompiled_dist');
    assert.equal(res.body.detectedFormat, 'direct_dist');
    assert.equal(res.body.requiresBuildWorker, false);
    assert.equal(res.body.publicationRequired, true);
    assert.match(res.body.previewUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
    assert.match(res.body.previewUrl, /\/index\.html\?previewToken=/);
    assert.equal(res.body.previewUrl, res.body.build.previewUrl);
    assert.equal(res.body.build.status, 'draft');
    assert.match(res.body.build.buildUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
    assert.match(res.body.build.distUrl, /^https:\/\/preview\.askfluid\.now\/builds\//);
    assert.doesNotMatch(JSON.stringify(res.body), /askfluid\.now\/assets/);
    assert.equal(savedBuild.status, 'draft');
    assert.equal(savedBuild.buildJobId, null);
    assert.equal(fsSync.existsSync(uploadDir), false);
    const publicBuildDir = path.join(__dirname, '..', 'public', 'builds', String(projectId), String(savedBuild._id));
    assert.deepEqual(await fs.readFile(path.join(publicBuildDir, 'index.html')), originalFiles['index.html']);
    assert.equal(savedBuild.artifactFiles.find((file) => file.relativePath === 'assets/index-DECovwbJ.js').encoding, 'base64');
    assert.equal(
      savedBuild.artifactFiles.find((file) => file.relativePath === 'assets/index-DECovwbJ.js').content,
      originalFiles['assets/index-DECovwbJ.js'].toString('base64')
    );

    server = await listen();
    const preview = new URL(res.body.previewUrl);
    const index = await request(server, { path: `${preview.pathname}${preview.search}` });
    assert.equal(index.statusCode, 200);
    assert.deepEqual(index.body, originalFiles['index.html']);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['content-length'], String(originalFiles['index.html'].length));
    assert.equal(index.headers['content-encoding'], undefined);
    assert.match(String(index.headers['set-cookie'] || ''), /fluid_build_preview=/);
    assert.equal(index.headers['x-build-artifact-sha256'], sha256(originalFiles['index.html']));

    const expectedContentTypes = {
      'index.html': 'text/html; charset=utf-8',
      'assets/index-DECovwbJ.js': 'application/javascript; charset=utf-8',
      'assets/index-Df5xQ9.css': 'text/css; charset=utf-8',
      'images/logo.png': 'image/png',
      'favicon.svg': 'image/svg+xml',
    };
    for (const [assetPath, expectedContent] of Object.entries(originalFiles)) {
      if (!expectedContentTypes[assetPath]) {
        continue;
      }

      const asset = await request(server, {
        path: `/builds/${projectId}/${savedBuild._id}/${assetPath}${preview.search}`,
      });
      assert.equal(asset.statusCode, 200);
      assert.deepEqual(asset.body, expectedContent);
      assert.equal(asset.headers['content-type'], expectedContentTypes[assetPath]);
      assert.equal(asset.headers['content-length'], String(expectedContent.length));
      assert.equal(asset.headers['content-encoding'], undefined);
      assert.equal(asset.headers['x-build-artifact-sha256'], sha256(expectedContent));
    }
    assert.equal(
      (await request(server, {
        path: `/builds/${projectId}/${savedBuild._id}/assets/missing.js${preview.search}`,
      })).statusCode,
      404
    );

    const returnedJs = await request(server, {
      path: `/builds/${projectId}/${savedBuild._id}/assets/index-DECovwbJ.js${preview.search}`,
    });
    const temporaryJsPath = path.join(root, 'returned-index-DECovwbJ.js');
    await fs.writeFile(temporaryJsPath, returnedJs.body);
    await nodeCheck(temporaryJsPath);

    assert.equal(savedBuild.status, 'draft');
    await fs.rm(publicBuildDir, { recursive: true, force: true });

    for (const [assetPath, expectedContent] of Object.entries(originalFiles)) {
      if (!expectedContentTypes[assetPath]) {
        continue;
      }

      const fallbackAsset = await request(server, {
        path: `/builds/${projectId}/${savedBuild._id}/${assetPath}${preview.search}`,
      });
      assert.equal(fallbackAsset.statusCode, 200);
      assert.deepEqual(fallbackAsset.body, expectedContent);
      assert.equal(fallbackAsset.headers['content-type'], expectedContentTypes[assetPath]);
      assert.equal(fallbackAsset.headers['content-length'], String(expectedContent.length));
      assert.equal(fallbackAsset.headers['content-encoding'], undefined);
      assert.equal(fallbackAsset.headers['x-build-artifact-sha256'], sha256(expectedContent));
      assert.equal(fallbackAsset.headers['x-build-artifact-expected-sha256'], sha256(expectedContent));
      assert.equal(fallbackAsset.headers['x-build-artifact-sha256-match'], 'true');
    }

    const publication = await publishProjectBuild({
      req,
      project,
      projectBuild: savedBuild,
      body: {},
    });
    assert.equal(publication.alreadyPublished, false);
    assert.equal(publication.publishedBuild.status, 'done');
    assert.match(publication.publicUrl, /\/p\/precompiled-test$/);

    const republishedDistDir = path.join(root, 'republished-dist');
    await writeFiles(republishedDistDir, originalFiles);
    await publishValidatedDist(republishedDistDir, publicBuildDir);
    const publishedJs = await request(server, {
      path: `/builds/${projectId}/${savedBuild._id}/assets/index-DECovwbJ.js`,
    });
    assert.equal(publishedJs.statusCode, 200);
    assert.deepEqual(publishedJs.body, originalFiles['assets/index-DECovwbJ.js']);
    assert.equal(publishedJs.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(publishedJs.headers['x-build-artifact-sha256'], sha256(originalFiles['assets/index-DECovwbJ.js']));
  } finally {
    if (server) {
      await close(server);
    }
    BuildJob.findOne = originalBuildJobFindOne;
    ProjectBuild.find = originalBuildFind;
    ProjectBuild.findOne = originalBuildFindOne;
    ProjectBuild.findOneAndUpdate = originalBuildUpdate;
    Project.findById = originalProjectFindById;
    ProjectBuild.prototype.save = originalSave;
    Project.findByIdAndUpdate = originalProjectUpdate;
    if (previousPreviewSecret === undefined) delete process.env.BUILD_PREVIEW_SECRET;
    else process.env.BUILD_PREVIEW_SECRET = previousPreviewSecret;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(
      path.join(__dirname, '..', 'public', 'builds', String(projectId)),
      { recursive: true, force: true }
    );
  }
});

test('project ZIP with dist/index.html is accepted and non-dist content is ignored', async () => {
  const root = await makeTempDir('fluid-precompiled-project');

  try {
    const zipPath = path.join(root, 'dist.zip');
    const extractedDir = path.join(root, 'isolated-dist');
    const markerPath = path.join(root, 'postinstall-ran');
    await writeZip(zipPath, [
      { name: 'dist/index.html', content: '<div id="root"></div><script src="./assets/app.js"></script>' },
      { name: 'dist/assets/app.js', content: 'document.querySelector("#root").textContent = "ready";' },
      { name: 'src/main.jsx', content: 'const apiKey = "sk-proj-secret-outside-dist-123456";' },
      { name: 'node_modules/pkg/index.js', content: 'throw new Error("ignored");' },
      {
        name: 'package.json',
        content: JSON.stringify({
          scripts: {
            postinstall: `node -e "require('fs').writeFileSync('${markerPath}', 'ran')"`,
          },
        }),
      },
    ]);

    const manifest = inspectPrecompiledDistZip(zipPath);
    assert.equal(manifest.format, 'project_with_dist');
    await extractPrecompiledDistZipSafely(zipPath, extractedDir);
    const validation = await validateDistDirectory(extractedDir);
    const security = await assertPrecompiledDistSecurityAllowsPublication(validation);

    assert.equal(security.status, 'passed');
    assert.equal(await fs.readFile(path.join(extractedDir, 'index.html'), 'utf8'), '<div id="root"></div><script src="./assets/app.js"></script>');
    assert.equal(fsSync.existsSync(path.join(extractedDir, 'src')), false);
    assert.equal(fsSync.existsSync(path.join(extractedDir, 'node_modules')), false);
    assert.equal(fsSync.existsSync(path.join(extractedDir, 'package.json')), false);
    assert.equal(fsSync.existsSync(markerPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled project ZIP with multiple valid dist directories is rejected', async () => {
  const root = await makeTempDir('fluid-precompiled-multiple-dist');

  try {
    const zipPath = path.join(root, 'dist.zip');
    await writeZip(zipPath, [
      { name: 'dist/index.html', content: '<div>root dist</div>' },
      { name: 'packages/app/dist/index.html', content: '<div>nested dist</div>' },
    ]);

    assert.throws(
      () => inspectPrecompiledDistZip(zipPath),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'ambiguous_dist'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled project ZIP with dist but without dist/index.html is rejected', async () => {
  const root = await makeTempDir('fluid-precompiled-missing-dist-index');

  try {
    const zipPath = path.join(root, 'dist.zip');
    await writeZip(zipPath, [
      { name: 'index.html', content: '<div>must not be used when dist exists</div>' },
      { name: 'dist/assets/app.js', content: 'console.log("missing dist index");' },
    ]);

    assert.throws(
      () => inspectPrecompiledDistZip(zipPath),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'missing_index'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled ZIP with unexpectedly nested dist is rejected', async () => {
  const root = await makeTempDir('fluid-precompiled-nested-dist');

  try {
    const zipPath = path.join(root, 'dist.zip');
    await writeZip(zipPath, [
      { name: 'dist/dist/index.html', content: '<div>nested dist</div>' },
    ]);

    assert.throws(
      () => inspectPrecompiledDistZip(zipPath),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'nested_dist'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('direct dist ZIP with package and source content is rejected without executing lifecycle scripts', async () => {
  const root = await makeTempDir('fluid-precompiled-source');

  try {
    const markerPath = path.join(root, 'postinstall-ran');
    const zipPath = path.join(root, 'source.zip');
    await writeZip(zipPath, [
      { name: 'index.html', content: '<div>not enough to make source safe</div>' },
      {
        name: 'package.json',
        content: JSON.stringify({
          scripts: {
            postinstall: `node -e "require('fs').writeFileSync('${markerPath}', 'ran')"`,
          },
        }),
      },
      { name: 'src/main.jsx', content: 'throw new Error("must never run")' },
    ]);

    assert.throws(
      () => inspectPrecompiledDistZip(zipPath),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'source_file'
    );
    assert.equal(fsSync.existsSync(markerPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled dist rejects zip slip, symlinks, and executable entries', async () => {
  const root = await makeTempDir('fluid-precompiled-hostile');

  try {
    const traversalZip = path.join(root, 'traversal.zip');
    await writeZip(traversalZip, [
      { name: 'index.html', content: '<div>ok</div>' },
      { name: 'aa/escape.js', content: 'escape' },
    ]);
    await patchZipEntryName(traversalZip, 'aa/escape.js', '../escape.js');
    assert.throws(
      () => inspectPrecompiledDistZip(traversalZip),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'path_traversal'
    );

    const symlinkZip = path.join(root, 'symlink.zip');
    await writeZip(symlinkZip, [
      { name: 'index.html', content: '<div>ok</div>' },
      { name: 'assets/passwd.txt', content: '/etc/passwd' },
    ]);
    await patchZipExternalAttributes(symlinkZip, 0o120777 << 16);
    assert.throws(
      () => inspectPrecompiledDistZip(symlinkZip),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'symlink'
    );

    const executableZip = path.join(root, 'executable.zip');
    await writeZip(executableZip, [{ name: 'index.html', content: '<div>ok</div>' }]);
    await patchZipExternalAttributes(executableZip, 0o100755 << 16);
    assert.throws(
      () => inspectPrecompiledDistZip(executableZip),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'executable_mode'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('precompiled dist rejects dangerous extensions and configured size or count excess', async () => {
  const root = await makeTempDir('fluid-precompiled-limits');

  try {
    const dangerousZip = path.join(root, 'dangerous.zip');
    await writeZip(dangerousZip, [
      { name: 'index.html', content: '<div>ok</div>' },
      { name: 'assets/start.sh', content: 'echo unsafe' },
    ]);
    assert.throws(
      () => inspectPrecompiledDistZip(dangerousZip),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'dangerous_extension'
    );

    const limitsZip = path.join(root, 'limits.zip');
    await writeZip(limitsZip, [
      { name: 'index.html', content: '<div>ok</div>' },
      { name: 'assets/app.js', content: 'x' },
    ]);
    assert.throws(
      () => inspectPrecompiledDistZip(limitsZip, { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 }),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'size_or_encryption_limit'
    );
    assert.throws(
      () => inspectPrecompiledDistZip(limitsZip, { maxFiles: 10, maxFileBytes: 4, maxTotalBytes: 4096 }),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'size_or_encryption_limit'
    );
    assert.throws(
      () => inspectPrecompiledDistZip(limitsZip, {
        maxEntries: 1,
        maxFiles: 10,
        maxFileBytes: 1024,
        maxTotalBytes: 4096,
      }),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'entry_limit'
    );

    const projectLimitZip = path.join(root, 'project-limit.zip');
    await writeZip(projectLimitZip, [
      { name: 'dist/index.html', content: '<div>ok</div>' },
      { name: 'src/ignored.js', content: 'console.log("ignored but still counted by ZIP limits");' },
    ]);
    assert.throws(
      () => inspectPrecompiledDistZip(projectLimitZip, {
        maxZipFiles: 1,
        maxFiles: 10,
        maxFileBytes: 1024,
        maxTotalBytes: 4096,
      }),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'size_or_encryption_limit'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('critical secret inside the detected dist blocks publication', async () => {
  const root = await makeTempDir('fluid-precompiled-secret');

  try {
    const zipPath = path.join(root, 'dist.zip');
    const extractedDir = path.join(root, 'isolated-dist');
    const publishedDir = path.join(root, 'published');
    const padding = crypto.randomBytes(1600 * 1024).toString('base64');
    const secretAfterOldScanLimit = `${padding}\nconst apiKey = "sk-proj-critical-secret-123456";`;
    await writeZip(zipPath, [
      { name: 'index.html', content: '<script src="./assets/app.js"></script>' },
      { name: 'assets/app.js', content: secretAfterOldScanLimit },
    ]);

    await extractPrecompiledDistZipSafely(zipPath, extractedDir);
    const validation = await validateDistDirectory(extractedDir);
    await assert.rejects(
      assertPrecompiledDistSecurityAllowsPublication(validation),
      (error) => error.code === 'BUILD_SECURITY_BLOCKED' && error.security.criticalFindings >= 1
    );
    assert.equal(fsSync.existsSync(publishedDir), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Admin API exposes the workerless dist flow and keeps source ZIP worker-gated', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'routes', 'adminRoutes.js'), 'utf8');
  const routePaths = adminRoutes.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);

  assert.equal(adminRoutes.reactViteBuildHelpers.buildWorkerEnabled, false);
  assert.ok(routePaths.includes('/projects/:id/react-vite/dist'));
  assert.match(source, /ZIP de código-fonte React\/Vite exige um build worker sandboxado/);
  assert.match(source, /dist pré-compilado/);
  assert.match(source, /PRECOMPILED_DIST_FORMATS/);
  assert.equal(source.includes('return runLegacyReactViteBuild(req, res'), false);

  const statusReq = {
    adminAuth: {
      actorType: 'admin',
      adminUserId: new mongoose.Types.ObjectId(),
      permission: 'owner',
    },
  };
  const statusRes = createResponse();
  await getFinalGetRouteHandler('/status')(statusReq, statusRes);
  assert.deepEqual(
    statusRes.body.reactVite.precompiledDist.acceptedFormats,
    ['direct_dist', 'project_with_dist']
  );
  assert.equal(statusRes.body.reactVite.sourceZip.enabled, false);
  assert.equal(statusRes.body.reactVite.precompiledDist.requiresBuildWorker, false);
  assert.match(statusRes.body.reactVite.precompiledDist.message, /nada é executado/);

  const uploadDir = await makeTempDir('fluid-source-worker-disabled');
  const req = {
    file: { path: path.join(uploadDir, 'source.zip') },
    project: { _id: new mongoose.Types.ObjectId() },
    reactViteBuildDir: uploadDir,
  };
  const res = createResponse();
  await getFinalRouteHandler('/projects/:id/react-vite')(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'BUILD_WORKER_REQUIRED');
  assert.match(res.body.message, /dist pré-compilado/);
  assert.equal(fsSync.existsSync(uploadDir), false);
});

test('precompiled dist route returns JSON for unsupported methods', async () => {
  const req = {
    params: { id: String(new mongoose.Types.ObjectId()) },
  };
  const res = createResponse();

  await getFinalAllRouteHandler('/projects/:id/react-vite/dist')(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'METHOD_NOT_ALLOWED');
  assert.match(res.body.message, /POST/);
});

test('precompiled dist upload persists normalized browser-resolved asset aliases', async () => {
  const root = await makeTempDir('fluid-precompiled-route-alias');
  const projectId = new mongoose.Types.ObjectId();
  const oldBuildId = new mongoose.Types.ObjectId();
  const draftBuildId = new mongoose.Types.ObjectId();
  const foreignProjectId = new mongoose.Types.ObjectId();
  const foreignBuildId = new mongoose.Types.ObjectId();
  const zipPath = path.join(root, 'dist.zip');
  const heroPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lP5VhQAAAABJRU5ErkJggg==',
    'base64'
  );
  const originalEnv = {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
    ADMIN_TOKEN_LEGACY_ENABLED: process.env.ADMIN_TOKEN_LEGACY_ENABLED,
    ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED: process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED,
    BUILD_PREVIEW_SECRET: process.env.BUILD_PREVIEW_SECRET,
  };
  const originalAuditFindOne = AdminAuditLog.findOne;
  const originalAuditCreate = AdminAuditLog.create;
  const originalBuildFind = ProjectBuild.find;
  const originalBuildFindById = ProjectBuild.findById;
  const originalBuildFindOne = ProjectBuild.findOne;
  const originalBuildSave = ProjectBuild.prototype.save;
  const originalProjectFindById = Project.findById;
  const originalProjectFindByIdAndUpdate = Project.findByIdAndUpdate;
  const originalBuildDeleteOne = ProjectBuild.deleteOne;
  const builds = new Map();
  const projects = new Map();
  let savedBuild = null;
  let server = null;

  const buildIndexUrl = (buildId) => `https://preview.askfluid.now/builds/${projectId}/${buildId}/index.html`;
  const makeStoredBuild = ({ _id, projectId: ownerProjectId = projectId, status = 'done' }) => ({
    _id,
    projectId: ownerProjectId,
    type: 'react_vite',
    status,
    previewUrl: `https://preview.askfluid.now/builds/${ownerProjectId}/${_id}/index.html`,
    distUrl: `https://preview.askfluid.now/builds/${ownerProjectId}/${_id}/index.html`,
    buildUrl: `https://preview.askfluid.now/builds/${ownerProjectId}/${_id}/index.html`,
    deployUrl: `https://preview.askfluid.now/builds/${ownerProjectId}/${_id}/index.html`,
    artifactFiles: [
      {
        relativePath: 'index.html',
        path: 'index.html',
        mimeType: 'text/html; charset=utf-8',
        contentType: 'text/html; charset=utf-8',
        encoding: 'base64',
        content: Buffer.from('<!doctype html><div>stored</div>').toString('base64'),
      },
    ],
  });
  const normalizeBuild = (build) => (build && typeof build.toObject === 'function'
    ? build.toObject({ getters: true, virtuals: true })
    : build);
  const buildMatchesQuery = (build, query = {}) => {
    if (!build) return false;
    if (query._id && String(build._id) !== String(query._id)) return false;
    if (query.projectId && String(build.projectId) !== String(query.projectId)) return false;
    if (!Array.isArray(query.$or)) return true;

    return query.$or.some((condition) => Object.entries(condition).some(([field, expected]) => {
      const value = build[field];
      if (expected instanceof RegExp) return expected.test(String(value || ''));
      return String(value || '') === String(expected);
    }));
  };
  const findBuilds = (query = {}) => Array.from(builds.values())
    .map(normalizeBuild)
    .filter((build) => buildMatchesQuery(build, query));

  try {
    await writeZip(zipPath, [
      { name: 'index.html', content: '<!doctype html><script type="module" src="./assets/index.js"></script><div id="root"></div>' },
      { name: 'assets/index.js', content: 'const hero = "./images/hero.png"; document.body.dataset.hero = hero;' },
      { name: 'images/hero.png', content: heroPng },
    ]);

    projects.set(String(projectId), {
      _id: projectId,
      userId: new mongoose.Types.ObjectId(),
      isPublished: false,
      latestPublishedBuildId: oldBuildId,
      name: 'Alias Route Test',
      slug: 'alias-route-test',
      reactVite: true,
    });
    projects.set(String(foreignProjectId), {
      _id: foreignProjectId,
      userId: new mongoose.Types.ObjectId(),
      isPublished: false,
      latestPublishedBuildId: null,
      name: 'Foreign',
      slug: 'foreign',
      reactVite: true,
    });
    builds.set(String(oldBuildId), makeStoredBuild({ _id: oldBuildId, status: 'done' }));
    builds.set(String(draftBuildId), makeStoredBuild({ _id: draftBuildId, status: 'draft' }));
    builds.set(
      String(foreignBuildId),
      makeStoredBuild({ _id: foreignBuildId, projectId: foreignProjectId, status: 'done' })
    );

    process.env.ADMIN_TOKEN = 'precompiled-route-alias-token';
    process.env.ADMIN_TOKEN_LEGACY_ENABLED = 'true';
    process.env.ADMIN_TOKEN_LEGACY_CRITICAL_ENABLED = 'true';
    process.env.BUILD_PREVIEW_SECRET = 'precompiled-route-alias-preview-secret';

    AdminAuditLog.findOne = () => selectableValue(null);
    AdminAuditLog.create = async () => ({ _id: new mongoose.Types.ObjectId() });
    Project.findById = (id) => selectableValue(projects.get(String(id)) || null);
    Project.findByIdAndUpdate = async (id, update) => {
      const project = projects.get(String(id));
      Object.assign(project, update);
      return project;
    };
    ProjectBuild.deleteOne = async ({ _id }) => {
      builds.delete(String(_id));
      return { deletedCount: 1 };
    };
    ProjectBuild.prototype.save = async function saveRouteBuild() {
      savedBuild = this;
      builds.set(String(this._id), this);
      return this;
    };
    ProjectBuild.findById = (id) => selectableValue(normalizeBuild(builds.get(String(id))) || null);
    ProjectBuild.findOne = (query = {}) => selectableValue(findBuilds(query)[0] || null);
    ProjectBuild.find = (query = {}) => selectableValue(findBuilds(query));

    server = await listen();
    const uploadBody = multipartZipBody('file', 'dist.zip', await fs.readFile(zipPath));
    const upload = await request(server, {
      method: 'POST',
      path: `/api/admin/projects/${projectId}/react-vite/dist`,
      headers: {
        Host: 'fluidbe.onrender.com',
        Origin: 'https://askfluid.now',
        'x-admin-token': process.env.ADMIN_TOKEN,
        'Content-Type': uploadBody.contentType,
      },
      body: uploadBody.body,
    });
    const uploadJson = JSON.parse(upload.text);

    assert.equal(upload.statusCode, 201);
    assert.equal(uploadJson.flow, 'precompiled_dist');
    assert.ok(savedBuild);
    const newBuildId = String(savedBuild._id);
    assert.notEqual(newBuildId, String(oldBuildId));

    const savedPaths = savedBuild.artifactFiles.map((file) => file.relativePath).sort();
    assert.ok(savedPaths.includes('images/hero.png'));
    assert.ok(savedPaths.includes('assets/images/hero.png'));

    const reloadedBuild = await ProjectBuild.findById(newBuildId).select('artifactFiles').lean();
    const reloadedPaths = reloadedBuild.artifactFiles.map((file) => file.relativePath).sort();
    assert.ok(reloadedPaths.includes('images/hero.png'));
    assert.ok(reloadedPaths.includes('assets/images/hero.png'));

    savedBuild.status = 'done';
    const project = projects.get(String(projectId));
    project.isPublished = true;
    project.latestPublishedBuildId = savedBuild._id;
    project.previewUrl = buildIndexUrl(newBuildId);
    project.distUrl = buildIndexUrl(newBuildId);
    project.buildUrl = buildIndexUrl(newBuildId);
    project.deployUrl = buildIndexUrl(newBuildId);

    const publicBuildDir = path.join(__dirname, '..', 'public', 'builds', String(projectId), newBuildId);
    await fs.rm(publicBuildDir, { recursive: true, force: true });

    for (const assetPath of ['images/hero.png', 'assets/images/hero.png']) {
      const asset = await request(server, {
        path: `/builds/${projectId}/${newBuildId}/${assetPath}`,
        headers: { Host: 'preview.askfluid.now' },
      });
      assert.equal(asset.statusCode, 200);
      assert.deepEqual(asset.body, heroPng);
      assert.equal(asset.headers['content-type'], 'image/png');
    }

    const oldAsset = await request(server, {
      path: `/builds/${projectId}/${oldBuildId}/index.html`,
      headers: { Host: 'preview.askfluid.now' },
    });
    const draftAsset = await request(server, {
      path: `/builds/${projectId}/${draftBuildId}/index.html`,
      headers: { Host: 'preview.askfluid.now' },
    });
    const foreignAsset = await request(server, {
      path: `/builds/${foreignProjectId}/${foreignBuildId}/index.html`,
      headers: { Host: 'preview.askfluid.now' },
    });

    assert.equal(oldAsset.statusCode, 404);
    assert.equal(draftAsset.statusCode, 404);
    assert.equal(foreignAsset.statusCode, 404);
  } finally {
    if (server) {
      await close(server).catch(() => {});
    }
    AdminAuditLog.findOne = originalAuditFindOne;
    AdminAuditLog.create = originalAuditCreate;
    ProjectBuild.find = originalBuildFind;
    ProjectBuild.findById = originalBuildFindById;
    ProjectBuild.findOne = originalBuildFindOne;
    ProjectBuild.prototype.save = originalBuildSave;
    ProjectBuild.deleteOne = originalBuildDeleteOne;
    Project.findById = originalProjectFindById;
    Project.findByIdAndUpdate = originalProjectFindByIdAndUpdate;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.join(__dirname, '..', 'public', 'builds', String(projectId)), { recursive: true, force: true });
    await fs.rm(path.join(__dirname, '..', 'storage', 'react-vite-builds', String(projectId)), { recursive: true, force: true });
  }
});
