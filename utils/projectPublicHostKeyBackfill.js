const Project = require('../models/Project');
const {
  generatePublicHostKey,
  isValidPublicHostKey,
} = require('./publicHostKey');

const MAX_PUBLIC_HOST_KEY_GENERATION_ATTEMPTS = 16;
const PUBLIC_HOST_KEY_FIELD = 'publicHostKey';

function missingPublicHostKeyCondition() {
  return {
    $or: [
      { [PUBLIC_HOST_KEY_FIELD]: { $exists: false } },
      { [PUBLIC_HOST_KEY_FIELD]: null },
      { [PUBLIC_HOST_KEY_FIELD]: '' },
    ],
  };
}

function missingPublicHostKeyFilterForId(projectId) {
  return {
    _id: projectId,
    ...missingPublicHostKeyCondition(),
  };
}

function getMissingPublicHostKeyTargets(docs = []) {
  return docs
    .filter((doc) => classifyPublicHostKey(doc[PUBLIC_HOST_KEY_FIELD]).missing)
    .map((doc) => ({
      projectId: formatProjectId(doc._id),
      rawProjectId: doc._id,
    }));
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatProjectId(value) {
  if (value && typeof value.toString === 'function') {
    return value.toString();
  }

  return String(value);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function classifyPublicHostKey(value) {
  if (value === undefined) {
    return { state: 'missing', missing: true };
  }

  if (value === null || value === '') {
    return { state: 'unset', missing: true };
  }

  if (typeof value !== 'string') {
    return { state: 'invalid', reason: 'non-string' };
  }

  if (!isValidPublicHostKey(value)) {
    return { state: 'invalid', reason: 'malformed' };
  }

  return { state: 'valid' };
}

async function cursorToArray(cursor) {
  if (!cursor) {
    return [];
  }

  if (typeof cursor.toArray === 'function') {
    return cursor.toArray();
  }

  const rows = [];

  for await (const row of cursor) {
    rows.push(row);
  }

  return rows;
}

async function fetchProjectPublicHostKeyDocs(projectModel = Project) {
  return cursorToArray(projectModel.collection.find(
    {},
    { projection: { _id: 1, [PUBLIC_HOST_KEY_FIELD]: 1 } }
  ));
}

function buildProjectPublicHostKeySummary(docs = []) {
  const validKeys = new Map();
  const missingProjectIds = [];
  const invalidValues = [];

  for (const doc of docs) {
    const classification = classifyPublicHostKey(doc[PUBLIC_HOST_KEY_FIELD]);
    const projectId = formatProjectId(doc._id);

    if (classification.missing) {
      missingProjectIds.push(projectId);
      continue;
    }

    if (classification.state === 'invalid') {
      invalidValues.push({
        projectId,
        reason: classification.reason,
        valueType: valueType(doc[PUBLIC_HOST_KEY_FIELD]),
      });
      continue;
    }

    const key = doc[PUBLIC_HOST_KEY_FIELD];
    const projectIds = validKeys.get(key) || [];
    projectIds.push(projectId);
    validKeys.set(key, projectIds);
  }

  const duplicateKeys = [...validKeys.entries()]
    .filter(([, projectIds]) => projectIds.length > 1)
    .map(([publicHostKey, projectIds]) => ({
      publicHostKey,
      projectIds,
      count: projectIds.length,
    }));

  const duplicateDocumentCount = duplicateKeys
    .reduce((sum, duplicate) => sum + duplicate.count, 0);

  return {
    totalProjectsInspected: docs.length,
    alreadyValid: [...validKeys.values()].reduce((sum, projectIds) => sum + projectIds.length, 0),
    missingUnset: missingProjectIds.length,
    invalidExisting: invalidValues.length,
    duplicateValueCount: duplicateKeys.length,
    duplicateDocumentCount,
    wouldUpdate: missingProjectIds.length,
    missingProjectIds,
    invalidValues,
    duplicateKeys,
    readyForApply: invalidValues.length === 0 && duplicateKeys.length === 0,
    readyForUniqueIndex: invalidValues.length === 0 && duplicateKeys.length === 0,
    readyForHostRouting: missingProjectIds.length === 0
      && invalidValues.length === 0
      && duplicateKeys.length === 0,
  };
}

async function inspectProjectPublicHostKeys({ projectModel = Project } = {}) {
  const docs = await fetchProjectPublicHostKeyDocs(projectModel);
  return buildProjectPublicHostKeySummary(docs);
}

function createBackfillBlockedError(summary) {
  const error = new Error('Project publicHostKey backfill blocked by invalid or duplicate existing values.');
  error.code = 'PROJECT_PUBLIC_HOST_KEY_BACKFILL_BLOCKED';
  error.summary = summary;
  return error;
}

function createRetryExhaustedError(projectId, attempts) {
  const error = new Error(`Could not assign a unique publicHostKey to project ${formatProjectId(projectId)} after ${attempts} attempts.`);
  error.code = 'PROJECT_PUBLIC_HOST_KEY_RETRY_EXHAUSTED';
  error.projectId = formatProjectId(projectId);
  error.attempts = attempts;
  return error;
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 'E11000';
}

function getMatchedCount(updateResult) {
  return Number(
    updateResult?.matchedCount
    ?? updateResult?.result?.n
    ?? updateResult?.n
    ?? 0
  );
}

function getModifiedCount(updateResult) {
  return Number(
    updateResult?.modifiedCount
    ?? updateResult?.result?.nModified
    ?? updateResult?.nModified
    ?? 0
  );
}

async function findProjectById(projectModel, projectId) {
  return projectModel.collection.findOne(
    { _id: projectId },
    { projection: { _id: 1, [PUBLIC_HOST_KEY_FIELD]: 1 } }
  );
}

async function publicHostKeyExists(projectModel, publicHostKey) {
  const existing = await projectModel.collection.findOne(
    { [PUBLIC_HOST_KEY_FIELD]: publicHostKey },
    { projection: { _id: 1 } }
  );
  return Boolean(existing);
}

async function assignPublicHostKeyToLegacyProject({
  projectModel,
  projectId,
  generateKey = generatePublicHostKey,
  maxAttempts = MAX_PUBLIC_HOST_KEY_GENERATION_ATTEMPTS,
}) {
  let collisionRetries = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generateKey();

    if (!isValidPublicHostKey(candidate)) {
      const error = new Error('Generated publicHostKey did not match the canonical format.');
      error.code = 'PROJECT_PUBLIC_HOST_KEY_GENERATOR_INVALID';
      throw error;
    }

    if (await publicHostKeyExists(projectModel, candidate)) {
      collisionRetries += 1;
      continue;
    }

    try {
      const updateFilter = missingPublicHostKeyFilterForId(projectId);
      const updateResult = await projectModel.collection.updateOne(
        updateFilter,
        { $set: { [PUBLIC_HOST_KEY_FIELD]: candidate } }
      );
      const updateMatchedCount = getMatchedCount(updateResult);
      const updateModifiedCount = getModifiedCount(updateResult);

      if (updateMatchedCount > 0) {
        return {
          action: 'updated',
          projectId: formatProjectId(projectId),
          attempts: attempt,
          collisionRetries,
          updateMatchedCount,
          updateModifiedCount,
        };
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        collisionRetries += 1;
        continue;
      }

      error.projectId = formatProjectId(projectId);
      error.stage = 'conditional-update';
      throw error;
    }

    const currentProject = await findProjectById(projectModel, projectId);
    const currentKey = currentProject?.[PUBLIC_HOST_KEY_FIELD];

    if (isValidPublicHostKey(currentKey)) {
      return {
        action: 'concurrent-existing',
        projectId: formatProjectId(projectId),
        attempts: attempt,
        collisionRetries,
        updateMatchedCount: 0,
        updateModifiedCount: 0,
        rereadState: 'valid',
      };
    }

    const currentClassification = classifyPublicHostKey(currentKey);

    return {
      action: 'conflict',
      projectId: formatProjectId(projectId),
      attempts: attempt,
      collisionRetries,
      updateMatchedCount: 0,
      updateModifiedCount: 0,
      rereadFound: Boolean(currentProject),
      currentState: currentProject ? currentClassification.state : 'not-found',
      currentReason: currentClassification.reason,
      currentValueType: currentProject ? valueType(currentKey) : 'not-found',
      reason: currentProject
        ? 'conditional-update-zero-match-current-value-not-legacy-unset'
        : 'conditional-update-zero-match-project-not-found',
    };
  }

  throw createRetryExhaustedError(projectId, maxAttempts);
}

async function backfillProjectPublicHostKeys({
  projectModel = Project,
  apply = false,
  generateKey = generatePublicHostKey,
  maxAttempts = MAX_PUBLIC_HOST_KEY_GENERATION_ATTEMPTS,
} = {}) {
  const initialDocs = await fetchProjectPublicHostKeyDocs(projectModel);
  const initialSummary = buildProjectPublicHostKeySummary(initialDocs);
  const missingTargets = getMissingPublicHostKeyTargets(initialDocs);
  const result = {
    apply: Boolean(apply),
    dryRun: !apply,
    initial: clonePlain(initialSummary),
    totalProjectsInspected: initialSummary.totalProjectsInspected,
    alreadyValid: initialSummary.alreadyValid,
    missingUnset: initialSummary.missingUnset,
    invalidExisting: initialSummary.invalidExisting,
    duplicateValueCount: initialSummary.duplicateValueCount,
    duplicateDocumentCount: initialSummary.duplicateDocumentCount,
    wouldUpdate: initialSummary.wouldUpdate,
    updated: 0,
    concurrentAlreadyUpdated: 0,
    conditionalUpdateMatched: 0,
    conditionalUpdateModified: 0,
    conditionalUpdateZeroMatched: 0,
    conflicts: [],
    errors: [],
    collisionRetries: 0,
  };

  if (!apply) {
    return result;
  }

  if (!initialSummary.readyForApply) {
    throw createBackfillBlockedError(result);
  }

  for (const target of missingTargets) {
    let assignment;

    try {
      assignment = await assignPublicHostKeyToLegacyProject({
        projectModel,
        projectId: target.rawProjectId,
        generateKey,
        maxAttempts,
      });
    } catch (error) {
      result.errors.push({
        projectId: error.projectId || target.projectId,
        stage: error.stage || 'assignment',
        code: error.code || 'UNKNOWN',
        message: error.message,
      });
      error.result = result;
      throw error;
    }

    result.collisionRetries += assignment.collisionRetries || 0;
    result.conditionalUpdateMatched += assignment.updateMatchedCount || 0;
    result.conditionalUpdateModified += assignment.updateModifiedCount || 0;

    if ((assignment.updateMatchedCount || 0) === 0) {
      result.conditionalUpdateZeroMatched += 1;
    }

    if (assignment.action === 'updated') {
      result.updated += 1;
      continue;
    }

    if (assignment.action === 'concurrent-existing') {
      result.concurrentAlreadyUpdated += 1;
      continue;
    }

    result.conflicts.push(assignment);
  }

  const finalSummary = await inspectProjectPublicHostKeys({ projectModel });
  result.final = clonePlain(finalSummary);

  if (result.conflicts.length > 0 || !finalSummary.readyForApply) {
    const error = new Error('Project publicHostKey backfill completed with unresolved conflicts.');
    error.code = 'PROJECT_PUBLIC_HOST_KEY_BACKFILL_CONFLICT';
    error.result = result;
    throw error;
  }

  return result;
}

module.exports = {
  MAX_PUBLIC_HOST_KEY_GENERATION_ATTEMPTS,
  PUBLIC_HOST_KEY_FIELD,
  assignPublicHostKeyToLegacyProject,
  backfillProjectPublicHostKeys,
  buildProjectPublicHostKeySummary,
  classifyPublicHostKey,
  inspectProjectPublicHostKeys,
  missingPublicHostKeyCondition,
  missingPublicHostKeyFilterForId,
};
