const express = require('express');
const bcrypt = require('bcryptjs');
const authMiddleware = require('../middleware/authMiddleware');
const Project = require('../models/Project');
const User = require('../models/User');
const { serializeUser, signAuthToken } = require('../utils/auth');

const router = express.Router();
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://askfluid.now').replace(/\/+$/, '');
}

function redirectToOAuthError(res) {
  return res.redirect(`${getFrontendUrl()}/login.html?oauth_error=google`);
}

function redirectToOAuthSuccess(res, token, user) {
  const encodedToken = encodeURIComponent(token);
  const encodedUser = encodeURIComponent(JSON.stringify(user));

  return res.redirect(`${getFrontendUrl()}/auth-callback.html#token=${encodedToken}&user=${encodedUser}`);
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
  username: 32,
  bio: 240,
  website: 120,
  company: 80,
  location: 80,
});
const PROFILE_VISIBILITIES = new Set(['public', 'private']);
const PREFERENCE_ENUMS = Object.freeze({
  language: new Set(['english', 'portuguese']),
  appearance: new Set(['light', 'dark', 'system']),
  soundOnComplete: new Set(['first', 'always', 'never']),
});
const PREFERENCE_BOOLEANS = new Set([
  'chatSuggestions',
  'autoSave',
  'confirmBeforeDelete',
  'compactMode',
]);

function getObjectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
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

  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) {
    return null;
  }

  return normalized;
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
  };
}

async function findAuthenticatedUser(req, res) {
  const user = await User.findById(req.userId);

  if (!user) {
    res.status(401).json({ message: 'Usuário não encontrado.' });
    return null;
  }

  return user;
}

router.get('/google', (req, res) => {
  const config = getGoogleOAuthConfig();

  if (!hasGoogleOAuthConfig(config)) {
    return redirectToOAuthError(res);
  }

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('prompt', 'select_account');

  return res.redirect(authUrl.toString());
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

router.patch('/me/profile', authMiddleware, async (req, res) => {
  try {
    const body = getObjectBody(req.body);

    if (!body) {
      return res.status(400).json({ message: 'Informe um perfil válido.' });
    }

    const allowedFields = [...Object.keys(PROFILE_FIELDS), 'visibility'];
    const unknownMessage = rejectUnknownFields(body, allowedFields);

    if (unknownMessage) {
      return res.status(400).json({ message: unknownMessage });
    }

    const updates = {};

    Object.entries(PROFILE_FIELDS).forEach(([field, maxLength]) => {
      if (field === 'username') {
        return;
      }

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
      return res.status(400).json({ message: 'Informe campos de perfil válidos.' });
    }

    const username = normalizeUsername(body.username);

    if (username === null) {
      return res.status(400).json({
        message: 'Username deve ter 3 a 32 caracteres e usar apenas letras minúsculas, números, underscore ou hífen.',
      });
    }

    if (username !== undefined) {
      updates.username = username;
    }

    if (body.visibility !== undefined) {
      if (typeof body.visibility !== 'string' || !PROFILE_VISIBILITIES.has(body.visibility)) {
        return res.status(400).json({ message: 'Visibilidade inválida.' });
      }

      updates.visibility = body.visibility;
    }

    const user = await findAuthenticatedUser(req, res);

    if (!user) {
      return undefined;
    }

    if (updates.username) {
      const usernameExists = await User.exists({
        _id: { $ne: user._id },
        'profile.username': updates.username,
      });

      if (usernameExists) {
        return res.status(409).json({ message: 'Este username já está em uso.' });
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
      return res.status(409).json({ message: 'Este username já está em uso.' });
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

      if (typeof body[field] !== 'string' || !allowedValues.has(body[field])) {
        updates[field] = null;
        return;
      }

      updates[field] = body[field];
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

    if (!hasGoogleOAuthConfig(config) || !code) {
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

    let user = await User.findOne({ googleId: profile.googleId });

    if (!user) {
      user = await User.findOne({ email: profile.email });
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

    const token = signAuthToken(user);
    const serializedUser = serializeUser(user);

    return redirectToOAuthSuccess(res, token, serializedUser);
  } catch (error) {
    return redirectToOAuthError(res);
  }
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof email !== 'string' ||
      !email.trim() ||
      typeof password !== 'string' ||
      !password
    ) {
      return res.status(400).json({ message: 'Preencha todos os campos.' });
    }

    const normalizedEmail = email.trim();
    const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);

    if (!emailIsValid) {
      return res.status(400).json({ message: 'Informe um e-mail válido.' });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: 'A senha deve ter pelo menos 8 caracteres.',
      });
    }

    const userExists = await User.findOne({ email: normalizedEmail });

    if (userExists) {
      return res.status(400).json({ message: 'Este e-mail já está cadastrado.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      providers: ['local'],
    });

    return res.status(201).json({
      message: 'Usuário cadastrado com sucesso.',
      user: serializeUser(user),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Preencha e-mail e senha.' });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
    }

    if (!user.password) {
      return res.status(401).json({ message: 'Esta conta usa login com Google.' });
    }

    const passwordIsValid = await bcrypt.compare(password, user.password);

    if (!passwordIsValid) {
      return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
    }

    const token = signAuthToken(user);

    return res.json({
      message: 'Login realizado com sucesso.',
      token,
      user: serializeUser(user),
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro interno do servidor.',
    });
  }
});

module.exports = router;
