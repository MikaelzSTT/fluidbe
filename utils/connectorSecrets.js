const crypto = require('crypto');
const ConnectorSecret = require('../models/ConnectorSecret');

const CONNECTOR_FIELD_ENV_MAP = Object.freeze({
  stripe: Object.freeze({
    secret_key: 'STRIPE_SECRET_KEY',
  }),
  google_maps: Object.freeze({
    api_key: 'VITE_GOOGLE_MAPS_API_KEY',
  }),
  supabase: Object.freeze({
    project_url: 'VITE_SUPABASE_URL',
    anon_key: 'VITE_SUPABASE_ANON_KEY',
  }),
  openai: Object.freeze({
    api_key: 'OPENAI_API_KEY',
  }),
  resend: Object.freeze({
    api_key: 'RESEND_API_KEY',
  }),
  twilio: Object.freeze({
    account_sid: 'TWILIO_ACCOUNT_SID',
    auth_token: 'TWILIO_AUTH_TOKEN',
  }),
  cloudinary: Object.freeze({
    api_key: 'CLOUDINARY_API_KEY',
    api_secret: 'CLOUDINARY_API_SECRET',
    cloud_name: 'CLOUDINARY_CLOUD_NAME',
  }),
  shopify: Object.freeze({
    store_url: 'SHOPIFY_STORE_URL',
    access_token: 'SHOPIFY_ACCESS_TOKEN',
  }),
});

function normalizeConnectorProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function getConnectorEncryptionKey() {
  const rawKey = process.env.CONNECTOR_SECRET_KEY;

  if (!rawKey) {
    return null;
  }

  return crypto.createHash('sha256').update(rawKey).digest();
}

function encryptConnectorValue(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
    algorithm: 'aes-256-gcm',
  };
}

function decryptConnectorValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported connector secret format.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encryptedValue.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encryptedValue.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue.value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function getEncryptedFieldEntries(encryptedValues) {
  if (!encryptedValues) {
    return [];
  }

  if (typeof encryptedValues.entries === 'function') {
    return Array.from(encryptedValues.entries());
  }

  return Object.entries(encryptedValues);
}

function logSafeConnectorDecryptError(provider, error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`Connector secret decrypt failed for provider "${provider}": ${message}`);
}

async function resolveConnectorEnvValues(projectId) {
  const providerEnvMap = {};
  const availableEnvVars = [];
  const encryptionKey = getConnectorEncryptionKey();

  if (!encryptionKey) {
    console.error('Connector secret decrypt unavailable: CONNECTOR_SECRET_KEY is not configured.');
    return {
      providerEnvMap,
      availableEnvVars,
    };
  }

  const secrets = await ConnectorSecret.find({ projectId })
    .select('provider encryptedValues')
    .lean();

  secrets.forEach((secret) => {
    const provider = normalizeConnectorProvider(secret.provider);
    const fieldEnvMap = CONNECTOR_FIELD_ENV_MAP[provider];

    if (!fieldEnvMap) {
      return;
    }

    try {
      const resolvedValues = {};

      getEncryptedFieldEntries(secret.encryptedValues).forEach(([fieldName, encryptedValue]) => {
        const envVar = fieldEnvMap[fieldName];

        if (!envVar) {
          return;
        }

        resolvedValues[envVar] = decryptConnectorValue(encryptedValue, encryptionKey);
      });

      if (Object.keys(resolvedValues).length === 0) {
        return;
      }

      providerEnvMap[provider] = resolvedValues;
      availableEnvVars.push(...Object.keys(resolvedValues));
    } catch (error) {
      logSafeConnectorDecryptError(provider, error);
    }
  });

  return {
    providerEnvMap,
    availableEnvVars: Array.from(new Set(availableEnvVars)),
  };
}

module.exports = {
  CONNECTOR_FIELD_ENV_MAP,
  decryptConnectorValue,
  encryptConnectorValue,
  getConnectorEncryptionKey,
  resolveConnectorEnvValues,
};
