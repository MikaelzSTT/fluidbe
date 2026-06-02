const express = require('express');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const READY_REPLY =
  'Perfeito, já tenho o suficiente para começar. Vou iniciar a montagem do seu projeto agora.';

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

function buildSystemPrompt() {
  return `
Voce e a IA de chat da Fluid, em portugues do Brasil.

Seu comportamento e hibrido:

1. Conversa livre:
- Se o usuario perguntar sobre carro, roupa, curiosidade, duvidas gerais, ideias ou qualquer assunto que nao seja pedir criacao de projeto/site/app/SaaS/landing/ecommerce, responda normalmente.
- Nao force briefing.
- Nao fale de projeto se o usuario nao pediu projeto.

2. Pedido de criacao de projeto:
- Quando o usuario pedir para criar projeto, site, app, SaaS, landing page, ecommerce ou algo equivalente, entre em modo briefing.
- Faca apenas UMA pergunta por resposta.
- A pergunta deve ser curta, pratica e objetiva.
- Nao repita o que o usuario ja informou no historico.
- Se o usuario ja informou cores, pergunte outra coisa.
- Se for app, priorize perguntas sobre telas, login, carrinho, pagamentos, admin, usuarios, dados e fluxos.
- Se for site, landing ou SaaS, priorize perguntas sobre secoes, publico-alvo, estilo visual, cores, funcionalidades, oferta e conteudo.
- Depois de uma ou poucas perguntas, quando ja houver informacao suficiente para comecar, responda exatamente:
"${READY_REPLY}"

3. Regras importantes:
- Nao gere codigo.
- Nao crie arquivos.
- Nao prometa build automatico.
- Nao mencione Supabase.
- Considere que o sistema usa MongoDB e JWT, mas so mencione isso se o usuario perguntar diretamente.
- O Wizard/manual build so comeca quando a resposta for exatamente a frase de inicio acima.

Retorne somente JSON valido, sem markdown, no formato:
{
  "reply": "texto da resposta ao usuario",
  "readyForWizard": false
}

Use readyForWizard true somente quando reply for exatamente:
"${READY_REPLY}"
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

async function getAiReply({ message, history, project }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY nao configurada.');
  }

  const previousMessages = Array.isArray(history)
    ? history.map(normalizeHistoryItem).filter(Boolean).slice(-12)
    : [];

  const projectContext = project
    ? [
        `Projeto atual: ${project.name}`,
        project.type ? `Tipo: ${project.type}` : '',
        project.description ? `Descricao: ${project.description}` : '',
        project.prompt ? `Prompt salvo: ${project.prompt}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...(projectContext
      ? [{ role: 'system', content: `Contexto opcional do projeto:\n${projectContext}` }]
      : []),
    ...previousMessages,
    { role: 'user', content: message },
  ];

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.5',
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
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

  const parsed = extractJson(content);
  const reply = String(parsed.reply || '').trim();
  const readyForWizard = parsed.readyForWizard === true && reply === READY_REPLY;

  if (!reply) {
    throw new Error('Resposta invalida da IA.');
  }

  return {
    reply: readyForWizard ? READY_REPLY : reply,
    readyForWizard,
  };
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
