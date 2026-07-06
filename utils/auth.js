const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Session = require('../models/Session');

const AUTH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_TOKEN_EXPIRES_IN = '7d';

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

function signAuthToken(user, jti) {
  return jwt.sign(
    { id: user._id, jti },
    process.env.JWT_SECRET,
    { expiresIn: AUTH_TOKEN_EXPIRES_IN }
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

function serializeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    avatar: user.avatar || null,
    emailVerified: Boolean(user.emailVerified),
    providers: Array.isArray(user.providers) ? user.providers : [],
    onboardingComplete: Boolean(user.onboardingComplete),
    preferences: serializePreferences(user.preferences),
  };
}

module.exports = {
  AUTH_TOKEN_TTL_SECONDS,
  createAuthSession,
  createAuthToken,
  serializeUser,
  signAuthToken,
};
