const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const ProjectBuild = require('../models/ProjectBuild');
const {
  createCurrentProjectSnapshot,
  extractHtmlSnapshot,
  extractJsStrings,
  invalidateProjectSnapshotCache,
  looksSensitiveForSnapshot,
} = require('../utils/projectSnapshot');

function createFindOneMock(docs) {
  return (query = {}) => {
    let result = docs.filter((doc) => {
      if (query._id && String(doc._id) !== String(query._id)) return false;
      if (query.projectId && String(doc.projectId) !== String(query.projectId)) return false;
      if (query.status && doc.status !== query.status) return false;
      if (query.$or && doc.status === 'draft') {
        const hasPreview = Boolean(doc.fullHtml || doc.html || (doc.artifactFiles && doc.artifactFiles.length) || /\/builds\//.test(doc.previewUrl || doc.buildUrl || doc.distUrl || ''));
        if (!hasPreview) return false;
      }
      return true;
    });
    const chain = {
      sort(sortSpec) {
        const fields = Object.entries(sortSpec || {});
        result = [...result].sort((left, right) => {
          for (const [field, order] of fields) {
            const leftValue = field === '_id' ? String(left._id) : new Date(left[field] || 0).getTime();
            const rightValue = field === '_id' ? String(right._id) : new Date(right[field] || 0).getTime();
            if (leftValue === rightValue) continue;
            return order < 0 ? (rightValue > leftValue ? 1 : -1) : (leftValue > rightValue ? 1 : -1);
          }
          return 0;
        });
        return this;
      },
      select() { return this; },
      lean: async () => result[0] || null,
      then(resolve, reject) {
        return Promise.resolve(result[0] || null).then(resolve, reject);
      },
    };
    return chain;
  };
}

async function withBuilds(docs, fn) {
  const previousFindOne = ProjectBuild.findOne;
  ProjectBuild.findOne = createFindOneMock(docs);

  try {
    return await fn();
  } finally {
    ProjectBuild.findOne = previousFindOne;
    docs.forEach((doc) => invalidateProjectSnapshotCache(doc.projectId));
  }
}

test('project snapshot extracts real home title, headings, buttons and navigation', async () => {
  const html = '<html><head><title>TasteFlow</title><script>document.body.textContent = "ignore";</script></head><body><nav>Home Menu</nav><main><h1>TasteFlow</h1><p>Fresh bowls for busy teams.</p><button>Start order</button></main></body></html>';
  const snapshot = extractHtmlSnapshot(html);

  assert.equal(snapshot.title, 'TasteFlow');
  assert.deepEqual(snapshot.headings, ['TasteFlow']);
  assert.deepEqual(snapshot.buttons, ['Start order']);
  assert.deepEqual(snapshot.navigation, ['Home Menu']);
  assert.ok(snapshot.visibleTexts.includes('Fresh bowls for busy teams.'));
  assert.equal(snapshot.visibleTexts.includes('ignore'), false);
});

test('project snapshot never mixes project A with project B build content', async () => {
  const projectA = { _id: 'project-a', name: 'TasteFlow' };
  const projectB = { _id: 'project-b', name: 'MealHub' };

  await withBuilds([
    {
      _id: 'build-a',
      projectId: projectA._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>TasteFlow</h1><p>Fresh bowls.</p></main>',
      createdAt: new Date('2026-07-21T10:00:00Z'),
      updatedAt: new Date('2026-07-21T10:00:00Z'),
    },
    {
      _id: 'build-b',
      projectId: projectB._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>MealHub</h1><p>Old delivery app.</p></main>',
      createdAt: new Date('2026-07-22T10:00:00Z'),
      updatedAt: new Date('2026-07-22T10:00:00Z'),
    },
  ], async () => {
    const snapshot = await createCurrentProjectSnapshot(projectA);

    assert.match(snapshot.promptBlock, /TasteFlow/);
    assert.doesNotMatch(snapshot.promptBlock, /MealHub/);
    assert.equal(String(snapshot.build._id), 'build-a');
  });
});

test('project snapshot prefers published/done build and old project name does not replace current build text', async () => {
  const project = {
    _id: 'project-current',
    name: 'MealHub',
    appName: 'TasteFlow',
    latestPublishedBuildId: 'build-current',
  };

  await withBuilds([
    {
      _id: 'build-old',
      projectId: project._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>MealHub</h1></main>',
      createdAt: new Date('2026-07-20T10:00:00Z'),
      updatedAt: new Date('2026-07-20T10:00:00Z'),
    },
    {
      _id: 'build-current',
      projectId: project._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>TasteFlow</h1><button>Plan meals</button></main>',
      createdAt: new Date('2026-07-21T10:00:00Z'),
      updatedAt: new Date('2026-07-21T10:00:00Z'),
    },
  ], async () => {
    const snapshot = await createCurrentProjectSnapshot(project);

    assert.match(snapshot.promptBlock, /Build: id=build-current/);
    assert.match(snapshot.promptBlock, /Headings: TasteFlow/);
    assert.match(snapshot.promptBlock, /Buttons: Plan meals/);
  });
});

test('project snapshot falls back to latest draft preview when no done build exists', async () => {
  const project = { _id: 'project-draft', name: 'TasteFlow' };

  await withBuilds([
    {
      _id: 'draft-old',
      projectId: project._id,
      type: 'html',
      status: 'draft',
      fullHtml: '<main><h1>Old draft</h1></main>',
      createdAt: new Date('2026-07-20T10:00:00Z'),
      updatedAt: new Date('2026-07-20T10:00:00Z'),
    },
    {
      _id: 'draft-new',
      projectId: project._id,
      type: 'html',
      status: 'draft',
      fullHtml: '<main><h1>TasteFlow Draft</h1></main>',
      createdAt: new Date('2026-07-22T10:00:00Z'),
      updatedAt: new Date('2026-07-22T10:00:00Z'),
    },
  ], async () => {
    const snapshot = await createCurrentProjectSnapshot(project);

    assert.match(snapshot.promptBlock, /Build: id=draft-new/);
    assert.match(snapshot.promptBlock, /TasteFlow Draft/);
  });
});

test('project snapshot invalidates old context when a newer build appears', async () => {
  const project = { _id: 'project-invalidate', name: 'TasteFlow' };
  const docs = [
    {
      _id: 'build-old',
      projectId: project._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>Old Name</h1></main>',
      createdAt: new Date('2026-07-20T10:00:00Z'),
      updatedAt: new Date('2026-07-20T10:00:00Z'),
    },
  ];

  await withBuilds(docs, async () => {
    const oldSnapshot = await createCurrentProjectSnapshot(project);
    assert.match(oldSnapshot.promptBlock, /Old Name/);

    docs.push({
      _id: 'build-new',
      projectId: project._id,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>TasteFlow New</h1></main>',
      createdAt: new Date('2026-07-22T10:00:00Z'),
      updatedAt: new Date('2026-07-22T10:00:00Z'),
    });
    invalidateProjectSnapshotCache(project._id);
    const newSnapshot = await createCurrentProjectSnapshot(project);

    assert.match(newSnapshot.promptBlock, /TasteFlow New/);
    assert.doesNotMatch(newSnapshot.promptBlock, /Old Name/);
  });
});

test('project snapshot analyzes React/Vite dist assets without executing code', async () => {
  const projectId = '64f00000000000000000a111';
  const buildId = '64f00000000000000000b222';
  const buildDir = path.join(__dirname, '..', 'public', 'builds', projectId, buildId);
  const sideEffectPath = path.join(os.tmpdir(), 'fluid-snapshot-should-not-exist');

  await fs.rm(path.dirname(buildDir), { recursive: true, force: true });
  await fs.rm(sideEffectPath, { force: true });

  try {
    await fs.mkdir(path.join(buildDir, 'assets'), { recursive: true });
    await fs.writeFile(
      path.join(buildDir, 'index.html'),
      `<!doctype html><div id="root"></div><script type="module" src="/builds/${projectId}/${buildId}/assets/app.js"></script>`
    );
    await fs.writeFile(
      path.join(buildDir, 'assets', 'app.js'),
      `function HeroSection(){return {children:"TasteFlow"}}; globalThis.require && require("fs").writeFileSync(${JSON.stringify(sideEffectPath)},"ran"); const c={children:"Fresh bowls for busy teams",label:"Start order"};`
    );

    await withBuilds([
      {
        _id: buildId,
        projectId,
        type: 'react_vite',
        status: 'done',
        previewUrl: `/builds/${projectId}/${buildId}/index.html`,
        artifactFiles: [],
        indexedFiles: [],
        createdAt: new Date('2026-07-22T10:00:00Z'),
        updatedAt: new Date('2026-07-22T10:00:00Z'),
      },
    ], async () => {
      const snapshot = await createCurrentProjectSnapshot({ _id: projectId, name: 'TasteFlow' });

      assert.match(snapshot.promptBlock, /TasteFlow/);
      assert.match(snapshot.promptBlock, /Fresh bowls for busy teams/);
      assert.match(snapshot.promptBlock, /HeroSection/);
      await assert.rejects(() => fs.stat(sideEffectPath), /ENOENT/);
    });
  } finally {
    await fs.rm(path.dirname(buildDir), { recursive: true, force: true });
    await fs.rm(sideEffectPath, { force: true });
  }
});

test('project snapshot keeps secret scanner and source-map limits active', async () => {
  assert.equal(looksSensitiveForSnapshot('assets/app.js', 'const OPENAI_API_KEY="sk-proj-secretvalue123";'), true);
  assert.deepEqual(extractJsStrings('const a="TasteFlow"; const b="./assets/app.js"; const c="children";'), ['TasteFlow']);

  const project = { _id: 'project-secrets', name: 'TasteFlow' };

  await withBuilds([
    {
      _id: 'build-secret',
      projectId: project._id,
      type: 'react_vite',
      status: 'done',
      artifactFiles: [
        {
          relativePath: 'index.html',
          encoding: 'base64',
          content: Buffer.from('<main><h1>TasteFlow</h1></main>').toString('base64'),
        },
        {
          relativePath: 'assets/app.js',
          encoding: 'base64',
          content: Buffer.from('const OPENAI_API_KEY="sk-proj-verysecret123456789";').toString('base64'),
        },
        {
          relativePath: 'assets/app.js.map',
          encoding: 'base64',
          content: Buffer.from('{"sourcesContent":["MealHub source map"]}').toString('base64'),
        },
      ],
      createdAt: new Date('2026-07-22T10:00:00Z'),
      updatedAt: new Date('2026-07-22T10:00:00Z'),
    },
  ], async () => {
    const snapshot = await createCurrentProjectSnapshot(project);

    assert.match(snapshot.promptBlock, /TasteFlow/);
    assert.doesNotMatch(snapshot.promptBlock, /OPENAI_API_KEY/);
    assert.doesNotMatch(snapshot.promptBlock, /sk-proj/);
    assert.doesNotMatch(snapshot.promptBlock, /MealHub source map/);
    assert.match(snapshot.promptBlock, /skipped=1/);
  });
});
