const express = require('express');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const READY_REPLY =
  'Perfeito, vou montar a primeira versão do seu projeto agora. Depois você poderá ajustar cores, seções e estilo comigo.';
const PROJECT_TYPE_PATTERN =
  /\b(site|website|app|aplicativo|landing|landing page|saas|ecommerce|e-commerce|loja|loja virtual|loja online|blog|sistema|plataforma|portfolio|portifolio)\b/;
const CREATION_VERB_PATTERN =
  /\b(criar|cria|crie|fazer|faz|faca|montar|monte|gerar|gera|gere|desenvolver|construir|construa|quero|preciso|precisamos)\b/;
const FOLLOWUP_BUILD_TRIGGER_PATTERN =
  /\b(faz|faca|fazer|cria|crie|criar|pode fazer|pode criar|manda ver|gera|gere|gerar|monta|monte|montar|construa|construir|bora|vamos|ok|sim|isso)\b/;

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function hasProjectCreationIntent(message) {
  const text = normalizeText(message);

  if (!text) {
    return false;
  }

  const hasCreationVerb = CREATION_VERB_PATTERN.test(text);
  const hasProjectType = PROJECT_TYPE_PATTERN.test(text);
  const startsAsProjectRequest =
    /^(site|website|app|aplicativo|landing|landing page|saas|ecommerce|e-commerce|loja|loja virtual|loja online|blog|sistema|plataforma|portfolio|portifolio)\b.+\b(para|de|do|da|sobre)\b/.test(
      text
    );

  return hasProjectType && (hasCreationVerb || startsAsProjectRequest);
}

function hasProjectBriefingQuestion(content) {
  const text = normalizeText(content);

  return (
    text !== normalizeText(READY_REPLY) &&
    content.includes('?') &&
    /\b(tema|nicho|negocio|produto|servico|objetivo|principal|sobre quem|qual negocio)\b/.test(
      text
    )
  );
}

function isMeaningfulBriefingAnswer(content) {
  const text = normalizeText(content);

  if (!text || hasProjectCreationIntent(text)) {
    return false;
  }

  return /[a-z0-9]/i.test(text);
}

function hasAnsweredProjectBriefing(history, currentMessage = '') {
  if (!Array.isArray(history)) {
    return false;
  }

  const normalizedHistory = [
    ...history.map(normalizeHistoryItem).filter(Boolean),
    currentMessage ? { role: 'user', content: String(currentMessage).trim() } : null,
  ].filter(Boolean);
  const projectRequestIndex = normalizedHistory.findIndex(
    (item) => item.role === 'user' && hasProjectCreationIntent(item.content)
  );

  if (projectRequestIndex < 0) {
    return false;
  }

  const briefingQuestionIndex = normalizedHistory.findIndex(
    (item, index) =>
      index > projectRequestIndex &&
      item.role === 'assistant' &&
      hasProjectBriefingQuestion(item.content)
  );

  if (briefingQuestionIndex < 0) {
    return false;
  }

  const wizardAlreadyStartedIndex = normalizedHistory.findIndex(
    (item, index) =>
      index > briefingQuestionIndex && item.role === 'assistant' && item.content === READY_REPLY
  );

  if (wizardAlreadyStartedIndex >= 0) {
    return false;
  }

  return normalizedHistory
    .slice(briefingQuestionIndex + 1)
    .some((item) => item.role === 'user' && isMeaningfulBriefingAnswer(item.content));
}

function isProjectBriefingFollowup(history) {
  return hasAnsweredProjectBriefing(history);
}

function isBuildTriggerAfterBriefing(message) {
  const text = normalizeText(message);

  return (
    hasProjectCreationIntent(text) ||
    FOLLOWUP_BUILD_TRIGGER_PATTERN.test(text) ||
    /\b(site|website|landing|app|loja)\s+(dela|dele|disso|desse|dessa|para ela|para ele)\b/.test(text)
  );
}

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

Seu comportamento deve ser humano, natural e proativo:
- Nao responda seco. Use respostas acolhedoras, claras e com iniciativa.
- Nao seja robotico nem burocratico.
- Avance com o usuario em vez de transformar a conversa em interrogatorio.
- Se o usuario responder curto, como "sim", "isso", "ok", "pode ser" ou algo parecido, interprete pelo contexto anterior e continue naturalmente.

Seu comportamento e hibrido:

1. Conversa livre:
- Se o usuario perguntar sobre carro, roupa, curiosidade, duvidas gerais, ideias ou qualquer assunto que nao seja pedir criacao de projeto/site/app/SaaS/landing/ecommerce, responda normalmente.
- Nao force briefing.
- Nao fale de projeto se o usuario nao pediu projeto.
- Nao responda "continuar trabalhando no projeto" quando a mensagem do usuario nao indicar claramente essa intencao.
- Chat comum continua livre, normal e natural.

2. Pedido de criacao de projeto:
- Quando o usuario pedir claramente para criar projeto, site, app, SaaS, landing page, ecommerce, blog ou algo equivalente, entre em modo briefing curto.
- Nao transforme pedido de projeto em conversa comum.
- Nao trate texto aleatorio, palavra solta sem sentido ou mensagem sem intencao clara como projeto valido.
- Nao use o nome/titulo do projeto atual, nem a mensagem solta do usuario, como prova de intencao de criacao.
- Se a mensagem nao tiver intencao clara, responda livremente de forma natural, sem usar respostas fixas.
- Faca no maximo 1 pergunta de briefing no total.
- A pergunta deve ser curta, pratica e objetiva, apenas para descobrir o tema, nicho, negocio ou objetivo principal quando isso ainda nao estiver claro.
- Exemplos de pergunta unica: "Qual e o tema principal do blog?", "Qual e o tipo de negocio?", "Qual e o produto principal da landing page?"
- Nao pergunte varias coisas na mesma mensagem.
- Nao pergunte sobre tendencias, secoes, cores, estilo, funcionalidades, publico-alvo ou preferencias extras se o usuario ja pediu um projeto.
- Se o usuario ja informou o tema, nicho, negocio ou objetivo principal no pedido inicial, nao faca pergunta de briefing. Inicie o Wizard imediatamente.
- Se voce ja fez 1 pergunta de briefing e o usuario respondeu, mesmo que a resposta seja curta, considere suficiente e inicie o Wizard imediatamente.
- Quando for iniciar o Wizard, nao faca mais perguntas. Responda exatamente:
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
  const canStartWizard =
    hasProjectCreationIntent(message) || isProjectBriefingFollowup(previousMessages);
  const briefingWasAnswered = hasAnsweredProjectBriefing(previousMessages, message);
  const shouldForceWizard =
    briefingWasAnswered &&
    (isMeaningfulBriefingAnswer(message) || isBuildTriggerAfterBriefing(message));

  if (shouldForceWizard) {
    return {
      reply: READY_REPLY,
      readyForWizard: true,
    };
  }

  const shouldIncludeProjectContext =
    projectContext && (canStartWizard || previousMessages.length > 0);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...(shouldIncludeProjectContext
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
  const modelWantsWizard = parsed.readyForWizard === true && reply === READY_REPLY;
  const readyForWizard = canStartWizard && modelWantsWizard;

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
