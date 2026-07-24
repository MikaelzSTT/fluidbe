const express = require('express');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const ProjectMessage = require('../models/ProjectMessage');
const BriefingSession = require('../models/BriefingSession');
const ConnectorSecret = require('../models/ConnectorSecret');
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');
const { createRateLimit, getClientIp } = require('../middleware/rateLimit');
const { getConnectorByProvider } = require('./connectorRegistryRoutes');
const {
  encryptConnectorValue,
  getConnectorEncryptionKey,
} = require('../utils/connectorSecrets');
const {
  MAX_PROJECT_FILE_CONTENT_BYTES,
  MAX_PROJECT_FILE_TREE_ENTRIES,
  buildProjectArtifactFileTree,
  buildProjectFileTree,
  getProjectFileMetadata,
  isLikelyTextBuffer,
  resolveProjectArtifactFile,
  resolveProjectFilePath,
  resolveProjectFileRoot,
} = require('../utils/projectFiles');
const {
  publishProjectBuild,
  scanBuildSecurity,
} = require('../utils/projectPublication');
const {
  toDedicatedPreviewUrl,
} = require('../utils/previewOrigin');
const {
  extractExplicitAppName,
  extractExplicitProjectName,
  generateFallbackAppName,
  getUniqueProjectTitleForUser,
  normalizeAppName,
} = require('../utils/projectNaming');
const { addBuildPreviewToken } = require('../utils/buildPreviewAccess');
const { deleteProjectsData } = require('../utils/projectDeletion');
const {
  buildBriefingQuestions,
  buildBriefingSummary,
  collectProjectBriefing,
  evaluateProjectBriefing,
} = require('../utils/projectBriefing');
const {
  containsUnsafeMongoKey,
  isPlainObject,
} = require('../utils/mongoSafety');
const {
  findBriefingSession,
  getRequestedBriefingSessionId,
  isExpired: isBriefingSessionExpired,
  sendBriefingSessionExpired,
} = require('../utils/briefingSessions');

const router = express.Router();
const connectorCredentialIpRateLimit = createRateLimit({
  name: 'project-connector-credential-ip',
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: getClientIp,
});
const connectorCredentialUserRateLimit = createRateLimit({
  name: 'project-connector-credential-user',
  windowMs: 15 * 60 * 1000,
  max: 6,
  keyGenerator: (req) => req.userId ? `user:${req.userId}` : `ip:${getClientIp(req)}`,
});
const CONNECTOR_VALIDATION_FAILURE_MESSAGE = 'Não foi possível validar este conector. Confira a credencial.';
const CONNECTOR_VALIDATION_TIMEOUT_MS = 5000;
const CONNECTOR_STATUSES = ['pending', 'connected', 'skipped', 'error'];
const CONNECTOR_ERROR_MESSAGES = {
  stripe: 'Stripe Secret Key inválida ou sem permissão.',
  google_maps: 'Google Maps API Key inválida ou bloqueada.',
  resend: 'Resend API Key inválida.',
  openai: 'OpenAI API Key inválida.',
  twilio: 'Credenciais Twilio inválidas.',
  shopify: 'Credenciais Shopify inválidas ou loja inacessível.',
  supabase: 'Credenciais Supabase inválidas ou projeto inacessível.',
  cloudinary: 'Credenciais Cloudinary inválidas.',
};
const CONNECTOR_STATUS_LABELS = {
  pending: 'Pendente',
  connected: 'Conectado',
  skipped: 'Ignorado',
  error: 'Erro',
};
const CONNECTOR_STATUS_TONES = {
  pending: 'yellow',
  connected: 'green',
  skipped: 'gray',
  error: 'red',
};
const PROJECT_UPDATE_FIELDS = new Set([
  'name',
  'title',
  'description',
  'status',
  'generationStatus',
  'generation_status',
  'prompt',
  'type',
]);
const PROJECT_SETTINGS_UPDATE_FIELDS = new Set([
  'theme',
  'primaryColor',
  'language',
]);
const PUBLISHED_PROJECT_LIMITS = {
  free: 0,
  pro: 3,
  business: 10,
};
const BUILD_NOW_MODE = 'build_now';
const WIZARD_STATUSES = ['pending', 'in_progress', 'done'];

function getPublishedProjectLimit(plan) {
  return PUBLISHED_PROJECT_LIMITS[plan] || PUBLISHED_PROJECT_LIMITS.free;
}

function buildPublishedProjectLimitResponse({ currentPlan, publishedLimit, activePublishedCount }) {
  return {
    code: 'PUBLISHED_PROJECT_LIMIT_REACHED',
    message: publishedLimit > 0
      ? `You reached your limit of ${publishedLimit} active published projects.`
      : 'Upgrade your Fluid plan to publish projects.',
    currentPlan,
    publishedLimit,
    activePublishedCount,
  };
}
const CONNECTOR_RULES = [
  {
    provider: 'stripe',
    label: 'Stripe',
    reason: 'Necessário para pagamentos por cartão, checkout ou assinaturas.',
    patterns: [/\bpagament\w*\b/, /\bcartao\b/, /\bcartoes\b/, /\bcheckout\b/, /\bassinat\w*\b/, /\bloja\b/, /\bmarketplace\b/, /\bcorrida paga\b/],
  },
  {
    provider: 'google_maps',
    label: 'Google Maps',
    reason: 'Necessário para mapas, localização, rotas ou endereços.',
    patterns: [/\bmapa\w*\b/, /\blocaliz\w*\b/, /\brota\w*\b/, /\bentrega\w*\b/, /\buber\b/, /\bdelivery\b/, /\bmotorista\w*\b/, /\bendereco\w*\b/],
  },
  {
    provider: 'resend',
    label: 'Resend',
    reason: 'Necessário para envio de emails, recibos ou formulários de contato.',
    patterns: [/\bemail\w*\b/, /\be-mail\w*\b/, /\bnotificacao por email\b/, /\bnotificacoes por email\b/, /\brecibo\w*\b/, /\bformulario de contato\b/, /\bformularios de contato\b/],
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    reason: 'Necessário para login, banco de dados, usuários, dados salvos ou storage.',
    patterns: [/\blogin\b/, /\bbanco de dados\b/, /\bdashboard\b/, /\bcrm\b/, /\busuario\w*\b/, /\bdados salvos\b/, /\bstorage\b/],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    reason: 'Necessário para recursos de IA, chatbot, assistente ou geração por IA.',
    patterns: [/\bia\b/, /\bchatbot\w*\b/, /\bassistente\w*\b/, /\bgeracao por ia\b/, /\bgerar por ia\b/],
  },
  {
    provider: 'cloudinary',
    label: 'Cloudinary',
    reason: 'Necessário para upload e gerenciamento de imagens.',
    patterns: [/\bupload de imagen\w*\b/, /\bupload de foto\w*\b/, /\bfoto\w*\b/, /\bavatar\w*\b/, /\bproduto\w* com imagen\w*\b/],
  },
  {
    provider: 'backend',
    label: 'Backend',
    reason: 'Necessário para APIs, pedidos, corridas, status, realtime ou autenticação complexa.',
    patterns: [/\bbackend\b/, /\bapi\b/, /\bapis\b/, /\bpedido\w*\b/, /\bcorrida\w*\b/, /\bstatus\b/, /\brealtime\b/, /\btempo real\b/, /\bautenticacao complexa\b/],
  },
];

function normalizeConnectorText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConnectorProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeShopifyStoreUrl(value) {
  const storeUrl = String(value || '').trim();

  if (!storeUrl) {
    return '';
  }

  try {
    const parsedUrl = new URL(storeUrl.includes('://') ? storeUrl : `https://${storeUrl}`);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.username ||
      parsedUrl.password ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(hostname)
    ) {
      return '';
    }

    return hostname;
  } catch (error) {
    return '';
  }
}

function isSupabaseProjectUrl(value) {
  try {
    const parsedUrl = new URL(String(value || '').trim());
    return parsedUrl.protocol === 'https:' && parsedUrl.hostname.endsWith('.supabase.co');
  } catch (error) {
    return false;
  }
}

function normalizeConnectorValues(connector, values) {
  const normalizedValues = {};
  const provider = normalizeConnectorProvider(connector.provider);

  Object.entries(values || {}).forEach(([key, value]) => {
    normalizedValues[key] = typeof value === 'string' ? value.trim() : value;
  });

  if (provider === 'shopify' && Object.prototype.hasOwnProperty.call(normalizedValues, 'store_url')) {
    normalizedValues.store_url = normalizeShopifyStoreUrl(normalizedValues.store_url);
  }

  return normalizedValues;
}

function buildConfiguredFields(connector, values) {
  return (Array.isArray(connector.fields) ? connector.fields : [])
    .filter((field) => Object.prototype.hasOwnProperty.call(values, field.name))
    .filter((field) => values[field.name] !== undefined && values[field.name] !== null && String(values[field.name]).trim() !== '')
    .map((field) => ({
      name: field.name,
      label: field.label || field.name,
      type: field.type || '',
      required: field.required === true,
      configured: true,
    }));
}

function validateConnectorValues(connector, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return 'values deve ser um objeto com as credenciais do conector.';
  }

  const fields = Array.isArray(connector.fields) ? connector.fields : [];
  const missingFields = fields
    .filter((field) => field.required === true)
    .filter((field) => {
      const value = values[field.name];
      return value === undefined || value === null || String(value).trim() === '';
    })
    .map((field) => field.name);

  if (missingFields.length > 0) {
    return `Campos obrigatórios ausentes: ${missingFields.join(', ')}.`;
  }

  const provider = normalizeConnectorProvider(connector.provider);
  const trimmedValue = (fieldName) => String(values[fieldName] || '').trim();

  if (provider === 'stripe' && !/^sk_(test|live)_/.test(trimmedValue('secret_key'))) {
    return 'Stripe secret_key inválida. A chave precisa começar com sk_test_ ou sk_live_.';
  }

  if (provider === 'google_maps' && !trimmedValue('api_key').startsWith('AIza')) {
    return 'Google Maps api_key inválida. A chave precisa começar com AIza.';
  }

  if (provider === 'resend' && !trimmedValue('api_key').startsWith('re_')) {
    return 'Resend api_key inválida. A chave precisa começar com re_.';
  }

  if (provider === 'openai' && !trimmedValue('api_key').startsWith('sk-')) {
    return 'OpenAI api_key inválida. A chave precisa começar com sk-.';
  }

  if (provider === 'twilio' && !trimmedValue('account_sid').startsWith('AC')) {
    return 'Twilio account_sid inválido. O valor precisa começar com AC.';
  }

  if (provider === 'shopify') {
    const storeUrl = trimmedValue('store_url');

    if (!normalizeShopifyStoreUrl(storeUrl)) {
      return 'Shopify store_url inválida. Use o domínio HTTPS da loja em .myshopify.com.';
    }
  }

  if (provider === 'supabase') {
    const projectUrl = trimmedValue('project_url');

    if (!isSupabaseProjectUrl(projectUrl)) {
      return CONNECTOR_ERROR_MESSAGES.supabase;
    }
  }

  return '';
}

async function fetchWithConnectorTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECTOR_VALIDATION_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function validateGoogleMapsCredentials(values) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', 'New York');
  url.searchParams.set('key', values.api_key);

  const response = await fetchWithConnectorTimeout(url);

  if (!response.ok) {
    return false;
  }

  const body = await response.json().catch(() => null);
  return body?.status === 'OK' || body?.status === 'ZERO_RESULTS';
}

async function validateSupabaseCredentials(values) {
  const projectUrl = String(values.project_url || '').trim().replace(/\/+$/, '');
  const response = await fetchWithConnectorTimeout(`${projectUrl}/rest/v1/`, {
    headers: {
      apikey: values.anon_key,
      Authorization: `Bearer ${values.anon_key}`,
    },
  });

  return [200, 401, 404, 406].includes(response.status);
}

async function validateCloudinaryCredentials(values) {
  const credentials = Buffer.from(`${values.api_key}:${values.api_secret}`).toString('base64');
  const cloudName = encodeURIComponent(String(values.cloud_name || '').trim());
  const response = await fetchWithConnectorTimeout(
    `https://api.cloudinary.com/v1_1/${cloudName}/resources/image`,
    {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    }
  );

  return response.status === 200;
}

async function validateConnectorCredentials(connector, values) {
  const provider = normalizeConnectorProvider(connector.provider);
  const errorMessage = CONNECTOR_ERROR_MESSAGES[provider] || CONNECTOR_VALIDATION_FAILURE_MESSAGE;

  try {
    if (provider === 'stripe') {
      const response = await fetchWithConnectorTimeout('https://api.stripe.com/v1/account', {
        headers: {
          Authorization: `Bearer ${values.secret_key}`,
        },
      });
      return { valid: response.status === 200, message: errorMessage };
    }

    if (provider === 'openai') {
      const response = await fetchWithConnectorTimeout('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${values.api_key}`,
        },
      });
      return { valid: response.status === 200, message: errorMessage };
    }

    if (provider === 'resend') {
      const response = await fetchWithConnectorTimeout('https://api.resend.com/domains', {
        headers: {
          Authorization: `Bearer ${values.api_key}`,
        },
      });
      return { valid: response.status === 200, message: errorMessage };
    }

    if (provider === 'twilio') {
      const credentials = Buffer.from(`${values.account_sid}:${values.auth_token}`).toString('base64');
      const response = await fetchWithConnectorTimeout(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(values.account_sid)}.json`,
        {
          headers: {
            Authorization: `Basic ${credentials}`,
          },
        }
      );
      return { valid: response.status === 200, message: errorMessage };
    }

    if (provider === 'google_maps') {
      return { valid: await validateGoogleMapsCredentials(values), message: errorMessage };
    }

    if (provider === 'shopify') {
      const storeUrl = normalizeShopifyStoreUrl(values.store_url);
      const response = await fetchWithConnectorTimeout(`https://${storeUrl}/admin/api/2024-10/shop.json`, {
        headers: {
          'X-Shopify-Access-Token': values.access_token,
        },
      });
      return { valid: response.status === 200, message: errorMessage };
    }

    if (provider === 'supabase') {
      return { valid: await validateSupabaseCredentials(values), message: errorMessage };
    }

    if (provider === 'cloudinary') {
      return { valid: await validateCloudinaryCredentials(values), message: errorMessage };
    }
  } catch (error) {
    return { valid: false, message: errorMessage };
  }

  return { valid: false, message: errorMessage };
}

function encryptConnectorValues(connector, values, key) {
  const encryptedValues = {};
  const fields = Array.isArray(connector.fields) ? connector.fields : [];

  fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) {
      return;
    }

    const value = values[field.name];

    if (value === undefined || value === null || String(value).trim() === '') {
      return;
    }

    encryptedValues[field.name] = encryptConnectorValue(value, key);
  });

  return encryptedValues;
}

function connectorSecretToConfiguredFields(secret) {
  if (!secret) {
    return [];
  }

  if (Array.isArray(secret.fieldsMeta) && secret.fieldsMeta.length > 0) {
    return secret.fieldsMeta.map((field) => ({
      name: field.name,
      label: field.label || field.name,
      type: field.type || '',
      required: field.required === true,
      configured: field.configured !== false,
    }));
  }

  if (!secret.encryptedValues) {
    return [];
  }

  if (typeof secret.encryptedValues.keys === 'function') {
    return Array.from(secret.encryptedValues.keys()).map((name) => ({
      name,
      label: name,
      type: '',
      required: false,
      configured: true,
    }));
  }

  return Object.keys(secret.encryptedValues).map((name) => ({
    name,
    label: name,
    type: '',
    required: false,
    configured: true,
  }));
}

function buildSafeConnectorPayload(projectConnector, connector, secret) {
  const updatedAt = projectConnector?.updatedAt || secret?.lastUpdatedAt || secret?.updatedAt || null;
  const projectStatus = CONNECTOR_STATUSES.includes(projectConnector?.status)
    ? projectConnector.status
    : '';
  const status = projectStatus === 'error'
    ? 'error'
    : secret
      ? 'connected'
      : projectStatus || 'pending';

  return {
    provider: connector?.provider || projectConnector?.provider || secret?.provider || '',
    label: connector?.label || projectConnector?.label || projectConnector?.provider || secret?.provider || '',
    status,
    statusLabel: CONNECTOR_STATUS_LABELS[status] || CONNECTOR_STATUS_LABELS.pending,
    statusTone: CONNECTOR_STATUS_TONES[status] || CONNECTOR_STATUS_TONES.pending,
    connectedAt: secret?.createdAt || (status === 'connected' ? updatedAt : null),
    updatedAt,
    fieldsConfigured: connectorSecretToConfiguredFields(secret),
  };
}

function markRequiredConnectorError(project, connector, now) {
  const provider = connector.provider;
  const existingConnector = project.requiredConnectors.find(
    (item) => normalizeConnectorProvider(item.provider) === provider
  );

  if (existingConnector) {
    existingConnector.label = existingConnector.label || connector.label || provider;
    existingConnector.status = 'error';
    existingConnector.updatedAt = now;
    return;
  }

  project.requiredConnectors.push({
    provider,
    label: connector.label || provider,
    reason: connector.description || '',
    status: 'error',
    createdAt: now,
    updatedAt: now,
  });
}

function markRequiredConnectorConnected(project, connector, now) {
  const provider = connector.provider;
  const existingConnector = project.requiredConnectors.find(
    (item) => normalizeConnectorProvider(item.provider) === provider
  );

  if (existingConnector) {
    existingConnector.label = existingConnector.label || connector.label || provider;
    existingConnector.status = 'connected';
    existingConnector.updatedAt = now;
    return;
  }

  project.requiredConnectors.push({
    provider,
    label: connector.label || provider,
    reason: connector.description || '',
    status: 'connected',
    createdAt: now,
    updatedAt: now,
  });
}

function markRequiredConnectorPending(project, connector, now) {
  const provider = connector.provider;
  const existingConnector = project.requiredConnectors.find(
    (item) => normalizeConnectorProvider(item.provider) === provider
  );

  if (existingConnector) {
    existingConnector.label = existingConnector.label || connector.label || provider;
    existingConnector.status = 'pending';
    existingConnector.updatedAt = now;
    return;
  }

  project.requiredConnectors.push({
    provider,
    label: connector.label || provider,
    reason: connector.description || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
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
    status: CONNECTOR_STATUSES.includes(connector.status)
      ? connector.status
      : 'pending',
  };
}

function detectInitialRequiredConnectors({ name, description, prompt, requiredConnectors }) {
  const detectedConnectors = [];
  const seenProviders = new Set();
  const detectionText = normalizeConnectorText([name, description, prompt].filter(Boolean).join('\n'));

  CONNECTOR_RULES.forEach((rule) => {
    if (!detectionText || !rule.patterns.some((pattern) => pattern.test(detectionText))) {
      return;
    }

    seenProviders.add(rule.provider);
    detectedConnectors.push({
      provider: rule.provider,
      label: rule.label,
      reason: rule.reason,
      status: 'pending',
    });
  });

  (Array.isArray(requiredConnectors) ? requiredConnectors : []).forEach((connector) => {
    const sanitized = sanitizeRequiredConnector(connector);

    if (!sanitized || seenProviders.has(sanitized.provider)) {
      return;
    }

    seenProviders.add(sanitized.provider);
    detectedConnectors.push(sanitized);
  });

  return detectedConnectors;
}

function isBuildNowMode(value) {
  return String(value || '').trim().toLowerCase() === BUILD_NOW_MODE;
}

function normalizeWizardStatus(value) {
  const normalizedStatus = String(value || '').trim().toLowerCase();
  return WIZARD_STATUSES.includes(normalizedStatus) ? normalizedStatus : null;
}

function getBackendBaseUrl(req) {
  const configuredBaseUrl =
    process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    '';

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function toAbsoluteBackendUrl(req, value) {
  if (typeof value !== 'string' || !value) {
    return value || '';
  }

  const dedicatedPreviewUrl = toDedicatedPreviewUrl(value);
  const absoluteValue = dedicatedPreviewUrl !== value
    ? dedicatedPreviewUrl
    : value.startsWith('/builds/')
      ? new URL(value, `${getBackendBaseUrl(req)}/`).toString()
      : value;
  return addBuildPreviewToken(absoluteValue);
}

function withAbsoluteBuildUrls(req, value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const payload =
    typeof value.toObject === 'function'
      ? value.toObject({ getters: true, virtuals: true })
      : { ...value };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl', 'deployUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  return payload;
}

function withAbsoluteProjectBuildUrls(req, value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const payload =
    typeof value.toObject === 'function'
      ? value.toObject({ getters: true, virtuals: true })
      : { ...value };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  if (payload.build && typeof payload.build === 'object') {
    payload.build = withAbsoluteBuildUrls(req, payload.build);
  }

  return payload;
}

function getEffectiveBuildStatus(project) {
  return project.generationStatus || project.generation_status || project.status || 'pending';
}

function buildProjectPayload(req, projectDocument) {
  const project =
    typeof projectDocument.toObject === 'function'
      ? projectDocument.toObject({ getters: true, virtuals: true })
      : projectDocument;
  const effectiveStatus = getEffectiveBuildStatus(project);
  const fullHtml = project.fullHtml || project.latestFullHtml || '';
  const build = project.build && typeof project.build === 'object' ? project.build : {};
  const payload = {
    success: true,
    status: effectiveStatus,
    generationStatus: effectiveStatus,
    generation_status: effectiveStatus,
    project: withAbsoluteProjectBuildUrls(req, project),
  };

  if (effectiveStatus !== 'done') {
    return payload;
  }

  return {
    ...payload,
    response: project.response || '',
    summary: project.summary || '',
    html: project.html || '',
    css: project.css || '',
    js: project.js || '',
    fullHtml,
    latestFullHtml: project.latestFullHtml || fullHtml,
    distUrl: toAbsoluteBackendUrl(req, project.distUrl || build.distUrl || ''),
    previewUrl: toAbsoluteBackendUrl(req, project.previewUrl || build.previewUrl || ''),
    buildUrl: toAbsoluteBackendUrl(req, project.buildUrl || build.buildUrl || ''),
    deploy: project.deploy || {},
    reactVite: project.reactVite === true || build.reactVite === true,
    build: withAbsoluteBuildUrls(req, build),
  };
}

function buildDoneProjectBuildPayload(req, project, buildDocument) {
  const build =
    typeof buildDocument.toObject === 'function'
      ? buildDocument.toObject({ getters: true, virtuals: true })
      : buildDocument;

  return {
    success: true,
    status: 'done',
    generationStatus: 'done',
    generation_status: 'done',
    project: withAbsoluteProjectBuildUrls(req, project),
    build: withAbsoluteBuildUrls(req, build),
    html: build.html || '',
    css: build.css || '',
    js: build.js || '',
    fullHtml: build.fullHtml || '',
    latestFullHtml: build.fullHtml || '',
    distUrl: toAbsoluteBackendUrl(req, build.distUrl || ''),
    previewUrl: toAbsoluteBackendUrl(req, build.previewUrl || ''),
    buildUrl: toAbsoluteBackendUrl(req, build.buildUrl || build.deployUrl || build.previewUrl || build.distUrl || ''),
    deployUrl: toAbsoluteBackendUrl(req, build.deployUrl || ''),
    sourceZipUrl: build.sourceZipUrl || '',
    logs: build.logs || '',
    reactVite: build.type === 'react_vite',
  };
}

function getLegacyBuildJobStatus(projectBuildStatus) {
  switch (projectBuildStatus) {
    case 'failed':
      return 'failed';
    case 'in_progress':
      return 'running';
    case 'draft':
    case 'done':
      return 'succeeded';
    default:
      return 'queued';
  }
}

function buildStatusError(projectBuild, buildJob) {
  const failed = buildJob
    ? ['failed', 'timed_out', 'cancelled'].includes(buildJob.status)
    : projectBuild.status === 'failed';

  if (!failed) {
    return null;
  }

  if (buildJob) {
    return {
      code: buildJob.errorCode || null,
      message: buildJob.errorMessage || 'Build falhou.',
    };
  }

  return {
    code: null,
    message: 'Build falhou.',
  };
}

function buildProjectUpdate(body) {
  const update = {};
  const source = isPlainObject(body) ? body : {};

  if (containsUnsafeMongoKey(source, { blockProjectId: true })) {
    return null;
  }

  for (const field of PROJECT_UPDATE_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      source[field] !== undefined
    ) {
      update[field] = source[field];
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'briefing')) {
    if (!isPlainObject(source.briefing)) {
      return null;
    }
    update.briefing = collectProjectBriefing({ briefing: source.briefing });
  }

  if (Object.prototype.hasOwnProperty.call(source, 'settings')) {
    if (!isPlainObject(source.settings)) {
      return null;
    }

    for (const field of PROJECT_SETTINGS_UPDATE_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(source.settings, field) &&
        source.settings[field] !== undefined
      ) {
        update[`settings.${field}`] = source.settings[field];
      }
    }
  }

  return update;
}

function isBuildStartPayload(body = {}) {
  return isBuildNowMode(body.mode)
    || ['building', 'in_progress'].includes(String(body.status || '').trim().toLowerCase())
    || String(body.generationStatus || body.generation_status || '').trim().toLowerCase() === 'in_progress';
}

function sendIncompleteBriefing(res, briefingEvaluation) {
  return res.status(422).json({
    code: 'BRIEFING_INCOMPLETE',
    message: 'Complete o briefing mínimo antes de construir o projeto.',
    briefing: briefingEvaluation.briefing,
    briefingSummary: buildBriefingSummary(briefingEvaluation.briefing),
    briefingComplete: false,
    canBuild: false,
    missingBriefingFields: briefingEvaluation.missingFields,
    invalidBriefingFields: briefingEvaluation.invalidFields,
    questions: buildBriefingQuestions(briefingEvaluation),
  });
}

function buildPersistedBriefingPrompt(briefingEvaluation) {
  return JSON.stringify({
    briefingSummary: buildBriefingSummary(briefingEvaluation.briefing),
    structuredAnswers: briefingEvaluation.briefing,
  });
}

function getProjectCreationIdempotencyKey(req, briefingSession) {
  if (briefingSession?._id) {
    return `briefing-session:${briefingSession._id}`;
  }

  const provided = req.headers?.['idempotency-key']
    || req.headers?.['x-idempotency-key']
    || req.body?.idempotencyKey
    || req.body?.requestId;
  const normalized = String(provided || '').trim().slice(0, 180);
  return normalized ? `request:${normalized}` : '';
}

async function findIdempotentCreatedProject(req, creationIdempotencyKey) {
  if (!creationIdempotencyKey) return null;

  return Project.findOne({
    userId: req.userId,
    creationIdempotencyKey,
  });
}

function sendIdempotentCreatedProject(res, project) {
  return res.status(200).json({
    message: 'Projeto já criado para este briefing.',
    project,
    idempotent: true,
  });
}

function sendProjectUpdateError(res, error) {
  if (error?.name === 'ValidationError') {
    return res.status(400).json({ message: 'Dados inválidos para atualização do projeto.' });
  }

  if (error?.name === 'CastError') {
    return res.status(400).json({ message: 'Identificador de projeto inválido.' });
  }

  console.error('Erro ao atualizar projeto.', {
    name: error?.name || 'Error',
    path: error?.path || null,
    kind: error?.kind || null,
  });

  return res.status(500).json({
    message: 'Erro interno do servidor.',
  });
}

function validateOwnedProjectId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: 'Projeto não encontrado.' });
  }

  req.projectObjectId = new mongoose.Types.ObjectId(req.params.id);
  return next();
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.userId }).sort({
      createdAt: -1,
    });

    return res.json(projects.map((project) => withAbsoluteProjectBuildUrls(req, project)));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  let creationIdempotencyKey = '';

  try {
    const {
      name,
      title,
      description,
      status,
      generationStatus,
      generation_status: generationStatusSnake,
      prompt,
      type,
      settings,
      requiredConnectors,
      mode,
      briefing,
    } = req.body;

    const buildNow = isBuildNowMode(mode) || isBuildNowMode(status);
    const requestedWizardStatus = normalizeWizardStatus(
      generationStatus !== undefined
        ? generationStatus
        : generationStatusSnake !== undefined
          ? generationStatusSnake
          : status
    );
    const projectStatus = buildNow ? 'in_progress' : status;
    const projectGenerationStatus = buildNow ? 'in_progress' : requestedWizardStatus;
    const buildRequested = buildNow || requestedWizardStatus === 'in_progress' || status === 'building';
    let persistedBriefingSession = null;
    let effectivePrompt = prompt;
    let effectiveDescription = description;
    let effectiveType = type;
    let persistedBriefingEvaluation = null;

    if (buildRequested && (req.session || getRequestedBriefingSessionId(req.body))) {
      persistedBriefingSession = await findBriefingSession(req, { includeCompleted: true });

      if (!persistedBriefingSession) {
        return sendBriefingSessionExpired(res);
      }

      creationIdempotencyKey = getProjectCreationIdempotencyKey(req, persistedBriefingSession);
      const alreadyCreated = persistedBriefingSession.projectId
        ? await Project.findOne({
            _id: persistedBriefingSession.projectId,
            userId: req.userId,
          })
        : await findIdempotentCreatedProject(req, creationIdempotencyKey);

      if (alreadyCreated) {
        return sendIdempotentCreatedProject(res, alreadyCreated);
      }

      if (isBriefingSessionExpired(persistedBriefingSession)) {
        return sendBriefingSessionExpired(res);
      }

      persistedBriefingEvaluation = evaluateProjectBriefing({
        briefing: persistedBriefingSession.briefing || {},
        answers: persistedBriefingSession.structuredAnswers || {},
      });
      const sessionIsConsistent = Boolean(persistedBriefingSession.complete) === persistedBriefingEvaluation.complete
        && Boolean(persistedBriefingSession.canBuild) === persistedBriefingEvaluation.complete;

      if (!sessionIsConsistent) {
        return sendBriefingSessionExpired(res);
      }

      if (!persistedBriefingEvaluation.complete) {
        return sendIncompleteBriefing(res, persistedBriefingEvaluation);
      }

      effectivePrompt = buildPersistedBriefingPrompt(persistedBriefingEvaluation);
      effectiveDescription = effectivePrompt;
      effectiveType = persistedBriefingEvaluation.briefing.type || type;
    } else {
      creationIdempotencyKey = getProjectCreationIdempotencyKey(req, null);
      const alreadyCreated = await findIdempotentCreatedProject(req, creationIdempotencyKey);
      if (alreadyCreated) return sendIdempotentCreatedProject(res, alreadyCreated);
    }

    if (!name) {
      return res.status(400).json({ message: 'Nome do projeto é obrigatório.' });
    }

    const briefingEvaluation = persistedBriefingSession
      ? persistedBriefingEvaluation
      : evaluateProjectBriefing({
          ...req.body,
          briefing,
          prompt,
          description,
          type,
        });

    if (buildRequested && !briefingEvaluation.complete) {
      return persistedBriefingSession
        ? sendBriefingSessionExpired(res)
        : sendIncompleteBriefing(res, briefingEvaluation);
    }

    const titlePrompt = [effectivePrompt, effectiveDescription, title, name].filter(Boolean).join(' ');
    const explicitProjectName = extractExplicitProjectName(titlePrompt);
    const projectTitle = await getUniqueProjectTitleForUser(req.userId, titlePrompt);
    const explicitAppName = extractExplicitAppName(titlePrompt);
    const appName = explicitAppName || normalizeAppName(projectTitle) || generateFallbackAppName({
      name: projectTitle,
      description: effectiveDescription,
      prompt: effectivePrompt,
    }, effectivePrompt);

    const project = await Project.create({
      userId: req.userId,
      name: projectTitle,
      title: projectTitle,
      description: effectiveDescription,
      status: projectStatus,
      generationStatus: projectGenerationStatus || undefined,
      generation_status: projectGenerationStatus || undefined,
      prompt: effectivePrompt,
      briefing: briefingEvaluation.briefing,
      briefingSessionId: persistedBriefingSession?._id || undefined,
      creationIdempotencyKey: creationIdempotencyKey || undefined,
      type: effectiveType,
      settings,
      appName: normalizeAppName(appName) || undefined,
      appNameSource: explicitProjectName ? 'user' : 'generated',
      appNameLocked: Boolean(explicitProjectName),
      requiredConnectors: detectInitialRequiredConnectors({
        name: projectTitle,
        description: effectiveDescription,
        prompt: effectivePrompt,
        requiredConnectors: persistedBriefingSession ? [] : requiredConnectors,
      }),
    });

    if (persistedBriefingSession) {
      await BriefingSession.findOneAndUpdate(
        {
          _id: persistedBriefingSession._id,
          userId: req.userId,
        },
        {
          $set: {
            status: 'completed',
            projectId: project._id,
            completedAt: new Date(),
          },
        }
      );
    }

    return res.status(201).json({
      message: 'Projeto criado com sucesso.',
      project,
      idempotent: false,
    });
  } catch (error) {
    if (error?.code === 11000 && creationIdempotencyKey) {
      const alreadyCreated = await findIdempotentCreatedProject(req, creationIdempotencyKey);
      if (alreadyCreated) return sendIdempotentCreatedProject(res, alreadyCreated);
    }

    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:projectId/connectors', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const project = await Project.findOne({
      _id: req.params.projectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const secrets = await ConnectorSecret.find({
      projectId: project._id,
      userId: req.userId,
    }).lean();
    const secretByProvider = new Map(
      secrets.map((secret) => [normalizeConnectorProvider(secret.provider), secret])
    );
    const connectorByProvider = new Map();

    project.requiredConnectors.forEach((projectConnector) => {
      const provider = normalizeConnectorProvider(projectConnector.provider);
      const registryConnector = getConnectorByProvider(provider);

      connectorByProvider.set(
        provider,
        buildSafeConnectorPayload(projectConnector, registryConnector, secretByProvider.get(provider))
      );
    });

    secrets.forEach((secret) => {
      const provider = normalizeConnectorProvider(secret.provider);

      if (connectorByProvider.has(provider)) {
        return;
      }

      const registryConnector = getConnectorByProvider(provider);
      connectorByProvider.set(
        provider,
        buildSafeConnectorPayload(null, registryConnector, secret)
      );
    });

    return res.json({
      success: true,
      connectors: Array.from(connectorByProvider.values()),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post(
  '/:projectId/connectors/:provider/credentials',
  authMiddleware,
  connectorCredentialIpRateLimit,
  connectorCredentialUserRateLimit,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) {
        return res.status(400).json({ message: 'ID de projeto inválido.' });
      }

    const provider = normalizeConnectorProvider(req.params.provider);
    const connector = getConnectorByProvider(provider);

    if (!connector) {
      return res.status(404).json({ message: 'Conector não encontrado no registry.' });
    }

    if (connector.authType === 'manual') {
      return res.status(400).json({ message: CONNECTOR_VALIDATION_FAILURE_MESSAGE });
    }

    const encryptionKey = getConnectorEncryptionKey();

    if (!encryptionKey) {
      return res.status(500).json({
        message: 'CONNECTOR_SECRET_KEY não configurada. Não é possível salvar credenciais com segurança.',
      });
    }

    const project = await Project.findOne({
      _id: req.params.projectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const values = req.body?.values;
    const validationError = validateConnectorValues(connector, values);

    if (validationError) {
      const now = new Date();
      markRequiredConnectorError(project, connector, now);
      await project.save();

      return res.status(400).json({
        message: CONNECTOR_ERROR_MESSAGES[provider] || validationError,
        connector: buildSafeConnectorPayload(
          project.requiredConnectors.find((item) => normalizeConnectorProvider(item.provider) === provider),
          connector,
          null
        ),
      });
    }

    const normalizedValues = normalizeConnectorValues(connector, values);

    const credentialsValidation = await validateConnectorCredentials(connector, normalizedValues);

    if (!credentialsValidation.valid) {
      const now = new Date();
      markRequiredConnectorError(project, connector, now);
      await project.save();

      return res.status(400).json({
        message: credentialsValidation.message,
        connector: buildSafeConnectorPayload(
          project.requiredConnectors.find((item) => normalizeConnectorProvider(item.provider) === provider),
          connector,
          null
        ),
      });
    }

    const now = new Date();
    const encryptedValues = encryptConnectorValues(connector, normalizedValues, encryptionKey);
    const fieldsMeta = buildConfiguredFields(connector, normalizedValues);

    const secret = await ConnectorSecret.findOneAndUpdate(
      {
        projectId: project._id,
        userId: req.userId,
        provider,
      },
      {
        projectId: project._id,
        userId: req.userId,
        provider,
        encryptedValues,
        fieldsMeta,
        lastUpdatedAt: now,
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    markRequiredConnectorConnected(project, connector, now);
    await project.save();

    return res.status(201).json({
      success: true,
      message: 'Credenciais do conector salvas com segurança.',
      connector: buildSafeConnectorPayload(
        project.requiredConnectors.find((item) => normalizeConnectorProvider(item.provider) === provider),
        connector,
        secret
      ),
    });
    } catch (error) {
      return res.status(500).json({
        message: 'Erro interno do servidor.',
      });
    }
  }
);

router.delete('/:projectId/connectors/:provider', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const provider = normalizeConnectorProvider(req.params.provider);
    const connector = getConnectorByProvider(provider);

    if (!connector) {
      return res.status(404).json({ message: 'Conector não encontrado no registry.' });
    }

    const project = await Project.findOne({
      _id: req.params.projectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const secret = await ConnectorSecret.findOneAndDelete({
      projectId: project._id,
      userId: req.userId,
      provider,
    });

    if (!secret) {
      return res.status(404).json({ message: 'Credenciais do conector não encontradas.' });
    }

    markRequiredConnectorPending(project, connector, new Date());
    await project.save();

    return res.json({
      success: true,
      provider,
      status: 'pending',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:id/build', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const projectObjectId = new mongoose.Types.ObjectId(req.params.id);
    const project = await Project.findOne({
      _id: projectObjectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const latestDoneBuild = await ProjectBuild.findOne({
      projectId: project._id,
      status: 'done',
    }).sort({
      createdAt: -1,
      updatedAt: -1,
    });

    if (latestDoneBuild) {
      return res.json(buildDoneProjectBuildPayload(req, project, latestDoneBuild));
    }

    return res.json(buildProjectPayload(req, project));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:projectId/builds/:buildId/status', authMiddleware, async (req, res) => {
  try {
    const { projectId, buildId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(projectId) || !mongoose.Types.ObjectId.isValid(buildId)) {
      return res.status(400).json({ message: 'ID de projeto ou build inválido.' });
    }

    const project = await Project.findOne({
      _id: projectId,
      userId: req.userId,
    }).select('_id');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const projectBuild = await ProjectBuild.findOne({
      _id: buildId,
      projectId: project._id,
    }).select('status previewUrl buildUrl distUrl buildJobId');

    if (!projectBuild) {
      return res.status(404).json({ message: 'Build não encontrado.' });
    }

    const buildJobQuery = projectBuild.buildJobId
      ? { _id: projectBuild.buildJobId, projectBuildId: projectBuild._id }
      : { projectBuildId: projectBuild._id };
    const buildJob = await BuildJob.findOne(buildJobQuery)
      .sort({ createdAt: -1 })
      .select('status errorCode errorMessage');
    const previewUrl = toAbsoluteBackendUrl(
      req,
      projectBuild.previewUrl || projectBuild.buildUrl || projectBuild.distUrl || ''
    );
    const projectBuildStatus = projectBuild.status;
    const jobStatus = buildJob ? buildJob.status : getLegacyBuildJobStatus(projectBuildStatus);

    return res.json({
      buildId: String(projectBuild._id),
      projectBuildStatus,
      jobStatus,
      previewReady: ['draft', 'done'].includes(projectBuildStatus) && Boolean(previewUrl),
      previewUrl,
      error: buildStatusError(projectBuild, buildJob),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/:projectId/builds/:buildId/security-scan', authMiddleware, async (req, res) => {
  try {
    const { projectId, buildId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(projectId) || !mongoose.Types.ObjectId.isValid(buildId)) {
      return res.status(400).json({ message: 'ID de projeto ou build inválido.' });
    }

    const project = await Project.findOne({
      _id: projectId,
      userId: req.userId,
    }).select('_id');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const projectBuild = await ProjectBuild.findOne({
      _id: buildId,
      projectId: project._id,
    }).select(
      'fullHtml html css js artifactFiles sourceFiles artifactFilesSource indexedFiles'
    );

    if (!projectBuild) {
      return res.status(404).json({ message: 'Build não encontrado.' });
    }

    return res.json(scanBuildSecurity(projectBuild));
  } catch (error) {
    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.post('/:projectId/builds/:buildId/publish', authMiddleware, async (req, res) => {
  try {
    const { projectId, buildId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(projectId) || !mongoose.Types.ObjectId.isValid(buildId)) {
      return res.status(400).json({ message: 'ID de projeto ou build inválido.' });
    }

    const user = await User.findById(req.userId).select('plan');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const project = await Project.findOne({
      _id: projectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const projectBuild = await ProjectBuild.findOne({
      _id: buildId,
      projectId: project._id,
    });

    if (!projectBuild) {
      return res.status(404).json({ message: 'Build não encontrado.' });
    }

    if (project.isPublished !== true) {
      const currentPlan = user.plan || 'free';
      const publishedLimit = getPublishedProjectLimit(currentPlan);
      const activePublishedProjectCount = await Project.countDocuments({
        userId: req.userId,
        isPublished: true,
      });

      if (activePublishedProjectCount >= publishedLimit) {
        return res.status(403).json(buildPublishedProjectLimitResponse({
          currentPlan,
          publishedLimit,
          activePublishedCount: activePublishedProjectCount,
        }));
      }
    }

    const {
      alreadyPublished,
      publishedProject,
      build,
      previewUrl,
      publicUrl,
      deployUrl,
    } = await publishProjectBuild({
      req,
      project,
      projectBuild,
      body: req.body,
    });

    return res.json({
      success: true,
      ...(alreadyPublished ? { alreadyPublished } : {}),
      project: withAbsoluteProjectBuildUrls(req, publishedProject),
      build,
      previewUrl,
      publicUrl,
      deployUrl,
    });
  } catch (error) {
    if (error.statusCode && error.payload) {
      return res.status(error.statusCode).json(error.payload);
    }

    return res.status(500).json({ message: 'Erro interno do servidor.' });
  }
});

router.get('/:id/messages', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).select('_id');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const messages = await ProjectMessage.find({
      projectId: project._id,
      role: { $in: ['user', 'assistant'] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .select('role content createdAt -_id')
      .lean();

    return res.json({
      success: true,
      messages,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:id/files', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).select('_id name title prompt status').lean();

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const fileRoot = await resolveProjectFileRoot(project._id);

    if (!fileRoot) {
      return res.status(404).json({
        success: false,
        message: 'Arquivos do projeto não encontrados.',
      });
    }

    const counters = { entries: 0 };
    let root;

    if (fileRoot.type === 'artifact' || fileRoot.type === 'sourceArtifact') {
      root = {
        path: '',
        name: project.title || project.name || project.prompt || String(project._id),
        type: 'folder',
        size: 0,
        ext: '',
        language: '',
        children: buildProjectArtifactFileTree(fileRoot.artifactFiles, counters),
      };
    } else {
      const rootPath = await resolveProjectFilePath(fileRoot.rootDir, '');

      if (!rootPath || rootPath.blocked || rootPath.missing) {
        return res.status(404).json({
          success: false,
          message: 'Arquivos do projeto não encontrados.',
        });
      }

      const stats = await fs.stat(rootPath.absolutePath);
      root = getProjectFileMetadata(rootPath.absolutePath, rootPath.absolutePath, stats);

      root.path = '';
      root.name = project.title || project.name || project.prompt || String(project._id);
      root.children = await buildProjectFileTree(rootPath.absolutePath, rootPath.absolutePath, counters);
    }

    return res.json({
      success: true,
      project: {
        id: String(project._id),
        name: project.name,
        title: project.title,
        prompt: project.prompt,
        status: project.status,
      },
      source: {
        type: fileRoot.type,
        buildKey: fileRoot.buildKey,
        buildId: fileRoot.buildId,
      },
      limits: {
        maxContentBytes: MAX_PROJECT_FILE_CONTENT_BYTES,
        maxTreeEntries: MAX_PROJECT_FILE_TREE_ENTRIES,
        treeTruncated: counters.entries >= MAX_PROJECT_FILE_TREE_ENTRIES,
      },
      root,
      files: root.children,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:id/files/content', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).select('_id name title prompt status').lean();

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const fileRoot = await resolveProjectFileRoot(project._id);

    if (!fileRoot) {
      return res.status(404).json({
        success: false,
        message: 'Arquivos do projeto não encontrados.',
      });
    }

    let metadata;
    let contentBuffer;

    if (fileRoot.type === 'artifact' || fileRoot.type === 'sourceArtifact') {
      const resolvedFile = resolveProjectArtifactFile(fileRoot, req.query.path || '');

      if (!resolvedFile) {
        return res.status(400).json({
          success: false,
          message: 'Path inválido.',
        });
      }

      if (resolvedFile.blocked) {
        return res.status(403).json({
          success: false,
          message: 'Arquivo bloqueado por política de segurança.',
        });
      }

      if (resolvedFile.missing) {
        return res.status(404).json({
          success: false,
          message: 'Arquivo não encontrado.',
        });
      }

      if (resolvedFile.contentBuffer.length > MAX_PROJECT_FILE_CONTENT_BYTES) {
        return res.status(413).json({
          success: false,
          message: 'Arquivo excede o limite de tamanho para preview.',
          maxBytes: MAX_PROJECT_FILE_CONTENT_BYTES,
          size: resolvedFile.contentBuffer.length,
        });
      }

      metadata = resolvedFile.metadata;
      contentBuffer = resolvedFile.contentBuffer;
    } else {
      const resolvedFile = await resolveProjectFilePath(fileRoot.rootDir, req.query.path || '');

      if (!resolvedFile) {
        return res.status(400).json({
          success: false,
          message: 'Path inválido.',
        });
      }

      if (resolvedFile.blocked) {
        return res.status(403).json({
          success: false,
          message: 'Arquivo bloqueado por política de segurança.',
        });
      }

      if (resolvedFile.missing) {
        return res.status(404).json({
          success: false,
          message: 'Arquivo não encontrado.',
        });
      }

      const stats = await fs.stat(resolvedFile.absolutePath);

      if (!stats.isFile()) {
        return res.status(400).json({
          success: false,
          message: 'Path informado não é um arquivo.',
        });
      }

      if (stats.size > MAX_PROJECT_FILE_CONTENT_BYTES) {
        return res.status(413).json({
          success: false,
          message: 'Arquivo excede o limite de tamanho para preview.',
          maxBytes: MAX_PROJECT_FILE_CONTENT_BYTES,
          size: stats.size,
        });
      }

      contentBuffer = await fs.readFile(resolvedFile.absolutePath);
      metadata = getProjectFileMetadata(
        resolvedFile.rootDir,
        resolvedFile.absolutePath,
        stats
      );
    }

    const isText = isLikelyTextBuffer(contentBuffer);

    return res.json({
      success: true,
      project: {
        id: String(project._id),
        name: project.name,
        title: project.title,
        prompt: project.prompt,
        status: project.status,
      },
      source: {
        type: fileRoot.type,
        buildKey: fileRoot.buildKey,
        buildId: fileRoot.buildId,
      },
      file: metadata,
      encoding: isText ? 'utf8' : 'base64',
      content: isText ? contentBuffer.toString('utf8') : contentBuffer.toString('base64'),
      maxBytes: MAX_PROJECT_FILE_CONTENT_BYTES,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/:id', authMiddleware, validateOwnedProjectId, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.projectObjectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(withAbsoluteProjectBuildUrls(req, project));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.put('/:id', authMiddleware, validateOwnedProjectId, async (req, res) => {
  try {
    const update = buildProjectUpdate(req.body);

    if (!update) {
      return res.status(400).json({ message: 'Payload de atualização contém campos inválidos.' });
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: 'Nenhum campo válido enviado para atualização.' });
    }

    if (isBuildStartPayload(req.body)) {
      const currentProject = await Project.findOne({
        _id: req.projectObjectId,
        userId: req.userId,
      })
        .select('name title description prompt type briefing settings status generationStatus generation_status')
        .lean();

      if (!currentProject) {
        return res.status(404).json({ message: 'Projeto não encontrado.' });
      }

      const briefingEvaluation = evaluateProjectBriefing({
        ...currentProject,
        ...req.body,
        briefing: {
          ...(isPlainObject(currentProject.briefing) ? currentProject.briefing : {}),
          ...(isPlainObject(req.body.briefing) ? req.body.briefing : {}),
        },
      });

      if (!briefingEvaluation.complete) {
        return sendIncompleteBriefing(res, briefingEvaluation);
      }

      update.briefing = briefingEvaluation.briefing;
    }

    const project = await Project.findOneAndUpdate(
      {
        _id: req.projectObjectId,
        userId: req.userId,
      },
      { $set: update },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto atualizado com sucesso.',
      project,
    });
  } catch (error) {
    return sendProjectUpdateError(res, error);
  }
});

router.delete('/:id', authMiddleware, validateOwnedProjectId, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.projectObjectId,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    await deleteProjectsData([project._id]);

    return res.json({
      message: 'Projeto excluído com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

module.exports = router;
module.exports.buildProjectUpdate = buildProjectUpdate;
module.exports.normalizeShopifyStoreUrl = normalizeShopifyStoreUrl;
module.exports.sendProjectUpdateError = sendProjectUpdateError;
module.exports.isBuildStartPayload = isBuildStartPayload;
