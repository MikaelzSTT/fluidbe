const { PUBLIC_HOST_KEY_LENGTH, isValidPublicHostKey } = require('./publicHostKey');

const GENERATED_APP_DOMAIN_ENV = 'GENERATED_APP_DOMAIN';
const PREVIEW_HOST_PREFIX = 'pv-';
const PUBLISHED_HOST_PREFIX = 'app-';
const MAX_HOSTNAME_LENGTH = 253;
const MAX_GENERATED_APP_DOMAIN_LENGTH =
  MAX_HOSTNAME_LENGTH - PUBLISHED_HOST_PREFIX.length - PUBLIC_HOST_KEY_LENGTH - 1;

function generatedAppDomainError(reason) {
  return new Error(`${GENERATED_APP_DOMAIN_ENV} ${reason}`);
}

function normalizeGeneratedAppDomain(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw generatedAppDomainError('must be configured as a DNS hostname.');
  }

  const domain = value.trim().toLowerCase();

  if (domain.endsWith('.')) {
    throw generatedAppDomainError('must not have a trailing dot.');
  }

  if (domain.length > MAX_GENERATED_APP_DOMAIN_LENGTH) {
    throw generatedAppDomainError('is too long for generated application hostnames.');
  }

  const labels = domain.split('.');

  if (labels.length < 2) {
    throw generatedAppDomainError('must contain at least two DNS labels.');
  }

  for (const label of labels) {
    if (
      !/^[a-z0-9-]{1,63}$/.test(label)
      || label.startsWith('-')
      || label.endsWith('-')
    ) {
      throw generatedAppDomainError('must contain only valid DNS labels.');
    }
  }

  if (!/^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1])) {
    throw generatedAppDomainError('must end in a non-numeric DNS label.');
  }

  return domain;
}

function getGeneratedAppDomain(environment = process.env) {
  return normalizeGeneratedAppDomain(environment[GENERATED_APP_DOMAIN_ENV]);
}

function assertValidPublicHostKey(publicHostKey) {
  if (typeof publicHostKey !== 'string' || !isValidPublicHostKey(publicHostKey)) {
    throw new TypeError(
      `publicHostKey must be a ${PUBLIC_HOST_KEY_LENGTH}-character lowercase hexadecimal string.`
    );
  }
}

function buildGeneratedAppHostname(prefix, publicHostKey) {
  assertValidPublicHostKey(publicHostKey);
  return `${prefix}${publicHostKey}.${getGeneratedAppDomain()}`;
}

function buildGeneratedPreviewHostname(publicHostKey) {
  return buildGeneratedAppHostname(PREVIEW_HOST_PREFIX, publicHostKey);
}

function buildGeneratedPublishedHostname(publicHostKey) {
  return buildGeneratedAppHostname(PUBLISHED_HOST_PREFIX, publicHostKey);
}

function buildGeneratedPreviewOrigin(publicHostKey) {
  return `https://${buildGeneratedPreviewHostname(publicHostKey)}`;
}

function buildGeneratedPublishedOrigin(publicHostKey) {
  return `https://${buildGeneratedPublishedHostname(publicHostKey)}`;
}

function parseGeneratedAppHostname(hostname) {
  if (
    typeof hostname !== 'string'
    || !hostname
    || hostname !== hostname.trim()
    || hostname !== hostname.toLowerCase()
    || hostname.length > MAX_HOSTNAME_LENGTH
  ) {
    return null;
  }

  let generatedDomain;

  try {
    generatedDomain = getGeneratedAppDomain();
  } catch (error) {
    return null;
  }

  const hostnameLabels = hostname.split('.');
  const domainLabels = generatedDomain.split('.');

  if (hostnameLabels.length !== domainLabels.length + 1) {
    return null;
  }

  const generatedLabel = hostnameLabels.shift();

  if (hostnameLabels.join('.') !== generatedDomain) {
    return null;
  }

  const hostTypes = [
    { prefix: PREVIEW_HOST_PREFIX, type: 'preview' },
    { prefix: PUBLISHED_HOST_PREFIX, type: 'published' },
  ];

  for (const { prefix, type } of hostTypes) {
    if (!generatedLabel.startsWith(prefix)) {
      continue;
    }

    const publicHostKey = generatedLabel.slice(prefix.length);

    if (
      isValidPublicHostKey(publicHostKey)
      && generatedLabel === `${prefix}${publicHostKey}`
    ) {
      return { type, publicHostKey };
    }
  }

  return null;
}

module.exports = {
  GENERATED_APP_DOMAIN_ENV,
  buildGeneratedPreviewHostname,
  buildGeneratedPreviewOrigin,
  buildGeneratedPublishedHostname,
  buildGeneratedPublishedOrigin,
  getGeneratedAppDomain,
  normalizeGeneratedAppDomain,
  parseGeneratedAppHostname,
};
