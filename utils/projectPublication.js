const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const BuildJob = require('../models/BuildJob');
const {
  generateFallbackAppName,
  normalizeAppName,
  slugifyAppName,
} = require('./projectNaming');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  'https://apps.askfluid.now';
const SECURITY_SCAN_MAX_FINDINGS = 50;
const SECURITY_SCAN_MAX_TEXT_CHARS = 2 * 1024 * 1024;

function createHttpError(statusCode, payload) {
  const error = new Error(payload && payload.message ? payload.message : 'Request failed.');
  error.statusCode = statusCode;
  error.payload = payload;
  return error;
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

function applyWizardStatus(update, value) {
  update.generationStatus = value;
  update.generation_status = value;
  update.status = value;
}

function idsEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftId = left._id || left;
  const rightId = right._id || right;
  return String(leftId) === String(rightId);
}

function slugifyProjectTitle(value) {
  return slugifyAppName(value || 'projeto');
}

async function buildUniqueProjectSlug(project, title) {
  const appName = normalizeAppName(project.appName)
    || generateFallbackAppName(project, project.prompt, project.build);
  const baseSlug = slugifyProjectTitle(appName || title || project.title || project.name || project.prompt);
  let slug = baseSlug;
  let suffix = 2;

  while (
    await Project.exists({
      _id: { $ne: project._id },
      slug,
    })
  ) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

async function applyPublicationFields(project, update) {
  const appName = normalizeAppName(update.appName || project.appName)
    || generateFallbackAppName(project, project.prompt, update.build || project.build);
  if (!project.appNameLocked && appName && !project.appName) {
    update.appName = appName;
    update.appNameSource = 'generated';
  }

  const projectForSlug = {
    ...(typeof project.toObject === 'function' ? project.toObject() : project),
    appName,
  };
  const slug = update.slug || project.slug || (await buildUniqueProjectSlug(projectForSlug, update.title || update.name));
  const publishedAt = new Date();

  update.slug = slug;
  update.isPublished = true;
  update.publishedAt = publishedAt;
  update.publish = true;
  mergeDeployUpdate(update, {
    isPublished: true,
    publishedAt,
    url: `${PUBLIC_BASE_URL}/p/${slug}`,
  });
}

function buildUnpublishUpdate() {
  return {
    isPublished: false,
    publish: false,
    publishedAt: null,
    'deploy.isPublished': false,
    'deploy.url': '',
    'deploy.publishedAt': null,
  };
}

async function unpublishActiveProjectsForUser(userId) {
  if (!userId) {
    return { matchedCount: 0, modifiedCount: 0 };
  }

  return Project.updateMany(
    {
      userId,
      isPublished: true,
    },
    {
      $set: buildUnpublishUpdate(),
    }
  );
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
      throw createHttpError(400, {
        message: 'Visibility inválida.',
        allowedVisibility: ['public'],
      });
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

function getSecurityScanLine(content, index) {
  return String(content || '').slice(0, index).split('\n').length;
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

async function publishProjectBuild({ req, project, projectBuild, body }) {
  const publishMetadataUpdate = buildPublishMetadataUpdate(body);
  const isLatestPublishedBuild = idsEqual(project.latestPublishedBuildId, projectBuild._id);
  const isAlreadyPublishedBuild =
    project.isPublished === true && (isLatestPublishedBuild || projectBuild.status === 'done');

  if (isAlreadyPublishedBuild) {
    const hasMetadataUpdate = Object.keys(publishMetadataUpdate).length > 0;
    const publishedProject = hasMetadataUpdate
      ? await Project.findByIdAndUpdate(project._id, publishMetadataUpdate, {
        new: true,
        runValidators: true,
      })
      : project;
    const publicUrl = publishedProject.publicUrl || (publishedProject.deploy && publishedProject.deploy.url) || '';
    const previewUrl = toAbsoluteBackendUrl(
      req,
      projectBuild.previewUrl || projectBuild.buildUrl || projectBuild.deployUrl || projectBuild.distUrl || ''
    );

    return {
      alreadyPublished: true,
      publishedProject,
      publishedBuild: projectBuild,
      previewUrl,
      publicUrl,
      deployUrl: publicUrl,
      build: withAbsoluteBuildUrls(req, projectBuild),
    };
  }

  if (projectBuild.status === 'done') {
    throw createHttpError(409, {
      message: 'Build já está publicado.',
      code: 'BUILD_ALREADY_PUBLISHED',
    });
  }

  if (projectBuild.status !== 'draft') {
    throw createHttpError(409, {
      message: 'Apenas builds concluídos e em draft podem ser publicados.',
      code: 'BUILD_NOT_READY_FOR_PUBLICATION',
      buildStatus: projectBuild.status,
    });
  }

  let buildJob = null;

  if (projectBuild.buildJobId) {
    buildJob = await BuildJob.findOne({
      _id: projectBuild.buildJobId,
      projectBuildId: projectBuild._id,
      projectId: project._id,
    }).select('status');

    if (!buildJob) {
      throw createHttpError(409, {
        message: 'BuildJob vinculado não foi encontrado para este build.',
        code: 'BUILD_JOB_LINK_INVALID',
      });
    }
  } else {
    buildJob = await BuildJob.findOne({
      projectBuildId: projectBuild._id,
      projectId: project._id,
    })
      .sort({ createdAt: -1 })
      .select('status');
  }

  if (buildJob && buildJob.status !== 'succeeded') {
    throw createHttpError(409, {
      message: 'O build worker ainda não concluiu este build com sucesso.',
      code: 'BUILD_JOB_NOT_SUCCEEDED',
      jobStatus: buildJob.status,
    });
  }

  const previewUrl = await getServableBuildPreviewUrl(req, project._id, projectBuild);

  if (!previewUrl) {
    throw createHttpError(409, {
      message: 'Artifact index.html do build não está disponível para publicação.',
      code: 'BUILD_ARTIFACT_NOT_AVAILABLE',
    });
  }

  const publishedBuild = await ProjectBuild.findOneAndUpdate(
    {
      _id: projectBuild._id,
      projectId: project._id,
      status: 'draft',
    },
    { $set: { status: 'done' } },
    { new: true, runValidators: true }
  );

  if (!publishedBuild) {
    throw createHttpError(409, {
      message: 'O estado do build mudou antes da publicação. Atualize e tente novamente.',
      code: 'BUILD_STATUS_CHANGED',
    });
  }

  const update = { ...publishMetadataUpdate };
  applyPublishedBuildFields(publishedBuild, update);
  applyWizardStatus(update, 'done');
  await applyPublicationFields(project, update);
  update['metadata.lastBuildAt'] = new Date();

  const publishedProject = await Project.findByIdAndUpdate(project._id, update, {
    new: true,
    runValidators: true,
  });
  const publicUrl = publishedProject.publicUrl || (publishedProject.deploy && publishedProject.deploy.url) || '';

  return {
    alreadyPublished: false,
    publishedProject,
    publishedBuild,
    previewUrl,
    publicUrl,
    deployUrl: publicUrl,
    build: withAbsoluteBuildUrls(req, publishedBuild),
  };
}

module.exports = {
  applyPublishedBuildFields,
  applyPublicationFields,
  buildPublishMetadataUpdate,
  buildUnpublishUpdate,
  getServableBuildPreviewUrl,
  publishProjectBuild,
  scanBuildSecurity,
  toAbsoluteBackendUrl,
  unpublishActiveProjectsForUser,
  withAbsoluteBuildUrls,
};
