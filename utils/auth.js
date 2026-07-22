const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Session = require('../models/Session');

const AUTH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_TOKEN_EXPIRES_IN = '7d';
const SESSION_MFA_CAPTURE_WINDOW_MS = 60 * 1000;

function serializePreferences(preferences) {
  return {
    language: preferences?.language || 'english',
    appearance: preferences?.appearance || 'system',
    chatSuggestions: preferences?.chatSuggestions === undefined ? true : Boolean(preferences.chatSuggestions),
    soundOnComplete: preferences?.soundOnComplete || 'first',
    autoSave: preferences?.autoSave === undefined ? true : Boolean(preferences.autoSave),
    confirmBeforeDelete: preferences?.confirmBeforeDelete === undefined ? true : Boolean(preferences.confirmBeforeDelete),
    compactMode: preferences?.compactMode === undefined ? false : Boolean(preferences.compactMode),
    theme: preferences?.theme || null,
    displayName: preferences?.displayName || null,
    role: preferences?.role || null,
    goal: preferences?.goal || null,
    completedAt: preferences?.completedAt || null,
  };
}

function serializeProfile(profile, user) {
  const visibility = profile?.visibility === 'private' ? 'private' : 'public';

  return {
    displayName: profile?.displayName || user.name || '',
    username: profile?.username || '',
    bio: profile?.bio || '',
    website: profile?.website || '',
    company: profile?.company || '',
    location: profile?.location || '',
    visibility,
    avatarUrl: profile?.avatarUrl || '',
  };
}

function signAuthToken(user, jti) {
  return jwt.sign(
    { id: user._id, jti },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: AUTH_TOKEN_EXPIRES_IN }
  );
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function hashIp(req) {
  const ip = getClientIp(req);
  const secret = process.env.SESSION_IP_HASH_SECRET || process.env.JWT_SECRET;

  if (!ip || !secret) {
    return undefined;
  }

  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

function getSessionMfaVerifiedAt(user, now) {
  if (!user?.twoFactor?.enabled || !user.twoFactor.lastVerifiedAt) {
    return undefined;
  }

  const lastVerifiedAt = new Date(user.twoFactor.lastVerifiedAt);
  const lastVerifiedMs = lastVerifiedAt.getTime();

  if (
    !Number.isFinite(lastVerifiedMs) ||
    lastVerifiedMs > now.getTime() + 5000 ||
    now.getTime() - lastVerifiedMs > SESSION_MFA_CAPTURE_WINDOW_MS
  ) {
    return undefined;
  }

  return lastVerifiedAt;
}

async function createAuthSession(user, req) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000);
  const jti = crypto.randomUUID();
  const userAgent = typeof req?.headers?.['user-agent'] === 'string'
    ? req.headers['user-agent'].slice(0, 512)
    : undefined;

  await Session.create({
    userId: user._id,
    jti,
    userAgent,
    ipHash: hashIp(req),
    mfaVerifiedAt: getSessionMfaVerifiedAt(user, now),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });

  return { jti, expiresAt };
}

async function createAuthToken(user, req) {
  const session = await createAuthSession(user, req);

  return signAuthToken(user, session.jti);
}

async function createAuthTokenPair(user, req) {
  const session = await createAuthSession(user, req);
  const token = signAuthToken(user, session.jti);

  return {
    token,
    session,
  };
}

function hasPasswordHash(user) {
  return typeof user?.password === 'string' && user.password.trim().length > 0;
}

function serializeAuthMetadata(user) {
  const providers = [];

  if (hasPasswordHash(user)) {
    providers.push('password');
  }

  if (Array.isArray(user?.providers) && user.providers.includes('google')) {
    providers.push('google');
  } else if (typeof user?.googleId === 'string' && user.googleId.trim()) {
    providers.push('google');
  }

  if (Array.isArray(user?.providers) && user.providers.includes('github')) {
    providers.push('github');
  } else if (typeof user?.githubId === 'string' && user.githubId.trim()) {
    providers.push('github');
  }

  return {
    hasPassword: hasPasswordHash(user),
    providers,
  };
}

function serializeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
    emailVerified: Boolean(user.emailVerified),
    providers: Array.isArray(user.providers) ? user.providers : [],
    auth: serializeAuthMetadata(user),
    onboardingComplete: Boolean(user.onboardingComplete),
    profile: serializeProfile(user.profile, user),
    preferences: serializePreferences(user.preferences),
  };
}

module.exports = {
  AUTH_TOKEN_TTL_SECONDS,
  createAuthSession,
  createAuthToken,
  createAuthTokenPair,
  hasPasswordHash,
  serializeAuthMetadata,
  serializeProfile,
  serializeUser,
  signAuthToken,
};
