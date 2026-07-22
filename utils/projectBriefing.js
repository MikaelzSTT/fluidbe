const FIELD_LABELS = Object.freeze({
  type: 'Tipo',
  objective: 'Objetivo',
  mainContext: 'Tema/oferta',
  audience: 'Público',
  style: 'Estilo',
  cta: 'CTA',
});

const FIELD_ALIASES = Object.freeze({
  type: ['type', 'projectType', 'project_type', 'tipo', 'tipo_projeto'],
  objective: ['objective', 'goal', 'purpose', 'objetivo', 'finalidade'],
  mainContext: [
    'mainContext', 'main_context', 'context', 'topic', 'theme', 'subject',
    'offer', 'offering', 'product', 'service', 'business', 'tema', 'oferta',
    'produto', 'servico', 'negocio',
  ],
  audience: [
    'audience', 'targetAudience', 'target_audience', 'idealCustomer',
    'ideal_customer', 'publico', 'publico_alvo', 'cliente_ideal',
  ],
  style: ['style', 'visualStyle', 'visual_style', 'estilo', 'estilo_visual'],
  cta: ['cta', 'primaryAction', 'primary_action', 'acao_principal'],
});

const VAGUE_VALUES = new Set([
  'algo',
  'algo bacana',
  'algo interessante',
  'algo legal',
  'alguma coisa',
  'qualquer coisa',
  'nao sei',
  'nao tenho ideia',
  'tanto faz',
  'um negocio',
  'uma coisa',
]);

const GENERIC_CONTEXT_VALUES = new Set([
  'produto',
  'produtos',
  'servico',
  'servicos',
  'vender produto',
  'vender produtos',
  'vender servico',
  'vender servicos',
  'apresentar produto',
  'apresentar produtos',
  'apresentar servico',
  'apresentar servicos',
]);

function cleanValue(value) {
  if (value && typeof value === 'object') {
    value = value.customValue || value.custom_value || value.label || value.value || '';
  }

  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeText(value) {
  return cleanValue(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAliasValue(source, field) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return '';
  }

  for (const alias of FIELD_ALIASES[field]) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) {
      const value = cleanValue(source[alias]);
      if (value) return value;
    }
  }

  return '';
}

function normalizeProjectType(value) {
  const normalized = normalizeText(value).replace(/[_-]+/g, ' ');

  if (/\blanding\b/.test(normalized)) return 'landing-page';
  if (/\bmarket ?place\b/.test(normalized)) return 'marketplace';
  if (/\bportfolio\b/.test(normalized)) return 'portfolio';
  if (/\b(ecommerce|e commerce|loja virtual)\b/.test(normalized)) return 'ecommerce';
  if (/\b(app web|web app|aplicativo web|saas|dashboard|sistema web)\b/.test(normalized)) return 'web-app';
  if (/\b(site|website|pagina)\b/.test(normalized)) return 'website';
  if (/\b(app|aplicativo)\b/.test(normalized)) return 'web-app';

  return cleanValue(value);
}

function inferType(text) {
  const normalized = normalizeText(text);
  if (!/\b(landing|market ?place|portfolio|ecommerce|e commerce|loja virtual|app web|web app|aplicativo web|saas|dashboard|sistema web|site|website|pagina|app|aplicativo)\b/.test(normalized)) {
    return '';
  }
  return normalizeProjectType(text);
}

function inferObjective(text) {
  const normalized = normalizeText(text);

  if (/\b(vender|venda|comprar|compra|checkout|assinatura|assinar)\b/.test(normalized)) return 'Vender';
  if (/\b(captar|captacao|leads?|orcamentos?|contatos?)\b/.test(normalized)) return 'Captar leads';
  if (/\b(agendar|agendamento|reservar|reserva)\b/.test(normalized)) return 'Gerar agendamentos';
  if (/\b(apresentar|divulgar|mostrar|promover)\b/.test(normalized)) return 'Apresentar';
  if (/\b(portfolio)\b/.test(normalized)) return 'Apresentar trabalho';
  if (/\b(market ?place)\b/.test(normalized)) return 'Intermediar negociações';
  if (/\b(app|aplicativo|sistema|saas|dashboard)\b/.test(normalized)) return 'Resolver um problema';

  return '';
}

function trimCapturedValue(value) {
  return cleanValue(value)
    .replace(/\b(?:com estilo|no estilo|estilo)\b[\s\S]*$/i, '')
    .replace(/\b(?:e o cta|com cta|cta)\b[\s\S]*$/i, '')
    .trim();
}

function inferOfferAndAudience(text) {
  const normalized = normalizeText(text);
  const targetedSalesMatch = normalized.match(
    /\b(?:vender|vendendo|oferecer|comercializar)\s+(.+?)\s+(?:para|pra)\s+(.+)$/
  );
  const salesMatch = targetedSalesMatch || normalized.match(
    /\b(?:vender|vendendo|oferecer|comercializar)\s+(.+)$/
  );

  if (salesMatch) {
    return {
      mainContext: trimCapturedValue(salesMatch[1]),
      audience: trimCapturedValue(salesMatch[2]),
    };
  }

  const marketplaceMatch = normalized.match(
    /\bmarket ?place\s+(?:de|para)\s+(.+?)\s+(?:para|entre|por)\s+(.+)$/
  ) || normalized.match(/\bmarket ?place\s+(?:de|para)\s+(.+)$/);
  if (marketplaceMatch) {
    return {
      mainContext: trimCapturedValue(marketplaceMatch[1]),
      audience: trimCapturedValue(marketplaceMatch[2]),
    };
  }

  const portfolioMatch = normalized.match(/\bportfolio\s+(?:de|para)\s+(.+)$/);
  if (portfolioMatch) {
    return { mainContext: trimCapturedValue(portfolioMatch[1]), audience: '' };
  }

  const problemMatch = normalized.match(
    /\b(?:app|aplicativo|sistema|saas|dashboard)(?:\s+web)?\s+(?:para|que)\s+(.+?)\s+(?:para|pra)\s+(.+)$/
  ) || normalized.match(
    /\b(?:app|aplicativo|sistema|saas|dashboard)(?:\s+web)?\s+(?:para|que)\s+(.+)$/
  );
  if (problemMatch) {
    return {
      mainContext: trimCapturedValue(problemMatch[1]),
      audience: trimCapturedValue(problemMatch[2]),
    };
  }

  const topicMatch = normalized.match(/\b(?:sobre|para apresentar|para divulgar)\s+(.+)$/);
  return {
    mainContext: topicMatch ? trimCapturedValue(topicMatch[1]) : '',
    audience: '',
  };
}

function inferStyle(text) {
  const normalized = normalizeText(text);
  const styles = [
    ['minimalista', /\bminimalista?\b/],
    ['moderno', /\bmodern[oa]\b/],
    ['elegante', /\belegante\b/],
    ['corporativo', /\bcorporativ[oa]\b/],
    ['divertido', /\b(divertid[oa]|colorid[oa])\b/],
    ['premium', /\b(luxo|premium|sofisticad[oa])\b/],
  ];
  const match = styles.find(([, pattern]) => pattern.test(normalized));
  return match ? match[0] : '';
}

function hasExplicitBuildIntent(value) {
  const normalized = normalizeText(value);
  return /\b(crie|criar|cria|gere|gerar|gera|monte|monta|construa|construir|build|create|make|desenvolva|faca|faz|vamos criar|vamos construir|bora criar|bora construir)\b/.test(normalized)
    || /\b(quero|preciso)\b.*\b(app|aplicativo|site|website|landing page|marketplace|saas|dashboard|ecommerce|loja|projeto|sistema|pagina|interface|plataforma)\b/.test(normalized)
    || /^\s*(?:uma?\s+)?(?:landing page|market ?place|portfolio|app(?:licativo)?(?: web)?|site|website|saas|dashboard|ecommerce|loja virtual)\b.*\b(?:para|pra)\b/.test(normalized);
}

function getBriefingConversation(history, currentMessage) {
  const items = (Array.isArray(history) ? history : [])
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: cleanValue(item?.content || item?.message),
    }))
    .filter((item) => item.content);
  const current = cleanValue(currentMessage);

  if (current && !items.some((item, index) => (
    index === items.length - 1 && item.role === 'user' && normalizeText(item.content) === normalizeText(current)
  ))) {
    items.push({ role: 'user', content: current });
  }

  let startIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'user' && hasExplicitBuildIntent(items[index].content)) {
      startIndex = index;
      break;
    }
  }

  return startIndex >= 0 ? items.slice(startIndex) : [];
}

function inferFieldFromQuestion(question) {
  const normalized = normalizeText(question);
  if (/\b(tipo|formato)\b.*\b(projeto|pagina|site|app)\b/.test(normalized)) return 'type';
  if (/\b(objetivo|finalidade)\b/.test(normalized)) return 'objective';
  if (/\b(estilo|visual|aparencia)\b/.test(normalized)) return 'style';
  if (/\b(cta|acao principal|visitante deve fazer)\b/.test(normalized)) return 'cta';
  if (/\b(publico|cliente ideal|para quem|por quem|quem vai usar|quem negociara)\b/.test(normalized)) return 'audience';
  if (/\b(o que|qual)\b.*\b(vender|apresentar|produto|servico|negocio|oferta|problema|negociado|portfolio|area)\b/.test(normalized)) return 'mainContext';
  return '';
}

function collectStructuredFields(input) {
  const sources = [input?.briefing, input?.answers, input].filter(Boolean);
  const briefing = {};

  Object.keys(FIELD_ALIASES).forEach((field) => {
    for (const source of sources) {
      const value = getAliasValue(source, field);
      if (value) {
        briefing[field] = field === 'type' ? normalizeProjectType(value) : value;
        break;
      }
    }
  });

  return briefing;
}

function collectProjectBriefing(input = {}) {
  const briefing = collectStructuredFields(input);
  const conversation = getBriefingConversation(input.history || input.messages, input.message || input.prompt);

  for (let index = 0; index < conversation.length; index += 1) {
    const item = conversation[index];
    if (item.role !== 'user') continue;

    const inferredType = inferType(item.content);
    const inferredObjective = inferObjective(item.content);
    const inferredOffer = inferOfferAndAudience(item.content);
    const inferredStyle = inferStyle(item.content);

    if (!briefing.type && inferredType) briefing.type = inferredType;
    if (!briefing.objective && inferredObjective) briefing.objective = inferredObjective;
    if (!briefing.mainContext && inferredOffer.mainContext) briefing.mainContext = inferredOffer.mainContext;
    if (!briefing.audience && inferredOffer.audience) briefing.audience = inferredOffer.audience;
    if (!briefing.style && inferredStyle) briefing.style = inferredStyle;

    const previous = conversation[index - 1];
    if (previous?.role === 'assistant') {
      const answerField = inferFieldFromQuestion(previous.content);
      if (answerField && !briefing[answerField]) {
        briefing[answerField] = answerField === 'type'
          ? normalizeProjectType(item.content)
          : cleanValue(item.content);
      }
    }
  }

  const promptText = [input.prompt, input.description]
    .map(cleanValue)
    .filter(Boolean)
    .join(' ');
  if (promptText) {
    const offer = inferOfferAndAudience(promptText);
    if (!briefing.type) briefing.type = inferType(promptText);
    if (!briefing.objective) briefing.objective = inferObjective(promptText);
    if (!briefing.mainContext) briefing.mainContext = offer.mainContext;
    if (!briefing.audience) briefing.audience = offer.audience;
    if (!briefing.style) briefing.style = inferStyle(promptText);
  }

  if (!briefing.cta && isSalesBriefing(briefing) && /\b(vender|venda|comprar|compra)\b/.test(normalizeText([input.message, input.prompt, briefing.objective].join(' ')))) {
    briefing.cta = 'Comprar';
  }

  return Object.fromEntries(
    Object.entries(briefing).map(([field, value]) => [field, cleanValue(value)])
  );
}

function isVagueAnswer(value, field = '') {
  const normalized = normalizeText(value);
  if (!normalized || VAGUE_VALUES.has(normalized)) return true;
  if (field === 'mainContext' && GENERIC_CONTEXT_VALUES.has(normalized)) return true;
  if (field === 'mainContext' && /^(?:vender|apresentar|divulgar)\s+(?:alguns?\s+)?(?:produtos?|servicos?|coisas?)$/.test(normalized)) return true;
  return false;
}

function isSalesBriefing(briefing) {
  const normalized = normalizeText(`${briefing?.type || ''} ${briefing?.objective || ''}`);
  return /\b(vender|venda|comercio|ecommerce|e commerce|loja)\b/.test(normalized);
}

function getRequiredBriefingFields(briefing = {}) {
  const required = ['type', 'objective', 'mainContext', 'style'];
  const type = normalizeProjectType(briefing.type);

  if (isSalesBriefing(briefing) || ['landing-page', 'marketplace', 'web-app'].includes(type)) {
    required.push('audience');
  }
  if (isSalesBriefing(briefing) || type === 'landing-page') {
    required.push('cta');
  }

  return required;
}

function evaluateProjectBriefing(input = {}) {
  const briefing = collectProjectBriefing(input);
  const hasStructuredBriefing = [input.briefing, input.answers].some((source) => (
    source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).length > 0
  ));
  const active = hasStructuredBriefing || hasExplicitBuildIntent(input.message || input.prompt);
  const requiredFields = getRequiredBriefingFields(briefing);
  const invalidFields = requiredFields.filter((field) => (
    briefing[field] && isVagueAnswer(briefing[field], field)
  ));
  const missingFields = requiredFields.filter((field) => (
    !briefing[field] || invalidFields.includes(field)
  ));

  return {
    briefing,
    requiredFields,
    missingFields,
    invalidFields,
    complete: missingFields.length === 0,
    active,
  };
}

function createChoiceQuestion(field, question, options) {
  return {
    id: field,
    field,
    question,
    inputType: 'choice',
    required: true,
    options: options.map(([value, label, description]) => ({ value, label, description })),
  };
}

function createTextQuestion(field, question, placeholder, invalid) {
  return {
    id: field,
    field,
    question: invalid ? `Preciso de um pouco mais de detalhe. ${question}` : question,
    inputType: 'text',
    required: true,
    placeholder,
    options: [],
  };
}

function getMainContextQuestion(type, invalid) {
  if (type === 'marketplace') {
    return createTextQuestion('mainContext', 'O que será negociado no marketplace?', 'Ex.: equipamentos usados para restaurantes', invalid);
  }
  if (type === 'web-app') {
    return createTextQuestion('mainContext', 'Qual problema o app web deve resolver?', 'Ex.: organizar escalas de equipes de enfermagem', invalid);
  }
  if (type === 'landing-page') {
    return createTextQuestion('mainContext', 'O que você quer vender ou apresentar?', 'Ex.: cursos de inglês online para adultos', invalid);
  }
  if (type === 'portfolio') {
    return createTextQuestion('mainContext', 'De quem é o portfólio e de qual área?', 'Ex.: portfólio de Ana, fotógrafa de gastronomia', invalid);
  }
  return createTextQuestion('mainContext', 'Descreva em uma frase o produto, serviço, negócio ou tema.', 'Ex.: consultoria financeira para pequenas empresas', invalid);
}

function buildBriefingQuestions(evaluation, limit = 4) {
  const { briefing, missingFields, invalidFields } = evaluation;
  const type = normalizeProjectType(briefing.type);
  const questions = [];

  for (const field of missingFields) {
    const invalid = invalidFields.includes(field);
    if (field === 'type') {
      questions.push(createChoiceQuestion('type', 'Qual tipo de projeto você quer criar?', [
        ['landing-page', 'Landing page', 'Uma página focada em uma oferta e ação principal.'],
        ['web-app', 'App web', 'Uma aplicação que resolve um problema ou fluxo.'],
        ['marketplace', 'Marketplace', 'Uma plataforma que conecta compradores e vendedores.'],
        ['portfolio', 'Portfólio', 'Uma apresentação de trabalhos e experiência.'],
      ]));
    } else if (field === 'objective') {
      questions.push(createChoiceQuestion('objective', 'Qual é o objetivo principal do projeto?', [
        ['vender', 'Vender', 'Gerar compras ou contratações.'],
        ['captar_leads', 'Captar leads', 'Receber contatos ou pedidos de orçamento.'],
        ['apresentar', 'Apresentar', 'Divulgar um negócio, trabalho ou iniciativa.'],
        ['resolver_problema', 'Resolver um problema', 'Entregar uma ferramenta ou fluxo útil.'],
      ]));
    } else if (field === 'mainContext') {
      questions.push(getMainContextQuestion(type, invalid));
    } else if (field === 'audience') {
      const question = type === 'marketplace'
        ? 'Quem negocia nesse marketplace?'
        : type === 'web-app'
          ? 'Para quem o app resolve esse problema?'
          : 'Qual é o público-alvo ou cliente ideal?';
      questions.push(createTextQuestion('audience', question, 'Ex.: brasileiros adultos que estudam para trabalhar no exterior', invalid));
    } else if (field === 'style') {
      questions.push(createChoiceQuestion('style', 'Qual estilo visual deve orientar o projeto?', [
        ['moderno', 'Moderno', 'Visual atual, claro e objetivo.'],
        ['minimalista', 'Minimalista', 'Poucos elementos e bastante foco no conteúdo.'],
        ['premium', 'Premium', 'Acabamento sofisticado e alta percepção de valor.'],
        ['divertido', 'Divertido', 'Mais cor, energia e informalidade.'],
      ]));
    } else if (field === 'cta') {
      questions.push(createTextQuestion('cta', 'Qual ação principal o visitante deve realizar?', 'Ex.: Comprar agora, Solicitar orçamento ou Agendar demonstração', invalid));
    }
  }

  return questions.slice(0, Math.max(1, limit));
}

function buildBriefingSummary(briefing = {}) {
  const summary = {};
  Object.keys(FIELD_LABELS).forEach((field) => {
    if (briefing[field]) summary[field] = briefing[field];
  });
  return summary;
}

module.exports = {
  FIELD_LABELS,
  buildBriefingQuestions,
  buildBriefingSummary,
  collectProjectBriefing,
  evaluateProjectBriefing,
  getBriefingConversation,
  getRequiredBriefingFields,
  hasExplicitBuildIntent,
  isVagueAnswer,
  normalizeProjectType,
  normalizeText,
};
