const RUNTIME_COLLECTION_POLICIES = {
  products: {
    publicRead: true,
    createAuth: true,
    assignOwnerOnCreate: true,
    updateRoles: new Set(['admin']),
    deleteRoles: new Set(['admin']),
  },

  orders: {
    publicRead: false,
    createAuth: true,
    assignOwnerOnCreate: true,
    ownerScopedRead: true,
    updateRoles: new Set(['admin']),
    deleteRoles: new Set(['admin']),
    ownerCanUpdate: false,
    ownerCanDelete: false,
  },

  tasks: {
    publicRead: false,
    createAuth: true,
    assignOwnerOnCreate: true,
    publicWrite: false,
    ownerScopedRead: true,
    ownerCanUpdate: true,
    ownerCanDelete: true,
  },
};

const DEFAULT_RUNTIME_COLLECTION_POLICY = {
  publicRead: false,
  createAuth: true,
  assignOwnerOnCreate: true,
  ownerScopedRead: true,
  updateRoles: new Set(['admin']),
  deleteRoles: new Set(['admin']),
  ownerCanUpdate: true,
  ownerCanDelete: true,
};

function getRuntimeCollectionPolicy(collection) {
  return {
    ...DEFAULT_RUNTIME_COLLECTION_POLICY,
    ...(RUNTIME_COLLECTION_POLICIES[collection] || {}),
  };
}

function runtimeUserIsAdmin(req) {
  return req.runtimeUserRole === 'admin';
}

function runtimeUserHasRole(req, roles) {
  return Boolean(roles?.has(req.runtimeUserRole));
}

function runtimeUserOwnsDocument(req, document) {
  if (!req.runtimeUserId || !document?.ownerId) {
    return false;
  }

  return String(document.ownerId) === String(req.runtimeUserId);
}

function canReadRuntimeCollection(req, policy) {
  return policy.publicRead || Boolean(req.runtimeUserId);
}

function canReadRuntimeDocument(req, policy, document) {
  if (policy.publicRead || runtimeUserIsAdmin(req)) {
    return true;
  }

  if (policy.ownerScopedRead) {
    return runtimeUserOwnsDocument(req, document);
  }

  return Boolean(req.runtimeUserId);
}

function canCreateRuntimeDocument(req, policy) {
  return policy.publicWrite || !policy.createAuth || Boolean(req.runtimeUserId);
}

function canUpdateRuntimeDocument(req, policy, document) {
  if (policy.publicWrite) {
    return true;
  }

  if (runtimeUserHasRole(req, policy.updateRoles)) {
    return true;
  }

  return policy.ownerCanUpdate !== false && runtimeUserOwnsDocument(req, document);
}

function canDeleteRuntimeDocument(req, policy, document) {
  if (policy.publicWrite) {
    return true;
  }

  if (runtimeUserHasRole(req, policy.deleteRoles)) {
    return true;
  }

  return policy.ownerCanDelete !== false && runtimeUserOwnsDocument(req, document);
}

module.exports = {
  canCreateRuntimeDocument,
  canDeleteRuntimeDocument,
  canReadRuntimeCollection,
  canReadRuntimeDocument,
  canUpdateRuntimeDocument,
  getRuntimeCollectionPolicy,
  runtimeUserIsAdmin,
};
