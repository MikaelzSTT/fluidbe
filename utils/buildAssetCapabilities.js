function appendQueryParam(value, name, paramValue) {
  const hashIndex = value.indexOf('#');
  const beforeHash = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : value.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(name)}=${encodeURIComponent(paramValue)}${hash}`;
}

function withBuildPreviewTokenOnAssetUrl(rawValue, parsedPath, previewToken) {
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
  const basePath = `/builds/${parsedPath.projectId}/${parsedPath.buildKey}/index.html`;

  try {
    resolvedUrl = new URL(trimmedValue, `http://localhost${basePath}`);
  } catch (error) {
    return rawValue;
  }

  const buildBasePath = `/builds/${parsedPath.projectId}/${parsedPath.buildKey}/`;

  if (
    resolvedUrl.origin !== 'http://localhost' ||
    !resolvedUrl.pathname.startsWith(buildBasePath) ||
    resolvedUrl.pathname === basePath ||
    resolvedUrl.searchParams.has('previewToken')
  ) {
    return rawValue;
  }

  return appendQueryParam(rawValue, 'previewToken', previewToken);
}

function injectBuildPreviewTokenIntoHtmlAssets(html, parsedPath, previewToken) {
  if (typeof html !== 'string' || !html || !parsedPath || !previewToken) {
    return html || '';
  }

  const rewriteAssetUrl = (value) => withBuildPreviewTokenOnAssetUrl(value, parsedPath, previewToken);

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

function injectBuildPreviewTokenIntoCodeAssets(code, parsedPath, previewToken) {
  if (typeof code !== 'string' || !code || !parsedPath || !previewToken) {
    return code || '';
  }

  const rewriteAssetUrl = (value) => withBuildPreviewTokenOnAssetUrl(value, parsedPath, previewToken);

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
      /\bimport\s+(["'])([^"']+)\1/g,
      (match, quote, assetValue) => {
        const rewrittenValue = rewriteAssetUrl(assetValue);
        return `import ${quote}${rewrittenValue}${quote}`;
      }
    )
    .replace(
      /\bfrom\s+(["'])([^"']+)\1/g,
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
    );
}

module.exports = {
  injectBuildPreviewTokenIntoCodeAssets,
  injectBuildPreviewTokenIntoHtmlAssets,
  withBuildPreviewTokenOnAssetUrl,
};
