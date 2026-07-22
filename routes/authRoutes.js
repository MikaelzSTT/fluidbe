const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const authMiddleware = require('../middleware/authMiddleware');
const Project = require('../models/Project');
const Session = require('../models/Session');
const User = require('../models/User');
const {
  createAuthTokenPair,
  hasPasswordHash,
  serializeAuthMetadata,
  serializeUser,
} = require('../utils/auth');
const {
  clearPublicCsrfCookie,
  clearPublicSessionCookie,
  createCsrfToken,
  getPublicAuthMigrationDeadline,
  getPublicSessionCookieValue,
  isPublicBearerAuthLegacyEnabled,
  isPublicCookieAuthEnabled,
  setPublicCsrfCookie,
  setPublicSessionCookie,
} = require('../utils/publicAuthCookies');
const {
  countRemainingRecoveryCodes,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  getTotpAuthUrl,
  normalizeRecoveryCode,
  verifyTotpCode,
} = require('../utils/twoFactor');
const { createRateLimit } = require('../middleware/rateLimit');
const { deleteProjectsData } = require('../utils/projectDeletion');

const router = express.Router();
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';
const GITHUB_STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_OAUTH_REDIRECT_PATH = '/projects.html';
const OAUTH_STATE_COOKIE_PREFIX = 'fluid_oauth_state_';
const MAX_PASSWORD_BYTES = 72;
const MAX_EMAIL_CHARS = 320;
const INVALID_PASSWORD_HASH = '$2b$10$oE4adb62xrznmIZJwK9GYOgfO83CCk9wNy5mZUnKXto9FfRRWHfbq';
const passwordChangeRateLimit = createRateLimit({
  name: 'auth-password-change',
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => String(req.userId || 'anonymous'),
});
const twoFactorVerifyLoginRateLimit = createRateLimit({
  name: 'auth-2fa-verify-login',
  windowMs: 15 * 60 * 1000,
  max: 10,
});
const twoFactorEnableRateLimit = createRateLimit({
  name: 'auth-2fa-enable',
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => String(req.userId || 'anonymous'),
});
const twoFactorDisableRateLimit = createRateLimit({
  name: 'auth-2fa-disable',
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => String(req.userId || 'anonymous'),
});

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://askfluid.now').replace(/\/+$/, '');
}

function redirectToOAuthError(res) {
  return res.redirect(`${getFrontendUrl()}/login.html?oauth_error=google`);
}

function redirectToOAuthCodeError(res, code) {
  return res.redirect(`${getFrontendUrl()}/login.html?error=${encodeURIComponent(code)}`);
}

function redirectToOAuthSuccess(res, redirectPath = '') {
  const redirect = redirectPath ? normalizeFrontendRedirectPath(redirectPath) : '';
  const targetPath = redirect || DEFAULT_OAUTH_REDIRECT_PATH;

  return res.redirect(`${getFrontendUrl()}${targetPath}`);
}

function getGoogleOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  };
}

function hasGoogleOAuthConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.callbackUrl);
}

function getGitHubOAuthConfig() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackUrl: process.env.GITHUB_OAUTH_CALLBACK_URL,
  };
}

function hasGitHubOAuthConfig(config) {
  return Boolean(config.clientId && config.clientSecret && config.callbackUrl);
}

function normalizeFrontendRedirectPath(value) {
  if (typeof value !== 'string') {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 2048 || !trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }

  try {
    const parsed = new URL(trimmed, getFrontendUrl());

    if (parsed.origin !== getFrontendUrl() || !parsed.pathname.startsWith('/')) {
      return DEFAULT_OAUTH_REDIRECT_PATH;
    }

    if (/^\/(?:admin|wizard)(?:\.html|\/|$)/i.test(parsed.pathname)) {
      return DEFAULT_OAUTH_REDIRECT_PATH;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (error) {
    return DEFAULT_OAUTH_REDIRECT_PATH;
  }
}

function parseCookieHeader(req) {
  const cookies = {};
  const header = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';

  header.split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator < 1) return;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch (error) {
      cookies[name] = '';
    }
  });

  return cookies;
}

function oauthStateCookieName(provider) {
  return `${OAUTH_STATE_COOKIE_PREFIX}${provider}`;
}

function setOAuthStateCookie(res, provider, state, maxAge) {
  res.cookie(oauthStateCookieName(provider), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/api/auth/${provider}/callback`,
    maxAge,
  });
}

function consumeOAuthStateCookie(req, res, provider, presentedState) {
  const cookieName = oauthStateCookieName(provider);
  const expectedState = parseCookieHeader(req)[cookieName] || '';
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/api/auth/${provider}/callback`,
  });

  if (!expectedState || typeof presentedState !== 'string' || !presentedState) {
    return false;
  }

  const expected = Buffer.from(expectedState);
  const presented = Buffer.from(presentedState);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

function createGitHubOAuthState(redirectPath) {
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      purpose: 'github_oauth_state',
      nonce: crypto.randomBytes(16).toString('hex'),
      redirect: normalizeFrontendRedirectPath(redirectPath),
      createdAt: now,
      expiresAt: now + GITHUB_STATE_TTL_SECONDS,
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: GITHUB_STATE_TTL_SECONDS }
  );
}

function verifyGitHubOAuthState(state) {
  if (typeof state !== 'string' || !state) {
    return null;
  }

  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    if (
      decoded?.purpose !== 'github_oauth_state' ||
      typeof decoded.nonce !== 'string' ||
      typeof decoded.createdAt !== 'number' ||
      typeof decoded.expiresAt !== 'number' ||
      decoded.expiresAt < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return {
      redirect: normalizeFrontendRedirectPath(decoded.redirect),
    };
  } catch (error) {
    return null;
  }
}

function createGoogleOAuthState(redirectPath) {
  return jwt.sign(
    {
      purpose: 'google_oauth_state',
      nonce: crypto.randomBytes(16).toString('hex'),
      redirect: normalizeFrontendRedirectPath(redirectPath),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: GOOGLE_STATE_TTL_SECONDS }
  );
}

function verifyGoogleOAuthState(state) {
  if (typeof state !== 'string' || !state) {
    return null;
  }

  try {
    const decoded = jwt.verify(state, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    if (decoded?.purpose !== 'google_oauth_state' || typeof decoded.nonce !== 'string') {
      return null;
    }

    return {
      redirect: normalizeFrontendRedirectPath(decoded.redirect),
    };
  } catch (error) {
    return null;
  }
}

async function exchangeGoogleCodeForToken(code, config) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error('Google token exchange failed.');
  }

  return response.json();
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('Google profile fetch failed.');
  }

  return response.json();
}

async function exchangeGitHubCodeForToken(code, config) {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error('GitHub token exchange failed.');
  }

  const payload = await response.json();

  if (!payload.access_token || payload.error) {
    throw new Error('GitHub token exchange failed.');
  }

  return payload;
}

async function fetchGitHubJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Fluid OAuth',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error('GitHub API request failed.');
  }

  return response.json();
}

async function fetchGitHubProfile(accessToken) {
  return fetchGitHubJson(GITHUB_USER_URL, accessToken);
}

async function fetchGitHubEmails(accessToken) {
  return fetchGitHubJson(GITHUB_EMAILS_URL, accessToken);
}

function normalizeGoogleProfile(profile) {
  const googleId = String(profile.sub || '').trim();
  const email = String(profile.email || '').trim().toLowerCase();
  const name = String(profile.name || '').trim();
  const avatar = String(profile.picture || '').trim();
  const emailVerified = profile.email_verified === true || profile.email_verified === 'true';

  if (!googleId || !email || !emailVerified) {
    return null;
  }

  return {
    googleId,
    email,
    name: name || email,
    avatar,
    emailVerified,
  };
}

function withGoogleProvider(user) {
  const providers = Array.isArray(user.providers) ? user.providers : [];
  user.providers = Array.from(new Set([...providers, 'google']));
}

function normalizeGitHubProfile(profile, emails) {
  const githubId = String(profile?.id || '').trim();
  const login = String(profile?.login || '').trim();
  const name = String(profile?.name || '').trim();
  const avatar = String(profile?.avatar_url || '').trim();
  const primaryEmail = Array.isArray(emails)
    ? emails.find((email) => email?.primary === true && email?.verified === true && typeof email.email === 'string')
    : null;
  const email = String(primaryEmail?.email || '').trim().toLowerCase();

  if (!githubId || !login || !email) {
    return null;
  }

  return {
    githubId,
    login,
    email,
    name: name || login,
    avatar,
  };
}

function withGitHubProvider(user) {
  const providers = Array.isArray(user.providers) ? user.providers : [];
  user.providers = Array.from(new Set([...providers, 'github']));
}

function applyGitHubAvatarIfEmpty(user, avatar) {
  if (!avatar) {
    return;
  }

  if (!user.avatar) {
    user.avatar = avatar;
  }

  const currentProfile = user.profile?.toObject ? user.profile.toObject() : user.profile || {};

  if (!currentProfile.avatarUrl) {
    user.profile = {
      ...currentProfile,
      avatarUrl: avatar,
    };
  }
}

function normalizeRequiredString(value, maxLength) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

const PROFILE_FIELDS = Object.freeze({
  displayName: 80,
  username: 30,
  bio: 280,
  website: 2048,
  company: 80,
  location: 80,
  avatarUrl: 2048,
});
const PROFILE_STRING_FIELDS = Object.freeze({
  displayName: PROFILE_FIELDS.displayName,
  bio: PROFILE_FIELDS.bio,
  company: PROFILE_FIELDS.company,
  location: PROFILE_FIELDS.location,
});
const PROFILE_VISIBILITIES = new Set(['public', 'private']);
const RESERVED_USERNAMES = new Set([
  'admin',
  'root',
  'support',
  'billing',
  'security',
  'settings',
  'api',
  'fluid',
  'null',
  'undefined',
]);
const PREFERENCE_ENUMS = Object.freeze({
  language: new Set(['english', 'portuguese', 'spanish']),
  appearance: new Set(['light', 'dark', 'system']),
  soundOnComplete: new Set(['first', 'always', 'never']),
});
const LANGUAGE_ALIASES = Object.freeze({
  en: 'english',
  pt: 'portuguese',
  'pt-br': 'portuguese',
  es: 'spanish',
  'es-es': 'spanish',
  'es-mx': 'spanish',
});
const PREFERENCE_BOOLEANS = new Set([
  'chatSuggestions',
  'autoSave',
  'confirmBeforeDelete',
  'compactMode',
]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

function getObjectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(/\s+/);

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  return token;
}

function buildAuthenticatedPayload(payload, token) {
  if (!isPublicCookieAuthEnabled() && token) {
    return {
      ...payload,
      token,
    };
  }

  return payload;
}

async function createSessionAndSetCookie(user, req, res) {
  const { token, session } = await createAuthTokenPair(user, req);
  setPublicSessionCookie(res, token, session.expiresAt);

  return {
    token,
    session,
  };
}

function setCsrfTokenResponse(res) {
  const csrfToken = createCsrfToken();
  setPublicCsrfCookie(res, csrfToken);

  return csrfToken;
}

function serializeSession(session, currentSessionId) {
  const id = String(session._id);

  return {
    id,
    current: id === String(currentSessionId),
    userAgent: session.userAgent || '',
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
  };
}

async function revokeOtherSessions(userId, currentSessionId, reason) {
  const query = {
    userId,
    revokedAt: null,
  };

  if (currentSessionId) {
    query._id = { $ne: currentSessionId };
  }

  const result = await Session.updateMany(query, {
    $set: {
      revokedAt: new Date(),
      revokedReason: reason,
    },
  });

  return result.modifiedCount || 0;
}

function rejectUnknownFields(body, allowedFields) {
  const unknownFields = Object.keys(body).filter((field) => !allowedFields.includes(field));

  if (unknownFields.length) {
    return `Campos desconhecidos: ${unknownFields.join(', ')}.`;
  }

  return null;
}

function normalizeOptionalString(value, maxLength) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();

  if (normalized.length > maxLength) {
    return null;
  }

  return normalized;
}

function normalizeUsername(value) {
  const username = normalizeOptionalString(value, PROFILE_FIELDS.username);

  if (username === undefined || username === '') {
    return username;
  }

  const normalized = username.toLowerCase();

  if (!/^[a-z0-9_.-]{3,30}$/.test(normalized) || RESERVED_USERNAMES.has(normalized)) {
    return null;
  }

  return normalized;
}

async function generateUniqueUsername(preferredUsername, fallbackId) {
  const candidates = [];
  const normalizedPreferred = normalizeUsername(preferredUsername);

  if (normalizedPreferred) {
    candidates.push(normalizedPreferred);
  }

  const compactFallback = String(fallbackId || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

  if (compactFallback) {
    candidates.push(`gh-${compactFallback}`.slice(0, PROFILE_FIELDS.username));
  }

  for (const candidate of candidates) {
    if (!candidate || candidate.length < 3 || RESERVED_USERNAMES.has(candidate)) {
      continue;
    }

    const exists = await User.exists({ 'profile.username': candidate });

    if (!exists) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeHttpsUrl(value, options = {}) {
  const normalized = normalizeOptionalString(value, options.maxLength || 2048);

  if (normalized === undefined || normalized === '') {
    return normalized;
  }

  if (/^data:/i.test(normalized)) {
    return null;
  }

  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalized)
    ? normalized
    : `https://${normalized}`;

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'https:' || !url.hostname) {
      return null;
    }

    return url.toString();
  } catch (error) {
    return null;
  }
}

function normalizeAccountLanguage(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  return LANGUAGE_ALIASES[normalized] || normalized;
}

function serializeProfile(profile, user) {
  return {
    displayName: profile?.displayName || user.name || '',
    username: profile?.username || '',
    bio: profile?.bio || '',
    website: profile?.website || '',
    company: profile?.company || '',
    location: profile?.location || '',
    visibility: PROFILE_VISIBILITIES.has(profile?.visibility) ? profile.visibility : 'public',
    avatarUrl: profile?.avatarUrl || '',
  };
}

function serializeAccountPreferences(preferences) {
  return {
    language: PREFERENCE_ENUMS.language.has(preferences?.language) ? preferences.language : 'english',
    appearance: PREFERENCE_ENUMS.appearance.has(preferences?.appearance) ? preferences.appearance : 'system',
    chatSuggestions: preferences?.chatSuggestions === undefined ? true : Boolean(preferences.chatSuggestions),
    soundOnComplete: PREFERENCE_ENUMS.soundOnComplete.has(preferences?.soundOnComplete) ? preferences.soundOnComplete : 'first',
    autoSave: preferences?.autoSave === undefined ? true : Boolean(preferences.autoSave),
    confirmBeforeDelete: preferences?.confirmBeforeDelete === undefined ? true : Boolean(preferences.confirmBeforeDelete),
    compactMode: preferences?.compactMode === undefined ? false : Boolean(preferences.compactMode),
  };
}

function hasActivePaidSubscription(user) {
  const plan = String(user?.plan || '').toLowerCase();
  const subscriptionStatus = String(user?.subscriptionStatus || '').toLowerCase();
  const hasSubscriptionId = [
    user?.stripeSubscriptionId,
    user?.stripeTestSubscriptionId,
    user?.stripeLiveSubscriptionId,
  ].some((subscriptionId) => typeof subscriptionId === 'string' && subscriptionId.trim());

  return Boolean(
    hasSubscriptionId &&
    (['pro', 'business'].includes(plan) || ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus))
  );
}

function getDeletedEmail(userId) {
  return `deleted-user-${String(userId)}@deleted.askfluid.local`;
}

function hashDeletedIdentity(type, value) {
  const normalized = String(value || '').trim().toLowerCase();
  const secret = process.env.DELETION_IDENTITY_SECRET || process.env.JWT_SECRET;
  if (!normalized || !secret) return '';
  return crypto.createHmac('sha256', secret).update(`${type}:${normalized}`).digest('base64url');
}

async function deletedIdentityExists(identities) {
  const hashes = identities
    .map(({ type, value }) => hashDeletedIdentity(type, value))
    .filter(Boolean);
  if (!hashes.length) return false;
  return Boolean(await User.exists({
    deletedAt: { $ne: null },
    deletedIdentityHashes: { $in: hashes },
  }));
}

async function countUserProjects(userId) {
  const [published, active] = await Promise.all([
    Project.countDocuments({
      userId,
      $or: [
        { isPublished: true },
        { status: 'published' },
        { 'deploy.isPublished': true },
      ],
    }),
    Project.countDocuments({
      userId,
      status: { $ne: 'archived' },
    }),
  ]);

  return { published, active };
}

async function serializeAccountSettings(user, options = {}) {
  const projectCounts = options.projectCounts || await countUserProjects(user._id);
  const profile = serializeProfile(user.profile, user);

  return {
    id: user._id,
    email: user.email,
    name: user.name,
    displayName: profile.displayName,
    plan: user.plan || 'free',
    projectCounts,
    counts: projectCounts,
    profile,
    preferences: serializeAccountPreferences(user.preferences),
    auth: serializeAuthMetadata(user),
  };
}

async function findAuthenticatedUser(req, res) {
  const user = await User.findById(req.userId);

  if (!user) {
    res.status(401).json({ message: 'Usuário não encontrado.' });
    return null;
  }

  if (user.deletedAt) {
    res.status(401).json({ code: 'ACCOUNT_DELETED', message: 'ACCOUNT_DELETED' });
    return null;
  }

  return user;
}

function getPasswordlessProvider(user) {
  const hasGoogleProvider = Array.isArray(user?.providers) && user.providers.includes('google');
  const hasGitHubProvider = Array.isArray(user?.providers) && user.providers.includes('github');

  if (hasPasswordHash(user)) {
    return null;
  }

  if (hasGoogleProvider || Boolean(user?.googleId)) {
    return 'google';
  }

  if (hasGitHubProvider || Boolean(user?.githubId)) {
    return 'github';
  }

  return null;
}

function serializeTwoFactorStatus(user) {
  const available = hasPasswordHash(user);
  const passwordlessProvider = getPasswordlessProvider(user);

  return {
    enabled: Boolean(user?.twoFactor?.enabled),
    available,
    managedByProvider: !available ? passwordlessProvider : null,
    recoveryCodesRemaining: countRemainingRecoveryCodes(user),
  };
}

function jsonCode(res, status, code) {
  return res.status(status).json({
    ok: false,
    code,
    message: code,
  });
}

function createTwoFactorLoginChallenge(user) {
  return jwt.sign(
    {
      id: user._id,
      purpose: 'two_factor_login',
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function clearTwoFactor(user) {
  user.twoFactor = {
    enabled: false,
    secretEnc: '',
    pendingSecretEnc: '',
    pendingExpiresAt: undefined,
    enabledAt: undefined,
    recoveryCodes: [],
    lastVerifiedAt: undefined,
  };
}

async function hashRecoveryCodes(recoveryCodes) {
  return Promise.all(
    recoveryCodes.map(async (recoveryCode) => ({
      hash: await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 10),
    }))
  );
}

async function verifyCurrentPassword(user, currentPassword) {
  if (!hasPasswordHash(user) || typeof currentPassword !== 'string' || !currentPassword) {
    return false;
  }

  return bcrypt.compare(currentPassword, user.password);
}

function verifyUserTotp(user, code) {
  if (!user?.twoFactor?.enabled || !user.twoFactor.secretEnc) {
    return false;
  }

  const secret = decryptTotpSecret(user.twoFactor.secretEnc);

  return verifyTotpCode(secret, code);
}

async function verifyRecoveryCode(user, code, options = {}) {
  const normalizedCode = normalizeRecoveryCode(code);

  if (!normalizedCode) {
    return false;
  }

  const recoveryCodes = Array.isArray(user?.twoFactor?.recoveryCodes) ? user.twoFactor.recoveryCodes : [];

  for (const recoveryCode of recoveryCodes) {
    if (!recoveryCode?.hash || recoveryCode.usedAt) {
      continue;
    }

    const matches = await bcrypt.compare(normalizedCode, recoveryCode.hash);

    if (!matches) {
      continue;
    }

    if (options.markUsed) {
      recoveryCode.usedAt = new Date();
    }

    return true;
  }

  return false;
}

async function verifyTwoFactorCredential(user, code, options = {}) {
  if (verifyUserTotp(user, code)) {
    return { valid: true, usedRecoveryCode: false };
  }

  if (options.allowRecovery) {
    const recoveryCodeIsValid = await verifyRecoveryCode(user, code, {
      markUsed: options.markRecoveryUsed,
    });

    if (recoveryCodeIsValid) {
      return { valid: true, usedRecoveryCode: true };
    }
  }

  return { valid: false, usedRecoveryCode: false };
}

async function markCurrentSessionMfaVerified(req, user, verifiedAt) {
  if (!req.session?._id) {
    return false;
  }

  req.session.mfaVerifiedAt = verifiedAt;
  req.session.lastSeenAt = verifiedAt;

  if (typeof req.session.save === 'function') {
    await req.session.save();
    return true;
  }

  const result = await Session.updateOne(
    {
      _id: req.session._id,
      userId: user._id,
      revokedAt: null,
      expiresAt: { $gt: verifiedAt },
    },
    {
      $set: {
        mfaVerifiedAt: verifiedAt,
        lastSeenAt: verifiedAt,
      },
    }
  );

  return Boolean(result.modifiedCount || result.matchedCount);
}

router.get('/google', (req, res) => {
  const config = getGoogleOAuthConfig();

  if (!hasGoogleOAuthConfig(config)) {
    return redirectToOAuthError(res);
  }

  const authUrl = new URL(GOOGLE_AUTH_URL);
  const redirectPath = typeof req.query.redirect === 'string'
    ? req.query.redirect
    : DEFAULT_OAUTH_REDIRECT_PATH;
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('prompt', 'select_account');
  const state = createGoogleOAuthState(redirectPath);
  authUrl.searchParams.set('state', state);
  setOAuthStateCookie(res, 'google', state, GOOGLE_STATE_TTL_SECONDS * 1000);

  return res.redirect(authUrl.toString());
});

router.get('/github', (req, res) => {
  const config = getGitHubOAuthConfig();

  if (!hasGitHubOAuthConfig(config)) {
    return redirectToOAuthCodeError(res, 'GITHUB_OAUTH_NOT_CONFIGURED');
  }

  const redirectPath = typeof req.query.redirect === 'string'
    ? req.query.redirect
    : DEFAULT_OAUTH_REDIRECT_PATH;
  const state = createGitHubOAuthState(redirectPath);
  const authUrl = new URL(GITHUB_AUTH_URL);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.callbackUrl);
  authUrl.searchParams.set('scope', 'read:user user:email');
  authUrl.searchParams.set('state', state);
  setOAuthStateCookie(res, 'github', state, GITHUB_STATE_TTL_SECONDS * 1000);

  return res.redirect(authUrl.toString());
});

router.get('/csrf', (req, res) => {
  try {
    const csrfToken = setCsrfTokenResponse(res);

    return res.json({
      ok: true,
      csrfToken,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    return res.json({ user: serializeUser(user) });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/me/settings', authMiddleware, async (req, res) => {
  try {
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    const settings = await serializeAccountSettings(user);

    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/me/2fa', authMiddleware, async (req, res) => {
  try {
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    return res.json({
      ok: true,
      twoFactor: serializeTwoFactorStatus(user),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/me/2fa/setup', authMiddleware, async (req, res) => {
  try {
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    const passwordlessProvider = getPasswordlessProvider(user);

    if (passwordlessProvider) {
      return jsonCode(res, 400, `TWO_FACTOR_MANAGED_BY_${passwordlessProvider.toUpperCase()}`);
    }

    if (!hasPasswordHash(user)) {
      return jsonCode(res, 400, 'TWO_FACTOR_NOT_AVAILABLE');
    }

    if (user.twoFactor?.enabled) {
      return jsonCode(res, 400, 'TWO_FACTOR_ALREADY_ENABLED');
    }

    const secret = generateTotpSecret();
    const otpauthUrl = getTotpAuthUrl(user.email, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    user.twoFactor = {
      ...(user.twoFactor?.toObject ? user.twoFactor.toObject() : user.twoFactor || {}),
      enabled: false,
      pendingSecretEnc: encryptTotpSecret(secret),
      pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };

    await user.save();

    return res.json({
      ok: true,
      otpauthUrl,
      secret,
      qrCodeDataUrl,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/me/2fa/enable', authMiddleware, twoFactorEnableRateLimit, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const code = body?.code;
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    const passwordlessProvider = getPasswordlessProvider(user);

    if (passwordlessProvider) {
      return jsonCode(res, 400, `TWO_FACTOR_MANAGED_BY_${passwordlessProvider.toUpperCase()}`);
    }

    if (!hasPasswordHash(user)) {
      return jsonCode(res, 400, 'TWO_FACTOR_NOT_AVAILABLE');
    }

    if (user.twoFactor?.enabled) {
      return jsonCode(res, 400, 'TWO_FACTOR_ALREADY_ENABLED');
    }

    if (!user.twoFactor?.pendingSecretEnc || !user.twoFactor.pendingExpiresAt || user.twoFactor.pendingExpiresAt <= new Date()) {
      return jsonCode(res, 400, 'TWO_FACTOR_SETUP_EXPIRED');
    }

    const pendingSecret = decryptTotpSecret(user.twoFactor.pendingSecretEnc);

    if (!verifyTotpCode(pendingSecret, code)) {
      return jsonCode(res, 400, 'INVALID_TWO_FACTOR_CODE');
    }

    const recoveryCodes = generateRecoveryCodes(8);
    const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);
    const now = new Date();
    const ownedProjects = await Project.find({ userId: user._id }).select('_id').lean();
    const projectIds = ownedProjects.map((project) => project._id);

    user.twoFactor = {
      enabled: true,
      secretEnc: user.twoFactor.pendingSecretEnc,
      pendingSecretEnc: '',
      pendingExpiresAt: undefined,
      enabledAt: now,
      recoveryCodes: hashedRecoveryCodes,
      lastVerifiedAt: now,
    };

    await user.save();

    return res.json({
      ok: true,
      message: 'TWO_FACTOR_ENABLED',
      recoveryCodes,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/me/2fa/disable', authMiddleware, twoFactorDisableRateLimit, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    if (!user.twoFactor?.enabled) {
      return jsonCode(res, 400, 'TWO_FACTOR_NOT_ENABLED');
    }

    if (hasPasswordHash(user)) {
      const currentPasswordIsValid = await verifyCurrentPassword(user, body?.currentPassword);

      if (!currentPasswordIsValid) {
        return jsonCode(res, 401, 'INVALID_CURRENT_PASSWORD');
      }
    }

    const verification = await verifyTwoFactorCredential(user, body?.code, {
      allowRecovery: true,
      markRecoveryUsed: true,
    });

    if (!verification.valid) {
      return jsonCode(res, 400, 'INVALID_TWO_FACTOR_CODE');
    }

    clearTwoFactor(user);
    await user.save();

    return res.json({
      ok: true,
      message: 'TWO_FACTOR_DISABLED',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/me/2fa/step-up', authMiddleware, twoFactorVerifyLoginRateLimit, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    if (!user.twoFactor?.enabled) {
      return jsonCode(res, 403, 'TWO_FACTOR_REQUIRED');
    }

    const verification = await verifyTwoFactorCredential(user, body?.code, {
      allowRecovery: true,
      markRecoveryUsed: true,
    });

    if (!verification.valid) {
      return jsonCode(res, 400, 'INVALID_TWO_FACTOR_CODE');
    }

    const now = new Date();
    user.twoFactor.lastVerifiedAt = now;

    if (verification.usedRecoveryCode) {
      await user.save();
    } else {
      await User.updateOne(
        { _id: user._id },
        { $set: { 'twoFactor.lastVerifiedAt': now } }
      );
    }

    const sessionUpdated = await markCurrentSessionMfaVerified(req, user, now);

    if (!sessionUpdated) {
      return jsonCode(res, 401, 'SESSION_INVALID');
    }

    return res.json({
      ok: true,
      message: 'TWO_FACTOR_VERIFIED',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/me/2fa/recovery-codes/regenerate', authMiddleware, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    if (!user.twoFactor?.enabled) {
      return jsonCode(res, 400, 'TWO_FACTOR_NOT_ENABLED');
    }

    if (hasPasswordHash(user)) {
      const currentPasswordIsValid = await verifyCurrentPassword(user, body?.currentPassword);

      if (!currentPasswordIsValid) {
        return jsonCode(res, 401, 'INVALID_CURRENT_PASSWORD');
      }
    }

    if (!verifyUserTotp(user, body?.code)) {
      return jsonCode(res, 400, 'INVALID_TWO_FACTOR_CODE');
    }

    const recoveryCodes = generateRecoveryCodes(8);

    user.twoFactor.recoveryCodes = await hashRecoveryCodes(recoveryCodes);
    user.twoFactor.lastVerifiedAt = new Date();
    await user.save();

    return res.json({
      ok: true,
      message: 'RECOVERY_CODES_REGENERATED',
      recoveryCodes,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/me/password', authMiddleware, passwordChangeRateLimit, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ message: 'INVALID_INPUT' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'PASSWORD_TOO_SHORT' });
    }

    if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
      return res.status(400).json({ message: 'PASSWORD_TOO_LONG' });
    }

    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(401).json({ message: 'Usuário não encontrado.' });
    }

    if (!hasPasswordHash(user)) {
      return res.status(400).json({
        ok: false,
        code: 'PASSWORD_NOT_AVAILABLE_FOR_PROVIDER_ACCOUNT',
        message: 'PASSWORD_NOT_AVAILABLE_FOR_PROVIDER_ACCOUNT',
      });
    }

    const currentPasswordIsValid = await bcrypt.compare(currentPassword, user.password);

    if (!currentPasswordIsValid) {
      return res.status(401).json({ message: 'INVALID_CURRENT_PASSWORD' });
    }

    const newPasswordMatchesCurrent = await bcrypt.compare(newPassword, user.password);

    if (newPasswordMatchesCurrent) {
      return res.status(400).json({ message: 'PASSWORD_UNCHANGED' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    await Promise.all([
      revokeOtherSessions(user._id, req.session?._id, 'password_changed'),
    ]);

    return res.json({
      ok: true,
      message: 'PASSWORD_UPDATED',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/me/sessions', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const sessions = await Session.find({
      userId: req.userId,
      revokedAt: null,
      expiresAt: { $gt: now },
    }).sort({ createdAt: -1 });

    return res.json(sessions.map((session) => serializeSession(session, req.session?._id)));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.delete('/me/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.sessionId)) {
      return res.status(400).json({ message: 'INVALID_SESSION_ID' });
    }

    await Session.updateOne(
      {
        _id: req.params.sessionId,
        userId: req.userId,
        revokedAt: null,
      },
      {
        $set: {
          revokedAt: new Date(),
          revokedReason: 'user_revoked_session',
        },
      }
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.delete('/me/sessions', authMiddleware, async (req, res) => {
  try {
    const body = getObjectBody(req.body);

    if (body?.mode !== 'others') {
      return res.status(400).json({ message: 'INVALID_MODE' });
    }

    const revokedCount = await revokeOtherSessions(req.userId, req.session?._id, 'user_revoked_other_sessions');

    return res.json({
      ok: true,
      revokedCount,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.delete('/me/account', authMiddleware, async (req, res) => {
  try {
    if (req.authLegacyToken || !req.session?.jti) {
      return res.status(401).json({
        code: 'SESSION_REFRESH_REQUIRED',
        message: 'SESSION_REFRESH_REQUIRED',
      });
    }

    const body = getObjectBody(req.body);

    if (body?.confirmText !== 'DELETE') {
      return res.status(400).json({
        code: 'DELETE_CONFIRMATION_REQUIRED',
        message: 'DELETE_CONFIRMATION_REQUIRED',
      });
    }

    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    if (hasActivePaidSubscription(user)) {
      return res.status(409).json({
        code: 'ACTIVE_SUBSCRIPTION',
        message: 'ACTIVE_SUBSCRIPTION',
      });
    }

    if (hasPasswordHash(user)) {
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const currentPasswordIsValid = currentPassword
        ? await bcrypt.compare(currentPassword, user.password)
        : false;

      if (!currentPasswordIsValid) {
        return res.status(401).json({
          code: 'INVALID_CURRENT_PASSWORD',
          message: 'INVALID_CURRENT_PASSWORD',
        });
      }
    }

    const now = new Date();

    user.deletedAt = now;
    user.deletedIdentityHashes = [
      hashDeletedIdentity('email', user.email),
      hashDeletedIdentity('google', user.googleId),
      hashDeletedIdentity('github', user.githubId),
    ].filter(Boolean);
    user.deletionReason = typeof body.deletionReason === 'string'
      ? body.deletionReason.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 280)
      : undefined;
    user.name = 'Deleted user';
    user.email = getDeletedEmail(user._id);
    user.password = undefined;
    user.googleId = undefined;
    user.githubId = undefined;
    user.avatar = undefined;
    user.emailVerified = false;
    user.providers = [];
    user.onboardingComplete = false;
    user.plan = 'free';
    user.profile = {
      displayName: 'Deleted user',
      bio: '',
      website: '',
      company: '',
      location: '',
      visibility: 'private',
      avatarUrl: '',
    };
    user.preferences = {
      language: 'english',
      appearance: 'system',
      chatSuggestions: false,
      soundOnComplete: 'never',
      autoSave: false,
      confirmBeforeDelete: true,
      compactMode: false,
    };
    user.stripeCustomerId = undefined;
    user.stripeTestCustomerId = undefined;
    user.stripeLiveCustomerId = undefined;
    user.stripeSubscriptionId = undefined;
    user.stripeTestSubscriptionId = undefined;
    user.stripeLiveSubscriptionId = undefined;
    user.subscriptionStatus = undefined;
    user.stripeTestSubscriptionStatus = undefined;
    user.stripeLiveSubscriptionStatus = undefined;
    user.subscriptionCurrentPeriodEnd = undefined;
    user.stripeTestSubscriptionCurrentPeriodEnd = undefined;
    user.stripeLiveSubscriptionCurrentPeriodEnd = undefined;
    user.billingUpdatedAt = now;
    clearTwoFactor(user);

    await user.save();

    await Promise.all([
      Session.updateMany(
        {
          userId: user._id,
          revokedAt: null,
        },
        {
          $set: {
            revokedAt: now,
            revokedReason: 'account_deleted',
          },
        }
      ),
      deleteProjectsData(projectIds),
    ]);

    clearPublicSessionCookie(res);
    clearPublicCsrfCookie(res);

    return res.json({
      ok: true,
      message: 'ACCOUNT_DELETED',
    });
  } catch (error) {
    return res.status(500).json({
      code: 'ACCOUNT_DELETION_FAILED',
      message: 'ACCOUNT_DELETION_FAILED',
    });
  }
});

router.patch('/me/profile', authMiddleware, async (req, res) => {
  try {
    const body = getObjectBody(req.body);

    if (!body) {
      return res.status(400).json({ code: 'PROFILE_VALIDATION_FAILED', message: 'PROFILE_VALIDATION_FAILED' });
    }

    const allowedFields = [...Object.keys(PROFILE_FIELDS), 'visibility'];
    const unknownMessage = rejectUnknownFields(body, allowedFields);

    if (unknownMessage) {
      return res.status(400).json({ code: 'PROFILE_VALIDATION_FAILED', message: 'PROFILE_VALIDATION_FAILED' });
    }

    const updates = {};

    Object.entries(PROFILE_STRING_FIELDS).forEach(([field, maxLength]) => {
      const normalized = normalizeOptionalString(body[field], maxLength);

      if (normalized === null) {
        updates[field] = null;
        return;
      }

      if (normalized !== undefined) {
        updates[field] = normalized;
      }
    });

    if (Object.values(updates).some((value) => value === null)) {
      return res.status(400).json({ code: 'PROFILE_VALIDATION_FAILED', message: 'PROFILE_VALIDATION_FAILED' });
    }

    const username = normalizeUsername(body.username);

    if (username === null) {
      return res.status(400).json({
        code: 'INVALID_USERNAME',
        message: 'INVALID_USERNAME',
      });
    }

    if (username !== undefined) {
      updates.username = username;
    }

    const website = normalizeHttpsUrl(body.website, { maxLength: PROFILE_FIELDS.website });

    if (website === null) {
      return res.status(400).json({
        code: 'INVALID_WEBSITE',
        message: 'INVALID_WEBSITE',
      });
    }

    if (website !== undefined) {
      updates.website = website;
    }

    const avatarUrl = normalizeHttpsUrl(body.avatarUrl, { maxLength: PROFILE_FIELDS.avatarUrl });

    if (avatarUrl === null) {
      return res.status(400).json({
        code: 'INVALID_AVATAR_URL',
        message: 'INVALID_AVATAR_URL',
      });
    }

    if (avatarUrl !== undefined) {
      updates.avatarUrl = avatarUrl;
    }

    if (body.visibility !== undefined) {
      if (typeof body.visibility !== 'string' || !PROFILE_VISIBILITIES.has(body.visibility)) {
        return res.status(400).json({ code: 'PROFILE_VALIDATION_FAILED', message: 'PROFILE_VALIDATION_FAILED' });
      }

      updates.visibility = body.visibility;
    }

    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    const currentUsername = user.profile?.username || '';

    if (updates.username && updates.username !== currentUsername) {
      const usernameExists = await User.exists({
        _id: { $ne: user._id },
        'profile.username': updates.username,
      });

      if (usernameExists) {
        return res.status(409).json({ code: 'USERNAME_TAKEN', message: 'USERNAME_TAKEN' });
      }
    }

    if (updates.username === '') {
      updates.username = undefined;
    }

    user.profile = {
      ...(user.profile?.toObject ? user.profile.toObject() : user.profile || {}),
      ...updates,
    };

    await user.save();

    const settings = await serializeAccountSettings(user);

    return res.json({ settings });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.['profile.username']) {
      return res.status(409).json({ code: 'USERNAME_TAKEN', message: 'USERNAME_TAKEN' });
    }

    if (error?.name === 'ValidationError') {
      return res.status(400).json({ code: 'PROFILE_VALIDATION_FAILED', message: 'PROFILE_VALIDATION_FAILED' });
    }

    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/me/preferences', authMiddleware, async (req, res) => {
  try {
    const body = getObjectBody(req.body);

    if (!body) {
      return res.status(400).json({ message: 'Informe preferências válidas.' });
    }

    const allowedFields = [...Object.keys(PREFERENCE_ENUMS), ...PREFERENCE_BOOLEANS];
    const unknownMessage = rejectUnknownFields(body, allowedFields);

    if (unknownMessage) {
      return res.status(400).json({ message: unknownMessage });
    }

    const updates = {};

    Object.entries(PREFERENCE_ENUMS).forEach(([field, allowedValues]) => {
      if (body[field] === undefined) {
        return;
      }

      const value = field === 'language' ? normalizeAccountLanguage(body[field]) : body[field];

      if (typeof value !== 'string' || !allowedValues.has(value)) {
        updates[field] = null;
        return;
      }

      updates[field] = value;
    });

    PREFERENCE_BOOLEANS.forEach((field) => {
      if (body[field] === undefined) {
        return;
      }

      if (typeof body[field] !== 'boolean') {
        updates[field] = null;
        return;
      }

      updates[field] = body[field];
    });

    if (Object.values(updates).some((value) => value === null)) {
      return res.status(400).json({ message: 'Informe preferências válidas.' });
    }

    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    user.preferences = {
      ...(user.preferences?.toObject ? user.preferences.toObject() : user.preferences || {}),
      ...updates,
    };

    await user.save();

    const settings = await serializeAccountSettings(user);

    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.patch('/onboarding', authMiddleware, async (req, res) => {
  try {
    const theme = normalizeRequiredString(req.body.theme, 64);
    const displayName = normalizeRequiredString(req.body.displayName, 80);
    const role = normalizeRequiredString(req.body.role, 120);
    const goal = normalizeRequiredString(req.body.goal, 160);

    if (!theme || !displayName || !role || !goal) {
      return res.status(400).json({
        message: 'Informe theme, displayName, role e goal válidos.',
      });
    }

    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    user.preferences = {
      theme,
      displayName,
      role,
      goal,
      completedAt: new Date(),
    };
    user.onboardingComplete = true;

    await user.save();

    return res.json({ user: serializeUser(user) });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.get('/google/callback', async (req, res) => {
  try {
    const config = getGoogleOAuthConfig();
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const stateMatchesBrowser = consumeOAuthStateCookie(req, res, 'google', state);
    const statePayload = stateMatchesBrowser ? verifyGoogleOAuthState(state) : null;

    if (!hasGoogleOAuthConfig(config) || !code || !statePayload) {
      return redirectToOAuthError(res);
    }

    const tokenResponse = await exchangeGoogleCodeForToken(code, config);

    if (!tokenResponse.access_token) {
      return redirectToOAuthError(res);
    }

    const rawProfile = await fetchGoogleProfile(tokenResponse.access_token);
    const profile = normalizeGoogleProfile(rawProfile);

    if (!profile) {
      return redirectToOAuthError(res);
    }

    if (await deletedIdentityExists([
      { type: 'email', value: profile.email },
      { type: 'google', value: profile.googleId },
    ])) {
      return redirectToOAuthError(res);
    }

    let user = await User.findOne({ googleId: profile.googleId });

    if (user?.deletedAt) {
      return redirectToOAuthError(res);
    }

    if (!user) {
      user = await User.findOne({ email: profile.email });

      if (user?.deletedAt) {
        return redirectToOAuthError(res);
      }
    }

    if (user) {
      if (user.googleId && user.googleId !== profile.googleId) {
        return redirectToOAuthError(res);
      }

      user.googleId = user.googleId || profile.googleId;
      user.avatar = user.avatar || profile.avatar;
      user.emailVerified = true;
      withGoogleProvider(user);
      await user.save();
    } else {
      user = await User.create({
        name: profile.name,
        email: profile.email,
        googleId: profile.googleId,
        avatar: profile.avatar,
        emailVerified: true,
        providers: ['google'],
      });
    }

    await createSessionAndSetCookie(user, req, res);

    return redirectToOAuthSuccess(res, statePayload.redirect);
  } catch (error) {
    return redirectToOAuthError(res);
  }
});

router.get('/github/callback', async (req, res) => {
  let statePayload = null;

  try {
    const config = getGitHubOAuthConfig();
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    if (!hasGitHubOAuthConfig(config)) {
      return redirectToOAuthCodeError(res, 'GITHUB_OAUTH_NOT_CONFIGURED');
    }

    const stateMatchesBrowser = consumeOAuthStateCookie(req, res, 'github', state);
    statePayload = stateMatchesBrowser ? verifyGitHubOAuthState(state) : null;

    if (!statePayload) {
      return redirectToOAuthCodeError(res, 'GITHUB_STATE_INVALID');
    }

    if (!code) {
      return redirectToOAuthCodeError(res, 'GITHUB_OAUTH_FAILED');
    }

    const tokenResponse = await exchangeGitHubCodeForToken(code, config);
    const [rawProfile, rawEmails] = await Promise.all([
      fetchGitHubProfile(tokenResponse.access_token),
      fetchGitHubEmails(tokenResponse.access_token),
    ]);
    const profile = normalizeGitHubProfile(rawProfile, rawEmails);

    if (!profile) {
      return redirectToOAuthCodeError(res, 'GITHUB_EMAIL_REQUIRED');
    }

    if (await deletedIdentityExists([
      { type: 'email', value: profile.email },
      { type: 'github', value: profile.githubId },
    ])) {
      return redirectToOAuthCodeError(res, 'GITHUB_ACCOUNT_LINK_FAILED');
    }

    let user = await User.findOne({ githubId: profile.githubId });

    if (user?.deletedAt) {
      return redirectToOAuthCodeError(res, 'GITHUB_ACCOUNT_LINK_FAILED');
    }

    if (!user) {
      user = await User.findOne({ email: profile.email });

      if (user?.deletedAt) {
        return redirectToOAuthCodeError(res, 'GITHUB_ACCOUNT_LINK_FAILED');
      }
    }

    if (user) {
      if (user.githubId && user.githubId !== profile.githubId) {
        return redirectToOAuthCodeError(res, 'GITHUB_ACCOUNT_LINK_FAILED');
      }

      user.githubId = user.githubId || profile.githubId;
      user.emailVerified = true;
      withGitHubProvider(user);
      applyGitHubAvatarIfEmpty(user, profile.avatar);
      await user.save();
    } else {
      const username = await generateUniqueUsername(profile.login, profile.githubId);
      const userProfile = {};

      if (username) {
        userProfile.username = username;
      }

      if (profile.avatar) {
        userProfile.avatarUrl = profile.avatar;
      }

      user = await User.create({
        name: profile.name,
        email: profile.email,
        githubId: profile.githubId,
        avatar: profile.avatar,
        emailVerified: true,
        providers: ['github'],
        plan: 'free',
        profile: userProfile,
      });
    }

    await createSessionAndSetCookie(user, req, res);

    return redirectToOAuthSuccess(res, statePayload.redirect);
  } catch (error) {
    if (error?.code === 11000) {
      return redirectToOAuthCodeError(res, 'GITHUB_ACCOUNT_LINK_FAILED');
    }

    return redirectToOAuthCodeError(res, 'GITHUB_OAUTH_FAILED');
  }
});

router.post('/register', async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const name = body?.name;
    const email = body?.email;
    const password = body?.password;

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 120 ||
      typeof email !== 'string' ||
      !email.trim() ||
      email.length > MAX_EMAIL_CHARS ||
      typeof password !== 'string' ||
      !password
    ) {
      return res.status(400).json({ message: 'Preencha todos os campos.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);

    if (!emailIsValid) {
      return res.status(400).json({ message: 'Informe um e-mail válido.' });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: 'A senha deve ter pelo menos 8 caracteres.',
      });
    }

    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return res.status(400).json({ message: 'A senha excede o limite seguro.' });
    }

    const userExists = await User.findOne({ email: normalizedEmail });

    if (userExists || await deletedIdentityExists([{ type: 'email', value: normalizedEmail }])) {
      return res.status(400).json({ message: 'Este e-mail já está cadastrado.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      providers: ['local'],
    });

    return res.status(201).json({
      message: 'Usuário cadastrado com sucesso.',
      user: serializeUser(user),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ message: 'Este e-mail já está cadastrado.' });
    }

    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/2fa/verify-login', twoFactorVerifyLoginRateLimit, async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const loginChallenge = typeof body?.loginChallenge === 'string' ? body.loginChallenge : '';

    if (!loginChallenge) {
      return jsonCode(res, 401, 'TWO_FACTOR_CHALLENGE_EXPIRED');
    }

    let decoded;

    try {
      decoded = jwt.verify(loginChallenge, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
      return jsonCode(res, 401, 'TWO_FACTOR_CHALLENGE_EXPIRED');
    }

    if (!decoded?.id || decoded.purpose !== 'two_factor_login') {
      return jsonCode(res, 401, 'TWO_FACTOR_CHALLENGE_EXPIRED');
    }

    const user = await User.findById(decoded.id);

    if (!user || user.deletedAt || !user.twoFactor?.enabled) {
      return jsonCode(res, 401, 'TWO_FACTOR_CHALLENGE_EXPIRED');
    }

    const verification = await verifyTwoFactorCredential(user, body?.code, {
      allowRecovery: true,
      markRecoveryUsed: true,
    });

    if (!verification.valid) {
      return jsonCode(res, 400, 'INVALID_TWO_FACTOR_CODE');
    }

    user.twoFactor.lastVerifiedAt = new Date();

    if (verification.usedRecoveryCode) {
      await user.save();
    } else {
      await User.updateOne(
        { _id: user._id },
        { $set: { 'twoFactor.lastVerifiedAt': user.twoFactor.lastVerifiedAt } }
      );
    }

    const { token } = await createSessionAndSetCookie(user, req, res);

    return res.json(buildAuthenticatedPayload({
      ok: true,
      user: serializeUser(user),
    }, token));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/login', async (req, res) => {
  try {
    const body = getObjectBody(req.body);
    const email = body?.email;
    const password = body?.password;

    if (
      typeof email !== 'string' ||
      !email.trim() ||
      email.length > MAX_EMAIL_CHARS ||
      typeof password !== 'string' ||
      !password ||
      Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      return res.status(400).json({ message: 'Preencha e-mail e senha.' });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    const passwordIsValid = await bcrypt.compare(password, user?.password || INVALID_PASSWORD_HASH);

    if (!user || !user.password || !passwordIsValid || user.deletedAt) {
      return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
    }

    if (user.twoFactor?.enabled) {
      return res.json({
        ok: true,
        requiresTwoFactor: true,
        loginChallenge: createTwoFactorLoginChallenge(user),
        message: 'TWO_FACTOR_REQUIRED',
      });
    }

    const { token } = await createSessionAndSetCookie(user, req, res);

    return res.json(buildAuthenticatedPayload({
      ok: true,
      message: 'Login realizado com sucesso.',
      user: serializeUser(user),
    }, token));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/session/migrate', async (req, res) => {
  try {
    if (!isPublicCookieAuthEnabled() || !isPublicBearerAuthLegacyEnabled()) {
      return res.status(404).json({ message: 'Not found.' });
    }

    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ message: 'Token não enviado.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    if (!decoded?.id || !decoded?.jti || decoded.runtimeUserId) {
      return res.status(401).json({
        code: 'SESSION_REFRESH_REQUIRED',
        message: 'SESSION_REFRESH_REQUIRED',
      });
    }

    const now = new Date();
    const [session, user] = await Promise.all([
      Session.findOne({
        jti: decoded.jti,
        userId: decoded.id,
        revokedAt: null,
        expiresAt: { $gt: now },
      }),
      User.findById(decoded.id).select('deletedAt'),
    ]);

    if (!session) {
      return res.status(401).json({
        code: 'SESSION_INVALID',
        message: 'Sessão inválida ou expirada.',
      });
    }

    if (user?.deletedAt) {
      return res.status(401).json({
        code: 'ACCOUNT_DELETED',
        message: 'ACCOUNT_DELETED',
      });
    }

    setPublicSessionCookie(res, token, session.expiresAt);
    setCsrfTokenResponse(res);

    return res.json({
      ok: true,
      migrationDeadline: getPublicAuthMigrationDeadline(),
    });
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido ou expirado.' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = getPublicSessionCookieValue(req)
      || (isPublicBearerAuthLegacyEnabled() ? getBearerToken(req) : '');

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

        if (decoded?.jti && decoded?.id && !decoded.runtimeUserId) {
          await Session.updateOne(
            {
              jti: decoded.jti,
              userId: decoded.id,
              revokedAt: null,
            },
            {
              $set: {
                revokedAt: new Date(),
                revokedReason: 'logout',
              },
            }
          );
        }
      } catch (error) {
        // Logout stays idempotent for expired, malformed, or already invalid tokens.
      }
    }

    clearPublicSessionCookie(res);
    clearPublicCsrfCookie(res);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

module.exports = router;
