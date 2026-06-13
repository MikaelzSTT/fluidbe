const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
const CONNECTOR_RULES = [
  {
    provider: 'stripe',
    label: 'Stripe',
    reason: 'Necessário para pagamentos por cartão, checkout ou assinaturas.',
    patterns: [
      /\bpagament\w*\b/,
      /\bcartao\b/,
      /\bcartoes\b/,
      /\bcheckout\b/,
      /\bassinat\w*\b/,
      /\bloja\b/,
      /\bmarketplace\b/,
      /\bcorrida paga\b/,
    ],
  },
  {
    provider: 'google_maps',
    label: 'Google Maps',
    reason: 'Necessário para mapas, localização, rotas ou endereços.',
    patterns: [
      /\bmapa\w*\b/,
      /\blocaliz\w*\b/,
      /\brota\w*\b/,
      /\bentrega\w*\b/,
      /\buber\b/,
      /\bdelivery\b/,
      /\bmotorista\w*\b/,
      /\bendereco\w*\b/,
    ],
  },
  {
    provider: 'resend',
    label: 'Resend',
    reason: 'Necessário para envio de emails, recibos ou formulários de contato.',
    patterns: [
      /\bemail\w*\b/,
      /\be-mail\w*\b/,
      /\bnotificacao por email\b/,
      /\bnotificacoes por email\b/,
      /\brecibo\w*\b/,
      /\bformulario de contato\b/,
      /\bformularios de contato\b/,
    ],
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    reason: 'Necessário para login, banco de dados, usuários, dados salvos ou storage.',
    patterns: [
      /\blogin\b/,
      /\bbanco de dados\b/,
      /\bdashboard\b/,
      /\bcrm\b/,
      /\busuario\w*\b/,
      /\bdados salvos\b/,
      /\bstorage\b/,
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    reason: 'Necessário para recursos de IA, chatbot, assistente ou geração por IA.',
    patterns: [
      /\bia\b/,
      /\bchatbot\w*\b/,
      /\bassistente\w*\b/,
      /\bgeracao por ia\b/,
      /\bgerar por ia\b/,
    ],
  },
  {
    provider: 'cloudinary',
    label: 'Cloudinary',
    reason: 'Necessário para upload e gerenciamento de imagens.',
    patterns: [
      /\bupload de imagen\w*\b/,
      /\bupload de foto\w*\b/,
      /\bfoto\w*\b/,
      /\bavatar\w*\b/,
      /\bproduto\w* com imagen\w*\b/,
    ],
  },
  {
    provider: 'backend',
    label: 'Backend',
    reason: 'Necessário para APIs, pedidos, corridas, status, realtime ou autenticação complexa.',
    patterns: [
      /\bbackend\b/,
      /\bapi\b/,
      /\bapis\b/,
      /\bpedido\w*\b/,
      /\bcorrida\w*\b/,
      /\bstatus\b/,
      /\brealtime\b/,
      /\btempo real\b/,
      /\bautenticacao complexa\b/,
    ],
  },
];

function normalizeHistoryItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const role = item.role === 'assistant' ? 'assistant' : 'user';
  const content = String(item.content || item.message || '').trim();

  if (!content) {
    return null;
  }

  return { role, content };
}

function buildProjectContext(project) {
  if (!project) {
    return '';
  }

  return [
    `Nome: ${project.name}`,
    project.type ? `Tipo: ${project.type}` : '',
    project.description ? `Descricao: ${project.description}` : '',
    project.prompt ? `Prompt salvo: ${project.prompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeConnectorText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildConnectorDetectionText({ message, history, project, scope = 'initial' }) {
  const parts = [message];

  if (scope === 'edit') {
    return normalizeConnectorText(parts.filter(Boolean).join('\n'));
  }

  if (Array.isArray(history)) {
    history.forEach((item) => {
      const normalizedItem = normalizeHistoryItem(item);

      if (normalizedItem?.role === 'user') {
        parts.push(normalizedItem.content);
      }
    });
  }

  const projectContext = buildProjectContext(project);

  if (projectContext) {
    parts.push(projectContext);
  }

  return normalizeConnectorText(parts.filter(Boolean).join('\n'));
}

function hasNewIntegrationIntent(detectionText) {
  return /\b(adicion\w*|inclu\w*|integr\w*|conect\w*|configur\w*|implement\w*|habilit\w*|ativ\w*|precis\w*|necessit\w*)\b/.test(
    detectionText
  );
}

function detectRequiredConnectors({ message, history, project, scope }) {
  const detectionText = buildConnectorDetectionText({
    message,
    history,
    project,
    scope,
  });

  if (!detectionText) {
    return [];
  }

  if (scope === 'edit' && !hasNewIntegrationIntent(detectionText)) {
    return [];
  }

  return CONNECTOR_RULES.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(detectionText))
  ).map(({ provider, label, reason }) => ({
    provider,
    label,
    reason,
  }));
}

function normalizeConnectorProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function sanitizeRequiredConnector(connector) {
  if (!connector || typeof connector !== 'object') {
    return null;
  }

  const provider = normalizeConnectorProvider(connector.provider);

  if (!provider) {
    return null;
  }

  return {
    provider,
    label: String(connector.label || provider).replace(/\s+/g, ' ').trim(),
    reason: String(connector.reason || '').replace(/\s+/g, ' ').trim(),
  };
}

function connectorToObject(connector) {
  return typeof connector?.toObject === 'function'
    ? connector.toObject({ getters: true, virtuals: true })
    : connector;
}

function mergeRequiredConnectors(existingConnectors, detectedConnectors) {
  const now = new Date();
  const mergedConnectors = [];
  const providerIndex = new Map();

  if (Array.isArray(existingConnectors)) {
    existingConnectors.forEach((connector) => {
      const existing = connectorToObject(connector);
      const provider = normalizeConnectorProvider(existing?.provider);

      if (!provider || providerIndex.has(provider)) {
        return;
      }

      providerIndex.set(provider, mergedConnectors.length);
      mergedConnectors.push({
        provider,
        label: String(existing.label || provider).replace(/\s+/g, ' ').trim(),
        reason: String(existing.reason || '').replace(/\s+/g, ' ').trim(),
        status: ['pending', 'connected', 'skipped', 'error'].includes(existing.status)
          ? existing.status
          : 'pending',
        createdAt: existing.createdAt || now,
        updatedAt: existing.updatedAt || now,
      });
    });
  }

  (Array.isArray(detectedConnectors) ? detectedConnectors : []).forEach(
    (connector) => {
      const detected = sanitizeRequiredConnector(connector);

      if (!detected) {
        return;
      }

      const existingIndex = providerIndex.get(detected.provider);

      if (existingIndex !== undefined) {
        mergedConnectors[existingIndex] = {
          ...mergedConnectors[existingIndex],
          label: detected.label || mergedConnectors[existingIndex].label,
          reason: detected.reason || mergedConnectors[existingIndex].reason,
          updatedAt: now,
        };
        return;
      }

      providerIndex.set(detected.provider, mergedConnectors.length);
      mergedConnectors.push({
        ...detected,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
  );

  return mergedConnectors;
}

async function persistRequiredConnectors(project, detectedConnectors) {
  if (
    !project ||
    !Array.isArray(detectedConnectors) ||
    detectedConnectors.length === 0
  ) {
    return [];
  }

  const requiredConnectors = mergeRequiredConnectors(
    project.requiredConnectors || [],
    detectedConnectors
  );

  project.requiredConnectors = requiredConnectors;
  await project.save();

  return requiredConnectors;
}

function filterNewRequiredConnectors(project, detectedConnectors) {
  const existingProviders = new Set(
    (Array.isArray(project?.requiredConnectors) ? project.requiredConnectors : [])
      .map((connector) => normalizeConnectorProvider(connector?.provider))
      .filter(Boolean)
  );
  const newConnectors = [];
  const seenProviders = new Set();

  (Array.isArray(detectedConnectors) ? detectedConnectors : []).forEach((connector) => {
    const sanitized = sanitizeRequiredConnector(connector);

    if (!sanitized) {
      return;
    }

    if (existingProviders.has(sanitized.provider) || seenProviders.has(sanitized.provider)) {
      return;
    }

    seenProviders.add(sanitized.provider);
    newConnectors.push(sanitized);
  });

  return newConnectors;
}

function buildDecisionSystemPrompt(projectContext, hasProjectContext = false) {
  return `
Voce e a IA de chat da Fluid, em portugues do Brasil.

Sua tarefa e orquestrar uma conversa e decidir se o sistema deve iniciar o wizard de criacao ou pedir clarificacao.

Use action "wizard" somente quando houver intencao clara de criar, gerar, montar, construir ou iniciar um site, app, landing page, SaaS, dashboard, ecommerce, interface ou projeto.
${hasProjectContext ? 'Como ha um projeto atual, tambem use action "wizard" quando o usuario pedir para editar, alterar, adicionar, remover, ajustar, trocar, melhorar ou modificar qualquer parte do projeto existente.' : ''}

Use action "chat" para conversa normal, duvidas, mensagens aleatorias, testes, cumprimentos, risadas, reacoes curtas ou texto sem intencao clara de criacao.

Use action "clarify" quando houver intencao clara de criar um projeto, mas o pedido ainda estiver vago ou incompleto para uma boa primeira geracao.

Exemplos que devem ser "chat" se nao houver contexto anterior suficiente:
- "wadsczx"
- "teste"
- "oi"
- "ok"
- "kkkk"
- "calma"
- "mano"

Exemplos de pedidos com intencao de criar, mas vagos, que devem ser "clarify":
- "crie um marketplace"
- "construa uma landing page"
- "faz um app"
- "quero criar um site"
- "monta um SaaS"

Se o historico ou a mensagem atual contiver respostas estruturadas de briefing, com escolhas ou definicoes sobre objetivo, publico, funcionalidades, fluxo, conteudo, login, pagamento, checkout, vendedores, plataforma, CTA ou visual, entao use action "wizard".

Se o usuario ja informar no pedido inicial o que deve ser criado e trouxer detalhes suficientes para uma primeira versao boa, use action "wizard".

Quando action for "wizard", reply deve ser uma frase natural, curta e sem pergunta, dizendo que voce vai iniciar a criacao. Nao use texto fixo.

Quando action for "clarify", reply deve ser exatamente: "Vou fazer algumas perguntas rápidas para entender melhor o projeto."

Quando action for "chat", reply deve ser natural, util e breve. Nao use respostas fixas de "nao entendi".

Quando action for "chat" e reply for uma pergunta, gere tambem options com 2 a 4 respostas curtas que o usuario poderia escolher.
Quando action for "chat" e reply nao for uma pergunta, options deve ser [].
Quando action for "wizard" ou "clarify", options deve ser [].
As options devem ser geradas por voce para a conversa atual, nunca copiadas de uma lista fixa.

Nao gere codigo, HTML, CSS ou JS. Nao crie arquivos. Nao salve dados. Nao mencione detalhes internos como polling, ProjectBuild, MongoDB ou JWT a menos que o usuario pergunte.
Nunca peca API key, token, senha ou secret no chat.

Contexto do projeto atual:
${projectContext || 'Nenhum projeto informado.'}

Retorne somente JSON valido, sem markdown, sem texto antes ou depois, no formato:
{
  "action": "chat" | "wizard" | "clarify",
  "reply": "string",
  "options": ["string"]
}
`.trim();
}

function buildClarifySystemPrompt() {
  return `
Voce e a IA de briefing da Fluid, em portugues do Brasil.

Sua tarefa e gerar perguntas de clarificacao para melhorar a primeira geracao de um projeto digital.

Regras obrigatorias:
- Retorne somente JSON valido, sem markdown, sem texto antes ou depois.
- Gere entre 2 e 4 perguntas.
- Cada pergunta deve ter entre 2 e 4 opcoes.
- As perguntas e opcoes devem ser dinamicas e contextuais ao pedido do usuario e ao historico, nunca hardcoded.
- Tudo deve estar em portugues do Brasil.
- Cada pergunta precisa ajudar a melhorar a primeira geracao do projeto.
- Nao gere codigo, HTML, CSS ou JS.
- Nao salve dados e nao mencione banco, ProjectBuild, MongoDB, JWT ou detalhes internos.
- Nunca peca API key, token, senha ou secret no chat.
- Sempre inclua uma pergunta de estilo visual quando fizer sentido.

Direcionamento por tipo de projeto:
- Se for marketplace, pode perguntar sobre pagamentos, login, vendedores, checkout e visual.
- Se for landing page, pode perguntar sobre objetivo, publico, CTA e visual.
- Se for app, pode perguntar sobre plataforma, funcionalidades principais, login e visual.

Formato exato:
{
  "questions": [
    {
      "id": "string_unica_curta_em_snake_case",
      "question": "pergunta em portugues",
      "options": [
        {
          "value": "string_curta_em_snake_case",
          "label": "titulo curto",
          "description": "explicacao curta"
        }
      ]
    }
  ]
}
`.trim();
}

function buildFallbackSystemPrompt(projectContext) {
  return `
Voce e a IA de chat da Fluid, em portugues do Brasil.

Responda de forma natural, breve e util. Nao gere codigo, HTML, CSS ou JS. Nao crie arquivos.
Nunca peca API key, token, senha ou secret no chat.

Se o usuario pedir algo vago sobre criar site, app, landing page, SaaS, dashboard, ecommerce, interface ou projeto, faca no maximo uma pergunta curta sobre tema, negocio, produto ou objetivo principal.

Contexto do projeto atual:
${projectContext || 'Nenhum projeto informado.'}
`.trim();
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw error;
    }

    return JSON.parse(match[0]);
  }
}

function splitSystemMessage(messages) {
  const systemMessages = [];
  const conversationMessages = [];

  messages.forEach((message) => {
    if (message.role === 'system') {
      systemMessages.push(message.content);
      return;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = String(message.content || '').trim();

    if (!content) {
      return;
    }

    if (!conversationMessages.length && role === 'assistant') {
      return;
    }

    const previousMessage = conversationMessages[conversationMessages.length - 1];

    if (previousMessage?.role === role) {
      previousMessage.content = `${previousMessage.content}\n\n${content}`;
      return;
    }

    conversationMessages.push({
      role,
      content,
    });
  });

  return {
    system: systemMessages.filter(Boolean).join('\n\n'),
    messages: conversationMessages,
  };
}

function extractClaudeText(response) {
  return (response.content || [])
    .map((item) => {
      if (item.type === 'text') {
        return item.text;
      }

      return '';
    })
    .join('')
    .trim();
}

function isQuestion(text) {
  const normalized = String(text || '').trim();

  if (!normalized) {
    return false;
  }

  if (normalized.includes('?')) {
    return true;
  }

  return /^(qual|quais|quem|quando|onde|como|por que|porque|o que|que|voce quer|você quer|pode me dizer|me diga|me conta)\b/i.test(
    normalized
  );
}

function normalizeOptions(options, shouldIncludeOptions) {
  if (!shouldIncludeOptions || !Array.isArray(options)) {
    return [];
  }

  const normalizedOptions = [];

  options.forEach((option) => {
    const value = String(option || '').replace(/\s+/g, ' ').trim();

    if (!value || normalizedOptions.includes(value)) {
      return;
    }

    normalizedOptions.push(value);
  });

  if (normalizedOptions.length < 2) {
    return [];
  }

  return normalizedOptions.slice(0, 4);
}

function normalizeSlug(value, fallback) {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

  return normalized || fallback;
}

function normalizeClarifyQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 2) {
    throw new Error('Perguntas de clarificacao invalidas.');
  }

  const usedQuestionIds = new Set();
  const normalizedQuestions = [];

  questions.forEach((question, questionIndex) => {
    if (!question || typeof question !== 'object') {
      return;
    }

    const questionText = String(question.question || '').replace(/\s+/g, ' ').trim();
    const rawOptions = Array.isArray(question.options) ? question.options : [];

    if (!questionText || rawOptions.length < 2) {
      return;
    }

    let questionId = normalizeSlug(question.id || questionText, `pergunta_${questionIndex + 1}`);
    let suffix = 2;

    while (usedQuestionIds.has(questionId)) {
      questionId = `${questionId}_${suffix}`;
      suffix += 1;
    }

    const usedOptionValues = new Set();
    const normalizedOptions = [];

    rawOptions.forEach((option, optionIndex) => {
      if (!option || typeof option !== 'object') {
        return;
      }

      const label = String(option.label || '').replace(/\s+/g, ' ').trim();
      const description = String(option.description || '').replace(/\s+/g, ' ').trim();

      if (!label || !description) {
        return;
      }

      let value = normalizeSlug(option.value || label, `opcao_${optionIndex + 1}`);
      let optionSuffix = 2;

      while (usedOptionValues.has(value)) {
        value = `${value}_${optionSuffix}`;
        optionSuffix += 1;
      }

      usedOptionValues.add(value);
      normalizedOptions.push({
        value,
        label: label.slice(0, 80),
        description: description.slice(0, 180),
      });
    });

    if (normalizedOptions.length < 2) {
      return;
    }

    usedQuestionIds.add(questionId);
    normalizedQuestions.push({
      id: questionId,
      question: questionText,
      options: normalizedOptions.slice(0, 4),
    });
  });

  if (normalizedQuestions.length < 2) {
    throw new Error('Perguntas de clarificacao invalidas.');
  }

  return normalizedQuestions.slice(0, 4);
}

async function callClaude({ messages, maxTokens = 700 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY nao configurada.');
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const claudeMessages = splitSystemMessage(messages);

  const response = await anthropic.messages.create({
    model:
      process.env.CLAUDE_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      DEFAULT_CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: claudeMessages.system,
    messages: claudeMessages.messages,
  });

  const content = extractClaudeText(response);

  if (!content) {
    throw new Error('Resposta vazia da IA.');
  }

  return content;
}

async function getClarificationQuestions({ message, history }) {
  const previousMessages = Array.isArray(history)
    ? history.map(normalizeHistoryItem).filter(Boolean).slice(-12)
    : [];

  const content = await callClaude({
    maxTokens: 1400,
    messages: [
      { role: 'system', content: buildClarifySystemPrompt() },
      ...previousMessages,
      { role: 'user', content: message },
    ],
  });
  const parsed = extractJson(content);

  return normalizeClarifyQuestions(parsed.questions);
}

async function getFallbackChatReply({ message, previousMessages, projectContext }) {
  const content = await callClaude({
    messages: [
      { role: 'system', content: buildFallbackSystemPrompt(projectContext) },
      ...previousMessages,
      { role: 'user', content: message },
    ],
  });

  const reply = String(content || '').trim();

  if (!reply) {
    throw new Error('Resposta invalida da IA.');
  }

  return {
    reply,
    readyForWizard: false,
    needsClarification: false,
    options: [],
    requiredConnectors: [],
  };
}

async function getAiReply({ message, history, project }) {
  const previousMessages = Array.isArray(history)
    ? history.map(normalizeHistoryItem).filter(Boolean).slice(-12)
    : [];
  const projectContext = buildProjectContext(project);

  const decisionMessages = [
    { role: 'system', content: buildDecisionSystemPrompt(projectContext, Boolean(project)) },
    ...previousMessages,
    { role: 'user', content: message },
  ];

  try {
    const content = await callClaude({ messages: decisionMessages });
    const parsed = extractJson(content);
    const action = String(parsed.action || '').trim().toLowerCase();
    const reply = String(parsed.reply || '').trim();

    if (!['chat', 'wizard', 'clarify'].includes(action) || !reply) {
      throw new Error('Decisao invalida da IA.');
    }

    const shouldIncludeOptions = action === 'chat' && isQuestion(reply);
    const options = normalizeOptions(parsed.options, shouldIncludeOptions);
    const readyForWizard = action === 'wizard';
    const connectorScope = project ? 'edit' : 'initial';
    const detectedRequiredConnectors = readyForWizard
      ? detectRequiredConnectors({
          message,
          history,
          project,
          scope: connectorScope,
        })
      : [];
    const requiredConnectors = project
      ? filterNewRequiredConnectors(project, detectedRequiredConnectors)
      : detectedRequiredConnectors;

    return {
      reply:
        action === 'clarify'
          ? 'Vou fazer algumas perguntas rápidas para entender melhor o projeto.'
          : reply,
      readyForWizard,
      needsClarification: action === 'clarify',
      options,
      requiredConnectors,
    };
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error.message === 'Decisao invalida da IA.'
    ) {
      return getFallbackChatReply({
        message,
        previousMessages,
        projectContext,
      });
    }

    throw error;
  }
}

router.post('/clarify', authMiddleware, async (req, res) => {
  try {
    const { message, history, messages } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ message: 'Mensagem obrigatória.' });
    }

    const questions = await getClarificationQuestions({
      message: message.trim(),
      history: history || messages,
    });

    return res.json({
      success: true,
      questions,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao gerar perguntas de clarificação.',
      error: error.message,
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { projectId, message, history, messages } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ message: 'Mensagem obrigatória.' });
    }

    let project = null;
    let userMessage = null;
    let changeRequest = null;
    const trimmedMessage = message.trim();

    if (!trimmedMessage) {
      return res.status(400).json({ message: 'Mensagem obrigatória.' });
    }

    if (projectId) {
      if (!mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({ message: 'ID de projeto inválido.' });
      }

      project = await Project.findOne({
        _id: projectId,
        userId: req.userId,
      });

      if (!project) {
        return res.status(404).json({ message: 'Projeto não encontrado.' });
      }

      userMessage = await ProjectMessage.create({
        projectId: project._id,
        role: 'user',
        content: trimmedMessage,
        metadata: {
          source: 'api_chat',
          userId: req.userId,
        },
      });

      changeRequest = await ProjectChangeRequest.create({
        projectId: project._id,
        userId: req.userId,
        messageId: userMessage._id,
        content: trimmedMessage,
        metadata: {
          source: 'api_chat',
          classification: 'edit',
        },
      });
    }

    const aiReply = await getAiReply({
      message: trimmedMessage,
      history: history || messages,
      project,
    });
    let requiredConnectors = aiReply.requiredConnectors || [];

    if (project) {
      if (requiredConnectors.length > 0) {
        await persistRequiredConnectors(project, requiredConnectors);
      }

      const assistantMessage = await ProjectMessage.create({
        projectId: project._id,
        role: 'assistant',
        content: aiReply.reply,
        metadata: {
          source: 'api_chat',
          userId: req.userId,
          readyForWizard: Boolean(aiReply.readyForWizard),
          needsClarification: Boolean(aiReply.needsClarification),
          options: aiReply.options || [],
          requiredConnectors,
        },
      });

      if (changeRequest) {
        changeRequest.assistantMessageId = assistantMessage._id;
        changeRequest.requiredConnectors = requiredConnectors;
        changeRequest.metadata = {
          ...(changeRequest.metadata || {}),
          readyForWizard: Boolean(aiReply.readyForWizard),
          needsClarification: Boolean(aiReply.needsClarification),
        };
        await changeRequest.save();
      }
    }

    return res.json({
      success: true,
      reply: aiReply.reply,
      readyForWizard: aiReply.readyForWizard,
      needsClarification: Boolean(aiReply.needsClarification),
      options: aiReply.options || [],
      requiredConnectors,
      changeRequest,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao processar chat.',
      error: error.message,
    });
  }
});

module.exports = router;
