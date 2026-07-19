const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsUnsafeMongoKey(value, {
  allowDots = false,
  blockOwnerId = false,
  blockProjectId = false,
} = {}) {
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeMongoKey(item, {
      allowDots,
      blockOwnerId,
      blockProjectId,
    }));
  }

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (
      key.startsWith('$') ||
      (!allowDots && key.includes('.')) ||
      UNSAFE_OBJECT_KEYS.has(key) ||
      (blockProjectId && key === 'projectId') ||
      (blockOwnerId && key === 'ownerId')
    ) {
      return true;
    }

    return containsUnsafeMongoKey(nestedValue, {
      allowDots,
      blockOwnerId,
      blockProjectId,
    });
  });
}

module.exports = {
  containsUnsafeMongoKey,
  isPlainObject,
};
