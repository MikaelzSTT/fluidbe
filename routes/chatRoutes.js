const express = require('express');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const READY_REPLY =
  'Perfeito, vou montar a primeira versão do seu projeto agora. Depois você poderá ajustar cores, seções e estilo comigo.';
const UNCLEAR_INTENT_REPLY =
  'Não entendi muito bem o que você quis dizer. Você quer criar um site, app, landing page, SaaS ou ecommerce?';

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

  const hasCreationVerb =
    /\b(criar|crie|fazer|faca|montar|monte|gerar|gere|desenvolver|construir|quero|preciso|precisamos)\b/.test(
      text
    );
  const hasProjectType =
    /\b(site|website|app|aplicativo|landing|landing page|saas|ecommerce|e-commerce|loja|loja virtual|loja online|blog|sistema|plataforma|portfolio|portifolio)\b/.test(
      text
    );
  const startsAsProjectRequest =
    /^(site|website|app|aplicativo|landing|landing page|saas|ecommerce|e-commerce|loja|loja virtual|loja online|blog|sistema|plataforma|portfolio|portifolio)\b.+\b(para|de|do|da|sobre)\b/.test(
      text
    );

  return hasProjectType && (hasCreationVerb || startsAsProjectRequest);
}

function isProjectBriefingFollowup(history) {
  if (!Array.isArray(history)) {
    return false;
  }

  const normalizedHistory = history.map(normalizeHistoryItem).filter(Boolean);
  const lastAssistantIndex = normalizedHistory
    .map((item) => item.role)
    .lastIndexOf('assistant');

  if (lastAssistantIndex < 0) {
    return false;
  }

  const lastAssistant = normalizedHistory[lastAssistantIndex];
  const previousUserMessages = normalizedHistory
    .slice(0, lastAssistantIndex)
    .filter((item) => item.role === 'user');

  return (
    lastAssistant.content !== READY_REPLY &&
    lastAssistant.content.includes('?') &&
    previousUserMessages.some((item) => hasProjectCreationIntent(item.content))
  );
}

function looksLikeUnclearMessage(message) {
  const text = normalizeText(message);
  const compact = text.replace(/[^a-z0-9]/g, '');

  if (!compact) {
    return true;
  }

  if (compact.length >= 4 && !/[aeiou]/.test(compact)) {
    return true;
  }

  if (compact.length >= 6 && /[bcdfghjklmnpqrstvwxyz]{4,}/.test(compact)) {
    return true;
  }

  if (/\b(asdf|qwer|zxcv|hjkl)\b/.test(text)) {
    return true;
  }

  if (/^(.)\1{3,}$/.test(compact)) {
    return true;
  }

  return false;
}

function looksLikeGeneralConversation(message) {
  const text = normalizeText(message);

  if (!text) {
    return false;
  }

  return (
    text.includes('?') ||
    /\b(oi|ola|bom dia|boa tarde|boa noite|tudo bem|me ajuda|ajuda|duvida|pergunta|explique|explica|como|qual|quais|quando|onde|porque|por que|o que|quanto|quantos)\b/.test(
      text
    )
  );
}

function isFirstUserMessage(history) {
  return !history.some((item) => item.role === 'user');
}

function shouldReturnUnclearIntent({ message, previousMessages, canStartWizard }) {
  if (canStartWizard) {
    return false;
  }

  if (looksLikeUnclearMessage(message)) {
    return true;
  }

  return isFirstUserMessage(previousMessages) && !looksLikeGeneralConversation(message);
}

function isProjectContinuationFallback(reply) {
  const text = normalizeText(reply);

  return /\bcontinuar\s+(trabalhando|mexendo|editando|ajustando)\s+no\s+projeto\b/.test(
    text
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
- Se a primeira mensagem nao tiver intencao clara, responda que nao entendeu e pergunte se o usuario quer criar site, app, landing page, SaaS ou ecommerce.
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

  if (shouldReturnUnclearIntent({ message, previousMessages, canStartWizard })) {
    return {
      reply: UNCLEAR_INTENT_REPLY,
      readyForWizard: false,
    };
  }

  const shouldIncludeProjectContext =
    projectContext && (canStartWizard || !isFirstUserMessage(previousMessages));

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

  if (
    (modelWantsWizard && !canStartWizard) ||
    (!canStartWizard && isProjectContinuationFallback(reply))
  ) {
    return {
      reply: UNCLEAR_INTENT_REPLY,
      readyForWizard: false,
    };
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
