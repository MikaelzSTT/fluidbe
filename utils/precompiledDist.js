const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { scanBuildSecurity } = require('./projectPublication');

const MAX_PRECOMPILED_DIST_FILES = Number(process.env.MAX_REACT_VITE_DIST_FILES || 1000);
const MAX_PRECOMPILED_DIST_ENTRIES = MAX_PRECOMPILED_DIST_FILES * 2;
const MAX_PRECOMPILED_DIST_FILE_BYTES = Number(
  process.env.MAX_REACT_VITE_DIST_FILE_BYTES || 10 * 1024 * 1024
);
const MAX_PRECOMPILED_DIST_TOTAL_BYTES = Number(
  process.env.MAX_REACT_VITE_DIST_TOTAL_BYTES || 50 * 1024 * 1024
);
const MAX_PRECOMPILED_DIST_COMPRESSION_RATIO = 100;
const INVALID_PRECOMPILED_DIST_MESSAGE =
  'ZIP de dist inválido. Envie arquivos estáticos compilados com index.html na raiz ou um projeto React/Vite com dist/index.html.';
const INVALID_PRECOMPILED_DIST_CODE = 'INVALID_PRECOMPILED_DIST_ZIP';
const PRECOMPILED_DIST_FORMATS = Object.freeze({
  DIRECT_DIST: 'direct_dist',
  PROJECT_WITH_DIST: 'project_with_dist',
});

const ALLOWED_STATIC_EXTENSIONS = new Set([
  '.avif', '.bmp', '.css', '.csv', '.eot', '.gif', '.html', '.ico', '.jpeg', '.jpg',
  '.js', '.json', '.map', '.mjs', '.mp3', '.mp4', '.ogg', '.otf', '.pdf', '.png',
  '.svg', '.ttf', '.txt', '.webmanifest', '.webm', '.webp', '.woff', '.woff2', '.xml',
]);
const FORBIDDEN_SOURCE_SEGMENTS = new Set([
  '.git', '.github', '.vite', 'node_modules', 'src', 'source',
]);
const FORBIDDEN_SOURCE_FILES = new Set([
  'bun.lock', 'bun.lockb', 'package-lock.json', 'package.json', 'pnpm-lock.yaml',
  'yarn.lock',
]);
const FORBIDDEN_SOURCE_FILE_PATTERNS = [
  /^tsconfig(?:\..+)?\.json$/i,
  /^vite\.config(?:\..+)?$/i,
];

function createInvalidPrecompiledDistError(reason = '') {
  const error = new Error(INVALID_PRECOMPILED_DIST_MESSAGE);
  error.code = INVALID_PRECOMPILED_DIST_CODE;
  error.reason = reason;
  return error;
}

function normalizedZipPath(entryName) {
  const rawName = String(entryName || '').replace(/\\/g, '/');

  if (
    !rawName ||
    rawName.includes('\0') ||
    rawName.startsWith('/') ||
    /^[a-z]:\//i.test(rawName)
  ) {
    throw createInvalidPrecompiledDistError('invalid_path');
  }

  const withoutTrailingSlash = rawName.replace(/\/+$/, '');
  const segments = withoutTrailingSlash.split('/');

  if (
    !withoutTrailingSlash ||
    Buffer.byteLength(withoutTrailingSlash, 'utf8') > 512 ||
    segments.length > 20 ||
    /[\x00-\x1f\x7f]/.test(withoutTrailingSlash) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw createInvalidPrecompiledDistError('path_traversal');
  }

  return segments.join('/');
}

function getUnixMode(entry) {
  return (Number(entry.attr) >>> 16) & 0xffff;
}

function assertRegularNonExecutableEntry(entry) {
  const mode = getUnixMode(entry);
  const fileType = mode & 0o170000;

  if (fileType === 0o120000) {
    throw createInvalidPrecompiledDistError('symlink');
  }

  if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
    throw createInvalidPrecompiledDistError('special_file');
  }

  if (!entry.isDirectory && (mode & 0o111) !== 0) {
    throw createInvalidPrecompiledDistError('executable_mode');
  }
}

function assertStaticFilePath(relativePath) {
  const segments = relativePath.split('/');
  const basename = segments[segments.length - 1];
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const lowerBasename = basename.toLowerCase();

  if (
    lowerSegments.some((segment) => segment.startsWith('.')) ||
    lowerSegments.some((segment) => FORBIDDEN_SOURCE_SEGMENTS.has(segment)) ||
    FORBIDDEN_SOURCE_FILES.has(lowerBasename) ||
    FORBIDDEN_SOURCE_FILE_PATTERNS.some((pattern) => pattern.test(lowerBasename))
  ) {
    throw createInvalidPrecompiledDistError('source_file');
  }

  const extension = path.posix.extname(lowerBasename);
  if (!ALLOWED_STATIC_EXTENSIONS.has(extension)) {
    throw createInvalidPrecompiledDistError('dangerous_extension');
  }
}

function isPathInsideRoot(relativePath, rootPath) {
  return rootPath === '' || relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function stripRootPath(relativePath, rootPath) {
  if (!rootPath) {
    return relativePath;
  }

  if (relativePath === rootPath) {
    return '';
  }

  return relativePath.slice(rootPath.length + 1);
}

function hasExecutableSignature(data) {
  if (!Buffer.isBuffer(data) || data.length < 2) {
    return false;
  }

  if (data[0] === 0x23 && data[1] === 0x21) {
    return true;
  }

  if (data[0] === 0x4d && data[1] === 0x5a) {
    return true;
  }

  if (data.length >= 4) {
    const prefix = data.subarray(0, 4).toString('hex');
    return new Set([
      '7f454c46',
      'cafebabe',
      'cefaedfe',
      'cffaedfe',
      'feedface',
      'feedfacf',
    ]).has(prefix);
  }

  return false;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inspectPrecompiledDistZip(zipPath, options = {}) {
  const maxFiles = Number(options.maxFiles || MAX_PRECOMPILED_DIST_FILES);
  const maxEntries = Number(options.maxEntries || MAX_PRECOMPILED_DIST_ENTRIES);
  const maxZipFiles = Number(options.maxZipFiles || maxEntries);
  const maxFileBytes = Number(options.maxFileBytes || MAX_PRECOMPILED_DIST_FILE_BYTES);
  const maxTotalBytes = Number(options.maxTotalBytes || MAX_PRECOMPILED_DIST_TOTAL_BYTES);
  let zip;

  try {
    zip = new AdmZip(zipPath);
  } catch (error) {
    throw createInvalidPrecompiledDistError('invalid_zip');
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch (error) {
    throw createInvalidPrecompiledDistError('invalid_zip');
  }

  if (!entries.length) {
    throw createInvalidPrecompiledDistError('empty_zip');
  }

  if (entries.length > maxEntries) {
    throw createInvalidPrecompiledDistError('entry_limit');
  }

  const inspectedEntries = [];
  const paths = new Map();
  const validDistRoots = new Set();
  let zipFileCount = 0;
  let zipTotalBytes = 0;
  let rootIndex = false;
  let topLevelDist = false;
  let nestedDist = false;

  for (const entry of entries) {
    const relativePath = normalizedZipPath(entry.entryName);
    const pathKey = relativePath.toLowerCase();
    const segments = relativePath.split('/');
    const lowerSegments = segments.map((segment) => segment.toLowerCase());

    if (paths.has(pathKey)) {
      throw createInvalidPrecompiledDistError('duplicate_path');
    }

    assertRegularNonExecutableEntry(entry);
    paths.set(pathKey, entry.isDirectory ? 'directory' : 'file');
    topLevelDist ||= lowerSegments[0] === 'dist';
    nestedDist ||= lowerSegments.some((segment, index) => segment === 'dist' && index > 0);

    if (entry.isDirectory) {
      inspectedEntries.push({ entry, relativePath, isDirectory: true });
      continue;
    }

    zipFileCount += 1;
    const uncompressedBytes = Number(entry.header.size);
    const compressedBytes = Number(entry.header.compressedSize);

    if (
      zipFileCount > maxZipFiles ||
      !Number.isSafeInteger(uncompressedBytes) ||
      !Number.isSafeInteger(compressedBytes) ||
      uncompressedBytes < 0 ||
      compressedBytes < 0 ||
      uncompressedBytes > maxFileBytes ||
      zipTotalBytes + uncompressedBytes > maxTotalBytes ||
      (uncompressedBytes > 0 &&
        uncompressedBytes / Math.max(compressedBytes, 1) > MAX_PRECOMPILED_DIST_COMPRESSION_RATIO) ||
      (Number(entry.header.flags) & 0x1) !== 0
    ) {
      throw createInvalidPrecompiledDistError('size_or_encryption_limit');
    }

    rootIndex ||= relativePath === 'index.html';
    if (segments[segments.length - 1] === 'index.html') {
      for (let index = 0; index < lowerSegments.length - 1; index += 1) {
        if (lowerSegments[index] === 'dist' && index === lowerSegments.length - 2) {
          validDistRoots.add(segments.slice(0, index + 1).join('/'));
        }
      }
    }

    zipTotalBytes += uncompressedBytes;
    inspectedEntries.push({ entry, relativePath, isDirectory: false, size: uncompressedBytes });
  }

  for (const relativePath of paths.keys()) {
    const segments = relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (paths.get(parent) === 'file') {
        throw createInvalidPrecompiledDistError('file_directory_collision');
      }
    }
  }

  if (validDistRoots.size > 1) {
    throw createInvalidPrecompiledDistError('ambiguous_dist');
  }

  let format;
  let selectedRoot = '';

  if (validDistRoots.has('dist')) {
    format = PRECOMPILED_DIST_FORMATS.PROJECT_WITH_DIST;
    selectedRoot = 'dist';
  } else if (validDistRoots.size === 1 || nestedDist) {
    throw createInvalidPrecompiledDistError('nested_dist');
  } else if (topLevelDist) {
    throw createInvalidPrecompiledDistError('missing_index');
  } else if (rootIndex) {
    format = PRECOMPILED_DIST_FORMATS.DIRECT_DIST;
  } else {
    throw createInvalidPrecompiledDistError('missing_index');
  }

  const selectedEntries = [];
  let fileCount = 0;
  let totalBytes = 0;
  let hasIndex = false;

  for (const inspected of inspectedEntries) {
    if (!isPathInsideRoot(inspected.relativePath, selectedRoot)) {
      continue;
    }

    const publishPath = stripRootPath(inspected.relativePath, selectedRoot);
    if (!publishPath) {
      continue;
    }

    if (publishPath.split('/').some((segment) => segment.toLowerCase() === 'dist')) {
      throw createInvalidPrecompiledDistError('nested_dist');
    }

    if (!inspected.isDirectory) {
      assertStaticFilePath(publishPath);
      fileCount += 1;
      if (fileCount > maxFiles || totalBytes + inspected.size > maxTotalBytes) {
        throw createInvalidPrecompiledDistError('size_or_encryption_limit');
      }
      hasIndex ||= publishPath === 'index.html';
      totalBytes += inspected.size;
    }

    selectedEntries.push({ ...inspected, relativePath: publishPath });
  }

  if (!hasIndex) {
    throw createInvalidPrecompiledDistError('missing_index');
  }

  return {
    entries: selectedEntries,
    fileCount,
    format,
    totalBytes,
    zipEntryCount: entries.length,
    zipFileCount,
    zipTotalBytes,
  };
}

async function extractPrecompiledDistZipSafely(zipPath, destinationDir, options = {}) {
  const manifest = inspectPrecompiledDistZip(zipPath, options);
  const destinationRoot = path.resolve(destinationDir);

  try {
    await fs.mkdir(path.dirname(destinationRoot), { recursive: true, mode: 0o700 });
    await fs.mkdir(destinationRoot, { recursive: false, mode: 0o700 });

    for (const inspected of manifest.entries) {
      const targetPath = path.resolve(destinationRoot, inspected.relativePath);
      if (!targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw createInvalidPrecompiledDistError('path_traversal');
      }

      if (inspected.isDirectory) {
        await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
        continue;
      }

      let data;
      try {
        data = inspected.entry.getData();
      } catch (error) {
        throw createInvalidPrecompiledDistError('invalid_entry');
      }

      if (data.length !== inspected.size || hasExecutableSignature(data)) {
        throw createInvalidPrecompiledDistError('executable_or_invalid_content');
      }

      inspected.sha256 = sha256Buffer(data);
      await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(targetPath, data, { flag: 'wx', mode: 0o600 });
    }

    return manifest;
  } catch (error) {
    await fs.rm(destinationRoot, { recursive: true, force: true }).catch(() => {});
    if (error?.code === INVALID_PRECOMPILED_DIST_CODE) {
      throw error;
    }
    throw createInvalidPrecompiledDistError('extraction_failed');
  }
}

async function scanPrecompiledDistSecurity(validation) {
  const artifactFiles = [];

  for (const file of validation.files) {
    artifactFiles.push({
      relativePath: file.relativePath,
      path: file.relativePath,
      content: await fs.readFile(file.absolutePath, 'utf8'),
    });
  }

  return scanBuildSecurity({ artifactFiles });
}

async function assertPrecompiledDistSecurityAllowsPublication(validation) {
  const securityScan = await scanPrecompiledDistSecurity(validation);
  const criticalFindings = securityScan.findings.filter(
    (finding) => finding.severity === 'critical'
  ).length;

  if (securityScan.status === 'blocked' || criticalFindings > 0) {
    const error = new Error('Build blocked by security scan.');
    error.code = 'BUILD_SECURITY_BLOCKED';
    error.security = {
      status: 'blocked',
      criticalFindings,
    };
    throw error;
  }

  return securityScan;
}

module.exports = {
  ALLOWED_STATIC_EXTENSIONS,
  INVALID_PRECOMPILED_DIST_CODE,
  INVALID_PRECOMPILED_DIST_MESSAGE,
  PRECOMPILED_DIST_FORMATS,
  assertPrecompiledDistSecurityAllowsPublication,
  extractPrecompiledDistZipSafely,
  inspectPrecompiledDistZip,
  scanPrecompiledDistSecurity,
};
