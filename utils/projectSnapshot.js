const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const ProjectBuild = require('../models/ProjectBuild');
const {
  isLikelyTextBuffer,
  isProjectFileSensitive,
  parsePublicBuildUrl,
} = require('./projectFiles');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const MAX_SNAPSHOT_CHARS = Number(process.env.MAX_PROJECT_SNAPSHOT_CHARS || 7000);
const MAX_SNAPSHOT_FILES = Number(process.env.MAX_PROJECT_SNAPSHOT_FILES || 24);
const MAX_SNAPSHOT_FILE_BYTES = Number(process.env.MAX_PROJECT_SNAPSHOT_FILE_BYTES || 256 * 1024);
const MAX_SNAPSHOT_TOTAL_BYTES = Number(process.env.MAX_PROJECT_SNAPSHOT_TOTAL_BYTES || 900 * 1024);
const MAX_VISIBLE_TEXT_ITEMS = 80;
const MAX_JS_TEXT_ITEMS = 80;
const SNAPSHOT_BUILD_FIELDS = [
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
  'artifactFiles',
  'sourceFiles',
  'artifactFilesSource',
  'sourceSummary',
  'indexedFiles',
  'createdAt',
  'updatedAt',
].join(' ');

const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.jsx', '.ts', '.tsx']);
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const SKIPPED_BASENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
const CODE_STRING_STOPWORDS = new Set([
  'a',
  'alt',
  'app',
  'aria',
  'assets',
  'body',
  'button',
  'children',
  'class',
  'classname',
  'div',
  'false',
  'fragment',
  'head',
  'header',
  'href',
  'html',
  'id',
  'img',
  'index',
  'jsx',
  'jsxs',
  'main',
  'module',
  'modulepreload',
  'nav',
  'p',
  'rel',
  'role',
  'root',
  'script',
  'section',
  'src',
  'stylesheet',
  'true',
  'type',
  'vite',
]);

const snapshotCache = new Map();

function hashProjectId(projectId) {
  return crypto.createHash('sha256').update(String(projectId || '')).digest('hex').slice(0, 12);
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeLine(value, maxLength = 180) {
  return compactWhitespace(decodeHtmlEntities(stripHtmlTags(value))).slice(0, maxLength);
}

function uniqPush(list, value, maxItems = Infinity) {
  const normalized = compactWhitespace(value);

  if (!normalized || list.includes(normalized) || list.length >= maxItems) {
    return;
  }

  list.push(normalized);
}

function safeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function buildCacheKey(project, build) {
  if (!project || !build) {
    return '';
  }

  return [
    String(project._id),
    String(build._id || ''),
    String(build.status || ''),
    safeDate(build.updatedAt),
    safeDate(build.createdAt),
  ].join(':');
}

function invalidateProjectSnapshotCache(projectId) {
  const prefix = `${String(projectId || '')}:`;

  for (const key of snapshotCache.keys()) {
    if (key.startsWith(prefix)) {
      snapshotCache.delete(key);
    }
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const valueCode = Number(code);
      return Number.isFinite(valueCode) ? String.fromCodePoint(valueCode) : '';
    });
}

function stripHtmlTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function removeHtmlInvisibleBlocks(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
}

function extractTagTexts(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const texts = [];
  let match;

  while ((match = pattern.exec(html)) && texts.length < 40) {
    const text = normalizeLine(match[1]);
    if (text) texts.push(text);
  }

  return texts;
}

function extractAttributeValues(html, attributeName) {
  const pattern = new RegExp(`\\b${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi');
  const values = [];
  let match;

  while ((match = pattern.exec(html)) && values.length < 40) {
    const value = normalizeLine(match[2] || match[3] || match[4] || '');
    if (value) values.push(value);
  }

  return values;
}

function extractHtmlSnapshot(html) {
  const visibleHtml = removeHtmlInvisibleBlocks(html);
  const title = normalizeLine((String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const headings = [];
  const buttons = [];
  const navigation = [];
  const visibleTexts = [];
  const structure = [];

  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag) => {
    extractTagTexts(visibleHtml, tag).forEach((text) => uniqPush(headings, text, 30));
  });

  extractTagTexts(visibleHtml, 'button').forEach((text) => uniqPush(buttons, text, 30));
  extractAttributeValues(visibleHtml, 'aria-label').forEach((text) => uniqPush(buttons, text, 30));
  extractAttributeValues(visibleHtml, 'value').forEach((text) => uniqPush(buttons, text, 30));
  extractTagTexts(visibleHtml, 'nav').forEach((text) => uniqPush(navigation, text, 20));

  const body = (visibleHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [null, visibleHtml])[1] || '';
  decodeHtmlEntities(stripHtmlTags(body))
    .split(/[\n\r]|(?<=[.!?])\s+|\s{2,}/)
    .map((text) => compactWhitespace(text).slice(0, 220))
    .filter((text) => text.length >= 2)
    .forEach((text) => uniqPush(visibleTexts, text, MAX_VISIBLE_TEXT_ITEMS));

  const structurePattern = /<(header|nav|main|section|article|aside|footer|form|input|button|a|h[1-6])\b/gi;
  let match;

  while ((match = structurePattern.exec(visibleHtml)) && structure.length < 40) {
    uniqPush(structure, match[1].toLowerCase(), 40);
  }

  return { title, headings, buttons, navigation, visibleTexts, structure };
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

function normalizeArtifactPath(file, fallbackPath = '') {
  return String(file?.relativePath || file?.path || fallbackPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSourceMapPath(relativePath) {
  return String(relativePath || '').toLowerCase().endsWith('.map');
}

function shouldSkipSnapshotPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').toLowerCase();
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized);

  return (
    !normalized ||
    isSourceMapPath(normalized) ||
    isProjectFileSensitive(normalized) ||
    SKIPPED_BASENAMES.has(basename) ||
    !TEXT_EXTENSIONS.has(extension)
  );
}

function looksSensitiveForSnapshot(relativePath, content) {
  const basename = path.posix.basename(String(relativePath || '').toLowerCase());
  const text = String(content || '');

  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(text)) return true;
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/.test(text)) return true;
  if (/mongodb(?:\+srv)?:\/\/[^\s'"<>]+/i.test(text)) return true;
  if (/\b(?:token|secret|api[_-]?key|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{24,}/i.test(text)) return true;
  if (/\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|DATABASE_URL|MONGODB_URI|STRIPE_SECRET_KEY|OPENAI_API_KEY)\s*=/.test(text)) return true;

  return false;
}

function readJsStringLiteral(source, start) {
  const quote = source[start];
  let value = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      const next = source[index + 1];
      if (next === 'n' || next === 'r' || next === 't') value += ' ';
      else if (next) value += next;
      index += 2;
      continue;
    }

    if (char === quote) {
      return { value, end: index + 1 };
    }

    if ((quote !== '`' && (char === '\n' || char === '\r')) || (quote === '`' && char === '$' && source[index + 1] === '{')) {
      return { value: '', end: index + 1 };
    }

    value += char;
    index += 1;
  }

  return { value: '', end: source.length };
}

function isLikelyVisibleString(value) {
  const text = compactWhitespace(value);
  const lower = text.toLowerCase();

  if (text.length < 2 || text.length > 160) return false;
  if (!/[A-Za-zÀ-ÿ0-9]/.test(text)) return false;
  if (/^(?:[.#/]|\.\.?\/|https?:|data:|@|--)/i.test(text)) return false;
  if (/[{};]/.test(text)) return false;
  if (/\.(?:js|mjs|css|png|jpe?g|webp|svg|woff2?|map)$/i.test(text)) return false;
  if (CODE_STRING_STOPWORDS.has(lower)) return false;
  if (/^[a-z0-9_-]{2,24}$/.test(text) && !/[A-ZÀ-Ý]/.test(text) && !/\s/.test(text)) return false;

  return true;
}

function extractJsStrings(source) {
  const texts = [];
  let index = 0;

  while (index < source.length && texts.length < MAX_JS_TEXT_ITEMS) {
    const char = source[index];

    if (char !== '"' && char !== "'" && char !== '`') {
      index += 1;
      continue;
    }

    const literal = readJsStringLiteral(source, index);
    const value = compactWhitespace(decodeHtmlEntities(literal.value));

    if (isLikelyVisibleString(value)) {
      uniqPush(texts, value, MAX_JS_TEXT_ITEMS);
    }

    index = literal.end;
  }

  return texts;
}

function extractComponentNamesFromCode(source, relativePath = '') {
  const names = [];
  const basename = path.posix.basename(String(relativePath || ''), path.posix.extname(String(relativePath || '')));

  if (/^[A-Z][A-Za-z0-9]*$/.test(basename)) {
    uniqPush(names, basename, 30);
  }

  const patterns = [
    /\b(?:function|class)\s+([A-Z][A-Za-z0-9]*)\b/g,
    /\b(?:const|let|var)\s+([A-Z][A-Za-z0-9]*)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_$]+)?\s*=>/g,
    /\bexport\s+default\s+([A-Z][A-Za-z0-9]*)\b/g,
  ];

  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(source)) && names.length < 30) {
      uniqPush(names, match[1], 30);
    }
  });

  return names;
}

function mergeSnapshotData(target, partial) {
  if (!partial) return;

  if (partial.title && !target.title) target.title = partial.title;
  (partial.headings || []).forEach((text) => uniqPush(target.headings, text, 30));
  (partial.buttons || []).forEach((text) => uniqPush(target.buttons, text, 30));
  (partial.navigation || []).forEach((text) => uniqPush(target.navigation, text, 20));
  (partial.visibleTexts || []).forEach((text) => uniqPush(target.visibleTexts, text, MAX_VISIBLE_TEXT_ITEMS));
  (partial.structure || []).forEach((text) => uniqPush(target.structure, text, 40));
}

function processSnapshotFile(file, data) {
  const relativePath = file.relativePath;
  const extension = path.posix.extname(relativePath).toLowerCase();
  const content = String(file.content || '').slice(0, MAX_SNAPSHOT_FILE_BYTES);

  if (!content || looksSensitiveForSnapshot(relativePath, content)) {
    data.skippedFiles += 1;
    return;
  }

  data.filesProcessed += 1;
  data.bytesProcessed += Buffer.byteLength(content, 'utf8');
  data.filePaths.push(relativePath);

  if (HTML_EXTENSIONS.has(extension)) {
    mergeSnapshotData(data, extractHtmlSnapshot(content));
  }

  if (JS_EXTENSIONS.has(extension)) {
    extractJsStrings(content).forEach((text) => uniqPush(data.jsTexts, text, MAX_JS_TEXT_ITEMS));
    extractComponentNamesFromCode(content, relativePath).forEach((name) => uniqPush(data.components, name, 30));
  }
}

async function collectFilesFromBuildFields(build) {
  const files = [];

  if (build.fullHtml) files.push({ relativePath: 'index.html', content: build.fullHtml });
  else if (build.html) files.push({ relativePath: 'index.html', content: build.html });
  if (build.css) files.push({ relativePath: 'style.css', content: build.css });
  if (build.js) files.push({ relativePath: 'script.js', content: build.js });

  (Array.isArray(build.artifactFiles) ? build.artifactFiles : []).forEach((file) => {
    const relativePath = normalizeArtifactPath(file);
    if (!relativePath) return;
    files.push({ relativePath, content: decodeBuildFileContent(file) });
  });

  return files;
}

async function collectFilesFromPublicBuild(projectId, build) {
  const urls = [build.previewUrl, build.buildUrl, build.deployUrl, build.distUrl];
  let buildKey = '';

  for (const url of urls) {
    const parsed = parsePublicBuildUrl(url);
    if (parsed && parsed.projectId === String(projectId)) {
      buildKey = parsed.buildKey;
      break;
    }
  }

  if (!buildKey) return [];

  const rootDir = path.resolve(PUBLIC_BUILDS_DIR, String(projectId), buildKey);
  const buildsRoot = path.resolve(PUBLIC_BUILDS_DIR);

  if (rootDir !== buildsRoot && !rootDir.startsWith(`${buildsRoot}${path.sep}`)) {
    return [];
  }

  const files = [];
  const queue = [''];

  while (queue.length && files.length < MAX_SNAPSHOT_FILES) {
    const current = queue.shift();
    const absoluteDir = path.join(rootDir, current);
    let entries;

    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return files;
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = path.posix.join(current, entry.name);
      const absolutePath = path.join(rootDir, relativePath);

      if (entry.isDirectory()) {
        if (!['node_modules', '.git'].includes(entry.name)) queue.push(relativePath);
        continue;
      }

      if (entry.isSymbolicLink() || shouldSkipSnapshotPath(relativePath) || files.length >= MAX_SNAPSHOT_FILES) {
        continue;
      }

      const stats = await fs.stat(absolutePath);
      if (!stats.isFile() || stats.size > MAX_SNAPSHOT_FILE_BYTES) {
        continue;
      }

      const buffer = await fs.readFile(absolutePath);
      if (!isLikelyTextBuffer(buffer)) {
        continue;
      }

      files.push({
        relativePath,
        content: buffer.toString('utf8'),
      });
    }
  }

  return files;
}

async function collectBuildSnapshotFiles(projectId, build) {
  const files = await collectFilesFromBuildFields(build);
  const seen = new Set(files.map((file) => file.relativePath));
  const publicFiles = await collectFilesFromPublicBuild(projectId, build);

  publicFiles.forEach((file) => {
    if (!seen.has(file.relativePath)) {
      files.push(file);
      seen.add(file.relativePath);
    }
  });

  return files
    .filter((file) => !shouldSkipSnapshotPath(file.relativePath))
    .slice(0, MAX_SNAPSHOT_FILES);
}

async function queryOne(query, sort = null) {
  const selection = ProjectBuild.findOne(query);
  const sorted = sort && typeof selection.sort === 'function' ? selection.sort(sort) : selection;
  const selected = typeof sorted.select === 'function' ? sorted.select(SNAPSHOT_BUILD_FIELDS) : sorted;
  const lean = typeof selected.lean === 'function' ? selected.lean() : selected;
  return lean && typeof lean.then === 'function' ? lean : Promise.resolve(lean);
}

async function resolveCurrentProjectBuild(project) {
  if (!project?._id) {
    return { build: null, reason: 'missing_project' };
  }

  const projectId = project._id;
  let publishedBuild = null;

  if (project.latestPublishedBuildId) {
    publishedBuild = await queryOne({
      _id: project.latestPublishedBuildId,
      projectId,
      status: 'done',
    });
  }

  if (publishedBuild) {
    return { build: publishedBuild, reason: 'latest_published_done' };
  }

  const doneBuild = await queryOne(
    { projectId, status: 'done' },
    { createdAt: -1, updatedAt: -1, _id: -1 }
  );

  if (doneBuild) {
    return { build: doneBuild, reason: 'latest_done' };
  }

  const draftBuild = await queryOne(
    {
      projectId,
      status: 'draft',
      $or: [
        { fullHtml: { $ne: '' } },
        { html: { $ne: '' } },
        { 'artifactFiles.0': { $exists: true } },
        { previewUrl: { $regex: /\/builds\// } },
        { buildUrl: { $regex: /\/builds\// } },
        { distUrl: { $regex: /\/builds\// } },
      ],
    },
    { createdAt: -1, updatedAt: -1, _id: -1 }
  );

  if (draftBuild) {
    return { build: draftBuild, reason: 'latest_draft_preview' };
  }

  return { build: null, reason: 'no_done_or_draft_build' };
}

function buildProjectDisplayName(project) {
  return compactWhitespace(project?.appName || project?.title || project?.name || 'Projeto sem nome').slice(0, 120);
}

function extractComponentsFromIndexedFiles(indexedFiles = []) {
  const names = [];

  (Array.isArray(indexedFiles) ? indexedFiles : []).forEach((file) => {
    const relativePath = String(file?.path || '');
    const excerpt = String(file?.excerpt || '');
    extractComponentNamesFromCode(excerpt, relativePath).forEach((name) => uniqPush(names, name, 30));
  });

  return names;
}

function formatList(label, values, fallback = 'nenhum identificado') {
  return `${label}: ${values && values.length ? values.join(' | ') : fallback}`;
}

function formatSnapshot({ project, build, reason, data, absenceReason = '' }) {
  const projectName = buildProjectDisplayName(project);
  const buildId = build?._id ? String(build._id) : '';
  const buildVersion = safeDate(build?.updatedAt || build?.createdAt) || 'sem timestamp';
  const lines = [
    'CURRENT PROJECT SNAPSHOT',
    'Use this snapshot as the authoritative current project context. If the user asks what is visible in the home/preview, answer only from the visible text/headings/navigation/buttons below. If this block has no visible content, say you could not inspect the project instead of inventing.',
    `Project: ${projectName}`,
    buildId ? `Build: id=${buildId}; status=${build.status || 'unknown'}; type=${build.type || 'unknown'}; selectedBy=${reason}; version=${buildVersion}` : `Build: unavailable; reason=${absenceReason || reason || 'unknown'}`,
    `Files processed: ${data.filesProcessed}; bytes=${data.bytesProcessed}; skipped=${data.skippedFiles}; limited=${data.limited ? 'yes' : 'no'}`,
    data.filePaths.length ? `Files: ${data.filePaths.slice(0, 16).join(', ')}` : '',
    data.title ? `Title: ${data.title}` : '',
    formatList('Headings', data.headings),
    formatList('Navigation', data.navigation),
    formatList('Buttons', data.buttons),
    formatList('Visible text', [...data.visibleTexts, ...data.jsTexts].slice(0, MAX_VISIBLE_TEXT_ITEMS)),
    formatList('Main structure', data.structure),
    formatList('Relevant components', data.components),
    'END CURRENT PROJECT SNAPSHOT',
  ].filter(Boolean);

  return lines.join('\n').slice(0, MAX_SNAPSHOT_CHARS);
}

function emptySnapshotData() {
  return {
    title: '',
    headings: [],
    buttons: [],
    navigation: [],
    visibleTexts: [],
    jsTexts: [],
    structure: [],
    components: [],
    filePaths: [],
    filesProcessed: 0,
    bytesProcessed: 0,
    skippedFiles: 0,
    limited: false,
  };
}

function logSnapshotSelection(project, build, reason, data, absenceReason = '') {
  console.info('[chat] project snapshot', {
    projectIdHash: hashProjectId(project?._id),
    buildId: build?._id ? String(build._id) : '',
    selectedBy: reason || '',
    filesProcessed: data.filesProcessed,
    bytesProcessed: data.bytesProcessed,
    absenceReason,
  });
}

async function createCurrentProjectSnapshot(project) {
  const { build, reason } = await resolveCurrentProjectBuild(project);
  const data = emptySnapshotData();

  if (!build) {
    const snapshot = formatSnapshot({ project, build: null, reason, data, absenceReason: reason });
    logSnapshotSelection(project, null, reason, data, reason);
    return {
      available: false,
      reason,
      build: null,
      promptBlock: snapshot,
      log: {
        projectIdHash: hashProjectId(project?._id),
        buildId: '',
        selectedBy: reason,
        filesProcessed: 0,
        bytesProcessed: 0,
        absenceReason: reason,
      },
    };
  }

  const cacheKey = buildCacheKey(project, build);
  if (snapshotCache.has(cacheKey)) {
    const cached = snapshotCache.get(cacheKey);
    console.info('[chat] project snapshot', {
      projectIdHash: cached.log.projectIdHash,
      buildId: cached.log.buildId,
      selectedBy: cached.log.selectedBy,
      filesProcessed: cached.log.filesProcessed,
      bytesProcessed: cached.log.bytesProcessed,
      absenceReason: cached.log.absenceReason,
    });
    return cached;
  }

  const files = await collectBuildSnapshotFiles(project._id, build);

  for (const file of files) {
    if (data.filesProcessed >= MAX_SNAPSHOT_FILES || data.bytesProcessed >= MAX_SNAPSHOT_TOTAL_BYTES) {
      data.limited = true;
      break;
    }

    processSnapshotFile(file, data);
  }

  extractComponentsFromIndexedFiles(build.indexedFiles).forEach((name) => uniqPush(data.components, name, 30));

  if (data.bytesProcessed >= MAX_SNAPSHOT_TOTAL_BYTES || files.length >= MAX_SNAPSHOT_FILES) {
    data.limited = true;
  }

  const available = data.visibleTexts.length > 0 || data.jsTexts.length > 0 || data.headings.length > 0 || data.title;
  const absenceReason = available ? '' : 'no_visible_snapshot_content';
  const result = {
    available,
    reason: available ? reason : absenceReason,
    build,
    promptBlock: formatSnapshot({ project, build, reason, data, absenceReason }),
    log: {
      projectIdHash: hashProjectId(project?._id),
      buildId: String(build._id || ''),
      selectedBy: reason,
      filesProcessed: data.filesProcessed,
      bytesProcessed: data.bytesProcessed,
      absenceReason,
    },
  };

  snapshotCache.set(cacheKey, result);
  logSnapshotSelection(project, build, reason, data, absenceReason);
  return result;
}

module.exports = {
  CODE_STRING_STOPWORDS,
  createCurrentProjectSnapshot,
  extractHtmlSnapshot,
  extractJsStrings,
  hashProjectId,
  invalidateProjectSnapshotCache,
  looksSensitiveForSnapshot,
  resolveCurrentProjectBuild,
};
