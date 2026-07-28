const acorn = require('acorn');

function appendQueryParam(value, name, paramValue) {
  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : value.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(name)}=${encodeURIComponent(paramValue)}${hash}`;
}

function getCurrentBuildAssetPath(parsedPath) {
  const artifactPath = String(parsedPath?.artifactPath || 'index.html')
    .replace(/^\/+/, '');

  return `/builds/${parsedPath.projectId}/${parsedPath.buildKey}/${artifactPath || 'index.html'}`;
}

function getAllowedAssetOrigins(options = {}) {
  const origins = new Set(['http://localhost']);

  if (typeof options.baseOrigin === 'string' && options.baseOrigin) {
    origins.add(options.baseOrigin);
  }

  for (const origin of options.allowedOrigins || []) {
    if (typeof origin === 'string' && origin) {
      origins.add(origin);
    }
  }

  return origins;
}

function isLikelyBuildAssetReference(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmedValue = value.trim();

  if (
    !trimmedValue ||
    trimmedValue.startsWith('#') ||
    trimmedValue.includes('\\') ||
    /[\s<>]/.test(trimmedValue) ||
    /^(?:data|blob|mailto|tel|javascript):/i.test(trimmedValue)
  ) {
    return false;
  }

  if (
    trimmedValue.startsWith('/builds/') ||
    trimmedValue.startsWith('./') ||
    trimmedValue.startsWith('../') ||
    trimmedValue.startsWith('assets/') ||
    /^https?:\/\//i.test(trimmedValue)
  ) {
    return true;
  }

  return /\.(?:avif|css|gif|html|ico|jpeg|jpg|js|json|mjs|mp3|mp4|ogg|png|svg|ttf|txt|wasm|wav|webm|webp|woff|woff2)(?:[?#]|$)/i.test(trimmedValue);
}

function withBuildPreviewTokenOnAssetUrl(rawValue, parsedPath, previewToken, options = {}) {
  if (typeof rawValue !== 'string' || !rawValue || !previewToken) {
    return rawValue;
  }

  const trimmedValue = rawValue.trim();

  if (
    !trimmedValue ||
    trimmedValue.startsWith('#') ||
    trimmedValue.includes('\\') ||
    /^(?:data|blob|mailto|tel|javascript):/i.test(trimmedValue)
  ) {
    return rawValue;
  }

  let resolvedUrl;
  const basePath = getCurrentBuildAssetPath(parsedPath);
  const allowedOrigins = getAllowedAssetOrigins(options);
  const baseOrigin = typeof options.baseOrigin === 'string' && options.baseOrigin
    ? options.baseOrigin
    : 'http://localhost';

  try {
    resolvedUrl = new URL(trimmedValue, `${baseOrigin}${basePath}`);
  } catch (error) {
    return rawValue;
  }

  const buildBasePath = `/builds/${parsedPath.projectId}/${parsedPath.buildKey}/`;

  if (!allowedOrigins.has(resolvedUrl.origin)) {
    return rawValue;
  }

  if (resolvedUrl.pathname.startsWith(buildBasePath)) {
    if (
      resolvedUrl.pathname === basePath ||
      resolvedUrl.searchParams.has('previewToken')
    ) {
      return rawValue;
    }

    return appendQueryParam(rawValue, 'previewToken', previewToken);
  }

  if (
    options.rewriteRootRelativeAssetUrls === true &&
    resolvedUrl.pathname.startsWith('/') &&
    !resolvedUrl.pathname.startsWith('/builds/') &&
    !trimmedValue.startsWith('//') &&
    isLikelyBuildAssetReference(trimmedValue) &&
    !resolvedUrl.searchParams.has('previewToken')
  ) {
    const scopedUrl = new URL(
      `${resolvedUrl.origin}${buildBasePath.replace(/\/$/, '')}${resolvedUrl.pathname}`
    );
    scopedUrl.search = resolvedUrl.search;
    scopedUrl.hash = resolvedUrl.hash;
    scopedUrl.searchParams.set('previewToken', previewToken);

    return /^[a-z][a-z\d+.-]*:/i.test(trimmedValue)
      ? scopedUrl.toString()
      : `${scopedUrl.pathname}${scopedUrl.search}${scopedUrl.hash}`;
  }

  return rawValue;
}

function injectBuildPreviewTokenIntoHtmlAssets(html, parsedPath, previewToken, options = {}) {
  if (typeof html !== 'string' || !html || !parsedPath || !previewToken) {
    return html || '';
  }

  const rewriteAssetUrl = (value) => withBuildPreviewTokenOnAssetUrl(value, parsedPath, previewToken, options);

  return html
    .replace(
      /\b(src|href)=(["'])([^"']+)\2/gi,
      (match, attributeName, quote, attributeValue) => {
        const rewrittenValue = rewriteAssetUrl(attributeValue);
        return `${attributeName}=${quote}${rewrittenValue}${quote}`;
      }
    )
    .replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `url(${quote}${rewrittenValue}${quote})`;
      }
    );
}

function injectBuildPreviewTokenIntoCodeAssets(code, parsedPath, previewToken, options = {}) {
  if (typeof code !== 'string' || !code || !parsedPath || !previewToken) {
    return code || '';
  }

  const rewriteAssetUrl = (value) => withBuildPreviewTokenOnAssetUrl(value, parsedPath, previewToken, options);
  const replacements = collectJavaScriptAssetReplacements(code, rewriteAssetUrl);

  return applyReplacements(code, replacements);
}

function injectBuildPreviewTokenIntoCssAssets(css, parsedPath, previewToken, options = {}) {
  if (typeof css !== 'string' || !css || !parsedPath || !previewToken) {
    return css || '';
  }

  const rewriteAssetUrl = (value) => withBuildPreviewTokenOnAssetUrl(value, parsedPath, previewToken, options);

  return css
    .replace(
      /(@import\s+)(["'])([^"']+)\2/gi,
      (match, prefix, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `${prefix}${quote}${rewrittenValue}${quote}`;
      }
    )
    .replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `url(${quote}${rewrittenValue}${quote})`;
      }
    );
}

function parseJavaScript(code, sourceType = 'module') {
  return acorn.parse(code, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    sourceType,
  });
}

function assertJavaScriptParses(code, artifactPath = 'transformed JavaScript') {
  try {
    parseJavaScript(code, 'module');
    return;
  } catch (moduleError) {
    try {
      parseJavaScript(code, 'script');
      return;
    } catch (scriptError) {
      const error = new SyntaxError(`Transformed build JavaScript failed to parse: ${artifactPath}`);
      error.code = 'TRANSFORMED_BUILD_JAVASCRIPT_PARSE_ERROR';
      error.moduleParseMessage = moduleError.message;
      error.scriptParseMessage = scriptError.message;
      throw error;
    }
  }
}

function collectJavaScriptAssetReplacements(code, rewriteAssetUrl) {
  let ast;

  try {
    ast = parseJavaScript(code, 'module');
  } catch (moduleError) {
    try {
      ast = parseJavaScript(code, 'script');
    } catch (scriptError) {
      return [];
    }
  }

  const replacements = new Map();

  function addLiteralReplacement(node, options = {}) {
    if (!node || node.type !== 'Literal' || typeof node.value !== 'string') {
      return;
    }

    if (options.requireLikelyBuildAssetReference && !isLikelyBuildAssetReference(node.value)) {
      return;
    }

    const raw = code.slice(node.start, node.end);
    const quote = raw[0];

    if (
      raw.length < 2 ||
      (quote !== '"' && quote !== "'") ||
      raw[raw.length - 1] !== quote ||
      raw.includes('\\')
    ) {
      return;
    }

    const rewrittenValue = rewriteAssetUrl(node.value);

    if (rewrittenValue === node.value) {
      return;
    }

    replacements.set(`${node.start}:${node.end}`, {
      start: node.start,
      end: node.end,
      text: `${quote}${rewrittenValue}${quote}`,
    });
  }

  walkJavaScriptAst(ast, [], (node, ancestors) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      addLiteralReplacement(node.source);
      return;
    }

    if (node.type === 'ImportExpression') {
      addLiteralReplacement(node.source);
      return;
    }

    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Import' &&
      node.arguments.length === 1
    ) {
      addLiteralReplacement(node.arguments[0]);
      return;
    }

    if (isImportMetaUrlNewExpression(node, code)) {
      addLiteralReplacement(node.arguments[0]);
      return;
    }

    if (isViteMapDepsArray(node, ancestors, code)) {
      for (const element of node.elements || []) {
        addLiteralReplacement(element, { requireLikelyBuildAssetReference: true });
      }
    }
  });

  return Array.from(replacements.values()).sort((a, b) => a.start - b.start);
}

function applyReplacements(value, replacements) {
  if (!replacements.length) {
    return value;
  }

  let rewritten = '';
  let cursor = 0;

  for (const replacement of replacements) {
    if (replacement.start < cursor) {
      continue;
    }

    rewritten += value.slice(cursor, replacement.start);
    rewritten += replacement.text;
    cursor = replacement.end;
  }

  return `${rewritten}${value.slice(cursor)}`;
}

function walkJavaScriptAst(node, ancestors, visitor) {
  if (!node || typeof node.type !== 'string') {
    return;
  }

  visitor(node, ancestors);

  const nextAncestors = ancestors.concat(node);

  for (const key of Object.keys(node)) {
    if (
      key === 'type' ||
      key === 'start' ||
      key === 'end' ||
      key === 'loc' ||
      key === 'range'
    ) {
      continue;
    }

    const child = node[key];

    if (Array.isArray(child)) {
      for (const item of child) {
        walkJavaScriptAst(item, nextAncestors, visitor);
      }
    } else if (child && typeof child.type === 'string') {
      walkJavaScriptAst(child, nextAncestors, visitor);
    }
  }
}

function isImportMetaUrlNewExpression(node, code) {
  if (
    !node ||
    node.type !== 'NewExpression' ||
    !node.callee ||
    node.callee.type !== 'Identifier' ||
    node.callee.name !== 'URL' ||
    !Array.isArray(node.arguments) ||
    node.arguments.length < 2 ||
    !node.arguments[0] ||
    node.arguments[0].type !== 'Literal' ||
    typeof node.arguments[0].value !== 'string'
  ) {
    return false;
  }

  const firstArgumentEnd = node.arguments[0].end;
  const callTail = code.slice(firstArgumentEnd, node.end);
  return /^,\s*import\.meta\.url\s*\)$/.test(callTail);
}

function isViteMapDepsArray(node, ancestors, code) {
  if (!node || node.type !== 'ArrayExpression' || !Array.isArray(node.elements)) {
    return false;
  }

  const parent = ancestors[ancestors.length - 1];

  if (
    !parent ||
    parent.type !== 'AssignmentExpression' ||
    !parent.left ||
    parent.left.type !== 'MemberExpression' ||
    getMemberPropertyName(parent.left) !== 'f'
  ) {
    return false;
  }

  return ancestors.some((ancestor) => (
    typeof ancestor.start === 'number' &&
    typeof ancestor.end === 'number' &&
    code.slice(ancestor.start, ancestor.end).includes('__vite__mapDeps')
  ));
}

function getMemberPropertyName(memberExpression) {
  if (!memberExpression || !memberExpression.property) {
    return '';
  }

  if (!memberExpression.computed && memberExpression.property.type === 'Identifier') {
    return memberExpression.property.name;
  }

  if (memberExpression.property.type === 'Literal') {
    return String(memberExpression.property.value || '');
  }

  return '';
}

module.exports = {
  assertJavaScriptParses,
  injectBuildPreviewTokenIntoCodeAssets,
  injectBuildPreviewTokenIntoCssAssets,
  injectBuildPreviewTokenIntoHtmlAssets,
  withBuildPreviewTokenOnAssetUrl,
};
