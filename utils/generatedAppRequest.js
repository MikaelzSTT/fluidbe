const net = require('net');
const Project = require('../models/Project');
const {
  getGeneratedAppDomain,
  parseGeneratedAppHostname,
} = require('./generatedAppHostname');

const GENERATED_APP_PROJECT_PROJECTION = Object.freeze({
  _id: 1,
  publicHostKey: 1,
  isPublished: 1,
  latestPublishedBuildId: 1,
  runtimeEnabled: 1,
});

const GENERATED_APP_RESOLUTION_STATUS = Object.freeze({
  INVALID_HOST: 'invalid-host',
  NOT_FOUND: 'not-found',
  NOT_GENERATED: 'not-generated',
  RESOLVED: 'resolved',
});

const INVALID_HOST_RESULT = Object.freeze({
  status: GENERATED_APP_RESOLUTION_STATUS.INVALID_HOST,
  context: null,
});
const NOT_FOUND_RESULT = Object.freeze({
  status: GENERATED_APP_RESOLUTION_STATUS.NOT_FOUND,
  context: null,
});
const NOT_GENERATED_RESULT = Object.freeze({
  status: GENERATED_APP_RESOLUTION_STATUS.NOT_GENERATED,
  context: null,
});

class GeneratedAppProjectLookupError extends Error {
  constructor(cause) {
    super('Generated application project lookup failed.', { cause });
    this.name = 'GeneratedAppProjectLookupError';
    this.code = 'GENERATED_APP_PROJECT_LOOKUP_FAILED';
  }
}

function getRequestHeaderValues(req, headerName) {
  const normalizedName = headerName.toLowerCase();
  const rawHeaders = Array.isArray(req?.rawHeaders) ? req.rawHeaders : [];
  const rawValues = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index] || '').toLowerCase() === normalizedName) {
      rawValues.push(rawHeaders[index + 1]);
    }
  }

  if (rawValues.length > 0) {
    return rawValues;
  }

  const headerValue = req?.headers?.[normalizedName];

  if (Array.isArray(headerValue)) {
    return headerValue;
  }

  return headerValue === undefined ? [] : [headerValue];
}

function parsePort(value) {
  if (!/^\d{1,5}$/.test(value)) {
    return false;
  }

  const port = Number(value);
  return port >= 1 && port <= 65535;
}

function isValidDnsHostname(hostname) {
  if (!hostname || hostname.length > 253 || hostname.endsWith('.')) {
    return false;
  }

  if (net.isIP(hostname) === 4) {
    return true;
  }

  const labels = hostname.split('.');

  return labels.every((label) => (
    /^[A-Za-z0-9-]{1,63}$/.test(label)
    && !label.startsWith('-')
    && !label.endsWith('-')
  ));
}

function parseHostAuthority(value) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || /[\s\x00-\x1f\x7f]/.test(value)
    || /[,/@\\?#]/.test(value)
    || value.includes('://')
  ) {
    return null;
  }

  if (value.startsWith('[')) {
    const closingBracketIndex = value.indexOf(']');

    if (closingBracketIndex < 0 || value.indexOf(']', closingBracketIndex + 1) >= 0) {
      return null;
    }

    const hostname = value.slice(1, closingBracketIndex);
    const remainder = value.slice(closingBracketIndex + 1);

    if (net.isIP(hostname) !== 6) {
      return null;
    }

    if (remainder && (!remainder.startsWith(':') || !parsePort(remainder.slice(1)))) {
      return null;
    }

    return hostname;
  }

  if (value.includes('[') || value.includes(']')) {
    return null;
  }

  const parts = value.split(':');

  if (parts.length > 2 || (parts.length === 2 && !parsePort(parts[1]))) {
    return null;
  }

  const hostname = parts[0];
  return isValidDnsHostname(hostname) ? hostname : null;
}

function isImmediatePeerTrusted(req) {
  const trust = req?.app?.get?.('trust proxy fn');

  if (typeof trust !== 'function') {
    return false;
  }

  try {
    return trust(req?.socket?.remoteAddress, 0) === true;
  } catch (error) {
    return false;
  }
}

function resolveTrustedRequestHostname(req) {
  const hostValues = getRequestHeaderValues(req, 'host');

  if (hostValues.length !== 1) {
    return null;
  }

  const forwardedHostValues = getRequestHeaderValues(req, 'x-forwarded-host');
  const useForwardedHost = forwardedHostValues.length > 0 && isImmediatePeerTrusted(req);

  if (useForwardedHost && forwardedHostValues.length !== 1) {
    return null;
  }

  const authority = useForwardedHost ? forwardedHostValues[0] : hostValues[0];
  const hostname = parseHostAuthority(authority);

  if (!hostname) {
    return null;
  }

  return Object.freeze({
    hostname,
    source: useForwardedHost ? 'x-forwarded-host' : 'host',
  });
}

function isGeneratedAppDomainHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname) {
    return false;
  }

  let generatedDomain;

  try {
    generatedDomain = getGeneratedAppDomain();
  } catch (error) {
    return false;
  }

  const hostnameLabels = hostname.toLowerCase().split('.');
  const domainLabels = generatedDomain.split('.');

  if (hostnameLabels.length < domainLabels.length) {
    return false;
  }

  return hostnameLabels
    .slice(hostnameLabels.length - domainLabels.length)
    .every((label, index) => label === domainLabels[index]);
}

function hasGeneratedAppHostPrefix(hostname) {
  const firstLabel = String(hostname || '').split('.')[0].toLowerCase();
  return firstLabel.startsWith('pv-') || firstLabel.startsWith('app-');
}

async function findGeneratedAppProject(projectModel, publicHostKey) {
  const query = projectModel.findOne(
    { publicHostKey },
    { ...GENERATED_APP_PROJECT_PROJECTION }
  );

  return typeof query?.lean === 'function' ? query.lean() : query;
}

async function resolveGeneratedAppRequest(req, { projectModel = Project } = {}) {
  const effectiveHost = resolveTrustedRequestHostname(req);

  if (!effectiveHost) {
    return INVALID_HOST_RESULT;
  }

  const generatedHost = parseGeneratedAppHostname(effectiveHost.hostname);

  if (!generatedHost) {
    if (
      isGeneratedAppDomainHostname(effectiveHost.hostname)
      || hasGeneratedAppHostPrefix(effectiveHost.hostname)
    ) {
      return INVALID_HOST_RESULT;
    }

    return NOT_GENERATED_RESULT;
  }

  let project;

  try {
    project = await findGeneratedAppProject(projectModel, generatedHost.publicHostKey);
  } catch (error) {
    throw new GeneratedAppProjectLookupError(error);
  }

  if (
    !project
    || String(project.publicHostKey || '') !== generatedHost.publicHostKey
    || !project._id
  ) {
    return NOT_FOUND_RESULT;
  }

  const context = Object.freeze({
    type: generatedHost.type,
    hostname: effectiveHost.hostname,
    publicHostKey: generatedHost.publicHostKey,
    projectId: String(project._id),
    isPublished: project.isPublished === true,
    latestPublishedBuildId: project.latestPublishedBuildId
      ? String(project.latestPublishedBuildId)
      : null,
    runtimeEnabled: project.runtimeEnabled === true,
  });

  return Object.freeze({
    status: GENERATED_APP_RESOLUTION_STATUS.RESOLVED,
    context,
  });
}

module.exports = {
  GENERATED_APP_PROJECT_PROJECTION,
  GENERATED_APP_RESOLUTION_STATUS,
  GeneratedAppProjectLookupError,
  isGeneratedAppDomainHostname,
  parseHostAuthority,
  resolveGeneratedAppRequest,
  resolveTrustedRequestHostname,
};
