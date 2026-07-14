const crypto = require('crypto');

const BUILD_PREVIEW_TTL_SECONDS = 15 * 60;

function getBuildPreviewSecret() {
  const secret = process.env.BUILD_PREVIEW_SECRET || process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('BUILD_PREVIEW_SECRET or JWT_SECRET is required.');
  }

  return secret;
}

function createBuildPreviewToken(projectId, buildKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSeconds + BUILD_PREVIEW_TTL_SECONDS;
  const payload = `${String(projectId)}:${String(buildKey)}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', getBuildPreviewSecret()).update(payload).digest('base64url');
  return `${expiresAt}.${signature}`;
}

function verifyBuildPreviewToken(token, projectId, buildKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || !token) return false;
  const separator = token.indexOf('.');
  if (separator < 1) return false;

  const expiresAt = Number(token.slice(0, separator));
  const presentedSignature = token.slice(separator + 1);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < nowSeconds || expiresAt > nowSeconds + BUILD_PREVIEW_TTL_SECONDS) {
    return false;
  }

  const payload = `${String(projectId)}:${String(buildKey)}:${expiresAt}`;
  const expectedSignature = crypto.createHmac('sha256', getBuildPreviewSecret()).update(payload).digest('base64url');
  const expected = Buffer.from(expectedSignature);
  const presented = Buffer.from(presentedSignature);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

function addBuildPreviewToken(value) {
  if (typeof value !== 'string' || !value) return value || '';

  try {
    const url = new URL(value, 'http://localhost');
    const parts = url.pathname.slice('/builds/'.length).split('/').filter(Boolean);
    if (!url.pathname.startsWith('/builds/') || parts.length < 2) return value;
    url.searchParams.set('previewToken', createBuildPreviewToken(parts[0], parts[1]));
    return /^[a-z][a-z\d+.-]*:/i.test(value)
      ? url.toString()
      : `${url.pathname}${url.search}${url.hash}`;
  } catch (error) {
    return value;
  }
}

module.exports = {
  BUILD_PREVIEW_TTL_SECONDS,
  addBuildPreviewToken,
  verifyBuildPreviewToken,
};
