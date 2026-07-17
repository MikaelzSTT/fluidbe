const express = require('express');
const fsSync = require('fs');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const AdmZip = require('adm-zip');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const { CHANGE_REQUEST_STATUSES } = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const ConnectorSecret = require('../models/ConnectorSecret');
const { createRateLimit, getAdminTokenKey, getClientIp } = require('../middleware/rateLimit');
const { addBuildPreviewToken } = require('../utils/buildPreviewAccess');
const { timingSafeEqualString } = require('../utils/timingSafe');
const { getConnectorByProvider } = require('./connectorRegistryRoutes');
const {
  collectConnectorInjectionBuildFiles,
  createTemporaryFrontendEnv,
  resolveProjectConnectorInjection,
} = require('../utils/connectorInjection');
const {
  buildProjectArtifactFileTree,
  resolveProjectArtifactFile,
  resolveProjectFileRoot: resolveSharedProjectFileRoot,
} = require('../utils/projectFiles');
const { createSourceContext } = require('../utils/sourceContext');
const {
  publishProjectBuild: publishProjectBuildShared,
  scanBuildSecurity: scanBuildSecurityShared,
  withAbsoluteBuildUrls: withAbsoluteBuildUrlsShared,
} = require('../utils/projectPublication');

const router = express.Router();
const reactViteUploadRateLimit = createRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${getClientIp(req)}:${getAdminTokenKey(req)}`,
});
const ROOT_DIR = path.resolve(__dirname, '..');
const REACT_VITE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'react-vite-builds');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const MAX_REACT_VITE_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_REACT_VITE_ZIP_ENTRIES = 5000;
const MAX_REACT_VITE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_REACT_VITE_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_REACT_VITE_COMPRESSION_RATIO = 100;
const INVALID_REACT_VITE_ZIP_MESSAGE = 'Arquivo ZIP inválido ou excede limites permitidos.';
const INVALID_REACT_VITE_ZIP_ERROR_CODE = 'INVALID_REACT_VITE_ZIP';
const MAX_MONGO_ARTIFACT_BYTES = Number(process.env.MAX_MONGO_ARTIFACT_BYTES || 8 * 1024 * 1024);
const MAX_MONGO_SOURCE_BYTES = Number(process.env.MAX_MONGO_SOURCE_BYTES || 3 * 1024 * 1024);
const MAX_PROJECT_FILE_CONTENT_BYTES = Number(process.env.MAX_PROJECT_FILE_CONTENT_BYTES || 512 * 1024);
const MAX_PROJECT_FILE_TREE_ENTRIES = Number(process.env.MAX_PROJECT_FILE_TREE_ENTRIES || 5000);
const BUILD_WORKER_ENABLED = process.env.BUILD_WORKER_ENABLED === 'true';
const BUILD_COMMAND_TIMEOUT_MS = Number(process.env.BUILD_COMMAND_TIMEOUT_MS || 5 * 60 * 1000);
const BUILD_COMMAND_KILL_GRACE_MS = Number(process.env.BUILD_COMMAND_KILL_GRACE_MS || 2000);
const BUILD_COMMAND_MAX_BUFFER = Number(process.env.BUILD_COMMAND_MAX_BUFFER || 20 * 1024 * 1024);
const MAX_DIST_FILE_BYTES = Number(process.env.MAX_REACT_VITE_DIST_FILE_BYTES || 10 * 1024 * 1024);
const MAX_DIST_TOTAL_BYTES = Number(process.env.MAX_REACT_VITE_DIST_TOTAL_BYTES || 50 * 1024 * 1024);
const MAX_DIST_FILES = Number(process.env.MAX_REACT_VITE_DIST_FILES || 1000);
const REACT_VITE_RUNTIME_PACKAGES = (process.env.REACT_VITE_RUNTIME_PACKAGES || 'react@18.3.1 react-dom@18.3.1')
  .split(/\s+/)
  .filter(Boolean);
const REACT_VITE_DEV_PACKAGES = (
  process.env.REACT_VITE_DEV_PACKAGES ||
  'vite@5.4.11 @vitejs/plugin-react@4.3.4 typescript@5.6.3 @types/react@18.3.12 @types/react-dom@18.3.1'
)
  .split(/\s+/)
  .filter(Boolean);
const SECURITY_SCAN_MAX_FINDINGS = 50;
const SECURITY_SCAN_MAX_TEXT_CHARS = 2 * 1024 * 1024;

const WIZARD_STATUSES = ['pending', 'in_progress', 'done'];
const BUILD_MODES = ['manual', 'assisted', 'automatic'];
const BUILD_FIELDS = [
  'type',
  'status',
  'html',
  'css',
  'js',
  'fullHtml',
  'distUrl',
  'previewUrl',
  'buildUrl',
  'deployUrl',
  'sourceZipUrl',
  'artifactFiles',
  'sourceFiles',
  'artifactFilesSource',
  'logs',
];
const CONNECTOR_STATUSES = ['pending', 'connected', 'skipped', 'error'];
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
const PROJECT_FILE_TREE_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'node_modules',
]);
const SOURCE_SNAPSHOT_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const SUBPROCESS_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'NODE_ENV', 'CI',
  'NPM_CONFIG_CACHE', 'npm_config_cache', 'NPM_CONFIG_PRODUCTION', 'npm_config_production',
  'NPM_CONFIG_IGNORE_SCRIPTS', 'npm_config_ignore_scripts',
]);
const SENSITIVE_ENV_NAME_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|KEY|CREDENTIAL|MONGODB|MONGO|DATABASE_URL|DB_URL|OPENAI|STRIPE|JWT|CONNECTOR|RESEND|TWILIO|SHOPIFY|AUTH)/i;
const TOKEN_REDACTION_PATTERNS = Object.freeze([
  /\bsk_(?:test|live)_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bre_[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bmongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]);
const INTERNAL_BUILD_PATH_PATTERN = /(?:\/opt\/render|\/tmp)(?:\/[^\s'"`:,)\]}]*)*/g;
const BUILD_ENV_LOG_KEY_PATTERN = /\b(?:PATH|HOME|PWD|INIT_CWD|npm_package_json|npm_config_local_prefix|npm_config_userconfig)\b/i;
const ENV_DUMP_LINE_KEY_PATTERN = /\b(?:PATH|HOME|PWD|INIT_CWD|npm_package_json|npm_config_[A-Za-z0-9_]+)\b\s*(?::|=)/i;
const ENV_DUMP_KEY_PATTERN = /\b(?:PATH|HOME|PWD|INIT_CWD|npm_package_json|npm_config_[A-Za-z0-9_]+)\b\s*(?::|=)/gi;
const ENV_DUMP_REDACTION_MARKER = '[env dump redacted]';
const PROJECT_FILE_LANGUAGE_BY_EXT = {
  '.css': 'css',
  '.csv': 'csv',
  '.html': 'html',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.scss': 'scss',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.txt': 'text',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
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

  const absoluteValue = value.startsWith('/builds/')
    ? new URL(value, `${getBackendBaseUrl(req)}/`).toString()
    : value;
  return addBuildPreviewToken(absoluteValue);
}

function withAbsoluteBuildUrls(req, document) {
  if (!document || typeof document !== 'object') {
    return document;
  }

  const payload =
    typeof document.toObject === 'function'
      ? document.toObject({ getters: true, virtuals: true })
      : { ...document };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl', 'deployUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  return payload;
}

function withAbsoluteProjectBuildUrls(req, document) {
  if (!document || typeof document !== 'object') {
    return document;
  }

  const payload =
    typeof document.toObject === 'function'
      ? document.toObject({ getters: true, virtuals: true })
      : { ...document };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl', 'deployUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  if (payload.build && typeof payload.build === 'object') {
    payload.build = withAbsoluteBuildUrls(req, payload.build);
  }

  return payload;
}

function applyWizardStatus(update, value) {
  update.generationStatus = value;
  update.generation_status = value;
  update.status = value;
}

function mergeDeployUpdate(update, deployFields) {
  if (update.deploy && typeof update.deploy === 'object' && !Array.isArray(update.deploy)) {
    update.deploy = {
      ...update.deploy,
      ...deployFields,
    };
    return;
  }

  Object.entries(deployFields).forEach(([field, value]) => {
    update[`deploy.${field}`] = value;
  });
}

function applyLoadingStatus(update) {
  applyWizardStatus(update, 'in_progress');
  update.publish = false;
  update.isPublished = false;
  mergeDeployUpdate(update, { isPublished: false });
}

function sanitizeOptionalText(value, maxLength = null) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = String(value || '').trim();
  return maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function buildPublishMetadataUpdate(body) {
  const update = {};

  if (Object.prototype.hasOwnProperty.call(body || {}, 'visibility')) {
    const visibility = String(body.visibility || '').trim();

    if (visibility !== 'public') {
      const error = new Error('Visibility inválida.');
      error.statusCode = 400;
      error.payload = {
        message: 'Visibility inválida.',
        allowedVisibility: ['public'],
      };
      throw error;
    }

    update.visibility = 'public';
  }

  if (body && typeof body.seo === 'object' && !Array.isArray(body.seo)) {
    const seoFields = {
      title: sanitizeOptionalText(body.seo.title, 60),
      description: sanitizeOptionalText(body.seo.description, 160),
      socialImage: sanitizeOptionalText(body.seo.socialImage),
    };

    Object.entries(seoFields).forEach(([field, value]) => {
      if (value !== undefined) {
        update[`seo.${field}`] = value;
      }
    });
  }

  return update;
}

function applyPublishedBuildFields(build, update) {
  const publishedBuild =
    typeof build.toObject === 'function'
      ? build.toObject({ getters: true, virtuals: true })
      : build;

  update.reactVite = build.type === 'react_vite';
  update.build = publishedBuild;
  update.latestPublishedBuildId = build._id;
  update.distUrl = build.distUrl || '';
  update.previewUrl = build.previewUrl || '';
  update.buildUrl = build.buildUrl || build.deployUrl || build.previewUrl || build.distUrl || '';
  update.deployUrl = build.deployUrl || build.buildUrl || build.previewUrl || build.distUrl || '';

  if (build.fullHtml) {
    update.fullHtml = build.fullHtml;
    update.latestFullHtml = build.fullHtml;
  }
}

function removePublicPublishFields(update) {
  delete update.isPublished;
  delete update.publishedAt;
  delete update.publish;
  delete update['deploy.isPublished'];
  delete update['deploy.url'];
  delete update['deploy.publishedAt'];

  if (update.deploy && typeof update.deploy === 'object' && !Array.isArray(update.deploy)) {
    delete update.deploy.isPublished;
    delete update.deploy.url;
    delete update.deploy.publishedAt;

    if (Object.keys(update.deploy).length === 0) {
      delete update.deploy;
    }
  }
}

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || !timingSafeEqualString(req.headers['x-admin-token'], adminToken)) {
    return res.status(401).json({ message: 'Admin não autorizado' });
  }

  return next();
}

function normalizeConnectorProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
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

function validateProjectId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'ID de projeto inválido.' });
  }

  return next();
}

function validateObjectIdParam(paramName, message) {
  return function validateObjectId(req, res, next) {
    if (!mongoose.Types.ObjectId.isValid(req.params[paramName])) {
      return res.status(400).json({ message });
    }

    return next();
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

function getSecurityScanLine(content, index) {
  return String(content || '').slice(0, index).split('\n').length;
}

function redactSecurityPreview(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();

  if (!compact) {
    return '';
  }

  if (compact.length <= 12) {
    return '[REDACTED]';
  }

  return `${compact.slice(0, 8)}...${compact.slice(-4)}`;
}

function decodeBuildFileContent(file) {
  if (!file || typeof file.content !== 'string') {
    return '';
  }

  if (file.encoding === 'base64') {
    try {
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
      return '';
    }
  }

  return file.content;
}

function collectSecurityScanInputs(projectBuild) {
  const inputs = [];
  const addInput = (file, content) => {
    if (content === undefined || content === null) {
      return;
    }

    const text = String(content);

    if (!text) {
      return;
    }

    inputs.push({
      file: file || 'unknown',
      content: text.slice(0, SECURITY_SCAN_MAX_TEXT_CHARS),
    });
  };
  const addFileInputs = (files, sourceLabel) => {
    (Array.isArray(files) ? files : []).forEach((file, index) => {
      const filePath = file.relativePath || file.path || `${sourceLabel}[${index}]`;
      addInput(filePath, decodeBuildFileContent(file));
    });
  };

  addInput('fullHtml', projectBuild.fullHtml);
  addInput('html', projectBuild.html);
  addInput('css', projectBuild.css);
  addInput('js', projectBuild.js);
  addFileInputs(projectBuild.artifactFiles, 'artifactFiles');
  addFileInputs(projectBuild.sourceFiles, 'sourceFiles');
  addFileInputs(projectBuild.artifactFilesSource, 'artifactFilesSource');

  (Array.isArray(projectBuild.indexedFiles) ? projectBuild.indexedFiles : []).forEach((file, index) => {
    addInput(file.path || `indexedFiles[${index}]`, file.content || file.excerpt);
  });

  return inputs;
}

function addSecurityFinding(findings, finding) {
  if (findings.length >= SECURITY_SCAN_MAX_FINDINGS) {
    return;
  }

  findings.push(finding);
}

function scanSecurityPattern({ findings, input, pattern, severity, type, message }) {
  let match;

  pattern.lastIndex = 0;

  while ((match = pattern.exec(input.content)) && findings.length < SECURITY_SCAN_MAX_FINDINGS) {
    addSecurityFinding(findings, {
      severity,
      type,
      message,
      file: input.file || 'unknown',
      line: getSecurityScanLine(input.content, match.index),
      preview: redactSecurityPreview(match[0]),
    });

    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
}

function looksLikeEnvFileContent(content) {
  const envLikeLines = String(content || '')
    .split('\n')
    .filter((line) => /^\s*[A-Z][A-Z0-9_]{2,}\s*=/.test(line));
  const sensitiveEnvLines = envLikeLines.filter((line) => (
    /(?:SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|MONGODB_URI|STRIPE|SUPABASE|OPENAI|AWS)/.test(line)
  ));

  return sensitiveEnvLines.length >= 1 && envLikeLines.length >= 2;
}

function scanBuildSecurity(projectBuild) {
  const findings = [];
  const criticalPatterns = [
    { type: 'private_key', message: 'Private key marker found.', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
    { type: 'secret', message: 'OpenAI-style secret key found.', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g },
    { type: 'connection_string', message: 'MongoDB connection string found.', pattern: /mongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi },
    { type: 'token', message: 'Long token-like secret found near a sensitive label.', pattern: /\b(?:token|secret|api[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{32,})["']?/gi },
  ];
  const warningPatterns = [
    { type: 'secret', message: 'Generic API_KEY assignment found.', pattern: /\bAPI_KEY\s*=/gi },
    { type: 'secret', message: 'SECRET assignment found.', pattern: /\bSECRET\s*=/gi },
    { type: 'token', message: 'TOKEN assignment found.', pattern: /\bTOKEN\s*=/gi },
    { type: 'secret', message: 'PASSWORD assignment found.', pattern: /\bPASSWORD\s*=/gi },
    { type: 'secret', message: 'Supabase service role reference found.', pattern: /\bSUPABASE_SERVICE_ROLE\b/gi },
    { type: 'secret', message: 'Stripe secret key reference found.', pattern: /\bSTRIPE_SECRET_KEY\b/gi },
    { type: 'token', message: 'GitHub token reference found.', pattern: /\bGITHUB_TOKEN\b/gi },
    { type: 'secret', message: 'Google client secret reference found.', pattern: /\bGOOGLE_CLIENT_SECRET\b/gi },
    { type: 'secret', message: 'AWS access key reference found.', pattern: /\bAWS_ACCESS_KEY_ID\b/gi },
    { type: 'secret', message: 'AWS secret access key reference found.', pattern: /\bAWS_SECRET_ACCESS_KEY\b/gi },
  ];

  for (const input of collectSecurityScanInputs(projectBuild)) {
    const basename = path.posix.basename(String(input.file || '').replace(/\\/g, '/')).toLowerCase();

    if (basename === '.env' || basename.startsWith('.env.') || looksLikeEnvFileContent(input.content)) {
      addSecurityFinding(findings, {
        severity: 'critical',
        type: 'env_file',
        message: 'Environment file content included in build content.',
        file: input.file || 'unknown',
        line: null,
        preview: redactSecurityPreview(input.file),
      });
    }

    for (const scan of criticalPatterns) {
      scanSecurityPattern({
        findings,
        input,
        severity: 'critical',
        type: scan.type,
        message: scan.message,
        pattern: scan.pattern,
      });
    }

    for (const scan of warningPatterns) {
      scanSecurityPattern({
        findings,
        input,
        severity: 'warning',
        type: scan.type,
        message: scan.message,
        pattern: scan.pattern,
      });
    }

    if (findings.length >= SECURITY_SCAN_MAX_FINDINGS) {
      break;
    }
  }

  const hasCritical = findings.some((finding) => finding.severity === 'critical');
  const hasWarning = findings.some((finding) => finding.severity === 'warning');
  const status = hasCritical ? 'blocked' : hasWarning ? 'warning' : 'passed';
  const score = status === 'blocked' ? 0 : status === 'warning' ? 70 : 100;
  const summary = status === 'blocked'
    ? 'Critical security findings were detected. Review before publishing.'
    : status === 'warning'
      ? 'Potential sensitive references were detected. Review before publishing.'
      : 'No obvious sensitive build content was detected.';

  return {
    status,
    score,
    summary,
    findings,
  };
}

function resolvePublicBuildIndexPath(buildUrl) {
  if (typeof buildUrl !== 'string') {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(new URL(buildUrl, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const relativeBuildPath = pathname.slice('/builds/'.length);
  const requestedPath = path.basename(relativeBuildPath) === 'index.html'
    ? relativeBuildPath
    : path.join(relativeBuildPath, 'index.html');
  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);
  const indexPath = path.resolve(buildsRoot, requestedPath);

  if (indexPath !== buildsRoot && !indexPath.startsWith(`${buildsRoot}${path.sep}`)) {
    return null;
  }

  return indexPath;
}

function parsePublicBuildUrl(buildUrl) {
  if (typeof buildUrl !== 'string') {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(new URL(buildUrl, 'http://localhost').pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const parts = pathname.slice('/builds/'.length).split('/').filter(Boolean);

  if (parts.length < 2 || !mongoose.Types.ObjectId.isValid(parts[0])) {
    return null;
  }

  const projectId = parts[0];
  const buildKey = parts[1];

  return {
    projectId,
    buildKey,
    indexBuildUrl: `/builds/${projectId}/${buildKey}/index.html`,
  };
}

async function hasMongoBuildFallback(buildUrl) {
  const parsedUrl = parsePublicBuildUrl(buildUrl);

  if (!parsedUrl) {
    return false;
  }

  const escapedIndexBuildUrl = parsedUrl.indexBuildUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absoluteIndexBuildUrlPattern = new RegExp(`${escapedIndexBuildUrl}$`);
  const build = await ProjectBuild.findOne({
    projectId: parsedUrl.projectId,
    $or: [
      { distUrl: parsedUrl.indexBuildUrl },
      { previewUrl: parsedUrl.indexBuildUrl },
      { buildUrl: parsedUrl.indexBuildUrl },
      { deployUrl: parsedUrl.indexBuildUrl },
      { distUrl: absoluteIndexBuildUrlPattern },
      { previewUrl: absoluteIndexBuildUrlPattern },
      { buildUrl: absoluteIndexBuildUrlPattern },
      { deployUrl: absoluteIndexBuildUrlPattern },
    ],
  }).select('fullHtml html artifactFiles.path artifactFiles.relativePath');

  return Boolean(
    build &&
      (
        build.fullHtml ||
        build.html ||
        (Array.isArray(build.artifactFiles) &&
          build.artifactFiles.some((file) => (file.relativePath || file.path) === 'index.html'))
      )
  );
}

function getCanonicalBuildPreviewUrl(projectId, projectBuild) {
  const buildUrls = [
    projectBuild.previewUrl,
    projectBuild.buildUrl,
    projectBuild.deployUrl,
    projectBuild.distUrl,
  ];

  for (const buildUrl of buildUrls) {
    const parsedUrl = parsePublicBuildUrl(buildUrl);

    if (parsedUrl && parsedUrl.projectId === String(projectId)) {
      return parsedUrl.indexBuildUrl;
    }
  }

  return '';
}

async function getServableBuildPreviewUrl(req, projectId, projectBuild) {
  const indexBuildUrl = getCanonicalBuildPreviewUrl(projectId, projectBuild);

  if (!indexBuildUrl) {
    return '';
  }

  const indexPath = resolvePublicBuildIndexPath(indexBuildUrl);

  if (indexPath) {
    try {
      const indexStats = await fs.stat(indexPath);

      if (indexStats.isFile()) {
        return toAbsoluteBackendUrl(req, indexBuildUrl);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (await hasMongoBuildFallback(indexBuildUrl)) {
    return toAbsoluteBackendUrl(req, indexBuildUrl);
  }

  return '';
}

async function collectBuildArtifactFiles(distDir) {
  const distRoot = path.resolve(distDir);
  const candidates = [];
  const files = [];
  let totalBytes = 0;

  async function discover(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await discover(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const absolutePath = path.resolve(entryPath);
      if (absolutePath !== distRoot && !absolutePath.startsWith(`${distRoot}${path.sep}`)) {
        continue;
      }

      const stats = await fs.stat(absolutePath);
      const relativePath = path.relative(distRoot, absolutePath).split(path.sep).join('/');
      candidates.push({
        absolutePath,
        relativePath,
        size: stats.size,
      });
    }
  }

  await discover(distRoot);

  const priorityFor = (relativePath) => {
    const ext = path.extname(relativePath).toLowerCase();

    if (relativePath === 'index.html') {
      return 0;
    }

    if (['.css', '.js', '.mjs'].includes(ext)) {
      return 1;
    }

    if (['.json', '.svg', '.woff', '.woff2', '.ttf'].includes(ext)) {
      return 2;
    }

    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) {
      return 3;
    }

    return 4;
  };

  candidates.sort((a, b) => {
    const priorityDifference = priorityFor(a.relativePath) - priorityFor(b.relativePath);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return a.relativePath.localeCompare(b.relativePath);
  });

  for (const candidate of candidates) {
    if (totalBytes + candidate.size > MAX_MONGO_ARTIFACT_BYTES) {
      continue;
    }

    const content = await fs.readFile(candidate.absolutePath);
    const mimeType = getContentType(candidate.relativePath);
    totalBytes += candidate.size;
    files.push({
      relativePath: candidate.relativePath,
      path: candidate.relativePath,
      mimeType,
      contentType: mimeType,
      encoding: 'base64',
      content: content.toString('base64'),
    });
  }

  return {
    files,
    complete: files.length === candidates.length,
    totalBytes,
    skippedFiles: Math.max(candidates.length - files.length, 0),
  };
}

async function validateDistDirectory(distDir, options = {}) {
  const distRoot = path.resolve(distDir);
  const maxFileBytes = Number(options.maxFileBytes || MAX_DIST_FILE_BYTES);
  const maxTotalBytes = Number(options.maxTotalBytes || MAX_DIST_TOTAL_BYTES);
  const maxFiles = Number(options.maxFiles || MAX_DIST_FILES);
  const files = [];
  let totalBytes = 0;

  const indexPath = path.join(distRoot, 'index.html');
  let indexStats;

  try {
    indexStats = await fs.lstat(indexPath);
  } catch (error) {
    throw new Error('Build inválido: dist/index.html é obrigatório.');
  }

  if (!indexStats.isFile() || indexStats.nlink > 1) {
    throw new Error('Build inválido: dist/index.html precisa ser um arquivo regular.');
  }

  async function discover(currentDir) {
    const resolvedCurrentDir = path.resolve(currentDir);

    if (resolvedCurrentDir !== distRoot && !resolvedCurrentDir.startsWith(`${distRoot}${path.sep}`)) {
      throw new Error('Build inválido: caminho fora de dist.');
    }

    const entries = await fs.readdir(resolvedCurrentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.resolve(resolvedCurrentDir, entry.name);

      if (absolutePath !== distRoot && !absolutePath.startsWith(`${distRoot}${path.sep}`)) {
        throw new Error('Build inválido: caminho fora de dist.');
      }

      const stats = await fs.lstat(absolutePath);

      if (stats.isSymbolicLink() || stats.isSocket() || stats.isFIFO() || stats.isBlockDevice() || stats.isCharacterDevice()) {
        throw new Error('Build inválido: dist contém symlink, socket, FIFO ou device.');
      }

      if (stats.isDirectory()) {
        await discover(absolutePath);
        continue;
      }

      if (!stats.isFile()) {
        throw new Error('Build inválido: dist contém entrada não regular.');
      }

      if (stats.nlink > 1) {
        throw new Error('Build inválido: dist contém hardlink.');
      }

      if (stats.size > maxFileBytes) {
        throw new Error(`Build inválido: arquivo excede ${maxFileBytes} bytes.`);
      }

      if (files.length + 1 > maxFiles) {
        throw new Error(`Build inválido: dist excede ${maxFiles} arquivos.`);
      }

      if (totalBytes + stats.size > maxTotalBytes) {
        throw new Error(`Build inválido: dist excede ${maxTotalBytes} bytes.`);
      }

      totalBytes += stats.size;
      files.push({
        absolutePath,
        relativePath: path.relative(distRoot, absolutePath).split(path.sep).join('/'),
        size: stats.size,
      });
    }
  }

  await discover(distRoot);

  return {
    distRoot,
    files,
    totalBytes,
  };
}

async function copyValidatedDistFiles(validation, stagingDir) {
  const stagingRoot = path.resolve(stagingDir);

  await fs.mkdir(stagingRoot, { recursive: true });

  for (const file of validation.files) {
    const destinationPath = path.resolve(stagingRoot, file.relativePath);

    if (destinationPath === stagingRoot || !destinationPath.startsWith(`${stagingRoot}${path.sep}`)) {
      throw new Error('Build inválido: caminho de publicação fora do staging.');
    }

    const sourceStats = await fs.lstat(file.absolutePath);

    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.nlink > 1) {
      throw new Error('Build inválido: arquivo dist mudou antes da publicação.');
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    const flags = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
    const source = await fs.open(file.absolutePath, flags);
    try {
      const currentStats = await source.stat();
      if (
        !currentStats.isFile() ||
        currentStats.nlink > 1 ||
        currentStats.size !== file.size ||
        currentStats.size > MAX_DIST_FILE_BYTES
      ) {
        throw new Error('Build inválido: arquivo dist mudou antes da publicação.');
      }
      const content = await source.readFile();
      await fs.writeFile(destinationPath, content, { mode: 0o600 });
    } finally {
      await source.close();
    }
  }
}

async function publishValidatedDist(distDir, finalDir) {
  const finalPath = path.resolve(finalDir);
  const stagingPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  const backupPath = `${finalPath}.bak-${process.pid}-${Date.now()}`;
  let backupCreated = false;

  try {
    const validation = await validateDistDirectory(distDir);
    await fs.rm(stagingPath, { recursive: true, force: true });
    await fs.rm(backupPath, { recursive: true, force: true });
    await copyValidatedDistFiles(validation, stagingPath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fs.rename(finalPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await fs.rename(stagingPath, finalPath);
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true, force: true });
      backupCreated = false;
    }
    return validation;
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await fs.rm(finalPath, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupPath, finalPath).catch(() => {});
    }
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function collectProjectSourceFiles(sourceDir) {
  const sourceRoot = path.resolve(sourceDir);
  const realSourceRoot = await fs.realpath(sourceRoot);
  const candidates = [];
  const files = [];
  let totalBytes = 0;

  async function discover(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const absolutePath = path.resolve(entryPath);

      if (absolutePath !== sourceRoot && !absolutePath.startsWith(`${sourceRoot}${path.sep}`)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        continue;
      }

      const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join('/');

      if (isProjectFileSensitive(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (SOURCE_SNAPSHOT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }

        await discover(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const realPath = await fs.realpath(absolutePath);
      if (realPath !== realSourceRoot && !realPath.startsWith(`${realSourceRoot}${path.sep}`)) {
        continue;
      }

      const stats = await fs.stat(absolutePath);
      candidates.push({
        absolutePath,
        relativePath,
        size: stats.size,
      });
    }
  }

  await discover(sourceRoot);

  const priorityFor = (relativePath) => {
    const basename = path.posix.basename(relativePath).toLowerCase();
    const topLevel = relativePath.split('/')[0];
    const ext = path.extname(relativePath).toLowerCase();

    if (relativePath === 'package.json' || basename.startsWith('vite.config')) {
      return 0;
    }

    if (basename.startsWith('tsconfig') || relativePath === 'index.html') {
      return 1;
    }

    if (topLevel === 'src' || topLevel === 'components' || topLevel === 'routes') {
      return 2;
    }

    if (['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.json', '.html', '.md'].includes(ext)) {
      return 3;
    }

    return 4;
  };

  candidates.sort((a, b) => {
    const priorityDifference = priorityFor(a.relativePath) - priorityFor(b.relativePath);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return a.relativePath.localeCompare(b.relativePath);
  });

  for (const candidate of candidates) {
    if (totalBytes + candidate.size > MAX_MONGO_SOURCE_BYTES) {
      continue;
    }

    const content = await fs.readFile(candidate.absolutePath);
    const mimeType = getContentType(candidate.relativePath);
    totalBytes += candidate.size;
    files.push({
      relativePath: candidate.relativePath,
      path: candidate.relativePath,
      mimeType,
      contentType: mimeType,
      encoding: 'base64',
      content: content.toString('base64'),
    });
  }

  return {
    files,
    complete: files.length === candidates.length,
    totalBytes,
    skippedFiles: Math.max(candidates.length - files.length, 0),
  };
}

async function loadProject(req, res, next) {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    req.project = project;
    return next();
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
}

const reactViteUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, file, callback) => {
      try {
        const timestamp = String(Date.now());
        const uploadDir = path.join(REACT_VITE_STORAGE_DIR, req.params.id, timestamp);

        req.reactViteBuildTimestamp = timestamp;
        req.reactViteBuildDir = uploadDir;

        await fs.mkdir(uploadDir, { recursive: true });
        callback(null, uploadDir);
      } catch (error) {
        callback(error);
      }
    },
    filename: (req, file, callback) => {
      callback(null, 'source.zip');
    },
  }),
  fileFilter: (req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') {
      return callback(new Error('Apenas arquivos .zip são aceitos.'));
    }

    return callback(null, true);
  },
  limits: {
    files: 1,
    fileSize: MAX_REACT_VITE_ZIP_BYTES,
  },
});

function runReactViteUpload(req, res, next) {
  reactViteUpload.single('file')(req, res, async (error) => {
    if (!error) {
      return next();
    }

    if (req.reactViteBuildDir) {
      await fs.rm(req.reactViteBuildDir, { recursive: true, force: true }).catch(() => {});
    }

    return res.status(400).json({
      message: INVALID_REACT_VITE_ZIP_MESSAGE,
    });
  });
}

function createInvalidReactViteZipError() {
  const error = new Error(INVALID_REACT_VITE_ZIP_MESSAGE);
  error.code = INVALID_REACT_VITE_ZIP_ERROR_CODE;
  return error;
}

function isZipSymlink(entry) {
  const unixFileType = ((entry.attr >>> 16) & 0o170000);
  return unixFileType === 0o120000;
}

function resolveZipEntryPath(destinationRoot, entryName) {
  const normalizedEntryName = String(entryName || '').replace(/\\/g, '/');

  if (
    !normalizedEntryName ||
    normalizedEntryName.includes('\0') ||
    normalizedEntryName.startsWith('/') ||
    /^[a-z]:\//i.test(normalizedEntryName)
  ) {
    throw createInvalidReactViteZipError();
  }

  const targetPath = path.resolve(destinationRoot, normalizedEntryName);

  if (targetPath === destinationRoot || !targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
    throw createInvalidReactViteZipError();
  }

  return targetPath;
}

async function extractZipSafely(zipPath, destinationDir) {
  const destinationRoot = path.resolve(destinationDir);
  let zip;

  try {
    zip = new AdmZip(zipPath);
  } catch (error) {
    throw createInvalidReactViteZipError();
  }

  let entries;

  try {
    entries = zip.getEntries();
  } catch (error) {
    throw createInvalidReactViteZipError();
  }

  if (!entries.length || entries.length > MAX_REACT_VITE_ZIP_ENTRIES) {
    throw createInvalidReactViteZipError();
  }

  let totalUncompressedBytes = 0;
  let fileEntries = 0;

  for (const entry of entries) {
    resolveZipEntryPath(destinationRoot, entry.entryName);

    if (isZipSymlink(entry)) {
      throw createInvalidReactViteZipError();
    }

    if (entry.isDirectory) {
      continue;
    }

    fileEntries += 1;
    const uncompressedBytes = Number(entry.header.size);
    const compressedBytes = Number(entry.header.compressedSize);

    if (
      !Number.isSafeInteger(uncompressedBytes) ||
      !Number.isSafeInteger(compressedBytes) ||
      uncompressedBytes < 0 ||
      compressedBytes < 0 ||
      uncompressedBytes > MAX_REACT_VITE_ENTRY_BYTES ||
      totalUncompressedBytes + uncompressedBytes > MAX_REACT_VITE_UNCOMPRESSED_BYTES ||
      (uncompressedBytes > 0 && uncompressedBytes / Math.max(compressedBytes, 1) > MAX_REACT_VITE_COMPRESSION_RATIO)
    ) {
      throw createInvalidReactViteZipError();
    }

    totalUncompressedBytes += uncompressedBytes;
  }

  if (!fileEntries) {
    throw createInvalidReactViteZipError();
  }

  await fs.mkdir(destinationRoot, { recursive: true });
  let extractedBytes = 0;

  for (const entry of entries) {
    const targetPath = resolveZipEntryPath(destinationRoot, entry.entryName);

    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    let data;

    try {
      data = entry.getData();
    } catch (error) {
      throw createInvalidReactViteZipError();
    }

    if (
      data.length !== Number(entry.header.size) ||
      data.length > MAX_REACT_VITE_ENTRY_BYTES ||
      extractedBytes + data.length > MAX_REACT_VITE_UNCOMPRESSED_BYTES
    ) {
      throw createInvalidReactViteZipError();
    }

    extractedBytes += data.length;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, data, { mode: 0o600 });
  }
}

async function uploadReactViteSourceZip(zipPath, projectId, originalName) {
  if (!mongoose.connection.db) {
    throw new Error('Banco de dados indisponível.');
  }

  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: 'react_vite_sources',
  });
  const uploadStream = bucket.openUploadStream(`${projectId}-${Date.now()}.zip`, {
    contentType: 'application/zip',
    metadata: {
      projectId: String(projectId),
      originalName: String(originalName || 'source.zip'),
      type: 'react_vite',
    },
  });

  try {
    await new Promise((resolve, reject) => {
      const sourceStream = fsSync.createReadStream(zipPath);
      let settled = false;

      const finish = (error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (error) {
          reject(error);
          return;
        }

        resolve();
      };

      sourceStream.on('error', finish);
      uploadStream.on('error', finish);
      uploadStream.on('finish', () => finish());
      sourceStream.pipe(uploadStream);
    });
  } catch (error) {
    await bucket.delete(uploadStream.id).catch(() => {});
    throw error;
  }

  return {
    bucket,
    fileId: uploadStream.id,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeProjectFilePath(requestPath = '') {
  const rawPath = String(requestPath || '').replace(/\\/g, '/').trim();

  if (!rawPath || rawPath === '.') {
    return '';
  }

  if (
    rawPath.includes('\0') ||
    rawPath.startsWith('/') ||
    /^[a-z]:\//i.test(rawPath)
  ) {
    return null;
  }

  const segments = rawPath.split('/').filter(Boolean);

  if (segments.some((segment) => segment === '..')) {
    return null;
  }

  const normalizedPath = path.posix.normalize(segments.join('/'));

  if (normalizedPath === '.' || normalizedPath === '/') {
    return '';
  }

  if (normalizedPath.startsWith('../') || normalizedPath.includes('/../')) {
    return null;
  }

  return normalizedPath;
}

function isProjectFileSensitive(relativePath) {
  const segments = String(relativePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const basename = segments[segments.length - 1] || '';

  if (basename === '.env.example') {
    return false;
  }

  if (basename === '.env' || basename.startsWith('.env.')) {
    return true;
  }

  if (['.pem', '.key', '.cert', '.crt', '.p12', '.pfx'].includes(path.extname(basename))) {
    return true;
  }

  return segments.some((segment) => (
    segment === 'keys' ||
    segment === 'secrets' ||
    segment.includes('secret') ||
    segment.includes('private-key') ||
    segment.includes('private_key')
  ));
}

function getProjectFileMetadata(rootDir, absolutePath, stats, dirent = null) {
  const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');
  const name = relativePath ? path.posix.basename(relativePath) : path.basename(rootDir);
  const isDirectory = dirent ? dirent.isDirectory() : stats.isDirectory();
  const ext = isDirectory ? '' : path.extname(name).toLowerCase();

  return {
    path: relativePath,
    name,
    type: isDirectory ? 'folder' : 'file',
    size: isDirectory ? 0 : stats.size,
    ext,
    language: PROJECT_FILE_LANGUAGE_BY_EXT[ext] || ext.replace(/^\./, '') || '',
  };
}

async function resolveProjectFileRoot(projectId) {
  const projectStorageDir = path.join(REACT_VITE_STORAGE_DIR, String(projectId));

  try {
    const sourceCandidates = await fs.readdir(projectStorageDir, { withFileTypes: true });
    const sourceDirs = [];

    for (const entry of sourceCandidates) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sourceDir = path.join(projectStorageDir, entry.name, 'source');

      if (!(await pathExists(sourceDir))) {
        continue;
      }

      const rootDir = await findReactViteRoot(sourceDir);
      const stats = await fs.stat(rootDir);

      if (stats.isDirectory()) {
        sourceDirs.push({
          rootDir,
          label: entry.name,
          mtimeMs: stats.mtimeMs,
        });
      }
    }

    sourceDirs.sort((a, b) => {
      const numericDifference = Number(b.label) - Number(a.label);

      if (!Number.isNaN(numericDifference) && numericDifference !== 0) {
        return numericDifference;
      }

      return b.mtimeMs - a.mtimeMs;
    });

    if (sourceDirs[0]) {
      return {
        type: 'source',
        rootDir: sourceDirs[0].rootDir,
        buildKey: sourceDirs[0].label,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const sourceArtifactRoot = await resolveSharedProjectFileRoot(projectId);

  if (sourceArtifactRoot && sourceArtifactRoot.type === 'sourceArtifact') {
    return sourceArtifactRoot;
  }

  const latestBuild = await ProjectBuild.findOne({
    projectId,
    $or: [
      { distUrl: { $regex: /\/builds\// } },
      { previewUrl: { $regex: /\/builds\// } },
      { buildUrl: { $regex: /\/builds\// } },
      { deployUrl: { $regex: /\/builds\// } },
    ],
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  }).lean();
  const buildUrls = latestBuild
    ? [latestBuild.buildUrl, latestBuild.deployUrl, latestBuild.previewUrl, latestBuild.distUrl]
    : [];

  for (const buildUrl of buildUrls) {
    const parsedUrl = parsePublicBuildUrl(buildUrl);

    if (!parsedUrl || String(parsedUrl.projectId) !== String(projectId)) {
      continue;
    }

    const rootDir = path.join(PUBLIC_BUILDS_DIR, String(projectId), parsedUrl.buildKey);

    if (await pathExists(rootDir)) {
      const stats = await fs.stat(rootDir);

      if (stats.isDirectory()) {
        return {
          type: 'build',
          rootDir,
          buildKey: parsedUrl.buildKey,
        };
      }
    }
  }

  const publicProjectDir = path.join(PUBLIC_BUILDS_DIR, String(projectId));

  try {
    const buildCandidates = await fs.readdir(publicProjectDir, { withFileTypes: true });
    const buildDirs = [];

    for (const entry of buildCandidates) {
      if (!entry.isDirectory()) {
        continue;
      }

      const rootDir = path.join(publicProjectDir, entry.name);
      const stats = await fs.stat(rootDir);

      if (stats.isDirectory()) {
        buildDirs.push({
          rootDir,
          label: entry.name,
          mtimeMs: stats.mtimeMs,
        });
      }
    }

    buildDirs.sort((a, b) => {
      const numericDifference = Number(b.label) - Number(a.label);

      if (!Number.isNaN(numericDifference) && numericDifference !== 0) {
        return numericDifference;
      }

      return b.mtimeMs - a.mtimeMs;
    });

    if (buildDirs[0]) {
      return {
        type: 'build',
        rootDir: buildDirs[0].rootDir,
        buildKey: buildDirs[0].label,
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const artifactRoot = await resolveSharedProjectFileRoot(projectId);
  return artifactRoot && artifactRoot.type === 'artifact' ? artifactRoot : null;
}

async function resolveProjectFilePath(rootDir, requestPath) {
  const relativePath = normalizeProjectFilePath(requestPath);

  if (relativePath === null) {
    return null;
  }

  if (isProjectFileSensitive(relativePath)) {
    return {
      blocked: true,
      relativePath,
    };
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }

  let realRoot;
  let realPath;

  try {
    realRoot = await fs.realpath(resolvedRoot);
    realPath = await fs.realpath(resolvedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        missing: true,
        relativePath,
        absolutePath: resolvedPath,
      };
    }

    throw error;
  }

  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    return null;
  }

  return {
    relativePath,
    rootDir: realRoot,
    absolutePath: realPath,
  };
}

async function buildProjectFileTree(rootDir, currentDir = rootDir, counters = { entries: 0 }) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const children = [];

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (counters.entries >= MAX_PROJECT_FILE_TREE_ENTRIES) {
      break;
    }

    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');

    if (
      entry.isSymbolicLink() ||
      isProjectFileSensitive(relativePath) ||
      (entry.isDirectory() && PROJECT_FILE_TREE_IGNORED_DIRS.has(entry.name))
    ) {
      continue;
    }

    const stats = await fs.stat(absolutePath);
    const item = getProjectFileMetadata(rootDir, absolutePath, stats, entry);

    counters.entries += 1;

    if (entry.isDirectory()) {
      item.children = await buildProjectFileTree(rootDir, absolutePath, counters);
    }

    children.push(item);
  }

  return children;
}

function isLikelyTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));

  return !sample.includes(0);
}

async function findReactViteRoot(extractDir) {
  if (await pathExists(path.join(extractDir, 'package.json'))) {
    return extractDir;
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());

  if (directories.length === 1) {
    const nestedRoot = path.join(extractDir, directories[0].name);

    if (await pathExists(path.join(nestedRoot, 'package.json'))) {
      return nestedRoot;
    }
  }

  for (const directory of directories) {
    const nestedRoot = path.join(extractDir, directory.name);

    if (await pathExists(path.join(nestedRoot, 'package.json'))) {
      return nestedRoot;
    }
  }

  return extractDir;
}

async function validateReactViteProject(appRoot) {
  const requiredPaths = [
    path.join(appRoot, 'package.json'),
    path.join(appRoot, 'index.html'),
    path.join(appRoot, 'src'),
  ];

  for (const requiredPath of requiredPaths) {
    if (!(await pathExists(requiredPath))) {
      throw new Error(`Estrutura React/Vite inválida. Ausente: ${path.basename(requiredPath)}`);
    }
  }

  const srcStats = await fs.stat(path.join(appRoot, 'src'));

  if (!srcStats.isDirectory()) {
    throw new Error('Estrutura React/Vite inválida. src precisa ser uma pasta.');
  }
}

async function runNpmCommand(args, cwd, options = {}) {
  const redactionValues = getCommandRedactionValues(options);
  try {
    const result = await runFileCommand('npm', args, cwd, options);
    return redactBuildLogs([result.stdout, result.stderr].filter(Boolean).join('\n'), redactionValues);
  } catch (error) {
    throw new Error(formatBuildCommandFailure('npm', args, error, redactionValues));
  }
}

async function runNpxCommand(args, cwd, options = {}) {
  const redactionValues = getCommandRedactionValues(options);
  const message = 'npx remoto está desabilitado para builds React/Vite; use binários locais em node_modules/.bin.';
  if (options.throwDisabledError !== false) {
    throw new Error(redactBuildLogs(`[command disabled: npx ${args.join(' ')}] ${message}`, redactionValues));
  }
}

async function runLocalBinCommand(binName, args, cwd, options = {}) {
  const redactionValues = getCommandRedactionValues(options);
  const binPath = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? `${binName}.cmd` : binName);
  const resolvedBinPath = path.resolve(binPath);
  const resolvedNodeModulesBin = path.resolve(cwd, 'node_modules', '.bin');

  if (resolvedBinPath !== resolvedNodeModulesBin && !resolvedBinPath.startsWith(`${resolvedNodeModulesBin}${path.sep}`)) {
    throw new Error(`Binário local inválido: ${binName}`);
  }

  try {
    const stats = await fs.lstat(resolvedBinPath);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error(`Binário local não executável: ${binName}`);
    }
    const realBinPath = await fs.realpath(resolvedBinPath);
    const realNodeModules = await fs.realpath(path.resolve(cwd, 'node_modules'));

    if (realBinPath !== realNodeModules && !realBinPath.startsWith(`${realNodeModules}${path.sep}`)) {
      throw new Error(`Binário local aponta para fora de node_modules: ${binName}`);
    }

    const result = await runFileCommand(realBinPath, args, cwd, options);
    return redactBuildLogs([result.stdout, result.stderr].filter(Boolean).join('\n'), redactionValues);
  } catch (error) {
    throw new Error(formatBuildCommandFailure(resolvedBinPath, args, error, redactionValues));
  }
}

async function readPackageJson(appRoot) {
  return JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'));
}

function buildScriptContainsTscBuild(packageJson) {
  return typeof packageJson?.scripts?.build === 'string' && /\btsc\b/.test(packageJson.scripts.build);
}

function looksLikeTypecheckFailure(logs) {
  return [/\btsc\b/i, /\btsc\s+-b\b/i, /\btsc\s+--build\b/i, /\btypescript\b/i, /\bTS\d{4}\b/, /type\s+checking/i, /vue-tsc/i]
    .some((pattern) => pattern.test(logs || ''));
}

function formatBuildCommandFailure(command, args, error, redactionValues = []) {
  const code = Number(error?.code);
  const exitCode = Number.isInteger(code) ? code : 'unknown';
  return redactBuildLogs([
    `[command failed: ${command} ${args.join(' ')}; exit code ${exitCode}]`,
    error?.stdout, error?.stderr, error?.message,
  ].filter(Boolean).join('\n'), redactionValues);
}

function terminateBuildProcess(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch (error) {
    // The process may have exited between timeout and termination.
  }

  setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch (error) {
      // Best-effort hard kill after the grace period.
    }
  }, BUILD_COMMAND_KILL_GRACE_MS).unref();
}

function runFileCommand(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs || BUILD_COMMAND_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer || BUILD_COMMAND_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildSubprocessEnv(options),
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;

    const settle = (error, result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        error.stdout = Buffer.concat(stdout, stdoutBytes).toString('utf8');
        error.stderr = Buffer.concat(stderr, stderrBytes).toString('utf8');
        reject(error);
        return;
      }

      resolve(result);
    };

    const appendOutput = (chunks, currentBytes, chunk) => {
      const nextBytes = currentBytes + chunk.length;

      if (nextBytes > maxBuffer) {
        bufferExceeded = true;
        const error = new Error(`Command output exceeded ${maxBuffer} bytes.`);
        error.code = null;
        terminateBuildProcess(child);
        settle(error);
        return currentBytes;
      }

      chunks.push(chunk);
      return nextBytes;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Command timed out after ${timeoutMs}ms.`);
      error.code = null;
      terminateBuildProcess(child);
      settle(error);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (!settled) {
        stdoutBytes = appendOutput(stdout, stdoutBytes, chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!settled) {
        stderrBytes = appendOutput(stderr, stderrBytes, chunk);
      }
    });
    child.on('error', (error) => {
      settle(error);
    });
    child.on('close', (code, signal) => {
      if (settled && (timedOut || bufferExceeded)) {
        return;
      }

      const result = {
        stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
      };

      if (code === 0) {
        settle(null, result);
        return;
      }

      const error = new Error(signal ? `Command terminated by ${signal}.` : `Command exited with code ${code}.`);
      error.code = Number.isInteger(code) ? code : null;
      settle(error);
    });
  });
}

function buildSubprocessEnv(options = {}) {
  const env = {};
  SUBPROCESS_ENV_ALLOWLIST.forEach((name) => {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  });
  Object.entries(options.env || {}).forEach(([name, value]) => {
    if (SUBPROCESS_ENV_ALLOWLIST.has(name) && value != null) env[name] = String(value);
  });
  Object.entries(options.frontendEnv || {}).forEach(([name, value]) => {
    if (/^VITE_[A-Za-z0-9_]+$/.test(name) && value != null) env[name] = String(value);
  });
  env.CI = 'true';
  env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  return env;
}

function getCommandRedactionValues(options = {}) {
  return Object.values(options.frontendEnv || {}).filter((value) => typeof value === 'string' && value.length >= 6);
}

async function runReactViteBuild(appRoot, options = {}) {
  const packageJson = await readPackageJson(appRoot);
  // Temporary mitigation only: npm run build, vite.config.*, and Vite plugins
  // still execute project-controlled JavaScript. This does not replace a
  // container or VM sandbox.
  try {
    return await runNpmCommand(['run', 'build'], appRoot, options);
  } catch (error) {
    if (!buildScriptContainsTscBuild(packageJson) && !looksLikeTypecheckFailure(error.message)) throw error;
    const fallbackLog = [error.message, 'Fallback aplicado: vite build local sem typecheck.'].filter(Boolean).join('\n');
    try {
      return [fallbackLog, await runLocalBinCommand('vite', ['build'], appRoot, options)].filter(Boolean).join('\n');
    } catch (fallbackError) {
      throw new Error([fallbackLog, fallbackError.message].filter(Boolean).join('\n'));
    }
  }
}

async function hasNpmLockfile(appRoot) {
  return (
    await pathExists(path.join(appRoot, 'package-lock.json')) ||
    await pathExists(path.join(appRoot, 'npm-shrinkwrap.json'))
  );
}

async function runReactViteInstall(appRoot, options = {}) {
  const installEnv = {
    NODE_ENV: 'development',
    NPM_CONFIG_PRODUCTION: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  };
  const installOptions = {
    ...options,
    env: {
      ...(options.env || {}),
      ...installEnv,
    },
  };
  const logs = [];

  if (await hasNpmLockfile(appRoot)) {
    logs.push(await runNpmCommand(['ci', '--ignore-scripts', '--include=dev'], appRoot, installOptions));
  } else {
    logs.push(await runNpmCommand(['install', '--ignore-scripts', '--include=dev'], appRoot, installOptions));
  }

  logs.push(await runNpmCommand(['install', '--ignore-scripts', ...REACT_VITE_RUNTIME_PACKAGES], appRoot, installOptions));
  logs.push(await runNpmCommand(['install', '--ignore-scripts', '-D', ...REACT_VITE_DEV_PACKAGES], appRoot, installOptions));

  return logs.filter(Boolean).join('\n');
}

function stripJsonComments(json) {
  let result = ''; let inString = false; let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index]; const next = json[index + 1];
    if (inString) { result += char; escaped = !escaped && char === '\\'; if (!escaped && char === '"') inString = false; else if (char !== '\\') escaped = false; continue; }
    if (char === '"') { inString = true; result += char; continue; }
    if (char === '/' && next === '/') { while (index < json.length && json[index] !== '\n') index += 1; result += '\n'; continue; }
    if (char === '/' && next === '*') { index += 2; while (index < json.length && !(json[index] === '*' && json[index + 1] === '/')) { result += json[index] === '\n' ? '\n' : ' '; index += 1; } index += 1; continue; }
    result += char;
  }
  return result;
}

function parseTsconfig(rawConfig) {
  try { return JSON.parse(rawConfig); } catch (error) {
    return JSON.parse(stripJsonComments(rawConfig).replace(/,(\s*[}\]])/g, '$1'));
  }
}

async function findTsconfigFiles(rootDir) {
  const matches = []; const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) matches.push(...(await findTsconfigFiles(entryPath)));
    else if (entry.isFile() && /^tsconfig.*\.json$/i.test(entry.name)) matches.push(entryPath);
  }
  return matches;
}

async function applyTsconfigDeprecationFix(appRoot) {
  const fixedPaths = [];
  for (const tsconfigPath of await findTsconfigFiles(appRoot)) {
    const config = parseTsconfig(await fs.readFile(tsconfigPath, 'utf8'));
    config.compilerOptions = config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions : {};
    if (String(config.compilerOptions.moduleResolution).toLowerCase() === 'node10') config.compilerOptions.moduleResolution = 'bundler';
    config.compilerOptions.ignoreDeprecations = '6.0';
    await fs.writeFile(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    fixedPaths.push(path.relative(appRoot, tsconfigPath));
  }
  return fixedPaths;
}

async function ensureViteRelativeBase(appRoot) {
  for (const filename of ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts']) {
    const configPath = path.join(appRoot, filename);
    if (!(await pathExists(configPath))) continue;
    const raw = await fs.readFile(configPath, 'utf8');
    let updated = raw;
    if (!/base\s*:\s*(['"`])\.\/\1/.test(raw)) {
      if (/base\s*:\s*(['"`])[^'"`]*\1/.test(raw)) updated = raw.replace(/base\s*:\s*(['"`])[^'"`]*\1/, "base: './'");
      else if (/defineConfig\s*\(\s*\{/.test(raw)) updated = raw.replace(/defineConfig\s*\(\s*\{/, "defineConfig({\n  base: './',");
      else if (/export\s+default\s+\{/.test(raw)) updated = raw.replace(/export\s+default\s+\{/, "export default {\n  base: './',");
    }
    if (updated !== raw) { await fs.writeFile(configPath, updated); return filename; }
    return null;
  }
  return null;
}

async function fixDistIndexAssetPaths(distDir) {
  const indexPath = path.join(distDir, 'index.html');
  if (!(await pathExists(indexPath))) throw new Error('Build concluído sem gerar dist/index.html.');
  const html = await fs.readFile(indexPath, 'utf8');
  const fixed = html.replaceAll('src="/assets/', 'src="./assets/').replaceAll("src='/assets/", "src='./assets/")
    .replaceAll('href="/assets/', 'href="./assets/').replaceAll("href='/assets/", "href='./assets/")
    .replaceAll('url(/assets/', 'url(./assets/').replaceAll('url("/assets/', 'url("./assets/').replaceAll("url('/assets/", "url('./assets/");
  if (fixed !== html) { await fs.writeFile(indexPath, fixed); return true; }
  return false;
}

async function runLegacyReactViteBuild(req, res, project, buildDir) {
  await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
  return res.status(503).json({
    success: false,
    code: 'BUILD_WORKER_REQUIRED',
    message: 'Execução local síncrona de builds React/Vite está desabilitada.',
  });
}

function formatConnectorInjectionLog(resolution) {
  if (!resolution || !Array.isArray(resolution.requiredEnvVars)) {
    return '';
  }

  const resolvedProviders = (resolution.resolvedConnectors || [])
    .map((connector) => connector.provider)
    .join(', ');
  const unresolvedProviders = (resolution.unresolvedConnectors || [])
    .map((connector) => connector.provider)
    .join(', ');

  return [
    'Connector injection plan:',
    `- requiredEnvVars: ${resolution.requiredEnvVars.length ? resolution.requiredEnvVars.join(', ') : 'none'}`,
    `- frontendEnvVars: ${resolution.frontendEnvVars?.length ? resolution.frontendEnvVars.join(', ') : 'none'}`,
    `- backendEnvVars: ${resolution.backendEnvVars?.length ? resolution.backendEnvVars.join(', ') : 'none'}`,
    `- resolvedConnectors: ${resolvedProviders || 'none'}`,
    `- unresolvedConnectors: ${unresolvedProviders || 'none'}`,
    `- blockedEnvVars: ${resolution.blockedEnvVars?.length ? resolution.blockedEnvVars.join(', ') : 'none'}`,
    resolution.blockedEnvVars?.length
      ? '- backendSecrets: blocked; backend connector secrets will not be injected into frontend builds.'
      : '- backendSecrets: none blocked',
    '- secretsInjected: false',
  ].join('\n');
}

function collectSensitiveProcessEnvValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME_PATTERN.test(name) && typeof value === 'string')
    .map(([, value]) => value)
    .filter((value) => value.length >= 6);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownValues(text, values) {
  return (Array.isArray(values) ? values : []).reduce((redacted, value) => {
    if (typeof value !== 'string' || value.length < 6) {
      return redacted;
    }

    return redacted.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');
  }, String(text || ''));
}

function isLargeEnvironmentDump(text) {
  const matches = String(text || '').match(ENV_DUMP_KEY_PATTERN) || [];
  return matches.length >= 4;
}

function redactLargeEnvironmentDumps(text) {
  const lines = String(text || '').split('\n');
  const redactedLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (isLargeEnvironmentDump(line)) {
      redactedLines.push(ENV_DUMP_REDACTION_MARKER);
      continue;
    }

    if (/^\s*\{/.test(line)) {
      let objectEndIndex = index;

      while (objectEndIndex + 1 < lines.length && objectEndIndex - index < 300) {
        objectEndIndex += 1;
        if (/^\s*}\s*,?\s*$/.test(lines[objectEndIndex])) {
          break;
        }
      }

      const objectBlock = lines.slice(index, objectEndIndex + 1).join('\n');
      if (isLargeEnvironmentDump(objectBlock)) {
        redactedLines.push(ENV_DUMP_REDACTION_MARKER);
        index = objectEndIndex;
        continue;
      }
    }

    let endIndex = index;
    let block = line;

    while (endIndex + 1 < lines.length && endIndex - index < 80) {
      const nextLine = lines[endIndex + 1];

      if (!nextLine.trim() || /^\s*(?:[}\]])?\s*,?\s*$/.test(nextLine) || ENV_DUMP_LINE_KEY_PATTERN.test(nextLine)) {
        block += `\n${nextLine}`;
        endIndex += 1;
        continue;
      }

      break;
    }

    if (isLargeEnvironmentDump(block)) {
      redactedLines.push(ENV_DUMP_REDACTION_MARKER);
      index = endIndex;
      continue;
    }

    redactedLines.push(line);
  }

  return redactedLines.join('\n');
}

function redactBuildEnvironmentDetails(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      if (!BUILD_ENV_LOG_KEY_PATTERN.test(line)) {
        return line;
      }

      return line.replace(
        /(\b(?:PATH|HOME|PWD|INIT_CWD|npm_package_json|npm_config_local_prefix|npm_config_userconfig)\b\s*(?::|=)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\n}\]]+)/gi,
        '$1[REDACTED]'
      );
    })
    .join('\n');
}

function summarizeBuildStackPaths(text) {
  return String(text || '').replace(
    /(^|[\s(])\/(?:[^\s():/]+\/)*([^\s():/]+)(?=:\d+(?::\d+)?)/gm,
    '$1$2'
  );
}

function redactBuildLogs(logs, extraSensitiveValues = []) {
  let redacted = redactLargeEnvironmentDumps(logs);
  redacted = redactBuildEnvironmentDetails(redacted);
  redacted = redacted.replace(INTERNAL_BUILD_PATH_PATTERN, '[REDACTED_PATH]');
  redacted = summarizeBuildStackPaths(redacted);
  redacted = redactKnownValues(redacted, [
    ...collectSensitiveProcessEnvValues(),
    ...extraSensitiveValues,
  ]);

  TOKEN_REDACTION_PATTERNS.forEach((pattern) => {
    redacted = redacted.replace(pattern, (match) => {
      if (/^Bearer\s+/i.test(match)) {
        return 'Bearer [REDACTED]';
      }

      if (/^mongodb/i.test(match)) {
        return 'mongodb://[REDACTED]';
      }

      return '[REDACTED]';
    });
  });

  return redacted;
}

function stripJsonComments(json) {
  let stripped = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    const nextChar = json[index + 1];

    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      while (index < json.length && json[index] !== '\n') {
        index += 1;
      }
      stripped += '\n';
      continue;
    }

    if (char === '/' && nextChar === '*') {
      index += 2;
      while (index < json.length && !(json[index] === '*' && json[index + 1] === '/')) {
        stripped += json[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }

    stripped += char;
  }

  return stripped;
}

function stripJsonTrailingCommas(json) {
  let stripped = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];

    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;

      while (/\s/.test(json[nextIndex] || '')) {
        nextIndex += 1;
      }

      if (json[nextIndex] === '}' || json[nextIndex] === ']') {
        continue;
      }
    }

    stripped += char;
  }

  return stripped;
}

function parseTsconfig(rawConfig) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    return JSON.parse(stripJsonTrailingCommas(stripJsonComments(rawConfig)));
  }
}

async function findTsconfigFiles(rootDir) {
  const matches = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      matches.push(...(await findTsconfigFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && /^tsconfig.*\.json$/i.test(entry.name)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

async function applyTsconfigDeprecationFix(appRoot) {
  const tsconfigFiles = await findTsconfigFiles(appRoot);
  const fixedPaths = [];

  for (const tsconfigPath of tsconfigFiles) {
    const rawConfig = await fs.readFile(tsconfigPath, 'utf8');
    const config = parseTsconfig(rawConfig);

    if (!config.compilerOptions || typeof config.compilerOptions !== 'object') {
      config.compilerOptions = {};
    }

    const compilerOptions = config.compilerOptions;

    if (String(compilerOptions.moduleResolution).toLowerCase() === 'node10') {
      compilerOptions.moduleResolution = 'bundler';
    }

    compilerOptions.ignoreDeprecations = '6.0';

    await fs.writeFile(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    fixedPaths.push(path.relative(appRoot, tsconfigPath));
  }

  return fixedPaths;
}

function applyRelativeViteBase(rawConfig) {
  if (/base\s*:\s*(['"`])\.\/\1/.test(rawConfig)) {
    return rawConfig;
  }

  if (/base\s*:\s*(['"`])[^'"`]*\1/.test(rawConfig)) {
    return rawConfig.replace(/base\s*:\s*(['"`])[^'"`]*\1/, "base: './'");
  }

  if (/defineConfig\s*\(\s*\{/.test(rawConfig)) {
    return rawConfig.replace(/defineConfig\s*\(\s*\{/, "defineConfig({\n  base: './',");
  }

  if (/export\s+default\s+\{/.test(rawConfig)) {
    return rawConfig.replace(/export\s+default\s+\{/, "export default {\n  base: './',");
  }

  return rawConfig;
}

async function ensureViteRelativeBase(appRoot) {
  const viteConfigFiles = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts'];

  for (const filename of viteConfigFiles) {
    const configPath = path.join(appRoot, filename);

    if (!(await pathExists(configPath))) {
      continue;
    }

    const rawConfig = await fs.readFile(configPath, 'utf8');
    const updatedConfig = applyRelativeViteBase(rawConfig);

    if (updatedConfig !== rawConfig) {
      await fs.writeFile(configPath, updatedConfig);
      return filename;
    }

    return null;
  }

  return null;
}

async function fixDistIndexAssetPaths(distDir) {
  const indexPath = path.join(distDir, 'index.html');

  if (!(await pathExists(indexPath))) {
    throw new Error('Build concluído sem gerar dist/index.html.');
  }

  const html = await fs.readFile(indexPath, 'utf8');
  const fixedHtml = html
    .replaceAll('src="/assets/', 'src="./assets/')
    .replaceAll("src='/assets/", "src='./assets/")
    .replaceAll('href="/assets/', 'href="./assets/')
    .replaceAll("href='/assets/", "href='./assets/")
    .replaceAll('url(/assets/', 'url(./assets/')
    .replaceAll('url("/assets/', 'url("./assets/')
    .replaceAll("url('/assets/", "url('./assets/");

  if (fixedHtml !== html) {
    await fs.writeFile(indexPath, fixedHtml);
    return true;
  }

  return false;
}

function pickBuildPayload(body) {
  return BUILD_FIELDS.reduce((payload, field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }

    return payload;
  }, {});
}

async function applyLatestPendingBuild(projectId, update) {
  const latestPendingBuild = await ProjectBuild.findOne({
    projectId,
    // Legacy publication paths cannot target a build explicitly. Never promote
    // a worker build that is still running; new callers must use /publish.
    status: 'draft',
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  });

  if (!latestPendingBuild) {
    return;
  }

  latestPendingBuild.status = 'done';
  await latestPendingBuild.save();
  applyPublishedBuildFields(latestPendingBuild, update);
}

router.get('/change-requests', requireAdmin, async (req, res) => {
  try {
    const query = {};
    const status = String(req.query.status || '').trim();

    if (status) {
      if (!CHANGE_REQUEST_STATUSES.includes(status)) {
        return res.status(400).json({
          message: 'Status de change request inválido.',
          allowedStatuses: CHANGE_REQUEST_STATUSES,
        });
      }

      query.status = status;
    }

    const changeRequests = await ProjectChangeRequest.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .populate('projectId', 'name title prompt status generationStatus generation_status')
      .populate('userId', 'name email')
      .lean();

    return res.json({
      success: true,
      changeRequests,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/projects', requireAdmin, async (req, res) => {
  try {
    const projects = await Project.find().sort({
      updatedAt: -1,
      createdAt: -1,
    });
    const pendingChangeRequestCounts = await ProjectChangeRequest.aggregate([
      {
        $match: {
          status: 'pending',
          projectId: { $in: projects.map((project) => project._id) },
        },
      },
      {
        $group: {
          _id: '$projectId',
          count: { $sum: 1 },
        },
      },
    ]);
    const pendingCountByProjectId = new Map(
      pendingChangeRequestCounts.map((item) => [String(item._id), item.count])
    );

    return res.json({
      success: true,
      projects: projects.map((project) => ({
        ...withAbsoluteProjectBuildUrls(req, project),
        pendingChangeRequestCount: pendingCountByProjectId.get(String(project._id)) || 0,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/projects/:id/files', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('_id name title prompt status').lean();

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

router.get('/projects/:id/files/content', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('_id name title prompt status').lean();

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

router.get('/projects/:id/change-requests', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('name prompt status');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const changeRequests = await ProjectChangeRequest.find({ projectId: project._id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return res.json({
      success: true,
      project: {
        id: String(project._id),
        name: project.name,
        prompt: project.prompt,
        status: project.status,
      },
      changeRequests,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/projects/:id/connectors', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .select('name prompt status requiredConnectors userId')
      .lean();

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const secrets = await ConnectorSecret.find({
      projectId: project._id,
      userId: project.userId,
    }).lean();
    const secretByProvider = new Map(
      secrets.map((secret) => [normalizeConnectorProvider(secret.provider), secret])
    );
    const connectorByProvider = new Map();

    (Array.isArray(project.requiredConnectors) ? project.requiredConnectors : []).forEach((projectConnector) => {
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
      project: {
        id: String(project._id),
        name: project.name,
        prompt: project.prompt,
        status: project.status,
      },
      connectors: Array.from(connectorByProvider.values()),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch(
  '/change-requests/:requestId/status',
  requireAdmin,
  validateObjectIdParam('requestId', 'ID de change request inválido.'),
  async (req, res) => {
    try {
      const { status } = req.body;

      if (!CHANGE_REQUEST_STATUSES.includes(status)) {
        return res.status(400).json({
          message: 'Status de change request inválido.',
          allowedStatuses: CHANGE_REQUEST_STATUSES,
        });
      }

      const changeRequest = await ProjectChangeRequest.findByIdAndUpdate(
        req.params.requestId,
        { status },
        {
          new: true,
          runValidators: true,
        }
      );

      if (!changeRequest) {
        return res.status(404).json({ message: 'Change request não encontrado.' });
      }

      return res.json({
        success: true,
        changeRequest,
      });
    } catch (error) {
      return res.status(500).json({
        message: 'Erro interno do servidor.',
      });
    }
  }
);

router.get('/projects/:id/versions', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const ProjectVersion = mongoose.models.ProjectVersion;

    if (!ProjectVersion) {
      return res.json({
        success: true,
        versions: [],
      });
    }

    const versions = await ProjectVersion.find({ projectId: req.params.id }).sort({
      createdAt: -1,
    });

    return res.json({
      success: true,
      versions,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/projects/:id/messages', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('name prompt status');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const messages = await ProjectMessage.find({ projectId: req.params.id })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const changeRequests = await ProjectChangeRequest.find({ projectId: req.params.id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return res.json({
      success: true,
      project: {
        id: String(project._id),
        name: project.name,
        prompt: project.prompt,
        status: project.status,
      },
      messages,
      changeRequests,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post(
  '/projects/:id/react-vite',
  requireAdmin,
  validateProjectId,
  reactViteUploadRateLimit,
  loadProject,
  runReactViteUpload,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: INVALID_REACT_VITE_ZIP_MESSAGE });
    }

    const project = req.project;
    const buildDir = req.reactViteBuildDir;
    const sourceZipPath = req.file.path;
    const extractDir = path.join(buildDir, 'source');
    let sourceGridFsFile = null;
    let build = null;
    let job = null;

    try {
      if (!BUILD_WORKER_ENABLED) {
        await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
        return res.status(503).json({
          success: false,
          code: 'BUILD_WORKER_REQUIRED',
          message: process.env.NODE_ENV === 'production'
            ? 'BUILD_WORKER_ENABLED=true é obrigatório em produção para builds React/Vite.'
            : 'Build worker React/Vite não está habilitado; execução local síncrona está desabilitada.',
        });
      }

      await extractZipSafely(sourceZipPath, extractDir);

      const appRoot = await findReactViteRoot(extractDir);
      await validateReactViteProject(appRoot);

      sourceGridFsFile = await uploadReactViteSourceZip(
        sourceZipPath,
        project._id,
        req.file.originalname
      );

      build = await ProjectBuild.create({
        projectId: project._id,
        type: 'react_vite',
        status: 'in_progress',
        logs: 'React/Vite build enfileirado.',
      });
      job = await BuildJob.create({
        type: 'react_vite',
        projectId: project._id,
        projectBuildId: build._id,
        sourceGridFsFileId: sourceGridFsFile.fileId,
        status: 'queued',
      });
      build.buildJobId = job._id;
      await build.save();

      await Project.findByIdAndUpdate(
        project._id,
        {
          status: 'in_progress',
          generation_status: 'in_progress',
          generationStatus: 'in_progress',
          reactVite: true,
          'metadata.lastBuildAt': new Date(),
        },
        {
          runValidators: true,
        }
      );

      return res.status(202).json({
        success: true,
        build: withAbsoluteBuildUrls(req, build),
        buildId: String(build._id),
        jobId: String(job._id),
        status: 'queued',
      });
    } catch (error) {
      if (job) {
        await BuildJob.deleteOne({ _id: job._id }).catch(() => {});
      }

      if (build) {
        await ProjectBuild.deleteOne({ _id: build._id }).catch(() => {});
      }

      if (sourceGridFsFile) {
        await sourceGridFsFile.bucket.delete(sourceGridFsFile.fileId).catch(() => {});
      }

      if (error?.code === INVALID_REACT_VITE_ZIP_ERROR_CODE) {
        if (!BUILD_WORKER_ENABLED) {
          await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
        }
        return res.status(400).json({ message: INVALID_REACT_VITE_ZIP_MESSAGE });
      }

      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor.',
      });
    } finally {
      if (BUILD_WORKER_ENABLED) {
        await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
);

router.post('/projects/:id/builds', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const build = await ProjectBuild.create({
      projectId: project._id,
      ...pickBuildPayload(req.body),
    });

    return res.status(201).json({
      success: true,
      build: withAbsoluteBuildUrls(req, build),
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Requisição inválida.',
      });
    }

    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post(
  '/projects/:projectId/builds/:buildId/publish',
  requireAdmin,
  validateObjectIdParam('projectId', 'ID de projeto inválido.'),
  validateObjectIdParam('buildId', 'ID de build inválido.'),
  async (req, res) => {
    try {
      const { projectId, buildId } = req.params;
      const project = await Project.findById(projectId);

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

      const {
        alreadyPublished,
        publishedProject,
        publishedBuild,
        previewUrl,
        publicUrl,
        deployUrl,
      } = await publishProjectBuildShared({
        req,
        project,
        projectBuild,
        body: req.body,
      });

      return res.json({
        success: true,
        ...(alreadyPublished ? { alreadyPublished } : {}),
        project: withAbsoluteProjectBuildUrls(req, publishedProject),
        build: withAbsoluteBuildUrlsShared(req, publishedBuild),
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
  }
);

router.get(
  '/projects/:projectId/builds/:buildId/status',
  requireAdmin,
  validateObjectIdParam('projectId', 'ID de projeto inválido.'),
  validateObjectIdParam('buildId', 'ID de build inválido.'),
  async (req, res) => {
    try {
      const { projectId, buildId } = req.params;
      const projectBuild = await ProjectBuild.findOne({
        _id: buildId,
        projectId,
      }).select('status previewUrl buildUrl deployUrl distUrl buildJobId');

      if (!projectBuild) {
        return res.status(404).json({ message: 'Build não encontrado.' });
      }

      let buildJob = null;

      if (projectBuild.buildJobId) {
        buildJob = await BuildJob.findOne({
          _id: projectBuild.buildJobId,
          projectBuildId: projectBuild._id,
        }).select('status errorCode errorMessage');
      }

      if (!buildJob) {
        buildJob = await BuildJob.findOne({ projectBuildId: projectBuild._id })
          .sort({ createdAt: -1 })
          .select('status errorCode errorMessage');
      }

      const previewUrl = await getServableBuildPreviewUrl(req, projectId, projectBuild);
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
  }
);

router.get(
  '/projects/:projectId/builds/:buildId/security-scan',
  requireAdmin,
  validateObjectIdParam('projectId', 'ID de projeto inválido.'),
  validateObjectIdParam('buildId', 'ID de build inválido.'),
  async (req, res) => {
    try {
      const { projectId, buildId } = req.params;
      const project = await Project.findById(projectId).select('_id');

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

      return res.json(scanBuildSecurityShared(projectBuild));
    } catch (error) {
      return res.status(500).json({ message: 'Erro interno do servidor.' });
    }
  }
);

router.get('/projects/:id/builds/check', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const indexPath = resolvePublicBuildIndexPath(req.query.url);

    if (!indexPath) {
      return res.status(400).json({
        message: 'URL de build inválida.',
      });
    }

    try {
      const indexStats = await fs.stat(indexPath);

      if (!indexStats.isFile()) {
        throw new Error('Build index is not a file.');
      }

      return res.json({
        success: true,
        exists: true,
      });
    } catch (error) {
      if (await hasMongoBuildFallback(req.query.url)) {
        return res.json({
          success: true,
          exists: true,
          source: 'mongodb',
        });
      }

      return res.json({
        success: true,
        exists: false,
        message: 'Build não encontrado no servidor. Reimporte o ZIP ou gere novamente.',
      });
    }
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/projects/:id/builds', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const builds = await ProjectBuild.find({ projectId: project._id }).sort({
      createdAt: -1,
      updatedAt: -1,
    });

    return res.json({
      success: true,
      builds: builds.map((build) => withAbsoluteBuildUrls(req, build)),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/projects/:id/build-mode', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const { buildMode } = req.body;

    if (!BUILD_MODES.includes(buildMode)) {
      return res.status(400).json({
        message: 'Build mode inválido.',
        allowedBuildModes: BUILD_MODES,
      });
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { buildMode },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project: withAbsoluteProjectBuildUrls(req, project),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/projects/:id/manual', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const existingProject = await Project.findById(req.params.id);

    if (!existingProject) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const {
      title,
      response,
      html,
      css,
      js,
      fullHtml,
      latestFullHtml,
      summary,
      generationStatus,
      generation_status: generationStatusSnake,
      status,
      publish,
      distUrl,
      previewUrl,
      buildUrl,
      deploy,
      reactVite,
      build,
      buildMode,
    } = req.body;
    const update = {};
    const setIfDefined = (field, value) => {
      if (value !== undefined) {
        update[field] = value;
      }
    };

    if (title !== undefined) {
      update.title = title;
      update.name = title;
    }

    setIfDefined('response', response);
    setIfDefined('html', html);
    setIfDefined('css', css);
    setIfDefined('js', js);
    setIfDefined('fullHtml', fullHtml);
    setIfDefined('latestFullHtml', latestFullHtml !== undefined ? latestFullHtml : fullHtml);
    setIfDefined('summary', summary);
    setIfDefined('distUrl', distUrl);
    setIfDefined('previewUrl', previewUrl);
    setIfDefined('buildUrl', buildUrl);
    setIfDefined('deploy', deploy);
    setIfDefined('reactVite', reactVite);
    setIfDefined('build', build);

    if (buildMode !== undefined) {
      if (!BUILD_MODES.includes(buildMode)) {
        return res.status(400).json({
          message: 'Build mode inválido.',
          allowedBuildModes: BUILD_MODES,
        });
      }

      update.buildMode = buildMode;
    }

    const requestedStatus =
      generationStatus !== undefined
        ? generationStatus
        : generationStatusSnake !== undefined
          ? generationStatusSnake
          : status;

    if (requestedStatus !== undefined) {
      if (!WIZARD_STATUSES.includes(requestedStatus)) {
        return res.status(400).json({
          message: 'Status inválido.',
          allowedStatuses: WIZARD_STATUSES,
        });
      }

      if (requestedStatus === 'in_progress') {
        applyLoadingStatus(update);
      } else {
        applyWizardStatus(update, requestedStatus);
      }
    }

    const shouldMarkDone = requestedStatus === 'done' || publish === true;

    if (publish === true) {
      applyWizardStatus(update, 'done');
    }

    if (shouldMarkDone) {
      await applyLatestPendingBuild(req.params.id, update);
      update['metadata.lastBuildAt'] = new Date();
      removePublicPublishFields(update);
    }

    const project = await Project.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project: withAbsoluteProjectBuildUrls(req, project),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/projects/:id/status', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const existingProject = await Project.findById(req.params.id);

    if (!existingProject) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const { generationStatus, generation_status: generationStatusSnake, status } = req.body;
    const requestedStatus =
      generationStatus !== undefined
        ? generationStatus
        : generationStatusSnake !== undefined
          ? generationStatusSnake
          : status;

    if (!WIZARD_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({
        message: 'Status inválido.',
        allowedStatuses: WIZARD_STATUSES,
      });
    }

    const update = {};

    if (requestedStatus === 'in_progress') {
      applyLoadingStatus(update);
    } else {
      applyWizardStatus(update, requestedStatus);
    }

    if (requestedStatus === 'done') {
      await applyLatestPendingBuild(req.params.id, update);
      update['metadata.lastBuildAt'] = new Date();
      removePublicPublishFields(update);
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      update,
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project: withAbsoluteProjectBuildUrls(req, project),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

module.exports = router;
module.exports.reactViteBuildHelpers = {
  applyTsconfigDeprecationFix,
  collectBuildArtifactFiles,
  collectProjectSourceFiles,
  ensureViteRelativeBase,
  extractZipSafely,
  findReactViteRoot,
  fixDistIndexAssetPaths,
  formatConnectorInjectionLog,
  publishValidatedDist,
  redactBuildLogs,
  runLocalBinCommand,
  runNpmCommand,
  runReactViteInstall,
  runReactViteBuild,
  runNpxCommand,
  validateDistDirectory,
  validateReactViteProject,
};
