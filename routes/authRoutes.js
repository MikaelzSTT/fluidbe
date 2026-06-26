const express = require('express');
const bcrypt = require('bcryptjs');
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
