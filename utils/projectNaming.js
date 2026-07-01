const GENERIC_WORDS = new Set([
  'app',
  'application',
  'aplicativo',
  'site',
  'website',
  'sistema',
  'platform',
  'plataforma',
  'saas',
  'landing',
  'dashboard',
  'portal',
  'project',
  'projeto',
]);

const NAME_STOP_WORD_PATTERN = /\s+(?:for|para|que|with|com|and|e|where|onde|that|which|depois|after|usando|using|tipo|like)\b/i;

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeAppName(name) {
  const cleaned = decodeBasicEntities(name)
    .replace(/[<>[\]{}()]/g, ' ')
    .replace(/[“”‘’"']/g, '')
    .replace(/[^\p{L}\p{N}&._ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s._&-]+|[\s._&-]+$/g, '');

  if (!cleaned) {
    return null;
  }

  return cleaned.slice(0, 24).trim().replace(/[\s._&-]+$/g, '') || null;
}

function normalizeProjectTitle(name) {
  const cleaned = decodeBasicEntities(name)
    .replace(/[<>[\]{}()]/g, ' ')
    .replace(/[“”‘’"']/g, '')
    .replace(/[^\p{L}\p{N}&._ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s._&-]+|[\s._&-]+$/g, '');

  if (!cleaned) {
    return null;
  }

  return cleaned.slice(0, 28).trim().replace(/[\s._&-]+$/g, '') || null;
}

function looksLikeAppName(value) {
  const name = normalizeAppName(value);
  if (!name) {
    return false;
  }

  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 3) {
    return false;
  }

  if (GENERIC_WORDS.has(name.toLowerCase())) {
    return false;
  }

  return /[\p{L}\p{N}]/u.test(name);
}

function extractExplicitAppName(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return null;
  }

  const patterns = [
    /\b(?:called|named)\s+["'“”‘’]?([A-Z0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bwith\s+the\s+name\s+["'“”‘’]?([A-Z0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bcom\s+o\s+nome\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bcom\s+nome\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bchamad[oa]\s+de\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bchamad[oa]\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bnomead[oa]\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bnome\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
    /\bse\s+chama\s+["'“”‘’]?([\p{L}0-9][\p{L}\p{N}&._ -]{1,40})/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const candidate = String(match[1] || '').split(NAME_STOP_WORD_PATTERN)[0];
    const name = normalizeAppName(candidate);
    if (looksLikeAppName(name)) {
      return name;
    }
  }

  return null;
}

function extractExplicitProjectName(prompt) {
  const name = extractExplicitAppName(prompt);
  return normalizeProjectTitle(name);
}

function collectBrandCandidatesFromHtml(html) {
  const source = String(html || '').slice(0, 500000);
  const candidates = [];
  const patterns = [
    /<title\b[^>]*>([\s\S]{1,120}?)<\/title>/gi,
    /<h1\b[^>]*>([\s\S]{1,120}?)<\/h1>/gi,
    /<(?:a|div|span|strong)\b[^>]*(?:class|aria-label)=["'][^"']*(?:logo|brand|navbar-brand|app-name)[^"']*["'][^>]*>([\s\S]{1,120}?)<\/(?:a|div|span|strong)>/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const text = normalizeAppName(stripHtml(match[1]).split(/[|:–-]/)[0]);
      if (looksLikeAppName(text)) {
        candidates.push(text);
      }
    }
  }

  return candidates;
}

function keywordFallbackName(text) {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (/\b(carro|carros|auto|autos|automovel|automoveis|veiculo|veiculos|vehicle|vehicles|car|cars|drive|drives)\b/.test(normalized)) {
    if (/\b(venda|vendas|sell|sale|sales|marketplace|loja|shop|store|comprar|compra|buy)\b/.test(normalized)) {
      return 'CarMarket';
    }

    return 'AutoHub';
  }

  if (/\b(academy|academies|gym|gyms|academia|academias|fitness|treino|treinos|workout|workouts)\b/.test(normalized)) {
    return normalized.includes('academia') || normalized.includes('gym') ? 'GymFlow' : 'FitPilot';
  }

  if (/\b(delivery|deliveries|entrega|entregas|food|comida|restaurante|restaurant|meal|meals|lanche|lanches)\b/.test(normalized)) {
    return 'QuickBite';
  }

  if (/\b(ride|rides|mobility|mobilidade|corrida|corridas|uber|motorista|driver|taxi)\b/.test(normalized)) {
    return 'RideFlow';
  }

  if (/\b(roupa|roupas|moda|fashion|outfit|outfits|vestuario|clothing|apparel|feminina|feminino)\b/.test(normalized)) {
    return 'StyleFlow';
  }

  if (/\b(marketplace|shop|store|ecommerce|e-commerce|loja|venda|commerce)\b/.test(normalized)) {
    return 'ShopFlow';
  }

  if (/\b(finance|financial|invoice|invoices|financa|financeiro|fatura|cobranca|ledger)\b/.test(normalized)) {
    return 'LedgerFlow';
  }

  if (/\b(process|workflow|automation|automacao|fluxo|processo)\b/.test(normalized)) {
    return 'FlowPilot';
  }

  return 'LaunchPilot';
}

function generateFallbackAppName(project, prompt, build) {
  const htmlSources = [
    build && build.fullHtml,
    build && build.html,
    project && project.fullHtml,
    project && project.latestFullHtml,
    project && project.html,
  ];

  for (const html of htmlSources) {
    for (const candidate of collectBrandCandidatesFromHtml(html)) {
      return candidate;
    }
  }

  const sourceText = [
    prompt,
    project && project.prompt,
    project && project.name,
    project && project.title,
    project && project.description,
    build && build.sourceSummary,
  ].filter(Boolean).join(' ');

  return normalizeAppName(keywordFallbackName(sourceText));
}

function generateFallbackProjectName(prompt) {
  return normalizeProjectTitle(keywordFallbackName(prompt)) || 'LaunchPilot';
}

function getProjectTitleFromPrompt(prompt) {
  return extractExplicitProjectName(prompt) || generateFallbackProjectName(prompt);
}

function slugifyAppName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'fluid-app';
}

module.exports = {
  extractExplicitAppName,
  extractExplicitProjectName,
  generateFallbackAppName,
  generateFallbackProjectName,
  getProjectTitleFromPrompt,
  normalizeAppName,
  normalizeProjectTitle,
  slugifyAppName,
};
