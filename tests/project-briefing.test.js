const assert = require('assert/strict');
const test = require('node:test');

const Project = require('../models/Project');
const BriefingSession = require('../models/BriefingSession');
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

test('POST /api/projects usa briefing persistido após espera e ignora conversa casual do payload', async () => {
  const originalBriefingFindOne = BriefingSession.findOne;
  const originalBriefingUpdate = BriefingSession.findOneAndUpdate;
  const originalProjectFindOne = Project.findOne;
  const originalProjectFind = Project.find;
  const originalProjectCreate = Project.create;
  const briefingSessionId = '64f0000000000000000000b1';
  const savedSession = {
    _id: briefingSessionId,
    userId: '64f000000000000000000001',
    conversationId: 'session-id',
    status: 'active',
    briefing: {
      type: 'landing-page',
      objective: 'vender',
      mainContext: 'cursos de inglês',
      audience: 'brasileiros adultos',
      style: 'premium',
      cta: 'Comprar',
    },
    briefingSummary: {
      type: 'landing-page',
      objective: 'vender',
      mainContext: 'cursos de inglês',
      audience: 'brasileiros adultos',
      style: 'premium',
      cta: 'Comprar',
    },
    structuredAnswers: {
      type: 'landing-page',
      objective: 'vender',
      mainContext: 'cursos de inglês',
      audience: 'brasileiros adultos',
      style: 'premium',
      cta: 'Comprar',
    },
    complete: true,
    canBuild: true,
    updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    projectId: null,
  };
  let createdPayload;

  BriefingSession.findOne = () => ({ lean: async () => savedSession });
  BriefingSession.findOneAndUpdate = async (query, update) => {
    Object.assign(savedSession, update.$set);
    return savedSession;
  };
  Project.findOne = async () => null;
  Project.find = () => ({ select() { return this; }, lean: async () => [] });
  Project.create = async (payload) => {
    createdPayload = payload;
    return { _id: '64f0000000000000000000c1', ...payload };
  };

  try {
    const req = {
      userId: savedSession.userId,
      session: { _id: 'session-id' },
      headers: {},
      body: {
        name: 'English Now',
        mode: 'build_now',
        projectFlow: 'new_project',
        briefingSessionId,
        prompt: 'Conversa casual anterior sobre Superman',
        briefing: { mainContext: 'Superman' },
        requiredConnectors: [{ provider: 'openai', reason: 'Conversa casual anterior' }],
      },
    };
    const res = createResponse();

    await getCreateProjectHandler()(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(createdPayload.briefing.mainContext, 'cursos de inglês');
    assert.equal(createdPayload.briefingSessionId, briefingSessionId);
    assert.match(createdPayload.prompt, /briefingSummary/);
    assert.doesNotMatch(createdPayload.prompt, /Superman/);
    assert.deepEqual(createdPayload.requiredConnectors, []);
    assert.equal(savedSession.status, 'completed');
  } finally {
    BriefingSession.findOne = originalBriefingFindOne;
    BriefingSession.findOneAndUpdate = originalBriefingUpdate;
    Project.findOne = originalProjectFindOne;
    Project.find = originalProjectFind;
    Project.create = originalProjectCreate;
  }
});

test('duplo clique em construir reutiliza o projeto e cria uma única vez', async () => {
  const originalBriefingFindOne = BriefingSession.findOne;
  const originalBriefingUpdate = BriefingSession.findOneAndUpdate;
  const originalProjectFindOne = Project.findOne;
  const originalProjectFind = Project.find;
  const originalProjectCreate = Project.create;
  const briefingSessionId = '64f0000000000000000000b2';
  const projectId = '64f0000000000000000000c2';
  const savedSession = {
    _id: briefingSessionId,
    userId: '64f000000000000000000001',
    conversationId: 'session-id',
    status: 'active',
    briefing: {
      type: 'website', objective: 'apresentar', mainContext: 'consultoria financeira', style: 'moderno',
    },
    briefingSummary: {
      type: 'website', objective: 'apresentar', mainContext: 'consultoria financeira', style: 'moderno',
    },
    structuredAnswers: {
      type: 'website', objective: 'apresentar', mainContext: 'consultoria financeira', style: 'moderno',
    },
    complete: true,
    canBuild: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    projectId: null,
  };
  let createdProject = null;
  let createCalls = 0;

  BriefingSession.findOne = () => ({ lean: async () => savedSession });
  BriefingSession.findOneAndUpdate = async (query, update) => {
    Object.assign(savedSession, update.$set);
    return savedSession;
  };
  Project.findOne = async (query) => {
    if (createdProject && (
      String(query._id || '') === projectId
      || query.creationIdempotencyKey === createdProject.creationIdempotencyKey
    )) return createdProject;
    return null;
  };
  Project.find = () => ({ select() { return this; }, lean: async () => [] });
  Project.create = async (payload) => {
    createCalls += 1;
    createdProject = { _id: projectId, ...payload };
    return createdProject;
  };

  try {
    const requestBody = {
      name: 'Fin Consult',
      mode: 'build_now',
      projectFlow: 'new_project',
      briefingSessionId,
    };
    const firstRes = createResponse();
    const secondRes = createResponse();

    await getCreateProjectHandler()({
      userId: savedSession.userId, session: { _id: 'session-id' }, headers: {}, body: requestBody,
    }, firstRes);
    await getCreateProjectHandler()({
      userId: savedSession.userId, session: { _id: 'session-id' }, headers: {}, body: requestBody,
    }, secondRes);

    assert.equal(firstRes.statusCode, 201);
    assert.equal(secondRes.statusCode, 200);
    assert.equal(secondRes.body.idempotent, true);
    assert.equal(String(secondRes.body.project._id), projectId);
    assert.equal(createCalls, 1);
  } finally {
    BriefingSession.findOne = originalBriefingFindOne;
    BriefingSession.findOneAndUpdate = originalBriefingUpdate;
    Project.findOne = originalProjectFindOne;
    Project.find = originalProjectFind;
    Project.create = originalProjectCreate;
  }
});

test('POST /api/projects retorna BRIEFING_SESSION_EXPIRED para briefing persistido expirado', async () => {
  const originalBriefingFindOne = BriefingSession.findOne;
  const originalProjectFindOne = Project.findOne;
  const originalProjectCreate = Project.create;
  let createCalled = false;

  BriefingSession.findOne = () => ({
    lean: async () => ({
      _id: '64f0000000000000000000b3',
      userId: '64f000000000000000000001',
      conversationId: 'session-id',
      status: 'active',
      briefing: {},
      complete: true,
      canBuild: true,
      expiresAt: new Date(Date.now() - 1000),
      projectId: null,
    }),
  });
  Project.findOne = async () => null;
  Project.create = async () => {
    createCalled = true;
  };

  try {
    const res = createResponse();
    await getCreateProjectHandler()({
      userId: '64f000000000000000000001',
      session: { _id: 'session-id' },
      headers: {},
      body: {
        name: 'Expired',
        mode: 'build_now',
        briefingSessionId: '64f0000000000000000000b3',
      },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'BRIEFING_SESSION_EXPIRED');
    assert.equal(res.body.restoreRequired, true);
    assert.equal(createCalled, false);
  } finally {
    BriefingSession.findOne = originalBriefingFindOne;
    Project.findOne = originalProjectFindOne;
    Project.create = originalProjectCreate;
  }
});
