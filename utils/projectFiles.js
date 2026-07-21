const fs = require('fs/promises');
const path = require('path');
const ProjectBuild = require('../models/ProjectBuild');
const { parseBuildPathFromUrl } = require('./previewOrigin');

const ROOT_DIR = path.resolve(__dirname, '..');
const REACT_VITE_STORAGE_DIR = path.join(ROOT_DIR, 'storage', 'react-vite-builds');
const PUBLIC_BUILDS_DIR = path.join(ROOT_DIR, 'public', 'builds');
const MAX_PROJECT_FILE_CONTENT_BYTES = Number(process.env.MAX_PROJECT_FILE_CONTENT_BYTES || 512 * 1024);
const MAX_PROJECT_FILE_TREE_ENTRIES = Number(process.env.MAX_PROJECT_FILE_TREE_ENTRIES || 5000);

const PROJECT_FILE_TREE_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'node_modules',
]);
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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function findProjectSourceRoot(sourceDir) {
  if (await pathExists(path.join(sourceDir, 'package.json'))) {
    return sourceDir;
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const directory of directories) {
    const nestedRoot = path.join(sourceDir, directory.name);

    if (await pathExists(path.join(nestedRoot, 'package.json'))) {
      return nestedRoot;
    }
  }

  return sourceDir;
}

function parsePublicBuildUrl(buildUrl) {
  return parseBuildPathFromUrl(buildUrl);
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

function getProjectArtifactFileMetadata(relativePath, size, isDirectory = false) {
  const name = relativePath ? path.posix.basename(relativePath) : '';
  const ext = isDirectory ? '' : path.extname(name).toLowerCase();

  return {
    path: relativePath,
    name,
    type: isDirectory ? 'folder' : 'file',
    size: isDirectory ? 0 : size,
    ext,
    language: PROJECT_FILE_LANGUAGE_BY_EXT[ext] || ext.replace(/^\./, '') || '',
  };
}

function decodeProjectArtifactContent(artifactFile) {
  return Buffer.from(String(artifactFile.content || ''), 'base64');
}

function normalizeProjectArtifactFiles(artifactFiles = []) {
  const seenPaths = new Set();
  const normalizedFiles = [];

  for (const artifactFile of artifactFiles) {
    if (!artifactFile || typeof artifactFile.content !== 'string') {
      continue;
    }

    const relativePath = normalizeProjectFilePath(
      artifactFile.relativePath || artifactFile.path || ''
    );

    if (
      !relativePath ||
      seenPaths.has(relativePath) ||
      isProjectFileSensitive(relativePath)
    ) {
      continue;
    }

    const contentBuffer = decodeProjectArtifactContent(artifactFile);

    normalizedFiles.push({
      ...artifactFile,
      relativePath,
      path: relativePath,
      size: contentBuffer.length,
    });
    seenPaths.add(relativePath);
  }

  normalizedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return normalizedFiles;
}

async function findLatestProjectArtifactBuild(projectId) {
  const latestBuild = await ProjectBuild.findOne({
    projectId,
    'artifactFiles.0': { $exists: true },
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  }).lean();

  if (!latestBuild) {
    return null;
  }

  const artifactFiles = normalizeProjectArtifactFiles(latestBuild.artifactFiles);

  if (!artifactFiles.length) {
    return null;
  }

  return {
    type: 'artifact',
    buildId: String(latestBuild._id),
    buildKey: String(latestBuild._id),
    artifactFiles,
  };
}

async function findLatestProjectSourceArtifactBuild(projectId) {
  const latestBuild = await ProjectBuild.findOne({
    projectId,
    $or: [
      { 'sourceFiles.0': { $exists: true } },
      { 'artifactFilesSource.0': { $exists: true } },
    ],
  }).sort({
    createdAt: -1,
    updatedAt: -1,
  }).lean();

  if (!latestBuild) {
    return null;
  }

  const artifactFiles = normalizeProjectArtifactFiles(
    latestBuild.sourceFiles && latestBuild.sourceFiles.length
      ? latestBuild.sourceFiles
      : latestBuild.artifactFilesSource
  );

  if (!artifactFiles.length) {
    return null;
  }

  return {
    type: 'sourceArtifact',
    buildId: String(latestBuild._id),
    buildKey: String(latestBuild._id),
    artifactFiles,
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

      const rootDir = await findProjectSourceRoot(sourceDir);
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

  const sourceArtifactRoot = await findLatestProjectSourceArtifactBuild(projectId);

  if (sourceArtifactRoot) {
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

  return findLatestProjectArtifactBuild(projectId);
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

function buildProjectArtifactFileTree(artifactFiles = [], counters = { entries: 0 }) {
  const root = { children: new Map() };

  for (const artifactFile of artifactFiles) {
    if (counters.entries >= MAX_PROJECT_FILE_TREE_ENTRIES) {
      break;
    }

    const relativePath = normalizeProjectFilePath(artifactFile.relativePath || artifactFile.path || '');

    if (!relativePath || isProjectFileSensitive(relativePath)) {
      continue;
    }

    const segments = relativePath.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isFile = index === segments.length - 1;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;

      if (!current.children.has(segment)) {
        if (counters.entries >= MAX_PROJECT_FILE_TREE_ENTRIES) {
          break;
        }

        const item = isFile
          ? getProjectArtifactFileMetadata(currentPath, artifactFile.size || 0, false)
          : {
              ...getProjectArtifactFileMetadata(currentPath, 0, true),
              children: new Map(),
            };

        current.children.set(segment, item);
        counters.entries += 1;
      }

      const child = current.children.get(segment);

      if (isFile || child.type !== 'folder') {
        break;
      }

      current = child;
    }
  }

  function toSortedChildren(childrenMap) {
    return Array.from(childrenMap.values())
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
      })
      .map((item) => {
        if (item.type !== 'folder') {
          return item;
        }

        return {
          ...item,
          children: toSortedChildren(item.children),
        };
      });
  }

  return toSortedChildren(root.children);
}

function resolveProjectArtifactFile(fileRoot, requestPath) {
  const relativePath = normalizeProjectFilePath(requestPath);

  if (relativePath === null) {
    return null;
  }

  if (!relativePath || isProjectFileSensitive(relativePath)) {
    return {
      blocked: Boolean(relativePath && isProjectFileSensitive(relativePath)),
      missing: !relativePath,
      relativePath,
    };
  }

  const artifactFile = (fileRoot.artifactFiles || []).find((file) => (
    file.relativePath === relativePath || file.path === relativePath
  ));

  if (!artifactFile) {
    return {
      missing: true,
      relativePath,
    };
  }

  const contentBuffer = decodeProjectArtifactContent(artifactFile);

  return {
    relativePath,
    contentBuffer,
    metadata: getProjectArtifactFileMetadata(relativePath, contentBuffer.length, false),
  };
}

function isLikelyTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));

  return !sample.includes(0);
}

module.exports = {
  MAX_PROJECT_FILE_CONTENT_BYTES,
  MAX_PROJECT_FILE_TREE_ENTRIES,
  buildProjectArtifactFileTree,
  buildProjectFileTree,
  getProjectFileMetadata,
  isLikelyTextBuffer,
  parsePublicBuildUrl,
  resolveProjectArtifactFile,
  resolveProjectFilePath,
  resolveProjectFileRoot,
};
