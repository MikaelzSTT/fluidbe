const LANGUAGE_NAMES = Object.freeze({
  en: 'English',
  pt: 'Portuguese',
  es: 'Spanish',
});

const LANGUAGE_ALIASES = Object.freeze({
  en: 'en',
  eng: 'en',
  english: 'en',
  ingles: 'en',
  'inglês': 'en',
  pt: 'pt',
  br: 'pt',
  'pt-br': 'pt',
  portuguese: 'pt',
  portugues: 'pt',
  português: 'pt',
  es: 'es',
  spa: 'es',
  spanish: 'es',
  espanhol: 'es',
  espanol: 'es',
  español: 'es',
});

const LANGUAGE_TERMS = Object.freeze({
  en: ['english', 'ingles', 'inglês'],
  pt: ['portuguese', 'portugues', 'português'],
  es: ['spanish', 'espanol', 'español', 'espanhol'],
});

const WORD_MARKERS = Object.freeze({
  en: new Set([
    'about', 'after', 'answer', 'app', 'are', 'because', 'build', 'can',
    'create', 'could', 'for', 'from', 'have', 'help', 'how', 'i', 'in',
    'is', 'it', 'make', 'me', 'my', 'need', 'please', 'reply', 'should',
    'site', 'that', 'the', 'this', 'to', 'want', 'website', 'what', 'when',
    'where', 'who', 'why', 'with', 'would', 'you', 'your',
  ]),
  pt: new Set([
    'ajuda', 'ajudar', 'aplicativo', 'como', 'cria', 'criar', 'crie',
    'de', 'do', 'em', 'eu', 'faca', 'faça', 'me', 'meu', 'minha', 'nao',
    'não', 'obrigado', 'ola', 'olá', 'para', 'pq', 'pra', 'preciso',
    'projeto', 'qual', 'quando', 'quero', 'responda', 'responde',
    'site', 'um', 'uma', 'voce', 'você',
  ]),
  es: new Set([
    'aplicacion', 'aplicación', 'ayuda', 'ayudar', 'como', 'crear',
    'crea', 'de', 'el', 'en', 'es', 'gracias', 'hola', 'la', 'mi',
    'necesito', 'para', 'por', 'que', 'quiero', 'responde', 'sitio',
    'una',
  ]),
});

function normalizeLanguageCode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');

  if (!normalized) {
    return '';
  }

  if (LANGUAGE_ALIASES[normalized]) {
    return LANGUAGE_ALIASES[normalized];
  }

  const prefix = normalized.split('-')[0];
  return LANGUAGE_ALIASES[prefix] || '';
}

function normalizeTextForLanguage(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripDiacritics(value) {
  return normalizeTextForLanguage(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectExplicitResponseLanguage(message) {
  const rawText = normalizeTextForLanguage(message);
  const asciiText = stripDiacritics(message);
  const texts = [rawText, asciiText];

  for (const [language, terms] of Object.entries(LANGUAGE_TERMS)) {
    for (const term of terms) {
      const normalizedTerm = stripDiacritics(term);
      const termPattern = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(`\\b(?:reply|respond|answer|write|speak)\\s+(?:only\\s+|just\\s+)?in\\s+${termPattern}\\b`),
        new RegExp(`\\b(?:responda|responde|responder|fale|fala|escreva|escreve)\\s+(?:apenas\\s+|somente\\s+|so\\s+)?(?:em|en)\\s+${termPattern}\\b`),
        new RegExp(`\\b(?:contesta|conteste|responde)\\s+(?:solo\\s+|solamente\\s+)?(?:en|em)\\s+${termPattern}\\b`),
        new RegExp(`\\bin\\s+${termPattern}\\s+(?:please|pls)\\b`),
      ];

      if (texts.some((text) => patterns.some((pattern) => pattern.test(text)))) {
        return language;
      }
    }
  }

  return '';
}

function tokenizeLanguageText(value) {
  return stripDiacritics(value).match(/[a-z0-9]+/g) || [];
}

function scoreLanguageText(value) {
  const rawText = normalizeTextForLanguage(value);
  const asciiText = stripDiacritics(value);
  const words = tokenizeLanguageText(value);
  const scores = { en: 0, pt: 0, es: 0 };

  if (/[ãõç]/i.test(rawText)) scores.pt += 4;
  if (/[áàâêíóôú]/i.test(rawText)) scores.pt += 1;
  if (/[ñ¿¡]/i.test(rawText)) scores.es += 4;
  if (/\b(?:i'm|i’ve|i'd|don't|can't|won't|you're|it's|we're)\b/i.test(rawText)) scores.en += 3;

  words.forEach((word) => {
    for (const [language, markers] of Object.entries(WORD_MARKERS)) {
      if (markers.has(word)) {
        scores[language] += word.length <= 2 ? 1 : 2;
      }
    }
  });

  if (/\b(?:i need|i want|can you|could you|please)\b/.test(asciiText)) scores.en += 3;
  if (/\b(?:eu quero|eu preciso|voce pode|você pode|me ajuda|me ajude|o que|oque|o que tem)\b/.test(rawText)) scores.pt += 3;
  if (/\b(?:tem|voce|você)\b/.test(rawText)) scores.pt += 2;
  if (/\b(?:quiero|necesito|puedes|me ayudas)\b/.test(asciiText)) scores.es += 3;

  return { scores, words };
}

function detectMessageLanguage(message, { allowShort = false } = {}) {
  const { scores, words } = scoreLanguageText(message);

  if (!allowShort && words.length <= 2 && !/[ãõçñ¿¡]/i.test(String(message || ''))) {
    return '';
  }

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestLanguage, bestScore] = ranked[0];
  const [, secondScore] = ranked[1];

  if (bestScore < 2 || bestScore - secondScore < 2) {
    return '';
  }

  return bestLanguage;
}

function detectPredominantHistoryLanguage(history) {
  const scores = { en: 0, pt: 0, es: 0 };
  const items = (Array.isArray(history) ? history : []).slice(-8);

  items.forEach((item) => {
    const role = item?.role === 'assistant' ? 'assistant' : 'user';
    const language = detectMessageLanguage(item?.content || item?.message, { allowShort: false });

    if (language) {
      scores[language] += role === 'user' ? 2 : 1;
    }
  });

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestLanguage, bestScore] = ranked[0];
  const [, secondScore] = ranked[1];

  if (bestScore < 2 || bestScore === secondScore) {
    return '';
  }

  return bestLanguage;
}

function resolveResponseLanguage({
  message,
  history,
  accountLanguage,
  projectLanguage,
} = {}) {
  return detectExplicitResponseLanguage(message)
    || detectMessageLanguage(message)
    || detectPredominantHistoryLanguage(history)
    || normalizeLanguageCode(accountLanguage)
    || normalizeLanguageCode(projectLanguage)
    || 'en';
}

function getResponseLanguageName(language) {
  return LANGUAGE_NAMES[normalizeLanguageCode(language)] || LANGUAGE_NAMES.en;
}

module.exports = {
  detectExplicitResponseLanguage,
  detectMessageLanguage,
  detectPredominantHistoryLanguage,
  getResponseLanguageName,
  normalizeLanguageCode,
  resolveResponseLanguage,
};
