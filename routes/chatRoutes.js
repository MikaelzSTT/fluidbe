const express = require('express');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

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

function buildDecisionSystemPrompt(projectContext) {
  return `
Voce e a IA de chat da Fluid, em portugues do Brasil.

Sua tarefa e orquestrar uma conversa e decidir se o sistema deve iniciar o wizard de criacao.

Use action "wizard" somente quando houver intencao clara de criar, gerar, montar, construir ou iniciar um site, app, landing page, SaaS, dashboard, ecommerce, interface ou projeto.

Use action "chat" para conversa normal, duvidas, mensagens aleatorias, testes, cumprimentos, risadas, reacoes curtas ou texto sem intencao clara de criacao.

Exemplos que devem ser "chat" se nao houver contexto anterior suficiente:
- "wadsczx"
- "teste"
- "oi"
- "ok"
- "kkkk"
- "calma"
- "mano"

Se o usuario pedir algo vago como "construa uma landing page", use action "chat" e faca uma unica pergunta curta para descobrir o tema, negocio, produto ou objetivo principal.

Se o historico mostrar que voce ja fez uma pergunta curta de briefing e o usuario respondeu com o tema/negocio/produto, entao mensagens como "faz", "faz um site dela", "pode criar", "manda ver" ou "gera" devem virar action "wizard".

Se o usuario ja informar no pedido inicial o que deve ser criado e para que tema/negocio/produto, use action "wizard".

Quando action for "wizard", reply deve ser uma frase natural, curta e sem pergunta, dizendo que voce vai iniciar a criacao. Nao use texto fixo.

Quando action for "chat", reply deve ser natural, util e breve. Nao use respostas fixas de "nao entendi".

Nao gere codigo, HTML, CSS ou JS. Nao crie arquivos. Nao salve dados. Nao mencione detalhes internos como polling, ProjectBuild, MongoDB ou JWT a menos que o usuario pergunte.

Contexto do projeto atual:
${projectContext || 'Nenhum projeto informado.'}

Retorne somente JSON valido, sem markdown, no formato:
{
  "action": "chat",
  "reply": "string"
}
`.trim();
}

function buildFallbackSystemPrompt(projectContext) {
  return `
Voce e a IA de chat da Fluid, em portugues do Brasil.

Responda de forma natural, breve e util. Nao gere codigo, HTML, CSS ou JS. Nao crie arquivos.

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

async function callOpenAi({ messages, json = false }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY nao configurada.');
  }

  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-5.5',
    messages,
  };

  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const apiMessage = data.error?.message || 'Erro na chamada da IA.';
    throw new Error(apiMessage);
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Resposta vazia da IA.');
  }

  return content;
}

async function getFallbackChatReply({ message, previousMessages, projectContext }) {
  const content = await callOpenAi({
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
  };
}

async function getAiReply({ message, history, project }) {
  const previousMessages = Array.isArray(history)
    ? history.map(normalizeHistoryItem).filter(Boolean).slice(-12)
    : [];
  const projectContext = buildProjectContext(project);

  const decisionMessages = [
    { role: 'system', content: buildDecisionSystemPrompt(projectContext) },
    ...previousMessages,
    { role: 'user', content: message },
  ];

  try {
    const content = await callOpenAi({
      messages: decisionMessages,
      json: true,
    });
    const parsed = extractJson(content);
    const action = String(parsed.action || '').trim().toLowerCase();
    const reply = String(parsed.reply || '').trim();

    if (!['chat', 'wizard'].includes(action) || !reply) {
      throw new Error('Decisao invalida da IA.');
    }

    return {
      reply,
      readyForWizard: action === 'wizard',
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

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { projectId, message, history, messages } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ message: 'Mensagem obrigatória.' });
    }

    let project = null;

    if (projectId) {
      project = await Project.findOne({
        _id: projectId,
        userId: req.userId,
      });

      if (!project) {
        return res.status(404).json({ message: 'Projeto não encontrado.' });
      }
    }

    const aiReply = await getAiReply({
      message: message.trim(),
      history: history || messages,
      project,
    });

    return res.json({
      success: true,
      reply: aiReply.reply,
      readyForWizard: aiReply.readyForWizard,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao processar chat.',
      error: error.message,
    });
  }
});

module.exports = router;
