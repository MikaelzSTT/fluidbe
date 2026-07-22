const assert = require('assert/strict');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Module = require('module');
const test = require('node:test');

const ChatMessage = require('../models/ChatMessage');
const BriefingSession = require('../models/BriefingSession');
const Session = require('../models/Session');
const User = require('../models/User');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const rateLimit = require('../middleware/rateLimit');

const ORIGINAL_MODULE_LOAD = Module._load;

class SmokeRedis {
  constructor() {
    this.counters = new Map();
    this.requests = new Map();
    this.reserveCalls = 0;
    this.commitCalls = 0;
    this.refundCalls = 0;
  }

  getCounter(key) {
    return this.counters.get(key) || 0;
  }

  setCounter(key, value) {
    this.counters.set(key, value);
  }

  async eval(script, options) {
    const command = options.arguments[0];
    const keys = options.keys;

    if (command === 'commit') {
      this.commitCalls += 1;
      const request = this.requests.get(keys[0]);
      if (request?.state === 'reserved') {
        request.state = 'committed';
        return [1, 'committed'];
      }
      return [0, request?.state || 'missing'];
    }

    if (command === 'refund') {
      this.refundCalls += 1;
      const request = this.requests.get(keys[0]);
      if (!request || request.state !== 'reserved') {
        return [0, request?.state || 'missing'];
      }

      keys.slice(1).forEach((key) => {
        const current = this.getCounter(key);
        if (current > 0) this.setCounter(key, current - 1);
      });
      request.state = 'refunded';
      return [1, 'refunded'];
    }

    this.reserveCalls += 1;

    const dailyLimit = Number(options.arguments[3]);
    const monthlyLimit = Number(options.arguments[4]);
    const globalDailyLimit = Number(options.arguments[5]);
    const globalMonthlyLimit = Number(options.arguments[6]);
    const ipDailyLimit = Number(options.arguments[7]);

    const existing = this.requests.get(keys[0]);
    if (existing && existing.state !== 'refunded') {
      return [
        2,
        existing.state,
        this.getCounter(keys[1]),
        this.getCounter(keys[2]),
        this.getCounter(keys[3]),
        this.getCounter(keys[4]),
        this.getCounter(keys[5]),
      ];
    }

    const daily = this.getCounter(keys[1]);
    if (daily >= dailyLimit) return [0, 'daily', daily, dailyLimit, 0];

    const monthly = this.getCounter(keys[2]);
    if (monthly >= monthlyLimit) return [0, 'monthly', monthly, monthlyLimit, 0];

    const globalDaily = this.getCounter(keys[3]);
    if (globalDaily >= globalDailyLimit) return [0, 'daily', globalDaily, globalDailyLimit, 1];

    const globalMonthly = this.getCounter(keys[4]);
    if (globalMonthly >= globalMonthlyLimit) return [0, 'monthly', globalMonthly, globalMonthlyLimit, 1];

    const ipDaily = this.getCounter(keys[5]);
    if (ipDailyLimit > 0 && ipDaily >= ipDailyLimit) {
      return [0, 'daily', ipDaily, ipDailyLimit, 0];
    }

    this.setCounter(keys[1], daily + 1);
    this.setCounter(keys[2], monthly + 1);
    this.setCounter(keys[3], globalDaily + 1);
    this.setCounter(keys[4], globalMonthly + 1);
    if (ipDailyLimit > 0) this.setCounter(keys[5], ipDaily + 1);
    this.requests.set(keys[0], { state: 'reserved' });

    return [
      1,
      'reserved',
      daily + 1,
      monthly + 1,
      globalDaily + 1,
      globalMonthly + 1,
      ipDailyLimit > 0 ? ipDaily + 1 : ipDaily,
    ];
  }
}

function clearRouteModules() {
  [
    '../routes/chatRoutes',
    '../utils/aiQuota',
  ].forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function createAnthropicMock(providerState) {
  return function AnthropicMock() {
    this.messages = {
      create: async (request) => {
        providerState.calls += 1;
        providerState.requests = providerState.requests || [];
        providerState.requests.push(request);

        if (providerState.error) {
          throw providerState.error;
        }

        const result = providerState.resultFromRequest
          ? providerState.resultFromRequest(request)
          : {
              action: 'chat',
              reply: providerState.replyFromRequest
                ? providerState.replyFromRequest(request)
                : 'Resposta mockada do provider.',
            };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      },
    };
  };
}

function createRequest(app, token, body, headers = {}, path = '/api/chat') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        method: 'POST',
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          server.close(() => {
            resolve({
              status: res.statusCode,
              body: raw ? JSON.parse(raw) : null,
            });
          });
        });
      });

      req.on('error', (error) => {
        server.close(() => reject(error));
      });
      req.end(payload);
    });
  });
}

function createFindManyChain(docs) {
  const chain = {
    docs: [...docs],
    sort(sortSpec) {
      const fields = Object.entries(sortSpec || {});
      this.docs = [...this.docs].sort((left, right) => {
        for (const [field, order] of fields) {
          const leftValue = field === '_id' ? String(left._id || '') : new Date(left[field] || 0).getTime();
          const rightValue = field === '_id' ? String(right._id || '') : new Date(right[field] || 0).getTime();
          if (leftValue === rightValue) continue;
          return order < 0 ? (rightValue > leftValue ? 1 : -1) : (leftValue > rightValue ? 1 : -1);
        }
        return 0;
      });
      return this;
    },
    limit(count) {
      this.docs = this.docs.slice(0, count);
      return this;
    },
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(this.docs);
    },
  };

  return chain;
}

async function withChatRouteSmoke({
  redis,
  providerState,
  userPlan = 'free',
  sessionMessages = null,
  briefingSessions = null,
}, fn) {
  const previousEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_BEARER_AUTH_LEGACY_ENABLED: process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED,
  };
  const previousLoad = Module._load;
  const previousChatFind = ChatMessage.find;
  const previousChatCreate = ChatMessage.create;
  const previousBriefingFindOne = BriefingSession.findOne;
  const previousBriefingFindOneAndUpdate = BriefingSession.findOneAndUpdate;
  const previousBriefingCreate = BriefingSession.create;
  const previousFindOne = Session.findOne;
  const previousFindById = User.findById;
  const previousRedisProvider = rateLimit.getConnectedRedisClient;
  const previousConsoleInfo = console.info;
  const previousConsoleWarn = console.warn;
  const previousConsoleError = console.error;
  const errorLogs = [];
  const storedSessionMessages = Array.isArray(sessionMessages) ? sessionMessages : [];
  const storedBriefingSessions = Array.isArray(briefingSessions) ? briefingSessions : [];

  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = 'true';
  delete process.env.NODE_ENV;

  Session.findOne = async () => ({ _id: 'session-id', lastSeenAt: new Date(), save: async () => {} });
  User.findById = () => ({
    select: async (fields) => (String(fields).includes('plan') ? { plan: userPlan } : { deletedAt: null }),
  });
  ChatMessage.find = (query = {}) => createFindManyChain(storedSessionMessages.filter((message) => {
    if (query.userId && String(message.userId) !== String(query.userId)) return false;
    if (query.sessionId && String(message.sessionId) !== String(query.sessionId)) return false;
    if (query.role?.$in && !query.role.$in.includes(message.role)) return false;
    return true;
  }));
  ChatMessage.create = async (payload) => {
    const message = {
      _id: `chat-message-${storedSessionMessages.length + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 22, 12, storedSessionMessages.length)),
      ...payload,
    };
    storedSessionMessages.push(message);
    return message;
  };
  const matchesBriefingQuery = (session, query = {}) => {
    if (query._id && String(session._id) !== String(query._id)) return false;
    if (query.userId && String(session.userId) !== String(query.userId)) return false;
    if (query.conversationId && session.conversationId !== query.conversationId) return false;
    if (query.status && session.status !== query.status) return false;
    if (query.expiresAt?.$gt && new Date(session.expiresAt) <= new Date(query.expiresAt.$gt)) return false;
    return true;
  };
  BriefingSession.findOne = (query = {}) => {
    let docs = storedBriefingSessions.filter((session) => matchesBriefingQuery(session, query));
    const chain = {
      sort() {
        docs = [...docs].sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0));
        return this;
      },
      lean: async () => docs[0] || null,
      then(resolve, reject) {
        return Promise.resolve(docs[0] || null).then(resolve, reject);
      },
    };
    return chain;
  };
  BriefingSession.findOneAndUpdate = async (query, update) => {
    const session = storedBriefingSessions.find((item) => matchesBriefingQuery(item, query));
    if (!session) return null;
    Object.assign(session, update.$set || {}, { updatedAt: new Date() });
    return session;
  };
  BriefingSession.create = async (payload) => {
    const session = {
      _id: `64f000000000000000000${String(storedBriefingSessions.length + 1).padStart(3, '0')}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...payload,
    };
    storedBriefingSessions.push(session);
    return session;
  };
  rateLimit.getConnectedRedisClient = async () => redis;
  console.info = () => {};
  console.warn = () => {};
  console.error = (...args) => {
    errorLogs.push(args);
  };
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === '@anthropic-ai/sdk') {
      return createAnthropicMock(providerState);
    }
    return previousLoad.call(this, request, parent, isMain);
  };

  clearRouteModules();

  try {
    const chatRoutes = require('../routes/chatRoutes');
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    const token = jwt.sign({ id: '64b7f0f0f0f0f0f0f0f0f0f0', jti: 'session-jti' }, process.env.JWT_SECRET, { algorithm: 'HS256' });

    await fn({
      app,
      token,
      errorLogs,
      sessionMessages: storedSessionMessages,
      briefingSessions: storedBriefingSessions,
    });
  } finally {
    process.env.ANTHROPIC_API_KEY = previousEnv.ANTHROPIC_API_KEY;
    process.env.JWT_SECRET = previousEnv.JWT_SECRET;
    if (previousEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv.NODE_ENV;
    if (previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED === undefined) delete process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
    else process.env.PUBLIC_BEARER_AUTH_LEGACY_ENABLED = previousEnv.PUBLIC_BEARER_AUTH_LEGACY_ENABLED;
    ChatMessage.find = previousChatFind;
    ChatMessage.create = previousChatCreate;
    BriefingSession.findOne = previousBriefingFindOne;
    BriefingSession.findOneAndUpdate = previousBriefingFindOneAndUpdate;
    BriefingSession.create = previousBriefingCreate;
    Session.findOne = previousFindOne;
    User.findById = previousFindById;
    rateLimit.getConnectedRedisClient = previousRedisProvider;
    console.info = previousConsoleInfo;
    console.warn = previousConsoleWarn;
    console.error = previousConsoleError;
    Module._load = previousLoad || ORIGINAL_MODULE_LOAD;
    clearRouteModules();
  }
}

test('POST /api/chat: usuário free passa, reserva quota, chama provider uma vez e commita', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0 };

  await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'happy-path',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.reply, 'Resposta mockada do provider.');
    assert.equal(providerState.calls, 1);
    assert.equal(redis.reserveCalls, 1);
    assert.equal(redis.commitCalls, 1);
    assert.equal(redis.refundCalls, 0);
  });
});

test('POST /api/chat: erro do provider faz refund da reserva', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0, error: new Error('provider failed') };

  await withChatRouteSmoke({ redis, providerState }, async ({ app, token, errorLogs }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'provider-error',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: 'Erro interno do servidor.' });
    assert.equal(providerState.calls, 1);
    assert.equal(redis.reserveCalls, 1);
    assert.equal(redis.commitCalls, 0);
    assert.equal(redis.refundCalls, 1);
    assert.equal(errorLogs.length, 1);
    assert.equal(errorLogs[0][0], '[chat] error');
    assert.deepEqual(errorLogs[0][1], {
      name: 'Error',
      stage: 'provider_call',
      requestId: 'provider-error',
    });
    assert.equal(JSON.stringify(errorLogs).includes('provider failed'), false);
  });
});

test('POST /api/chat: Redis indisponível segue fallback e não retorna 500 no caminho feliz', async () => {
  const providerState = { calls: 0 };

  await withChatRouteSmoke({ redis: null, providerState }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Como voce pode ajudar meu projeto?',
      history: [],
    }, {
      'Idempotency-Key': 'redis-fallback',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(providerState.calls, 1);
  });
});

function mockFindOne(docs) {
  return (query = {}) => {
    const matches = docs.filter((doc) => {
      if (query._id && String(doc._id) !== String(query._id)) return false;
      if (query.projectId && String(doc.projectId) !== String(query.projectId)) return false;
      if (query.userId && String(doc.userId) !== String(query.userId)) return false;
      if (query.status) {
        if (query.status.$in && !query.status.$in.includes(doc.status)) return false;
        else if (!query.status.$in && doc.status !== query.status) return false;
      }
      return true;
    });
    const chain = {
      docs: matches,
      sort(sortSpec) {
        const [[field, order]] = Object.entries(sortSpec || { createdAt: -1 });
        this.docs = [...this.docs].sort((left, right) => {
          const leftValue = new Date(left[field] || 0).getTime();
          const rightValue = new Date(right[field] || 0).getTime();
          return order < 0 ? rightValue - leftValue : leftValue - rightValue;
        });
        return this;
      },
      select() {
        return this;
      },
      lean() {
        return Promise.resolve(this.docs[0] || null);
      },
      then(resolve, reject) {
        return Promise.resolve(this.docs[0] || null).then(resolve, reject);
      },
    };
    return chain;
  };
}

test('POST /api/chat: usa snapshot do projeto atual e ignora histórico de outro projeto com cookie auth', async () => {
  const redis = new SmokeRedis();
  const userId = '64b7f0f0f0f0f0f0f0f0f0f0';
  const projectAId = '64f0000000000000000000a1';
  const projectBId = '64f0000000000000000000b2';
  const buildAId = '64f0000000000000000000c3';
  const providerState = {
    calls: 0,
    replyFromRequest(request) {
      assert.match(request.system, /CURRENT PROJECT SNAPSHOT/);
      assert.match(request.system, /TasteFlow/);
      assert.match(request.system, /Fresh bowls/);
      assert.doesNotMatch(request.system, /MealHub/);
      assert.doesNotMatch(request.system, /OPENAI_API_KEY|sk-proj/);
      assert.equal(JSON.stringify(request.messages).includes('MealHub'), false);
      return 'Na home vejo TasteFlow, Fresh bowls e o botão Start order.';
    },
  };
  const previousProjectFindOne = Project.findOne;
  const previousBuildFindOne = ProjectBuild.findOne;
  const previousMessageFind = ProjectMessage.find;
  const previousMessageCreate = ProjectMessage.create;
  const previousChangeCreate = ProjectChangeRequest.create;
  const previousCookieEnabled = process.env.PUBLIC_COOKIE_AUTH_ENABLED;
  const previousCookieName = process.env.PUBLIC_COOKIE_NAME;
  const createdMessages = [];

  Project.findOne = mockFindOne([
    { _id: projectAId, userId, name: 'TasteFlow', appName: 'TasteFlow', latestPublishedBuildId: buildAId },
    { _id: projectBId, userId, name: 'MealHub', appName: 'MealHub' },
  ]);
  ProjectBuild.findOne = mockFindOne([
    {
      _id: buildAId,
      projectId: projectAId,
      type: 'react_vite',
      status: 'done',
      fullHtml: '<!doctype html><html><head><title>TasteFlow</title></head><body><nav>Menu Pricing</nav><main><h1>TasteFlow</h1><p>Fresh bowls for busy teams.</p><button>Start order</button></main></body></html>',
      artifactFiles: [],
      indexedFiles: [
        {
          path: 'src/App.jsx',
          kind: 'source',
          size: 80,
          excerpt: 'const OPENAI_API_KEY="sk-proj-secretvalue123456789";',
        },
      ],
      createdAt: new Date('2026-07-20T10:00:00Z'),
      updatedAt: new Date('2026-07-20T10:00:00Z'),
    },
  ]);
  ProjectMessage.find = () => ({
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => [
      { role: 'user', content: 'Historico real do TasteFlow', createdAt: new Date('2026-07-20T11:00:00Z') },
    ],
  });
  ProjectMessage.create = async (payload) => {
    createdMessages.push(payload);
    return { _id: `message-${createdMessages.length}`, ...payload };
  };
  ProjectChangeRequest.create = async (payload) => ({
    _id: 'change-request-id',
    ...payload,
    save: async function save() { return this; },
  });
  process.env.PUBLIC_COOKIE_AUTH_ENABLED = 'true';
  process.env.PUBLIC_COOKIE_NAME = '__Host-fluid_session';

  try {
    await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
      const response = await createRequest(app, token, {
        projectId: projectAId,
        message: 'fale tudo que está escrito na home',
        history: [
          { role: 'user', content: 'No projeto MealHub tinha uma home antiga.' },
        ],
      }, {
        Cookie: `__Host-fluid_session=${token}`,
        'Idempotency-Key': 'project-snapshot-cookie',
      });

      assert.equal(response.status, 200);
      assert.equal(response.body.reply, 'Na home vejo TasteFlow, Fresh bowls e o botão Start order.');
      assert.equal(providerState.calls, 1);
      assert.equal(redis.reserveCalls, 1);
      assert.equal(redis.commitCalls, 1);
      assert.equal(createdMessages.length, 2);
      assert.equal(createdMessages.every((message) => String(message.projectId) === projectAId), true);
    });
  } finally {
    Project.findOne = previousProjectFindOne;
    ProjectBuild.findOne = previousBuildFindOne;
    ProjectMessage.find = previousMessageFind;
    ProjectMessage.create = previousMessageCreate;
    ProjectChangeRequest.create = previousChangeCreate;
    if (previousCookieEnabled === undefined) delete process.env.PUBLIC_COOKIE_AUTH_ENABLED;
    else process.env.PUBLIC_COOKIE_AUTH_ENABLED = previousCookieEnabled;
    if (previousCookieName === undefined) delete process.env.PUBLIC_COOKIE_NAME;
    else process.env.PUBLIC_COOKIE_NAME = previousCookieName;
  }
});

test('POST /api/chat: inspeção de projeto existente ainda exige snapshot', async () => {
  const redis = new SmokeRedis();
  const userId = '64b7f0f0f0f0f0f0f0f0f0f0';
  const projectId = '64f0000000000000000000a9';
  const providerState = { calls: 0 };
  const previousProjectFindOne = Project.findOne;
  const previousBuildFindOne = ProjectBuild.findOne;
  const previousMessageFind = ProjectMessage.find;
  const previousMessageCreate = ProjectMessage.create;
  const createdMessages = [];

  Project.findOne = mockFindOne([{
    _id: projectId,
    userId,
    name: 'Projeto sem build',
    appName: 'Projeto sem build',
  }]);
  ProjectBuild.findOne = mockFindOne([]);
  ProjectMessage.find = () => ({
    sort() { return this; },
    limit() { return this; },
    select() { return this; },
    lean: async () => [],
  });
  ProjectMessage.create = async (payload) => {
    createdMessages.push(payload);
    return { _id: `missing-snapshot-${createdMessages.length}`, ...payload };
  };

  try {
    await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
      const response = await createRequest(app, token, {
        projectId,
        projectFlow: 'existing_project',
        message: 'O que tem na home?',
      });

      assert.equal(response.status, 200);
      assert.match(response.body.reply, /não consegui inspecionar o snapshot atual/i);
      assert.equal(response.body.mode, 'chat');
      assert.equal(providerState.calls, 0);
      assert.equal(redis.reserveCalls, 0);
      assert.equal(createdMessages.length, 2);
    });
  } finally {
    Project.findOne = previousProjectFindOne;
    ProjectBuild.findOne = previousBuildFindOne;
    ProjectMessage.find = previousMessageFind;
    ProjectMessage.create = previousMessageCreate;
  }
});

test('POST /api/chat: "Superman" seguido de "pq" mantém contexto da mesma sessão e conta uma chamada real por turno', async () => {
  const redis = new SmokeRedis();
  const providerState = {
    calls: 0,
    resultFromRequest(request) {
      if (providerState.calls === 1) {
        assert.deepEqual(request.messages.map((message) => message.content), [
          'fala só em uma palavra qm ganha batman ou superman',
        ]);
        return { action: 'chat', reply: 'Superman.' };
      }

      assert.deepEqual(request.messages.map((message) => message.role), ['user', 'assistant', 'user']);
      assert.deepEqual(request.messages.map((message) => message.content), [
        'fala só em uma palavra qm ganha batman ou superman',
        'Superman.',
        'pq',
      ]);
      assert.match(request.system, /follow-ups curtos/i);
      return { action: 'chat', reply: 'Porque, em geral, ele tem força, velocidade e resistência muito acima do Batman.' };
    },
  };

  await withChatRouteSmoke({ redis, providerState, sessionMessages: [] }, async ({ app, token, sessionMessages }) => {
    const first = await createRequest(app, token, {
      message: 'fala só em uma palavra qm ganha batman ou superman',
    }, {
      'Idempotency-Key': 'superman-first',
    });

    assert.equal(first.status, 200);
    assert.equal(first.body.reply, 'Superman.');

    const second = await createRequest(app, token, {
      message: 'pq',
    }, {
      'Idempotency-Key': 'superman-why',
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.mode, 'chat');
    assert.equal(second.body.readyForWizard, false);
    assert.equal(second.body.options.length, 0);
    assert.match(second.body.reply, /Porque/);
    assert.equal(providerState.calls, 2);
    assert.equal(redis.reserveCalls, 2);
    assert.equal(redis.commitCalls, 2);
    assert.equal(sessionMessages.length, 4);
  });
});

test('POST /api/chat: "do superman ué" referencia o turno anterior e não vira intenção de criação', async () => {
  const redis = new SmokeRedis();
  const sessionMessages = [
    { _id: 'm1', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'user', content: 'fala só em uma palavra qm ganha batman ou superman', createdAt: new Date('2026-07-22T12:00:00Z') },
    { _id: 'm2', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'assistant', content: 'Superman.', createdAt: new Date('2026-07-22T12:01:00Z') },
    { _id: 'm3', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'user', content: 'pq', createdAt: new Date('2026-07-22T12:02:00Z') },
    { _id: 'm4', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'assistant', content: 'Desculpe, não entendi.', createdAt: new Date('2026-07-22T12:03:00Z') },
  ];
  const providerState = {
    calls: 0,
    resultFromRequest(request) {
      assert.equal(request.messages.at(-1).content, 'do superman ué');
      assert.equal(request.messages.some((message) => message.content === 'Superman.'), true);
      assert.equal(request.messages.some((message) => message.content === 'Desculpe, não entendi.'), true);
      return { action: 'chat', reply: 'Entendi: você perguntou por que eu escolhi o Superman. É pela diferença de poderes físicos.' };
    },
  };

  await withChatRouteSmoke({ redis, providerState, sessionMessages }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'do superman ué',
    }, {
      'Idempotency-Key': 'superman-reference',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'chat');
    assert.equal(response.body.readyForWizard, false);
    assert.equal(response.body.needsClarification, false);
    assert.equal(response.body.options.length, 0);
    assert.match(response.body.reply, /Superman|poderes/);
  });
});

test('POST /api/chat: substantivo curto isolado não dispara build intent mesmo se o classificador sugerir wizard', async () => {
  const redis = new SmokeRedis();
  const providerState = {
    calls: 0,
    resultFromRequest() {
      return { action: 'wizard', reply: 'Vou começar a criar um projeto sobre Superman.' };
    },
  };

  await withChatRouteSmoke({ redis, providerState, sessionMessages: [] }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Superman',
    }, {
      'Idempotency-Key': 'short-noun-no-build',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'chat');
    assert.equal(response.body.readyForWizard, false);
    assert.equal(response.body.status, null);
    assert.equal(redis.reserveCalls, 1);
    assert.equal(redis.commitCalls, 1);
  });
});

test('POST /api/chat: conversa sobre Superman seguida de "vamos construir" abre briefing novo', async () => {
  const redis = new SmokeRedis();
  const sessionMessages = [
    { _id: 'm1', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'user', content: 'Quem ganha, Superman ou Hulk?', createdAt: new Date('2026-07-22T12:00:00Z') },
    { _id: 'm2', userId: '64b7f0f0f0f0f0f0f0f0f0f0', sessionId: 'session-id', role: 'assistant', content: 'Superman.', createdAt: new Date('2026-07-22T12:01:00Z') },
  ];
  const providerState = {
    calls: 0,
    resultFromRequest() {
      return { action: 'wizard', reply: 'Vou criar um projeto sobre Superman.' };
    },
  };

  await withChatRouteSmoke({ redis, providerState, sessionMessages }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'agora vamos construir',
      briefing: {
        type: 'landing-page',
        objective: 'vender',
        style: 'moderno',
      },
    }, {
      'Idempotency-Key': 'new-briefing-after-superman',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'clarify');
    assert.equal(response.body.readyForWizard, false);
    assert.equal(response.body.canBuild, false);
    assert.equal(response.body.briefing.mainContext, undefined);
    assert.equal(JSON.stringify(response.body.briefing).includes('Superman'), false);
  });
});

test('POST /api/chat/clarify gera perguntas sem duplicar quota de IA', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0 };

  await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'vamos criar uma landing page para vender marmitas fitness',
    }, {
      'Idempotency-Key': 'local-clarification',
    }, '/api/chat/clarify');

    assert.equal(response.status, 200);
    assert.equal(response.body.briefing.mainContext, 'marmitas fitness');
    assert.equal(response.body.questions.some((question) => question.field === 'mainContext'), false);
    assert.equal(response.body.questions.some((question) => question.field === 'audience'), true);
    assert.equal(providerState.calls, 0);
    assert.equal(redis.reserveCalls, 0);
    assert.equal(redis.commitCalls, 0);
  });
});

test('POST /api/chat: briefing completo continua construível após espera sem snapshot nem nova cobrança', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0 };
  const briefingSessionId = '64f0000000000000000000d1';
  const briefing = {
    type: 'landing-page',
    objective: 'vender',
    mainContext: 'marmitas fitness',
    audience: 'profissionais ocupados',
    style: 'moderno',
    cta: 'Comprar agora',
  };
  const briefingSessions = [{
    _id: briefingSessionId,
    userId: '64b7f0f0f0f0f0f0f0f0f0f0',
    conversationId: 'session-id',
    status: 'active',
    briefing,
    briefingSummary: briefing,
    structuredAnswers: briefing,
    sourcePrompt: 'Crie uma landing page para vender marmitas fitness',
    complete: true,
    canBuild: true,
    createdAt: new Date(Date.now() - 20 * 60 * 1000),
    updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    projectId: null,
  }];

  await withChatRouteSmoke({ redis, providerState, briefingSessions }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Construir projeto',
      action: 'build_project',
      projectFlow: 'new_project',
      briefingSessionId,
      projectId: '64f0000000000000000000e1',
      history: [{ role: 'user', content: 'Conversa casual sobre Superman' }],
    }, {
      'Idempotency-Key': 'delayed-build-click',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'build_now');
    assert.equal(response.body.canBuild, true);
    assert.equal(response.body.briefing.mainContext, 'marmitas fitness');
    assert.equal(response.body.briefingSessionId, briefingSessionId);
    assert.equal(providerState.calls, 0);
    assert.equal(redis.reserveCalls, 0);
    assert.equal(redis.commitCalls, 0);
    assert.equal(redis.refundCalls, 0);
    assert.doesNotMatch(response.body.reply, /snapshot/i);
  });
});

test('POST /api/chat: ação com briefing expirado retorna erro restaurável específico', async () => {
  const redis = new SmokeRedis();
  const providerState = { calls: 0 };
  const briefingSessionId = '64f0000000000000000000d2';
  const briefingSessions = [{
    _id: briefingSessionId,
    userId: '64b7f0f0f0f0f0f0f0f0f0f0',
    conversationId: 'session-id',
    status: 'active',
    briefing: {},
    briefingSummary: {},
    structuredAnswers: {},
    complete: true,
    canBuild: true,
    expiresAt: new Date(Date.now() - 1000),
  }];

  await withChatRouteSmoke({ redis, providerState, briefingSessions }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'Construir projeto',
      action: 'build_project',
      projectFlow: 'new_project',
      briefingSessionId,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'BRIEFING_SESSION_EXPIRED');
    assert.equal(response.body.restoreRequired, true);
    assert.equal(providerState.calls, 0);
    assert.equal(redis.reserveCalls, 0);
    assert.doesNotMatch(response.body.message, /snapshot/i);
  });
});

test('POST /api/chat: histórico truncado preserva os turnos mais recentes em ordem', async () => {
  const redis = new SmokeRedis();
  const userId = '64b7f0f0f0f0f0f0f0f0f0f0';
  const sessionMessages = Array.from({ length: 16 }, (_, index) => ({
    _id: `history-${index}`,
    userId,
    sessionId: 'session-id',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turno-${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 22, 13, index)),
  }));
  const providerState = {
    calls: 0,
    resultFromRequest(request) {
      const contents = request.messages.map((message) => message.content);
      assert.equal(contents.includes('turno-0'), false);
      assert.equal(contents[0], 'turno-4');
      assert.equal(contents.slice(-2)[0], 'turno-15');
      assert.equal(contents.at(-1), 'pq');
      return { action: 'chat', reply: 'Respondendo pelo contexto mais recente.' };
    },
  };

  await withChatRouteSmoke({ redis, providerState, sessionMessages }, async ({ app, token }) => {
    const response = await createRequest(app, token, {
      message: 'pq',
    }, {
      'Idempotency-Key': 'truncated-history',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.mode, 'chat');
    assert.equal(response.body.readyForWizard, false);
  });
});

test('POST /api/chat: "isso" e "deixa maior" usam o histórico recente do mesmo projeto', async () => {
  const redis = new SmokeRedis();
  const userId = '64b7f0f0f0f0f0f0f0f0f0f0';
  const projectId = '64f0000000000000000000d1';
  const buildId = '64f0000000000000000000d2';
  const projectMessages = [
    { _id: 'pm1', projectId, role: 'user', content: 'qual texto principal da home?', createdAt: new Date('2026-07-22T14:00:00Z') },
    { _id: 'pm2', projectId, role: 'assistant', content: 'O texto principal é TasteFlow.', createdAt: new Date('2026-07-22T14:01:00Z') },
  ];
  const providerState = {
    calls: 0,
    resultFromRequest(request) {
      const contents = request.messages.map((message) => message.content);

      if (providerState.calls === 1) {
        assert.deepEqual(contents, [
          'qual texto principal da home?',
          'O texto principal é TasteFlow.',
          'isso',
        ]);
        return { action: 'chat', reply: 'Sim, estou falando do texto TasteFlow.' };
      }

      assert.equal(contents.includes('isso'), true);
      assert.equal(contents.includes('Sim, estou falando do texto TasteFlow.'), true);
      assert.equal(contents.at(-1), 'deixa maior');
      return { action: 'wizard', reply: 'Vou aumentar o texto TasteFlow.' };
    },
  };
  const previousProjectFindOne = Project.findOne;
  const previousBuildFindOne = ProjectBuild.findOne;
  const previousMessageFind = ProjectMessage.find;
  const previousMessageCreate = ProjectMessage.create;
  const previousChangeCreate = ProjectChangeRequest.create;

  Project.findOne = mockFindOne([
    { _id: projectId, userId, name: 'TasteFlow', appName: 'TasteFlow', latestPublishedBuildId: buildId },
  ]);
  ProjectBuild.findOne = mockFindOne([
    {
      _id: buildId,
      projectId,
      type: 'html',
      status: 'done',
      fullHtml: '<main><h1>TasteFlow</h1><p>Fresh bowls.</p></main>',
      artifactFiles: [],
      indexedFiles: [],
      createdAt: new Date('2026-07-22T13:00:00Z'),
      updatedAt: new Date('2026-07-22T13:00:00Z'),
    },
  ]);
  ProjectMessage.find = (query = {}) => createFindManyChain(projectMessages.filter((message) => (
    String(message.projectId) === String(query.projectId) &&
    (!query.role?.$in || query.role.$in.includes(message.role))
  )));
  ProjectMessage.create = async (payload) => {
    const message = {
      _id: `pm-created-${projectMessages.length + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 22, 14, projectMessages.length + 1)),
      ...payload,
    };
    projectMessages.push(message);
    return message;
  };
  ProjectChangeRequest.create = async (payload) => ({
    _id: `cr-${providerState.calls}`,
    ...payload,
    save: async function save() { return this; },
  });

  try {
    await withChatRouteSmoke({ redis, providerState }, async ({ app, token }) => {
      const first = await createRequest(app, token, {
        projectId,
        message: 'isso',
      }, {
        'Idempotency-Key': 'project-isso',
      });

      assert.equal(first.status, 200);
      assert.equal(first.body.mode, 'chat');
      assert.equal(first.body.readyForWizard, false);
      assert.equal(first.body.options.length, 0);

      const second = await createRequest(app, token, {
        projectId,
        message: 'deixa maior',
      }, {
        'Idempotency-Key': 'project-deixa-maior',
      });

      assert.equal(second.status, 200);
      assert.equal(second.body.mode, 'wizard');
      assert.equal(second.body.readyForWizard, true);
      assert.equal(second.body.options.length, 0);
      assert.match(second.body.reply, /TasteFlow/);
    });
  } finally {
    Project.findOne = previousProjectFindOne;
    ProjectBuild.findOne = previousBuildFindOne;
    ProjectMessage.find = previousMessageFind;
    ProjectMessage.create = previousMessageCreate;
    ProjectChangeRequest.create = previousChangeCreate;
  }
});
