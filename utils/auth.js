const jwt = require('jsonwebtoken');

function serializePreferences(preferences) {
  return {
    theme: preferences?.theme || null,
    displayName: preferences?.displayName || null,
    role: preferences?.role || null,
    goal: preferences?.goal || null,
    completedAt: preferences?.completedAt || null,
  };
}

function signAuthToken(user) {
  return jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
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
  serializeUser,
  signAuthToken,
};
