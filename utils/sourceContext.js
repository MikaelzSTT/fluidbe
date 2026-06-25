const path = require('path');

const MAX_INDEXED_SOURCE_FILES = 30;
const MAX_INDEXED_FILE_EXCERPT_CHARS = 2000;
const INDEXED_SOURCE_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.jsx', '.json', '.mjs', '.ts', '.tsx', '.yaml', '.yml',
]);
const INDEXED_SOURCE_BINARY_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.ogg', '.wav', '.webm',
]);
const INDEXED_SOURCE_LOCK_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
]);

function isUsefulSourceFile(relativePath) {
  const normalizedPath = String(relativePath || '').replace(/^\.\//, '');
  const lowerPath = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  const extension = path.posix.extname(lowerPath);

  if (
    lowerPath.includes('/node_modules/') || lowerPath.includes('/dist/') ||
    lowerPath.startsWith('node_modules/') || lowerPath.startsWith('dist/') ||
    INDEXED_SOURCE_BINARY_EXTENSIONS.has(extension) ||
    INDEXED_SOURCE_LOCK_FILES.has(basename)
  ) {
    return false;
  }

  if (normalizedPath.startsWith('src/')) {
    return INDEXED_SOURCE_TEXT_EXTENSIONS.has(extension);
  }

  return (
    normalizedPath === 'package.json' ||
    normalizedPath === 'index.html' ||
    /^vite\.config\.(?:js|mjs|ts|mts|cjs|cts)$/.test(basename) ||
    /^tailwind\.config\.(?:js|mjs|ts|mts|cjs|cts)$/.test(basename)
  );
}

function indexedFileKind(relativePath) {
  const normalizedPath = String(relativePath || '').replace(/^\.\//, '');
  const basename = path.posix.basename(normalizedPath).toLowerCase();

  if (normalizedPath === 'package.json') return 'package';
  if (normalizedPath === 'index.html') return 'html';
  if (basename.startsWith('vite.config.')) return 'vite-config';
  if (basename.startsWith('tailwind.config.')) return 'tailwind-config';
  if (normalizedPath.startsWith('src/components/')) return 'component';
  if (normalizedPath.startsWith('src/pages/')) return 'page';
  if (normalizedPath.startsWith('src/routes/')) return 'route';
  return 'source';
}

function decodeSourceFile(file) {
  if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') return '';
  return Buffer.from(file.content, 'base64').toString('utf8');
}

function extractComponentNames(indexedFiles) {
  const components = new Set();

  for (const file of indexedFiles) {
    if (!['component', 'page', 'route'].includes(file.kind)) continue;

    const basename = path.posix.basename(file.path).replace(/\.[^.]+$/, '');
    if (/^[A-Z][A-Za-z0-9]*$/.test(basename)) components.add(basename);

    for (const match of file.excerpt.matchAll(/(?:export\s+(?:default\s+)?(?:function|const|class)|function|const)\s+([A-Z][A-Za-z0-9]*)/g)) {
      components.add(match[1]);
    }
  }

  return [...components].slice(0, 12);
}

function extractRoutePaths(indexedFiles) {
  const routes = new Set();

  for (const file of indexedFiles) {
    if (file.kind === 'page') routes.add(file.path);
    if (file.kind !== 'route' && !/\b(?:Routes|Route|createBrowserRouter|path\s*:)/.test(file.excerpt)) continue;

    for (const match of file.excerpt.matchAll(/\bpath\s*:\s*["']([^"']+)/g)) {
      routes.add(match[1]);
    }
    for (const match of file.excerpt.matchAll(/<Route\b[^>]*\bpath\s*=\s*["']([^"']+)/g)) {
      routes.add(match[1]);
    }
  }

  return [...routes].slice(0, 12);
}

function createSourceContext(sourceFiles) {
  const kindPriority = {
    package: 0,
    html: 1,
    'vite-config': 2,
    'tailwind-config': 3,
    source: 4,
    route: 5,
    page: 6,
    component: 7,
  };
  const indexedFiles = (sourceFiles || [])
    .map((file) => ({ file, path: file.relativePath || file.path || '' }))
    .filter(({ path: relativePath }) => isUsefulSourceFile(relativePath))
    .sort((a, b) => {
      const kindDifference = kindPriority[indexedFileKind(a.path)] - kindPriority[indexedFileKind(b.path)];
      return kindDifference || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_INDEXED_SOURCE_FILES)
    .map(({ file, path: relativePath }) => {
      const content = decodeSourceFile(file);
      return {
        path: relativePath,
        kind: indexedFileKind(relativePath),
        size: Buffer.byteLength(content, 'utf8'),
        excerpt: content.slice(0, MAX_INDEXED_FILE_EXCERPT_CHARS),
      };
    });

  const packageFile = indexedFiles.find((file) => file.path === 'package.json');
  const packageExcerpt = packageFile ? packageFile.excerpt : '';
  const sourceText = indexedFiles.map((file) => file.excerpt).join('\n');
  const framework = /["']react["']\s*:|from\s+["']react["']/.test(sourceText)
    ? (/["']vite["']\s*:|vite\.config\./.test(`${packageExcerpt}\n${sourceText}`) ? 'React com Vite' : 'React')
    : (/["']vite["']\s*:|vite\.config\./.test(`${packageExcerpt}\n${sourceText}`) ? 'Vite' : 'não identificado');
  const mainFiles = indexedFiles
    .filter((file) => ['package', 'html', 'vite-config', 'tailwind-config'].includes(file.kind) || /\/main\.[jt]sx?$|\/App\.[jt]sx?$/.test(file.path))
    .map((file) => file.path)
    .slice(0, 10);
  const components = extractComponentNames(indexedFiles);
  const routes = extractRoutePaths(indexedFiles);
  const summary = [
    `Framework provável: ${framework}.`,
    `Arquivos principais: ${mainFiles.length ? mainFiles.join(', ') : 'não identificados'}.`,
    `Componentes encontrados: ${components.length ? components.join(', ') : 'nenhum identificado'}.`,
    `Rotas/páginas: ${routes.length ? routes.join(', ') : 'nenhuma rota identificada'}.`,
  ].join('\n');

  return { indexedFiles, sourceSummary: summary };
}

module.exports = {
  createSourceContext,
};
