const RESERVED_QUERY_KEYS = new Set(['limit', 'skip']);
const BLOCKED_COLLECTIONS = new Set([
  'users',
  'projects',
  'admin',
  'billing',
  'auth',
  'sessions',
  'projectbuilds',
  'buildjobs',
]);

const SAFE_COLLECTION_PATTERN = /^[a-z0-9_-]+$/;
const SAFE_FIELD_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateCollectionName(collection) {
  if (
    typeof collection !== 'string' ||
    !SAFE_COLLECTION_PATTERN.test(collection) ||
    BLOCKED_COLLECTIONS.has(collection)
  ) {
    return null;
  }

  return collection;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsUnsafeKey(value, { blockProjectId = false } = {}) {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeKey(item, { blockProjectId }));
  }

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (
      key.startsWith('$') ||
      key.includes('.') ||
      (blockProjectId && key === 'projectId')
    ) {
      return true;
    }

    return containsUnsafeKey(nestedValue, { blockProjectId });
  });
}

function isPrimitiveFilterValue(value) {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function normalizeQueryValue(value) {
  if (Array.isArray(value)) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (value === 'null') {
    return null;
  }

  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function buildRuntimeEqualityFilter(query = {}) {
  const filter = {};

  for (const [key, rawValue] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key)) {
      continue;
    }

    if (!SAFE_FIELD_PATTERN.test(key) || key === 'projectId') {
      return null;
    }

    const value = normalizeQueryValue(rawValue);

    if (!isPrimitiveFilterValue(value)) {
      return null;
    }

    filter[`data.${key}`] = value;
  }

  return filter;
}

function parsePagination(query = {}) {
  const parsedLimit = Number.parseInt(query.limit, 10);
  const parsedSkip = Number.parseInt(query.skip, 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
  const skip = Number.isFinite(parsedSkip) ? Math.max(parsedSkip, 0) : 0;

  return { limit, skip };
}

function assertSafeRuntimeBody(body) {
  if (!isPlainObject(body)) {
    return false;
  }

  return !containsUnsafeKey(body, { blockProjectId: true });
}

module.exports = {
  assertSafeRuntimeBody,
  buildRuntimeEqualityFilter,
  parsePagination,
  validateCollectionName,
};
