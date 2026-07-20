const assert = require('assert/strict');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const mongoose = require('mongoose');

process.env.BUILD_WORKER_ENABLED = 'false';

const adminRoutes = require('../routes/adminRoutes');
const BuildJob = require('../models/BuildJob');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
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
    zip.addFile(entry.name, Buffer.from(entry.content || 'x'));
  }

  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => error ? reject(error) : resolve());
  });
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

    await extractPrecompiledDistZipSafely(zipPath, extractedDir);
    const validation = await validateDistDirectory(extractedDir);
    const security = await assertPrecompiledDistSecurityAllowsPublication(validation);
    await publishValidatedDist(extractedDir, publishedDir);

    assert.equal(adminRoutes.reactViteBuildHelpers.buildWorkerEnabled, false);
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
  const originalBuildUpdate = ProjectBuild.findOneAndUpdate;
  const originalSave = ProjectBuild.prototype.save;
  const originalProjectUpdate = Project.findByIdAndUpdate;
  const previousPreviewSecret = process.env.BUILD_PREVIEW_SECRET;
  let savedBuild = null;

  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await writeZip(zipPath, [
      { name: 'index.html', content: '<div id="root"></div>' },
      { name: 'assets/app.js', content: 'document.querySelector("#root").textContent = "ready";' },
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
    ProjectBuild.findOneAndUpdate = async () => {
      savedBuild.status = 'done';
      return savedBuild;
    };
    Project.findByIdAndUpdate = async (id, update) => ({
      _id: id,
      ...update,
      publicUrl: update['deploy.url'] || '',
    });

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
    assert.equal(res.body.requiresBuildWorker, false);
    assert.equal(res.body.publicationRequired, true);
    assert.equal(savedBuild.status, 'draft');
    assert.equal(savedBuild.buildJobId, null);
    assert.equal(fsSync.existsSync(uploadDir), false);
    assert.equal(
      await fs.readFile(
        path.join(__dirname, '..', 'public', 'builds', String(projectId), String(savedBuild._id), 'index.html'),
        'utf8'
      ),
      '<div id="root"></div>'
    );

    const publication = await publishProjectBuild({
      req,
      project,
      projectBuild: savedBuild,
      body: {},
    });
    assert.equal(publication.alreadyPublished, false);
    assert.equal(publication.publishedBuild.status, 'done');
    assert.match(publication.publicUrl, /\/p\/precompiled-test$/);
  } finally {
    BuildJob.findOne = originalBuildJobFindOne;
    ProjectBuild.findOneAndUpdate = originalBuildUpdate;
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

test('precompiled dist ZIP without root index.html is rejected', async () => {
  const root = await makeTempDir('fluid-precompiled-index');

  try {
    const zipPath = path.join(root, 'dist.zip');
    await writeZip(zipPath, [
      { name: 'dist/index.html', content: '<div>wrapped dist is outside the expected root</div>' },
    ]);

    assert.throws(
      () => inspectPrecompiledDistZip(zipPath),
      (error) => error.code === INVALID_PRECOMPILED_DIST_CODE && error.reason === 'missing_index'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('package and source ZIP content is rejected without executing lifecycle scripts', async () => {
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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('critical secret anywhere in precompiled text blocks publication', async () => {
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
  assert.equal(source.includes('return runLegacyReactViteBuild(req, res'), false);

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
