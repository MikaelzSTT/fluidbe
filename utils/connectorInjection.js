const fs = require('fs/promises');
const path = require('path');
const ConnectorSecret = require('../models/ConnectorSecret');
const {
  CONNECTOR_FIELD_ENV_MAP,
  resolveConnectorEnvValues,
} = require('./connectorSecrets');

const PROVIDER_ENV_VARS = Object.freeze(
  Object.entries(CONNECTOR_FIELD_ENV_MAP).reduce((providers, [provider, fieldEnvMap]) => {
    providers[provider] = Object.freeze(Object.values(fieldEnvMap));
    return providers;
  }, {})
);

const ENV_VAR_TO_PROVIDER = Object.freeze(
  Object.entries(PROVIDER_ENV_VARS).reduce((index, [provider, envVars]) => {
    envVars.forEach((envVar) => {
      index[envVar] = provider;
    });

    return index;
  }, {})
);

const KNOWN_ENV_VARS = Object.freeze(Object.keys(ENV_VAR_TO_PROVIDER));
const DETECTABLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.env',
  '.example',
  '.local',
  '.template',
]);
const DETECTABLE_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.example',
  '.env.template',
  'env.example',
  'env.template',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'dist',
  'build',
  'coverage',
  'node_modules',
]);
const MAX_DETECTABLE_FILE_BYTES = 512 * 1024;

function normalizeProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeBuildFile(file) {
  if (typeof file === 'string') {
    return {
      path: '',
      content: file,
    };
  }

  if (!file || typeof file !== 'object') {
    return null;
  }

  const content = file.content ?? file.source ?? file.body ?? '';

  if (Buffer.isBuffer(content)) {
    return {
      path: String(file.relativePath || file.path || file.name || ''),
      content: content.toString('utf8'),
    };
  }

  if (typeof content !== 'string') {
    return null;
  }

  return {
    path: String(file.relativePath || file.path || file.name || ''),
    content,
  };
}

function envVarPattern(envVar) {
  return new RegExp(`(^|[^A-Z0-9_])${envVar}([^A-Z0-9_]|$)`);
}

function detectRequiredEnvVars(buildFiles) {
  const detected = new Set();

  (Array.isArray(buildFiles) ? buildFiles : []).forEach((file) => {
    const normalizedFile = normalizeBuildFile(file);

    if (!normalizedFile) {
      return;
    }

    KNOWN_ENV_VARS.forEach((envVar) => {
      if (envVarPattern(envVar).test(normalizedFile.content)) {
        detected.add(envVar);
      }
    });
  });

  return KNOWN_ENV_VARS.filter((envVar) => detected.has(envVar));
}

function groupEnvVarsByProvider(envVars) {
  return envVars.reduce((grouped, envVar) => {
    const provider = ENV_VAR_TO_PROVIDER[envVar];

    if (!provider) {
      return grouped;
    }

    if (!grouped.has(provider)) {
      grouped.set(provider, []);
    }

    grouped.get(provider).push(envVar);
    return grouped;
  }, new Map());
}

async function resolveProjectConnectorInjection(projectId, buildFiles) {
  const requiredEnvVars = detectRequiredEnvVars(buildFiles);
  const envVarsByProvider = groupEnvVarsByProvider(requiredEnvVars);
  const providerList = Array.from(envVarsByProvider.keys());

  if (providerList.length === 0) {
    return {
      requiredEnvVars: [],
      resolvedConnectors: [],
      unresolvedConnectors: [],
      injectionPlan: [],
      availableEnvVars: [],
    };
  }

  const connectorEnvValues = await resolveConnectorEnvValues(projectId);
  const availableEnvVarSet = new Set(connectorEnvValues.availableEnvVars);

  const secrets = await ConnectorSecret.find({
    projectId,
    provider: { $in: providerList },
  })
    .select('provider fieldsMeta lastUpdatedAt createdAt updatedAt')
    .lean();
  const connectedProviders = new Set(
    secrets.map((secret) => normalizeProvider(secret.provider)).filter(Boolean)
  );

  const resolvedConnectors = [];
  const unresolvedConnectors = [];
  const injectionPlan = [];

  providerList.forEach((provider) => {
    const envVars = envVarsByProvider.get(provider);
    const connected = connectedProviders.has(provider);
    const connectorPlan = {
      provider,
      envVars,
      status: connected ? 'resolved' : 'unresolved',
    };

    if (connected) {
      resolvedConnectors.push(connectorPlan);
    } else {
      unresolvedConnectors.push(connectorPlan);
    }

    envVars.forEach((envVar) => {
      const valueAvailable = availableEnvVarSet.has(envVar);

      injectionPlan.push({
        envVar,
        provider,
        resolved: connected && valueAvailable,
        valueAvailable,
        status: connected ? (valueAvailable ? 'ready' : 'missing_value') : 'missing_connector',
        inject: false,
      });
    });
  });

  return {
    requiredEnvVars,
    resolvedConnectors,
    unresolvedConnectors,
    injectionPlan,
    availableEnvVars: connectorEnvValues.availableEnvVars,
  };
}

function isDetectableBuildFile(filename) {
  const normalizedFilename = String(filename || '').toLowerCase();
  const extension = path.extname(normalizedFilename);

  return (
    normalizedFilename.startsWith('.env') ||
    DETECTABLE_FILENAMES.has(normalizedFilename) ||
    DETECTABLE_EXTENSIONS.has(extension)
  );
}

async function collectConnectorInjectionBuildFiles(rootDir) {
  const rootPath = path.resolve(rootDir);
  const files = [];

  async function discover(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await discover(entryPath);
        }

        continue;
      }

      if (!entry.isFile() || !isDetectableBuildFile(entry.name)) {
        continue;
      }

      const stats = await fs.stat(entryPath);

      if (stats.size > MAX_DETECTABLE_FILE_BYTES) {
        continue;
      }

      files.push({
        relativePath: path.relative(rootPath, entryPath).split(path.sep).join('/'),
        content: await fs.readFile(entryPath, 'utf8'),
      });
    }
  }

  await discover(rootPath);
  return files;
}

module.exports = {
  CONNECTOR_FIELD_ENV_MAP,
  PROVIDER_ENV_VARS,
  resolveConnectorEnvValues,
  resolveProjectConnectorInjection,
  collectConnectorInjectionBuildFiles,
  detectRequiredEnvVars,
};
