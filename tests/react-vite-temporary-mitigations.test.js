const assert = require('assert/strict');
const fsSync = require('fs');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const AdmZip = require('adm-zip');

const {
  getBuildIdentityFromUrl,
  isProjectBuildExplicitlyPublished,
} = require('../utils/buildPublicationAccess');
const {
  reactViteBuildHelpers,
} = require('../routes/adminRoutes');

const {
  publishValidatedDist,
  extractZipSafely,
  runLocalBinCommand,
  runNpmCommand,
  runNpxCommand,
  validateDistDirectory,
} = reactViteBuildHelpers;

async function makeTempDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeValidDist(root) {
  const dist = path.join(root, 'dist');
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<div id="root"></div>');
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("ok");');
  return dist;
}

async function writeZip(zipPath, entries) {
  const zip = new AdmZip();

  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from(entry.content || 'x'));
    if (entry.attr !== undefined) {
      const zipEntry = zip.getEntry(entry.name);
      zipEntry.attr = entry.attr;
    }
  }

  await new Promise((resolve, reject) => {
    zip.writeZip(zipPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function patchZipSizes(zipPath, uncompressedBytes, compressedBytes) {
  const buffer = await fs.readFile(zipPath);
  const localFileHeader = 0x04034b50;
  const centralDirectoryHeader = 0x02014b50;

  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    const signature = buffer.readUInt32LE(offset);

    if (signature === localFileHeader) {
      buffer.writeUInt32LE(compressedBytes, offset + 18);
      buffer.writeUInt32LE(uncompressedBytes, offset + 22);
    } else if (signature === centralDirectoryHeader) {
      buffer.writeUInt32LE(compressedBytes, offset + 20);
      buffer.writeUInt32LE(uncompressedBytes, offset + 24);
    }
  }

  await fs.writeFile(zipPath, buffer);
}

async function patchZipEntryName(zipPath, fromName, toName) {
  assert.equal(Buffer.byteLength(fromName), Buffer.byteLength(toName));
  const buffer = await fs.readFile(zipPath);
  const from = Buffer.from(fromName);
  const to = Buffer.from(toName);
  let offset = 0;
  let patched = 0;

  while ((offset = buffer.indexOf(from, offset)) !== -1) {
    to.copy(buffer, offset);
    offset += to.length;
    patched += 1;
  }

  assert.ok(patched >= 1);
  await fs.writeFile(zipPath, buffer);
}

async function patchZipExternalAttributes(zipPath, externalAttributes) {
  const buffer = await fs.readFile(zipPath);
  const centralDirectoryHeader = 0x02014b50;
  let patched = 0;

  for (let offset = 0; offset <= buffer.length - 4; offset += 1) {
    if (buffer.readUInt32LE(offset) === centralDirectoryHeader) {
      buffer.writeUInt32LE(externalAttributes >>> 0, offset + 38);
      patched += 1;
    }
  }

  assert.ok(patched >= 1);
  await fs.writeFile(zipPath, buffer);
}

test('npm install ignores package lifecycle scripts', async () => {
  const root = await makeTempDir('fluid-npm-ignore-scripts');
  try {
    await writeJson(path.join(root, 'package.json'), {
      scripts: {
        postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-marker\', \'ran\')"',
      },
    });

    await runNpmCommand(['install', '--ignore-scripts', '--package-lock=false'], root, {
      env: {
        NODE_ENV: 'development',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      },
    });

    assert.equal(fsSync.existsSync(path.join(root, 'postinstall-marker')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('npx is disabled instead of downloading remote packages', async () => {
  const root = await makeTempDir('fluid-npx-disabled');
  try {
    await assert.rejects(
      runNpxCommand(['definitely-missing-fluid-package', '--version'], root),
      /npx remoto está desabilitado/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local Vite binary cannot resolve outside node_modules', async () => {
  const root = await makeTempDir('fluid-local-bin');
  try {
    await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
    await fs.symlink('/bin/echo', path.join(root, 'node_modules', '.bin', 'vite'));

    await assert.rejects(runLocalBinCommand('vite', ['hello'], root), /fora de node_modules/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dist validation rejects symlinks', async () => {
  const root = await makeTempDir('fluid-dist-symlink');
  try {
    const dist = await writeValidDist(root);
    await fs.symlink('/etc/passwd', path.join(dist, 'assets', 'passwd-link'));

    await assert.rejects(validateDistDirectory(dist), /symlink, socket, FIFO ou device/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('React/Vite ZIP extraction rejects traversal, symlink, zip bomb, and entry-count abuse', async () => {
  const root = await makeTempDir('fluid-zip-security');

  try {
    const traversalZip = path.join(root, 'traversal.zip');
    await writeZip(traversalZip, [{ name: 'aa/escape.txt', content: 'escape' }]);
    await patchZipEntryName(traversalZip, 'aa/escape.txt', '../escape.txt');
    await assert.rejects(
      extractZipSafely(traversalZip, path.join(root, 'out-traversal')),
      /Arquivo ZIP inválido/
    );

    const symlinkZip = path.join(root, 'symlink.zip');
    await writeZip(symlinkZip, [
      {
        name: 'link-to-secret',
        content: '/etc/passwd',
      },
    ]);
    await patchZipExternalAttributes(symlinkZip, 0o120777 << 16);
    await assert.rejects(
      extractZipSafely(symlinkZip, path.join(root, 'out-symlink')),
      /Arquivo ZIP inválido/
    );

    const bombZip = path.join(root, 'bomb.zip');
    await writeZip(bombZip, [{ name: 'bomb.txt', content: 'x' }]);
    await patchZipSizes(bombZip, 501 * 1024 * 1024, 1);
    await assert.rejects(
      extractZipSafely(bombZip, path.join(root, 'out-bomb')),
      /Arquivo ZIP inválido/
    );

    const tooManyEntriesZip = path.join(root, 'too-many.zip');
    const entries = Array.from({ length: 5001 }, (_, index) => ({
      name: `files/${index}.txt`,
      content: 'x',
    }));
    await writeZip(tooManyEntriesZip, entries);
    await assert.rejects(
      extractZipSafely(tooManyEntriesZip, path.join(root, 'out-many')),
      /Arquivo ZIP inválido/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dist validation rejects hardlinks', async () => {
  const root = await makeTempDir('fluid-dist-hardlink');
  try {
    const dist = await writeValidDist(root);
    const outside = path.join(root, 'outside-secret');
    await fs.writeFile(outside, 'secret');
    await fs.link(outside, path.join(dist, 'assets', 'hardlink-secret'));

    await assert.rejects(validateDistDirectory(dist), /hardlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dist validation rejects FIFO and socket entries', async (t) => {
  const fifoRoot = await makeTempDir('fluid-dist-fifo');
  try {
    const dist = await writeValidDist(fifoRoot);
    try {
      execFileSync('mkfifo', [path.join(dist, 'assets', 'pipe')]);
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('mkfifo is not permitted in this sandbox');
        return;
      }

      throw error;
    }
    await assert.rejects(validateDistDirectory(dist), /symlink, socket, FIFO ou device/);
  } finally {
    await fs.rm(fifoRoot, { recursive: true, force: true });
  }

  const socketRoot = await makeTempDir('fluid-dist-socket');
  const socketPath = path.join(socketRoot, 'dist', 'assets', 'sock');
  let server;
  try {
    const dist = await writeValidDist(socketRoot);
    await new Promise((resolve, reject) => {
      server = net.createServer();
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(validateDistDirectory(dist), /symlink, socket, FIFO ou device/);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(socketRoot, { recursive: true, force: true });
  }
});

test('dist validation enforces file count and byte limits', async () => {
  const root = await makeTempDir('fluid-dist-limits');
  try {
    const dist = await writeValidDist(root);

    await assert.rejects(
      validateDistDirectory(dist, { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 4096 }),
      /excede 1 arquivos/
    );
    await assert.rejects(
      validateDistDirectory(dist, { maxFiles: 10, maxFileBytes: 8, maxTotalBytes: 4096 }),
      /arquivo excede 8 bytes/
    );
    await assert.rejects(
      validateDistDirectory(dist, { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 8 }),
      /dist excede 8 bytes/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('publishValidatedDist stages and publishes only validated regular files', async () => {
  const root = await makeTempDir('fluid-dist-publish');
  try {
    const dist = await writeValidDist(root);
    const finalDir = path.join(root, 'public', 'builds', 'project', 'build');

    await publishValidatedDist(dist, finalDir);

    assert.equal(await fs.readFile(path.join(finalDir, 'index.html'), 'utf8'), '<div id="root"></div>');
    assert.equal(await fs.readFile(path.join(finalDir, 'assets', 'app.js'), 'utf8'), 'console.log("ok");');
    const siblings = await fs.readdir(path.dirname(finalDir));
    assert.deepEqual(siblings, ['build']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('build command timeout terminates the subprocess and caller can clean workspace', async () => {
  const root = await makeTempDir('fluid-build-timeout');
  try {
    await fs.writeFile(
      path.join(root, 'spawn-child.js'),
      [
        'const { spawn } = require("child_process");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => require(\\"fs\\").writeFileSync(\\"child-marker\\", \\"alive\\"), 800)"], { stdio: "ignore" });',
        'child.unref();',
        'setTimeout(() => {}, 10000);',
      ].join('\n')
    );
    await writeJson(path.join(root, 'package.json'), {
      scripts: {
        build: 'node spawn-child.js',
      },
    });

    await assert.rejects(runNpmCommand(['run', 'build'], root, { timeoutMs: 200 }), /command failed/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(fsSync.existsSync(path.join(root, 'child-marker')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  assert.equal(fsSync.existsSync(root), false);
});

test('subprocess env keeps application secrets out and keeps ignore-scripts on', async () => {
  const root = await makeTempDir('fluid-env-filter');
  const previousJwt = process.env.JWT_SECRET;
  const previousAdmin = process.env.ADMIN_TOKEN;
  try {
    process.env.JWT_SECRET = 'test-jwt-secret-must-not-leak';
    process.env.ADMIN_TOKEN = 'test-admin-token-must-not-leak';
    await writeJson(path.join(root, 'package.json'), {
      scripts: {
        build: [
          'node',
          '-e',
          '"if (process.env.JWT_SECRET || process.env.ADMIN_TOKEN) process.exit(42); if (process.env.NPM_CONFIG_IGNORE_SCRIPTS !== \'true\') process.exit(43);"',
        ].join(' '),
      },
    });

    await runNpmCommand(['run', 'build'], root);
  } finally {
    if (previousJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwt;
    if (previousAdmin === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousAdmin;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('API source no longer falls back to legacy synchronous React/Vite build', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'routes', 'adminRoutes.js'), 'utf8');

  assert.match(source, /BUILD_WORKER_REQUIRED/);
  assert.equal(source.includes('return runLegacyReactViteBuild(req, res'), false);
});

test('only the explicitly published build is public for a published project', () => {
  const project = {
    _id: 'project-a',
    isPublished: true,
    latestPublishedBuildId: 'build-new',
    buildUrl: '/builds/project-a/key-new/index.html',
    deployUrl: '/builds/project-a/key-new/index.html',
  };
  const publishedBuild = { _id: 'build-new', status: 'done' };
  const oldBuild = { _id: 'build-old', status: 'done' };

  assert.equal(
    isProjectBuildExplicitlyPublished(project, publishedBuild),
    true
  );
  assert.equal(
    isProjectBuildExplicitlyPublished(project, oldBuild),
    false
  );
});

test('published build authorization fails closed for legacy or ambiguous URL fields', () => {
  const urlFieldsOnlyProject = {
    _id: 'project-a',
    isPublished: true,
    buildUrl: 'https://apps.askfluid.now/builds/project-a/key-new/index.html?x=1#frag',
    deployUrl: 'https://old.example/builds/project-a/key-new/',
    previewUrl: '/builds/project-a/key-old/index.html',
  };
  const build = { _id: 'build-new', status: 'done' };

  assert.equal(
    isProjectBuildExplicitlyPublished(urlFieldsOnlyProject, build),
    false
  );

  assert.equal(
    isProjectBuildExplicitlyPublished(
      { ...urlFieldsOnlyProject, latestPublishedBuildId: 'missing-build' },
      build
    ),
    false
  );
});

test('published build authorization requires done status and explicit build id', () => {
  const project = {
    _id: 'project-a',
    isPublished: true,
    latestPublishedBuildId: 'build-new',
  };

  assert.equal(
    isProjectBuildExplicitlyPublished(project, { _id: 'build-new', status: 'draft' }),
    false
  );
  assert.equal(
    isProjectBuildExplicitlyPublished(project, { _id: 'build-other', status: 'done' }),
    false
  );
});

test('build URL parsing normalizes host query fragment encoding and slashes without granting access', () => {
  assert.deepEqual(
    getBuildIdentityFromUrl('https://apps.askfluid.now/builds/project-a/key-new/index.html?token=abc#frag'),
    {
      projectId: 'project-a',
      buildKey: 'key-new',
      indexBuildUrl: '/builds/project-a/key-new/index.html',
    }
  );
  assert.deepEqual(
    getBuildIdentityFromUrl('https://old.example/builds/project-a/key-new/'),
    {
      projectId: 'project-a',
      buildKey: 'key-new',
      indexBuildUrl: '/builds/project-a/key-new/index.html',
    }
  );
  assert.deepEqual(
    getBuildIdentityFromUrl('/builds/project-a/key%2Dnew/index.html?x=1'),
    {
      projectId: 'project-a',
      buildKey: 'key-new',
      indexBuildUrl: '/builds/project-a/key-new/index.html',
    }
  );
  assert.equal(getBuildIdentityFromUrl('/not-builds/project-a/key-new'), null);
});

test('published project without explicit build identifier does not make builds public', () => {
  assert.equal(
    isProjectBuildExplicitlyPublished(
      { _id: 'project-a', isPublished: true },
      { _id: 'build-new', status: 'done' }
    ),
    false
  );
});

test('published build key fields do not authorize public access without build id match', () => {
  assert.equal(
    isProjectBuildExplicitlyPublished(
      { _id: 'project-a', isPublished: true, publishedBuildKey: 'key-new' },
      { _id: 'build-other', status: 'done' }
    ),
    false
  );
});
