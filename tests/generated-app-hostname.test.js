const assert = require('assert/strict');
const test = require('node:test');

const {
  buildGeneratedPreviewHostname,
  buildGeneratedPreviewOrigin,
  buildGeneratedPublishedHostname,
  buildGeneratedPublishedOrigin,
  getGeneratedAppDomain,
  normalizeGeneratedAppDomain,
  parseGeneratedAppHostname,
} = require('../utils/generatedAppHostname');

const GENERATED_APP_DOMAIN = 'fluidapps.dev';
const PUBLIC_HOST_KEY = '0123456789abcdef0123456789abcdef';
const OTHER_PUBLIC_HOST_KEY = 'fedcba9876543210fedcba9876543210';

function withGeneratedAppDomain(value, callback) {
  const previousValue = process.env.GENERATED_APP_DOMAIN;

  if (value === undefined) {
    delete process.env.GENERATED_APP_DOMAIN;
  } else {
    process.env.GENERATED_APP_DOMAIN = value;
  }

  try {
    return callback();
  } finally {
    if (previousValue === undefined) {
      delete process.env.GENERATED_APP_DOMAIN;
    } else {
      process.env.GENERATED_APP_DOMAIN = previousValue;
    }
  }
}

test('valid generated preview hostname parses with its exact publicHostKey', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.deepEqual(
      parseGeneratedAppHostname(`pv-${PUBLIC_HOST_KEY}.fluidapps.dev`),
      {
        type: 'preview',
        publicHostKey: PUBLIC_HOST_KEY,
      }
    );
  });
});

test('valid generated published hostname parses with its exact publicHostKey', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.deepEqual(
      parseGeneratedAppHostname(`app-${PUBLIC_HOST_KEY}.fluidapps.dev`),
      {
        type: 'published',
        publicHostKey: PUBLIC_HOST_KEY,
      }
    );
  });
});

test('preview builders return the canonical hostname and HTTPS origin', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.equal(
      buildGeneratedPreviewHostname(PUBLIC_HOST_KEY),
      `pv-${PUBLIC_HOST_KEY}.fluidapps.dev`
    );
    assert.equal(
      buildGeneratedPreviewOrigin(PUBLIC_HOST_KEY),
      `https://pv-${PUBLIC_HOST_KEY}.fluidapps.dev`
    );
  });
});

test('published builders return the canonical hostname and HTTPS origin', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.equal(
      buildGeneratedPublishedHostname(PUBLIC_HOST_KEY),
      `app-${PUBLIC_HOST_KEY}.fluidapps.dev`
    );
    assert.equal(
      buildGeneratedPublishedOrigin(PUBLIC_HOST_KEY),
      `https://app-${PUBLIC_HOST_KEY}.fluidapps.dev`
    );
  });
});

test('different publicHostKeys produce different generated origins', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.notEqual(
      buildGeneratedPreviewOrigin(PUBLIC_HOST_KEY),
      buildGeneratedPreviewOrigin(OTHER_PUBLIC_HOST_KEY)
    );
    assert.notEqual(
      buildGeneratedPublishedOrigin(PUBLIC_HOST_KEY),
      buildGeneratedPublishedOrigin(OTHER_PUBLIC_HOST_KEY)
    );
  });
});

test('builders reject invalid publicHostKey values through canonical validation', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    for (const value of [
      '',
      'abc',
      'g'.repeat(32),
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
    ]) {
      assert.throws(
        () => buildGeneratedPreviewHostname(value),
        /publicHostKey must be a 32-character lowercase hexadecimal string/
      );
      assert.throws(
        () => buildGeneratedPublishedOrigin(value),
        /publicHostKey must be a 32-character lowercase hexadecimal string/
      );
    }
  });
});

test('parser rejects missing and malformed publicHostKey values', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    for (const value of [
      '',
      'abc',
      'g'.repeat(32),
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
    ]) {
      assert.equal(
        parseGeneratedAppHostname(`pv-${value}.fluidapps.dev`),
        null
      );
    }
  });
});

test('parser rejects wrong domains and suffix-confusion hostnames', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.equal(
      parseGeneratedAppHostname(`pv-${PUBLIC_HOST_KEY}.evil.com`),
      null
    );
    assert.equal(
      parseGeneratedAppHostname(`pv-${PUBLIC_HOST_KEY}.fluidapps.dev.evil.com`),
      null
    );
  });
});

test('parser rejects extra subdomain labels', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    assert.equal(
      parseGeneratedAppHostname(`app-${PUBLIC_HOST_KEY}.sub.fluidapps.dev`),
      null
    );
    assert.equal(
      parseGeneratedAppHostname(`sub.pv-${PUBLIC_HOST_KEY}.fluidapps.dev`),
      null
    );
  });
});

test('parser rejects unknown prefixes and aliases', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    for (const prefix of ['preview-', 'prod-', 'www-', 'x-pv-']) {
      assert.equal(
        parseGeneratedAppHostname(`${prefix}${PUBLIC_HOST_KEY}.fluidapps.dev`),
        null
      );
    }
  });
});

test('parser rejects uppercase and other noncanonical hostname forms', () => {
  withGeneratedAppDomain(GENERATED_APP_DOMAIN, () => {
    for (const hostname of [
      `pv-${PUBLIC_HOST_KEY.toUpperCase()}.fluidapps.dev`,
      `PV-${PUBLIC_HOST_KEY}.fluidapps.dev`,
      `pv-${PUBLIC_HOST_KEY}.FLUIDAPPS.DEV`,
      `pv-${PUBLIC_HOST_KEY}.fluidapps.dev.`,
      `pv-${PUBLIC_HOST_KEY}.fluidapps.dev:443`,
      ` pv-${PUBLIC_HOST_KEY}.fluidapps.dev`,
      `pv-${PUBLIC_HOST_KEY}.fluidapps.dev,evil.com`,
    ]) {
      assert.equal(parseGeneratedAppHostname(hostname), null, hostname);
    }
  });
});

test('configured generated-app domain is trimmed and normalized to lowercase', () => {
  assert.equal(
    normalizeGeneratedAppDomain('  FLUIDAPPS.DEV  '),
    GENERATED_APP_DOMAIN
  );

  withGeneratedAppDomain('FLUIDAPPS.DEV', () => {
    assert.equal(getGeneratedAppDomain(), GENERATED_APP_DOMAIN);
    assert.equal(
      buildGeneratedPreviewHostname(PUBLIC_HOST_KEY),
      `pv-${PUBLIC_HOST_KEY}.fluidapps.dev`
    );
  });
});

test('missing or malformed generated-app domain configuration fails safely', () => {
  for (const value of [
    undefined,
    '',
    'https://fluidapps.dev',
    'fluidapps.dev/path',
    'fluidapps.dev:443',
    'fluidapps.dev.',
    '*.fluidapps.dev',
    'fluid_apps.dev',
    'fluidapps..dev',
    '-fluidapps.dev',
    'fluidapps-.dev',
    'localhost',
    '127.0.0.1',
  ]) {
    withGeneratedAppDomain(value, () => {
      assert.throws(
        () => getGeneratedAppDomain(),
        /GENERATED_APP_DOMAIN/
      );
      assert.throws(
        () => buildGeneratedPreviewOrigin(PUBLIC_HOST_KEY),
        /GENERATED_APP_DOMAIN/
      );
      assert.equal(
        parseGeneratedAppHostname(`pv-${PUBLIC_HOST_KEY}.fluidapps.dev`),
        null
      );
    });
  }
});
