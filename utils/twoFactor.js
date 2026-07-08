const crypto = require('crypto');
const {
  generateSecret,
  generateURI,
  verifySync,
} = require('otplib');

const ENCRYPTION_VERSION = 'v1';
const GCM_IV_BYTES = 12;
const TWO_FACTOR_ISSUER = 'Fluid';

function getEncryptionKey() {
  const secret = process.env.TWO_FACTOR_SECRET_KEY || process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('TWO_FACTOR_SECRET_KEY or JWT_SECRET is required.');
  }

  return crypto.createHash('sha256').update(secret).digest();
}

function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

function decryptTotpSecret(encryptedSecret) {
  if (typeof encryptedSecret !== 'string' || !encryptedSecret) {
    return '';
  }

  const [version, ivBase64, tagBase64, encryptedBase64] = encryptedSecret.split(':');

  if (version !== ENCRYPTION_VERSION || !ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Invalid encrypted TOTP secret.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivBase64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function generateTotpSecret() {
  return generateSecret();
}

function getTotpAuthUrl(email, secret) {
  return generateURI({
    issuer: TWO_FACTOR_ISSUER,
    label: email,
    secret,
  });
}

function normalizeTotpCode(code) {
  if (typeof code !== 'string' && typeof code !== 'number') {
    return '';
  }

  return String(code).replace(/\s+/g, '').trim();
}

function verifyTotpCode(secret, code) {
  const normalizedCode = normalizeTotpCode(code);

  if (!/^\d{6}$/.test(normalizedCode)) {
    return false;
  }

  return verifySync({
    secret,
    token: normalizedCode,
    epochTolerance: 30,
  }).valid;
}

function generateRecoveryCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, generateRecoveryCode);
}

function normalizeRecoveryCode(code) {
  if (typeof code !== 'string') {
    return '';
  }

  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function countRemainingRecoveryCodes(user) {
  const codes = Array.isArray(user?.twoFactor?.recoveryCodes) ? user.twoFactor.recoveryCodes : [];

  return codes.filter((recoveryCode) => recoveryCode?.hash && !recoveryCode.usedAt).length;
}

module.exports = {
  countRemainingRecoveryCodes,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getTotpAuthUrl,
  normalizeRecoveryCode,
  normalizeTotpCode,
  verifyTotpCode,
};
