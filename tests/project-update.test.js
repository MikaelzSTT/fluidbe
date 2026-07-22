const assert = require('assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');

const Project = require('../models/Project');
const projectRoutes = require('../routes/projectRoutes');

function getProjectPutHandler() {
  const layer = projectRoutes.stack.find((item) => (
    item.route?.path === '/:id' &&
    item.route?.methods?.put
  ));

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

async function runPut(body, findOneAndUpdate) {
  const originalFindOneAndUpdate = Project.findOneAndUpdate;
  const handler = getProjectPutHandler();
  const req = {
    params: { id: '64f000000000000000000001' },
    projectObjectId: new mongoose.Types.ObjectId('64f000000000000000000001'),
    userId: '64f000000000000000000002',
    body,
  };
  const res = createResponse();

  Project.findOneAndUpdate = findOneAndUpdate;
  try {
    await handler(req, res);
  } finally {
    Project.findOneAndUpdate = originalFindOneAndUpdate;
  }

  return res;
}

async function runBuildStartPut(body, currentProject, findOneAndUpdate) {
  const originalFindOne = Project.findOne;
  const originalFindOneAndUpdate = Project.findOneAndUpdate;
  const handler = getProjectPutHandler();
  const req = {
    params: { id: '64f000000000000000000001' },
    projectObjectId: new mongoose.Types.ObjectId('64f000000000000000000001'),
    userId: '64f000000000000000000002',
    body,
  };
  const res = createResponse();

  Project.findOne = () => ({
    select() { return this; },
    lean: async () => currentProject,
  });
  Project.findOneAndUpdate = findOneAndUpdate;
  try {
    await handler(req, res);
  } finally {
    Project.findOne = originalFindOne;
    Project.findOneAndUpdate = originalFindOneAndUpdate;
  }

  return res;
}

test('project update builds partial update without absent name', () => {
  assert.deepEqual(
    projectRoutes.buildProjectUpdate({
      prompt: 'Refine the dashboard',
      name: undefined,
    }),
    { prompt: 'Refine the dashboard' }
  );
});

test('project PUT accepts partial update without name', async () => {
  let captured;
  const res = await runPut({ prompt: 'Refine the dashboard' }, async (...args) => {
    captured = args;
    return { _id: '64f000000000000000000001', name: 'Existing name' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(captured[0], {
    _id: new mongoose.Types.ObjectId('64f000000000000000000001'),
    userId: '64f000000000000000000002',
  });
  assert.deepEqual(captured[1], { $set: { prompt: 'Refine the dashboard' } });
  assert.equal(captured[2].runValidators, true);
  assert.equal(captured[2].new, true);
});

test('project PUT accepts valid status', async () => {
  let update;
  const res = await runPut({ status: 'done' }, async (query, nextUpdate) => {
    update = nextUpdate;
    return { _id: query._id, status: 'done' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, { $set: { status: 'done' } });
});

test('project PUT returns 400 for invalid status validation error', async () => {
  const validationError = new mongoose.Error.ValidationError();
  validationError.addError(
    'status',
    new mongoose.Error.ValidatorError({
      path: 'status',
      value: 'completed',
      kind: 'enum',
      message: '`completed` is not a valid enum value for path `status`.',
    })
  );

  const res = await runPut({ status: 'completed' }, async () => {
    throw validationError;
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Dados inválidos para atualização do projeto.' });
});

test('project PUT returns 400 for cast error', async () => {
  const res = await runPut({ prompt: 'Cast failure' }, async () => {
    throw new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Identificador de projeto inválido.' });
});

test('project PUT ignores unknown fields when valid fields are present', async () => {
  let update;
  const res = await runPut({ prompt: 'Keep this', unknownField: 'drop me' }, async (query, nextUpdate) => {
    update = nextUpdate;
    return { _id: query._id, prompt: 'Keep this' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, { $set: { prompt: 'Keep this' } });
});

test('project PUT ignores protected fields', async () => {
  let update;
  const res = await runPut({
    prompt: 'Allowed',
    owner: 'attacker',
    role: 'admin',
    publishedBuildId: '64f000000000000000000099',
    latestPublishedBuildId: '64f000000000000000000099',
    _id: '64f000000000000000000098',
    userId: '64f000000000000000000097',
  }, async (query, nextUpdate) => {
    update = nextUpdate;
    return { _id: query._id, prompt: 'Allowed' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, { $set: { prompt: 'Allowed' } });
});

test('project PUT returns 404 when project does not exist', async () => {
  const res = await runPut({ prompt: 'No matching project' }, async () => null);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: 'Projeto não encontrado.' });
});

test('project PUT returns 400 for empty payload', async () => {
  const res = await runPut({}, async () => {
    throw new Error('findOneAndUpdate should not be called');
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Nenhum campo válido enviado para atualização.' });
});

test('project PUT blocks transition to in_progress with incomplete saved briefing', async () => {
  let updated = false;
  const res = await runBuildStartPut(
    { generationStatus: 'in_progress' },
    {
      name: 'Generic Store',
      type: 'landing-page',
      prompt: 'landing page para vender produtos',
      briefing: {
        type: 'landing-page',
        objective: 'vender',
        mainContext: 'produtos',
        audience: 'adultos',
        style: 'moderno',
        cta: 'Comprar',
      },
    },
    async () => {
      updated = true;
      return null;
    }
  );

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'BRIEFING_INCOMPLETE');
  assert.equal(res.body.canBuild, false);
  assert.equal(updated, false);
});

test('project PUT allows transition to in_progress with complete saved briefing', async () => {
  let update;
  const currentProject = {
    name: 'English Now',
    type: 'landing-page',
    prompt: 'landing page para vender cursos de inglês para brasileiros adultos',
    briefing: {
      type: 'landing-page',
      objective: 'vender',
      mainContext: 'cursos de inglês',
      audience: 'brasileiros adultos',
      style: 'premium',
      cta: 'Comprar',
    },
  };
  const res = await runBuildStartPut(
    { generationStatus: 'in_progress' },
    currentProject,
    async (query, nextUpdate) => {
      update = nextUpdate;
      return { _id: query._id, ...currentProject, generationStatus: 'in_progress' };
    }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(update.$set.generationStatus, 'in_progress');
  assert.equal(update.$set.briefing.mainContext, 'cursos de inglês');
});

test('project PUT preserves normal wizard update fields and drops draft metadata', async () => {
  let update;
  const wizardPayload = {
    title: 'TasteFlow',
    name: 'TasteFlow',
    description: 'Premium delivery app',
    prompt: 'Build a premium food delivery app',
    draftPrompt: 'Build a premium food delivery app',
    mode: 'chat',
    model: 'claude',
    type: 'web-app',
    settings: { theme: 'light', primaryColor: '#2563eb', language: 'pt-BR' },
    messages: [{ role: 'user', content: 'secret token abc123' }],
    reply: 'Done',
    html: '<main></main>',
    css: 'body{}',
    js: 'console.log(1)',
    fullHtml: '<!doctype html>',
    status: 'done',
    generation_status: 'done',
    generationStatus: 'done',
    wizardStatus: 'done',
    previewUrl: '/builds/project/build/index.html',
    buildUrl: '/builds/project/build/index.html',
    deployUrl: '/builds/project/build/index.html',
    latestPublishedBuildId: '64f000000000000000000099',
    build: { internal: true },
    autoSave: true,
  };

  const res = await runPut(wizardPayload, async (query, nextUpdate) => {
    update = nextUpdate;
    return { _id: query._id, name: 'TasteFlow', status: 'done' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, {
    $set: {
      name: 'TasteFlow',
      title: 'TasteFlow',
      description: 'Premium delivery app',
      prompt: 'Build a premium food delivery app',
      type: 'web-app',
      'settings.theme': 'light',
      'settings.primaryColor': '#2563eb',
      'settings.language': 'pt-BR',
      status: 'done',
      generation_status: 'done',
      generationStatus: 'done',
    },
  });
});

test('project PUT ignores build artifacts and preview token URLs', async () => {
  let update;
  const res = await runPut({
    name: 'Safe update',
    prompt: 'Only this should be saved',
    fullHtml: '<!doctype html>' + 'x'.repeat(120000),
    latestFullHtml: '<!doctype html>' + 'y'.repeat(120000),
    latestBuild: { artifactFiles: [{ path: 'index.html', body: 'large' }] },
    build: { artifactFiles: [{ path: 'index.html', body: 'large' }], logs: 'secret' },
    artifactFiles: [{ path: 'index.html', body: 'large' }],
    logs: 'secret logs',
    sourceZipUrl: '/builds/source.zip?previewToken=secret',
    previewUrl: '/builds/project/build/index.html?previewToken=secret',
    buildUrl: '/builds/project/build/index.html?previewToken=secret',
    distUrl: '/builds/project/build/index.html?previewToken=secret',
    deployUrl: '/builds/project/build/index.html?previewToken=secret',
  }, async (query, nextUpdate) => {
    update = nextUpdate;
    return { _id: query._id, name: 'Safe update' };
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(update, {
    $set: {
      name: 'Safe update',
      prompt: 'Only this should be saved',
    },
  });
  assert.equal(JSON.stringify(update).includes('previewToken'), false);
  assert.equal(JSON.stringify(update).includes('artifactFiles'), false);
});

test('project PUT rejects Mongo update operators before querying', async () => {
  let queried = false;
  const res = await runPut({
    $set: {
      userId: '64f000000000000000000099',
    },
    prompt: 'Do not persist',
  }, async () => {
    queried = true;
    return null;
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Payload de atualização contém campos inválidos.' });
  assert.equal(queried, false);
});

test('project update rejects nested Mongo and prototype-pollution keys', () => {
  assert.equal(projectRoutes.buildProjectUpdate({
    settings: {
      $where: 'sleep(1000)',
    },
  }), null);

  assert.equal(projectRoutes.buildProjectUpdate(
    JSON.parse('{"settings":{"constructor":{"prototype":{"polluted":true}}}}')
  ), null);
});
