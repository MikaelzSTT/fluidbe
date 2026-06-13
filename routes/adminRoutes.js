const express = require('express');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectChangeRequest = require('../models/ProjectChangeRequest');
const { CHANGE_REQUEST_STATUSES } = require('../models/ProjectChangeRequest');
const ProjectMessage = require('../models/ProjectMessage');
const ConnectorSecret = require('../models/ConnectorSecret');
const { getConnectorByProvider } = require('./connectorRegistryRoutes');

const router = express.Router();
const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '..');
const REACT_VITE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'react-vite-builds');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const MAX_MONGO_ARTIFACT_BYTES = Number(process.env.MAX_MONGO_ARTIFACT_BYTES || 8 * 1024 * 1024);

const WIZARD_STATUSES = ['pending', 'in_progress', 'done'];
const BUILD_MODES = ['manual', 'assisted', 'automatic'];
const PUBLIC_BASE_URL = 'https://askfluid.now';
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

function withAbsoluteProjectBuildUrls(req, document) {
  if (!document || typeof document !== 'object') {
    return document;
  }

  const payload =
    typeof document.toObject === 'function'
      ? document.toObject({ getters: true, virtuals: true })
      : { ...document };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl']) {
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

function slugifyProjectTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'projeto';
}

async function buildUniqueProjectSlug(project, title) {
  const baseSlug = slugifyProjectTitle(title || project.title || project.name || project.prompt);
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
  const slug = update.slug || project.slug || (await buildUniqueProjectSlug(project, update.title || update.name));
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

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
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
      message: 'Erro ao buscar projeto.',
      error: error.message,
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
  },
});

function runReactViteUpload(req, res, next) {
  reactViteUpload.single('file')(req, res, (error) => {
    if (!error) {
      return next();
    }

    return res.status(400).json({
      message: 'Upload inválido.',
      error: error.message,
    });
  });
}

async function extractZipSafely(zipPath, destinationDir) {
  const zip = new AdmZip(zipPath);
  const destinationRoot = path.resolve(destinationDir);

  await fs.mkdir(destinationRoot, { recursive: true });

  for (const entry of zip.getEntries()) {
    const targetPath = path.resolve(destinationRoot, entry.entryName);

    if (targetPath !== destinationRoot && !targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
      throw new Error(`ZIP contém caminho inválido: ${entry.entryName}`);
    }

    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.getData());
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
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
  try {
    const result = await execFileAsync('npm', args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        CI: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  } catch (error) {
    const logs = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(logs || `npm ${args.join(' ')} falhou.`);
  }
}

async function runNpxCommand(args, cwd, options = {}) {
  try {
    const result = await execFileAsync('npx', args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        CI: 'true',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  } catch (error) {
    const logs = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    throw new Error(logs || `npx ${args.join(' ')} falhou.`);
  }
}

async function readPackageJson(appRoot) {
  const packageJsonPath = path.join(appRoot, 'package.json');
  const rawPackageJson = await fs.readFile(packageJsonPath, 'utf8');

  return JSON.parse(rawPackageJson);
}

function buildScriptContainsTscBuild(packageJson) {
  const buildScript = packageJson?.scripts?.build;

  return typeof buildScript === 'string' && /\btsc\b/.test(buildScript);
}

function looksLikeTypecheckFailure(logs) {
  return [
    /\btsc\b/i,
    /\btsc\s+-b\b/i,
    /\btsc\s+--build\b/i,
    /\btypescript\b/i,
    /\bTS\d{4}\b/,
    /type\s+checking/i,
    /vue-tsc/i,
  ].some((pattern) => pattern.test(logs || ''));
}

async function runViteBuildWithoutTypecheck(appRoot) {
  return runNpxCommand(['vite', 'build'], appRoot);
}

async function runFallbackViteBuild(appRoot, precedingLogs = '') {
  const fallbackLog = [precedingLogs, 'Fallback aplicado: npx vite build sem typecheck.']
    .filter(Boolean)
    .join('\n');

  try {
    return [fallbackLog, await runViteBuildWithoutTypecheck(appRoot)].filter(Boolean).join('\n');
  } catch (error) {
    throw new Error([fallbackLog, error.message].filter(Boolean).join('\n'));
  }
}

async function runReactViteBuild(appRoot) {
  const packageJson = await readPackageJson(appRoot);

  try {
    return await runNpmCommand(['run', 'build'], appRoot);
  } catch (error) {
    if (!buildScriptContainsTscBuild(packageJson) && !looksLikeTypecheckFailure(error.message)) {
      throw error;
    }

    return runFallbackViteBuild(appRoot, error.message);
  }
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
    status: { $in: ['draft', 'in_progress'] },
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  });

  if (!latestPendingBuild) {
    return;
  }

  latestPendingBuild.status = 'done';
  await latestPendingBuild.save();
  const publishedBuild = latestPendingBuild.toObject({
    getters: true,
    virtuals: true,
  });

  update.reactVite = latestPendingBuild.type === 'react_vite';
  update.build = publishedBuild;
  update.distUrl = latestPendingBuild.distUrl || '';
  update.previewUrl = latestPendingBuild.previewUrl || '';
  update.buildUrl =
    latestPendingBuild.buildUrl ||
    latestPendingBuild.deployUrl ||
    latestPendingBuild.previewUrl ||
    latestPendingBuild.distUrl ||
    '';

  if (latestPendingBuild.fullHtml) {
    update.fullHtml = latestPendingBuild.fullHtml;
    update.latestFullHtml = latestPendingBuild.fullHtml;
  }
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
      message: 'Erro ao buscar change requests.',
      error: error.message,
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
      message: 'Erro ao buscar projetos.',
      error: error.message,
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
      message: 'Erro ao buscar change requests do projeto.',
      error: error.message,
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
      message: 'Erro ao buscar conectores do projeto.',
      error: error.message,
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
        message: 'Erro ao atualizar status do change request.',
        error: error.message,
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
      message: 'Erro ao buscar versões do projeto.',
      error: error.message,
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
      message: 'Erro ao buscar mensagens do projeto.',
      error: error.message,
    });
  }
});

router.post(
  '/projects/:id/react-vite',
  requireAdmin,
  validateProjectId,
  loadProject,
  runReactViteUpload,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: 'Campo file é obrigatório.' });
    }

    const project = req.project;
    const timestamp = req.reactViteBuildTimestamp;
    const buildDir = req.reactViteBuildDir;
    const sourceZipPath = req.file.path;
    const extractDir = path.join(buildDir, 'source');
    let logs = '';

    try {
      await extractZipSafely(sourceZipPath, extractDir);

      const appRoot = await findReactViteRoot(extractDir);
      await validateReactViteProject(appRoot);

      const developmentInstallEnv = {
        NODE_ENV: 'development',
        NPM_CONFIG_PRODUCTION: 'false',
      };

      logs += await runNpmCommand(['install', '--include=dev'], appRoot, {
        env: developmentInstallEnv,
      });
      logs += '\n';

      logs += await runNpmCommand(['install', 'react', 'react-dom'], appRoot, {
        env: developmentInstallEnv,
      });
      logs += '\n';

      logs += await runNpmCommand(
        ['install', '-D', 'vite', '@vitejs/plugin-react', 'typescript', '@types/react', '@types/react-dom'],
        appRoot,
        {
          env: developmentInstallEnv,
        }
      );
      logs += '\n';

      const fixedTsconfigPaths = await applyTsconfigDeprecationFix(appRoot);
      for (const fixedTsconfigPath of fixedTsconfigPaths) {
        logs += `Auto-fix TS5107 aplicado em: ${fixedTsconfigPath}\n`;
      }

      const viteConfigFixed = await ensureViteRelativeBase(appRoot);
      if (viteConfigFixed) {
        logs += `Auto-fix aplicado: base './' em ${viteConfigFixed}.\n`;
      }

      logs += await runReactViteBuild(appRoot);

      const distDir = path.join(appRoot, 'dist');

      if (!(await pathExists(distDir))) {
        throw new Error('Build concluído sem gerar a pasta dist.');
      }

      if (await fixDistIndexAssetPaths(distDir)) {
        logs += '\nAuto-fix aplicado: caminhos /assets/ corrigidos em dist/index.html.\n';
      }

      const distIndexPath = path.join(distDir, 'index.html');
      const fullHtml = await fs.readFile(distIndexPath, 'utf8');
      const artifactSnapshot = await collectBuildArtifactFiles(distDir);

      if (!artifactSnapshot.complete) {
        logs += `\nAviso: dist gerado excedeu ${MAX_MONGO_ARTIFACT_BYTES} bytes; ${artifactSnapshot.skippedFiles} arquivo(s) menos prioritario(s) nao foram salvos no fallback MongoDB.\n`;
      }

      const publicBuildDir = path.join(PUBLIC_BUILDS_DIR, String(project._id), timestamp);
      await fs.mkdir(publicBuildDir, { recursive: true });
      await fs.cp(distDir, publicBuildDir, { recursive: true });

      const previewUrl = `/builds/${project._id}/${timestamp}/index.html`;
      const build = await ProjectBuild.create({
        projectId: project._id,
        type: 'react_vite',
        status: 'draft',
        distUrl: previewUrl,
        previewUrl,
        buildUrl: previewUrl,
        deployUrl: previewUrl,
        fullHtml,
        artifactFiles: artifactSnapshot.files,
        sourceZipUrl: '',
        logs: [logs, 'React/Vite build concluído com sucesso.'].filter(Boolean).join('\n'),
      });

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

      return res.status(201).json({
        success: true,
        build: withAbsoluteBuildUrls(req, build),
        previewUrl: toAbsoluteBackendUrl(req, previewUrl),
      });
    } catch (error) {
      const errorLogs = [logs, error.message].filter(Boolean).join('\n');
      const build = await ProjectBuild.create({
        projectId: project._id,
        type: 'react_vite',
        status: 'failed',
        logs: errorLogs,
      });

      return res.status(500).json({
        success: false,
        message: 'Erro ao gerar build React/Vite.',
        build,
        error: error.message,
      });
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
        message: 'Build inválido.',
        error: error.message,
      });
    }

    return res.status(500).json({
      message: 'Erro ao criar build do projeto.',
      error: error.message,
    });
  }
});

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
      message: 'Erro ao verificar build do projeto.',
      error: error.message,
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
      message: 'Erro ao buscar builds do projeto.',
      error: error.message,
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
      message: 'Erro ao atualizar modo de build do projeto.',
      error: error.message,
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

    if (publish !== undefined) {
      update.publish = publish === true;

      if (publish === true) {
        await applyLatestPendingBuild(req.params.id, update);
        applyWizardStatus(update, 'done');
        update['metadata.lastBuildAt'] = new Date();
      }
    }

    if (requestedStatus === 'done' || publish === true) {
      await applyPublicationFields(existingProject, update);
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
      message: 'Erro ao atualizar projeto manualmente.',
      error: error.message,
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
      await applyPublicationFields(existingProject, update);
      update['metadata.lastBuildAt'] = new Date();
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
      message: 'Erro ao atualizar status do projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
