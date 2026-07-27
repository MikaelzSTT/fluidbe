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

  if (
    !allowedOrigins.has(resolvedUrl.origin) ||
    !resolvedUrl.pathname.startsWith(buildBasePath) ||
    resolvedUrl.pathname === basePath ||
    resolvedUrl.searchParams.has('previewToken')
  ) {
    return rawValue;
  }

  return appendQueryParam(rawValue, 'previewToken', previewToken);
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

  return code
    .replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `url(${quote}${rewrittenValue}${quote})`;
      }
    )
    .replace(
      /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `import(${quote}${rewrittenValue}${quote})`;
      }
    )
    .replace(
      /\bimport(?!\s*\.)\s*(["'])([^"']+)\1/g,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `import ${quote}${rewrittenValue}${quote}`;
      }
    )
    .replace(
      /\bfrom\s*(["'])([^"']+)\1/g,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `from ${quote}${rewrittenValue}${quote}`;
      }
    )
    .replace(
      /\bnew\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `new URL(${quote}${rewrittenValue}${quote}, import.meta.url)`;
      }
    )
    .replace(
      /(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1/g,
      (match, quote, assetValue) => {
        if (!isLikelyBuildAssetReference(assetValue)) {
          return match;
        }

        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `${quote}${rewrittenValue}${quote}`;
      }
    );
}

module.exports = {
  injectBuildPreviewTokenIntoCodeAssets,
  injectBuildPreviewTokenIntoHtmlAssets,
  withBuildPreviewTokenOnAssetUrl,
};
