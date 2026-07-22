const assert = require('assert/strict');
const test = require('node:test');

const Project = require('../models/Project');
const projectRoutes = require('../routes/projectRoutes');
const {
  buildBriefingQuestions,
  evaluateProjectBriefing,
} = require('../utils/projectBriefing');

function getCreateProjectHandler() {
  const layer = projectRoutes.stack.find((item) => (
    item.route?.path === '/' && item.route?.methods?.post
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

test('landing page para vender produtos sem produto específico não conclui o briefing', () => {
  const result = evaluateProjectBriefing({
    message: 'landing page para vender produtos',
    briefing: { style: 'moderno', audience: 'adultos brasileiros' },
  });

  assert.equal(result.complete, false);
  assert.equal(result.briefing.mainContext, 'produtos');
  assert.equal(result.invalidFields.includes('mainContext'), true);
  assert.equal(result.missingFields.includes('mainContext'), true);
});

test('landing page para vender cursos de inglês para brasileiros adultos pode concluir', () => {
  const result = evaluateProjectBriefing({
    message: 'landing page para vender cursos de inglês para brasileiros adultos',
    briefing: { style: 'premium' },
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.briefing, {
    style: 'premium',
    type: 'landing-page',
    objective: 'Vender',
    mainContext: 'cursos de ingles',
    audience: 'brasileiros adultos',
    cta: 'Comprar',
  });
});

test('novo briefing ignora tema de conversa casual anterior', () => {
  const result = evaluateProjectBriefing({
    message: 'agora vamos construir',
    history: [
      { role: 'user', content: 'Quem ganha, Superman ou Hulk?' },
      { role: 'assistant', content: 'Superman.' },
    ],
    briefing: {
      type: 'landing-page',
      objective: 'vender',
      style: 'moderno',
    },
  });

  assert.equal(result.complete, false);
  assert.equal(result.briefing.mainContext, undefined);
  assert.equal(JSON.stringify(result.briefing).includes('Superman'), false);
});

test('oferta explícita é pré-preenchida e não é perguntada novamente', () => {
  const result = evaluateProjectBriefing({
    message: 'vamos criar uma landing page para vender marmitas fitness',
  });
  const questions = buildBriefingQuestions(result, 10);

  assert.equal(result.briefing.mainContext, 'marmitas fitness');
  assert.equal(result.missingFields.includes('mainContext'), false);
  assert.equal(questions.some((question) => question.field === 'mainContext'), false);
});

test('respostas vagas disparam uma nova pergunta curta de contexto', () => {
  for (const vagueAnswer of ['qualquer coisa', 'não sei', 'algo legal', 'vender produtos']) {
    const result = evaluateProjectBriefing({
      briefing: {
        type: 'landing-page',
        objective: 'vender',
        mainContext: vagueAnswer,
        audience: 'adultos brasileiros',
        style: 'moderno',
        cta: 'Comprar',
      },
    });
    const question = buildBriefingQuestions(result).find((item) => item.field === 'mainContext');

    assert.equal(result.complete, false, vagueAnswer);
    assert.ok(question, vagueAnswer);
    assert.equal(question.required, true);
    assert.equal(question.inputType, 'text');
    assert.match(question.question, /mais de detalhe/i);
  }
});

test('POST /api/projects bloqueia build sem briefing mínimo completo', async () => {
  const originalCreate = Project.create;
  let createCalled = false;
  Project.create = async () => {
    createCalled = true;
  };

  try {
    const req = {
      userId: '64f000000000000000000001',
      body: {
        name: 'Loja',
        mode: 'build_now',
        type: 'landing-page',
        prompt: 'landing page para vender produtos',
        briefing: { style: 'moderno', audience: 'adultos' },
      },
    };
    const res = createResponse();

    await getCreateProjectHandler()(req, res);

    assert.equal(res.statusCode, 422);
    assert.equal(res.body.code, 'BRIEFING_INCOMPLETE');
    assert.equal(res.body.canBuild, false);
    assert.equal(res.body.missingBriefingFields.includes('mainContext'), true);
    assert.equal(createCalled, false);
  } finally {
    Project.create = originalCreate;
  }
});

test('POST /api/projects inicia somente com briefing mínimo completo', async () => {
  const originalFind = Project.find;
  const originalCreate = Project.create;
  let createdPayload;
  Project.find = () => ({
    select() { return this; },
    lean: async () => [],
  });
  Project.create = async (payload) => {
    createdPayload = payload;
    return { _id: 'project-id', ...payload };
  };

  try {
    const req = {
      userId: '64f000000000000000000001',
      body: {
        name: 'English Now',
        mode: 'build_now',
        type: 'landing-page',
        prompt: 'landing page para vender cursos de inglês para brasileiros adultos com estilo premium',
      },
    };
    const res = createResponse();

    await getCreateProjectHandler()(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(createdPayload.status, 'in_progress');
    assert.equal(createdPayload.briefing.mainContext, 'cursos de ingles');
    assert.equal(createdPayload.briefing.audience, 'brasileiros adultos');
  } finally {
    Project.find = originalFind;
    Project.create = originalCreate;
  }
});
