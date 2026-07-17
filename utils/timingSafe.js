const crypto = require('crypto');

function timingSafeEqualString(presentedValue, expectedValue) {
  if (typeof presentedValue !== 'string' || typeof expectedValue !== 'string') {
    return false;
  }

  const presented = Buffer.from(presentedValue);
  const expected = Buffer.from(expectedValue);

  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

module.exports = { timingSafeEqualString };
