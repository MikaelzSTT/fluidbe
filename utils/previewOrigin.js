const DEFAULT_PREVIEW_BASE_URL = 'https://preview.askfluid.now';
const DEFAULT_LEGACY_PREVIEW_REMOVAL_DATE = '2026-08-31';
const BUILD_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeBaseUrl(value, fallback = DEFAULT_PREVIEW_BASE_URL) {
  const rawValue = trimTrailingSlash(value || fallback);

  try {
    const url = new URL(rawValue);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return trimTrailingSlash(fallback);
    }

    url.hash = '';
    url.search = '';
    url.pathname = '';
    return trimTrailingSlash(url.toString());
  } catch (error) {
    return trimTrailingSlash(fallback);
  }
}

function getPreviewBaseUrl() {
  return normalizeBaseUrl(process.env.PREVIEW_BASE_URL);
}

function getPreviewAllowedOrigin() {
  const configured = normalizeBaseUrl(process.env.PREVIEW_ALLOWED_ORIGIN || getPreviewBaseUrl());
  return new URL(configured).origin;
}

function getPreviewHost() {
  return new URL(getPreviewBaseUrl()).host.toLowerCase();
}

function getPreviewHostname() {
  return new URL(getPreviewBaseUrl()).hostname.toLowerCase();
}

function getPreviewFrameAncestors() {
  return String(process.env.PREVIEW_FRAME_ANCESTORS || 'https://askfluid.now').trim();
}

function getLegacyPreviewRemovalDate() {
  return String(process.env.LEGACY_PREVIEW_REMOVAL_DATE || DEFAULT_LEGACY_PREVIEW_REMOVAL_DATE).trim();
}

function normalizeRequestHost(value) {
  const host = String(value || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  if (!host) {
    return '';
  }

  if (host.startsWith('[')) {
    const closingBracketIndex = host.indexOf(']');
    return closingBracketIndex > 0 ? host.slice(1, closingBracketIndex) : host;
  }

  return host.split(':')[0];
}

function getRequestHost(req) {
  return normalizeRequestHost(
    req.headers?.['x-forwarded-host'] ||
    req.hostname ||
    req.headers?.host
  );
}

function isPreviewHost(req) {
  return getRequestHost(req) === getPreviewHostname();
}

function assertValidBuildPathParts(projectId, buildKey) {
  if (!String(projectId || '').match(/^[a-f\d]{24}$/i)) {
    return false;
  }

  return BUILD_KEY_PATTERN.test(String(buildKey || ''));
}

function parseBuildPathFromUrl(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  let url;

  try {
    url = new URL(value, 'http://localhost');
  } catch (error) {
    return null;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    return null;
  }

  if (!pathname.startsWith('/builds/')) {
    return null;
  }

  const parts = pathname.slice('/builds/'.length).split('/').filter(Boolean);

  if (parts.length < 2 || !assertValidBuildPathParts(parts[0], parts[1])) {
    return null;
  }

  const artifactPath = parts.slice(2).join('/') || 'index.html';

  if (
    artifactPath.includes('\0') ||
    artifactPath.split('/').some((segment) => segment === '..' || segment === '.' || !segment)
  ) {
    return null;
  }

  return {
    projectId: parts[0],
    buildKey: parts[1],
    artifactPath,
    pathname: `/builds/${parts[0]}/${parts[1]}/${artifactPath}`,
    indexBuildUrl: `/builds/${parts[0]}/${parts[1]}/index.html`,
    search: url.search,
    hash: url.hash,
  };
}

function isBuildUrlLike(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  try {
    return new URL(value, 'http://localhost').pathname.startsWith('/builds/');
  } catch (error) {
    return false;
  }
}

function joinPreviewBasePath(pathname) {
  const base = new URL(getPreviewBaseUrl());
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${pathname}`;
  return base;
}

function buildPreviewUrl(projectId, buildKey, artifactPath = 'index.html') {
  if (!assertValidBuildPathParts(projectId, buildKey)) {
    throw new Error('Invalid preview build identity.');
  }

  const cleanArtifactPath = String(artifactPath || 'index.html')
    .split('/')
    .filter(Boolean)
    .join('/');

  const parsed = parseBuildPathFromUrl(`/builds/${projectId}/${buildKey}/${cleanArtifactPath}`);

  if (!parsed) {
    throw new Error('Invalid preview artifact path.');
  }

  return joinPreviewBasePath(parsed.pathname).toString();
}

function toDedicatedPreviewUrl(value) {
  const parsed = parseBuildPathFromUrl(value);

  if (!parsed) {
    return value || '';
  }

  const url = joinPreviewBasePath(parsed.pathname);
  url.search = parsed.search;
  url.hash = parsed.hash;
  return url.toString();
}

function buildPublishedProjectUrl(slug) {
  const cleanSlug = String(slug || '').trim();

  if (!cleanSlug) {
    return getPreviewBaseUrl();
  }

  const url = joinPreviewBasePath(`/p/${encodeURIComponent(cleanSlug)}`);
  return url.toString();
}

module.exports = {
  DEFAULT_LEGACY_PREVIEW_REMOVAL_DATE,
  DEFAULT_PREVIEW_BASE_URL,
  assertValidBuildPathParts,
  buildPreviewUrl,
  buildPublishedProjectUrl,
  getLegacyPreviewRemovalDate,
  getPreviewAllowedOrigin,
  getPreviewBaseUrl,
  getPreviewFrameAncestors,
  getPreviewHost,
  getPreviewHostname,
  isPreviewHost,
  isBuildUrlLike,
  parseBuildPathFromUrl,
  toDedicatedPreviewUrl,
};
