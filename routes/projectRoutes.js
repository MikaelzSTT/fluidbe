const express = require('express');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectMessage = require('../models/ProjectMessage');
const ConnectorSecret = require('../models/ConnectorSecret');
const authMiddleware = require('../middleware/authMiddleware');
const { getConnectorByProvider } = require('./connectorRegistryRoutes');
const {
  encryptConnectorValue,
  getConnectorEncryptionKey,
} = require('../utils/connectorSecrets');
const {
  MAX_PROJECT_FILE_CONTENT_BYTES,
  MAX_PROJECT_FILE_TREE_ENTRIES,
  buildProjectFileTree,
  getProjectFileMetadata,
  isLikelyTextBuffer,
  resolveProjectFilePath,
  resolveProjectFileRoot,
} = require('../utils/projectFiles');

const router = express.Router();
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
    return parsedUrl.hostname.toLowerCase();
  } catch (error) {
    return storeUrl
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
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

    if (!storeUrl.includes('.myshopify.com') && !storeUrl.startsWith('https://')) {
      return 'Shopify store_url inválida. O valor precisa conter .myshopify.com ou começar com https://.';
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

  if (!value.startsWith('/builds/')) {
    return value;
  }

  return new URL(value, `${getBackendBaseUrl(req)}/`).toString();
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

router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.userId }).sort({
      createdAt: -1,
    });

    return res.json(projects);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings, requiredConnectors } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Nome do projeto é obrigatório.' });
    }

    const project = await Project.create({
  userId: req.userId,
  name,
  description,
  status,
  prompt,
  type,
  settings,
  requiredConnectors: detectInitialRequiredConnectors({
    name,
    description,
    prompt,
    requiredConnectors,
  }),
});
    return res.status(201).json({
      message: 'Projeto criado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao criar projeto.',
      error: error.message,
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
      message: 'Erro ao buscar conectores do projeto.',
      error: error.message,
    });
  }
});

router.post('/:projectId/connectors/:provider/credentials', authMiddleware, async (req, res) => {
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
      message: 'Erro ao salvar credenciais do conector.',
      error: error.message,
    });
  }
});

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
      message: 'Erro ao remover credenciais do conector.',
      error: error.message,
    });
  }
});

router.get('/:id/build', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
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
      message: 'Erro ao buscar build do projeto.',
      error: error.message,
    });
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
      message: 'Erro ao buscar mensagens do projeto.',
      error: error.message,
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

    const rootPath = await resolveProjectFilePath(fileRoot.rootDir, '');

    if (!rootPath || rootPath.blocked || rootPath.missing) {
      return res.status(404).json({
        success: false,
        message: 'Arquivos do projeto não encontrados.',
      });
    }

    const stats = await fs.stat(rootPath.absolutePath);
    const root = getProjectFileMetadata(rootPath.absolutePath, rootPath.absolutePath, stats);
    const counters = { entries: 0 };

    root.path = '';
    root.name = project.title || project.name || project.prompt || String(project._id);
    root.children = await buildProjectFileTree(rootPath.absolutePath, rootPath.absolutePath, counters);

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
      message: 'Erro ao listar arquivos do projeto.',
      error: error.message,
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

    const contentBuffer = await fs.readFile(resolvedFile.absolutePath);
    const isText = isLikelyTextBuffer(contentBuffer);
    const metadata = getProjectFileMetadata(
      resolvedFile.rootDir,
      resolvedFile.absolutePath,
      stats
    );

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
      },
      file: metadata,
      encoding: isText ? 'utf8' : 'base64',
      content: isText ? contentBuffer.toString('utf8') : contentBuffer.toString('base64'),
      maxBytes: MAX_PROJECT_FILE_CONTENT_BYTES,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao ler arquivo do projeto.',
      error: error.message,
    });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(project);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projeto.',
      error: error.message,
    });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
      },
      {
        name,
        description,
        status,
        prompt,
        type,
        settings,
        


      },
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
    return res.status(500).json({
      message: 'Erro ao atualizar projeto.',
      error: error.message,
    });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto excluído com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao excluir projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
