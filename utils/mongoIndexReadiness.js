const crypto = require('crypto');
const AdminSession = require('../models/AdminSession');
const BriefingSession = require('../models/BriefingSession');
const Session = require('../models/Session');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const User = require('../models/User');

const STRIPE_UNIQUE_PARTIAL_FIELDS = Object.freeze([
  'stripeCustomerId',
  'stripeTestCustomerId',
  'stripeLiveCustomerId',
  'stripeSubscriptionId',
  'stripeTestSubscriptionId',
  'stripeLiveSubscriptionId',
]);

const TTL_DATE_FIELD_CHECKS = Object.freeze([
  { collectionName: 'sessions', model: Session, fieldName: 'expiresAt' },
  { collectionName: 'adminsessions', model: AdminSession, fieldName: 'expiresAt' },
  { collectionName: 'briefingsessions', model: BriefingSession, fieldName: 'expiresAt' },
  { collectionName: 'stripewebhookevents', model: StripeWebhookEvent, fieldName: 'receivedAt' },
]);

function getCollectionName(model, fallback = '') {
  return model?.collection?.collectionName || model?.collection?.name || fallback;
}

function maskValue(value) {
  const text = String(value || '');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

  if (text.length <= 8) {
    return `<masked>#${hash}`;
  }

  return `${text.slice(0, 3)}...${text.slice(-2)}#${hash}`;
}

function pathValue(fieldName) {
  return `$${fieldName}`;
}

async function findDuplicateNonEmptyStrings(model, fieldName) {
  const pipeline = [
    {
      $match: {
        [fieldName]: { $type: 'string', $gt: '' },
      },
    },
    {
      $group: {
        _id: pathValue(fieldName),
        count: { $sum: 1 },
      },
    },
    {
      $match: {
        count: { $gt: 1 },
      },
    },
    {
      $sort: {
        count: -1,
      },
    },
    {
      $project: {
        _id: 0,
        value: '$_id',
        count: 1,
      },
    },
  ];
  const rows = await model.collection.aggregate(pipeline).toArray();

  return rows.map((row) => ({
    fieldName,
    maskedValue: maskValue(row.value),
    count: Number(row.count || 0),
  }));
}

async function findInvalidTtlDateValues({ model, collectionName, fieldName }) {
  const pipeline = [
    {
      $project: {
        fieldType: { $type: pathValue(fieldName) },
      },
    },
    {
      $group: {
        _id: '$fieldType',
        count: { $sum: 1 },
      },
    },
    {
      $match: {
        _id: { $ne: 'date' },
      },
    },
    {
      $sort: {
        count: -1,
      },
    },
  ];
  const rows = await model.collection.aggregate(pipeline).toArray();
  const invalidTypeCounts = rows.reduce((result, row) => {
    result[String(row._id || 'unknown')] = Number(row.count || 0);
    return result;
  }, {});
  const invalidCount = Object.values(invalidTypeCounts).reduce((sum, count) => sum + count, 0);

  return {
    collectionName: collectionName || getCollectionName(model),
    fieldName,
    invalidCount,
    invalidTypeCounts,
  };
}

async function validateMongoIndexReadiness({
  userModel = User,
  stripeFields = STRIPE_UNIQUE_PARTIAL_FIELDS,
  ttlChecks = TTL_DATE_FIELD_CHECKS,
} = {}) {
  const duplicateFields = [];

  for (const fieldName of stripeFields) {
    const duplicates = await findDuplicateNonEmptyStrings(userModel, fieldName);
    if (duplicates.length) {
      duplicateFields.push({
        collectionName: getCollectionName(userModel, 'users'),
        fieldName,
        duplicates,
        duplicateValueCount: duplicates.length,
        duplicateDocumentCount: duplicates.reduce((sum, item) => sum + item.count, 0),
      });
    }
  }

  const invalidTtlFields = [];

  for (const ttlCheck of ttlChecks) {
    const invalid = await findInvalidTtlDateValues(ttlCheck);
    if (invalid.invalidCount > 0) {
      invalidTtlFields.push(invalid);
    }
  }

  const duplicateValueCount = duplicateFields.reduce((sum, item) => sum + item.duplicateValueCount, 0);
  const duplicateDocumentCount = duplicateFields.reduce((sum, item) => sum + item.duplicateDocumentCount, 0);
  const invalidTtlDocumentCount = invalidTtlFields.reduce((sum, item) => sum + item.invalidCount, 0);

  return {
    clean: duplicateFields.length === 0 && invalidTtlFields.length === 0,
    stripeFields: [...stripeFields],
    duplicateFields,
    invalidTtlFields,
    summary: {
      duplicateFieldCount: duplicateFields.length,
      duplicateValueCount,
      duplicateDocumentCount,
      invalidTtlFieldCount: invalidTtlFields.length,
      invalidTtlDocumentCount,
    },
  };
}

function formatReadinessReport(result) {
  const lines = [
    `Stripe unique partial fields: ${result.stripeFields.join(', ')}`,
  ];

  if (result.clean) {
    lines.push('Mongo index readiness validation passed: no duplicate Stripe values and no incompatible TTL date values.');
    return lines;
  }

  lines.push(`Mongo index readiness validation failed: ${JSON.stringify(result.summary)}`);

  for (const field of result.duplicateFields) {
    lines.push(`${field.collectionName}.${field.fieldName}: ${field.duplicateValueCount} duplicate value(s), ${field.duplicateDocumentCount} document references.`);
    field.duplicates.slice(0, 10).forEach((duplicate) => {
      lines.push(`  value=${duplicate.maskedValue} count=${duplicate.count}`);
    });
  }

  for (const field of result.invalidTtlFields) {
    lines.push(`${field.collectionName}.${field.fieldName}: ${field.invalidCount} incompatible value(s) by BSON type ${JSON.stringify(field.invalidTypeCounts)}.`);
  }

  return lines;
}

function assertMongoIndexReadiness(result) {
  if (result.clean) {
    return;
  }

  const error = new Error('Mongo index readiness validation failed. Refusing to continue.');
  error.code = 'MONGO_INDEX_READINESS_FAILED';
  error.readiness = result;
  throw error;
}

module.exports = {
  STRIPE_UNIQUE_PARTIAL_FIELDS,
  TTL_DATE_FIELD_CHECKS,
  assertMongoIndexReadiness,
  findDuplicateNonEmptyStrings,
  findInvalidTtlDateValues,
  formatReadinessReport,
  maskValue,
  validateMongoIndexReadiness,
};
