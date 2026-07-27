const crypto = require('crypto');

const PUBLIC_HOST_KEY_BYTES = 16;
const PUBLIC_HOST_KEY_LENGTH = PUBLIC_HOST_KEY_BYTES * 2;
const PUBLIC_HOST_KEY_PATTERN = /^[a-f0-9]{32}$/;

function generatePublicHostKey() {
  return crypto.randomBytes(PUBLIC_HOST_KEY_BYTES).toString('hex');
}

function isValidPublicHostKey(value) {
  return PUBLIC_HOST_KEY_PATTERN.test(String(value || ''));
}

module.exports = {
  PUBLIC_HOST_KEY_BYTES,
  PUBLIC_HOST_KEY_LENGTH,
  PUBLIC_HOST_KEY_PATTERN,
  generatePublicHostKey,
  isValidPublicHostKey,
};
