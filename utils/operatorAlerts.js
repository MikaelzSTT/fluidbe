const User = require('../models/User');

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
const PROMPT_PREVIEW_MAX_CHARS = 160;
const alertJobs = new Set();
let injectedTelegramSender = null;

function getTelegramConfig() {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!botToken || !chatId) {
    return null;
  }

  return { botToken, chatId };
}

function isAutomatedTestRuntime() {
  return process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test';
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function maskEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const atIndex = normalized.indexOf('@');

  if (atIndex <= 0) {
    return '[unknown]';
  }

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const visibleLocal = local.length <= 1 ? local[0] : local.slice(0, Math.min(2, local.length));

  return `${visibleLocal}***@${domain || '[unknown]'}`;
}

function formatUtcTimestamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(value.getTime())) {
    return formatUtcTimestamp(new Date());
  }

  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function normalizeLine(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectSensitiveProcessEnvValues() {
  return Object.entries(process.env)
    .filter(([key, value]) => (
      typeof value === 'string' &&
      value.length >= 8 &&
      /\b(?:TOKEN|SECRET|PASSWORD|PASS|KEY|COOKIE|CREDENTIAL|JWT|CSRF)\b/i.test(key)
    ))
    .map(([, value]) => value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactKnownSensitiveValues(text) {
  return collectSensitiveProcessEnvValues().reduce((redacted, value) => (
    redacted.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]')
  ), text);
}

function redactSecrets(text) {
  let redacted = normalizeLine(text);
  redacted = redactKnownSensitiveValues(redacted);
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  redacted = redacted.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  redacted = redacted.replace(/\bmongodb(?:\+srv)?:\/\/[^\s'"<>]+/gi, 'mongodb://[REDACTED]');
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  redacted = redacted.replace(
    /\b(password|passwordHash|token|jwt|session[_ -]?token|oauth[_ -]?token|cookie|csrf[_ -]?token|secret|credential|api[_ -]?key|admin[_ -]?credentials?)\b\s*[:=]\s*["']?[^"',;}\]\s]+/gi,
    '$1=[REDACTED]'
  );

  return redacted;
}

function truncateText(value, maxLength = PROMPT_PREVIEW_MAX_CHARS) {
  const normalized = normalizeLine(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function safePromptPreview(prompt, maxLength = PROMPT_PREVIEW_MAX_CHARS) {
  return truncateText(redactSecrets(prompt), maxLength);
}

function getPrimaryProvider(user, fallbackProvider = '') {
  const provider = String(fallbackProvider || '').trim().toLowerCase();

  if (provider === 'local') {
    return 'email';
  }

  if (provider) {
    return provider;
  }

  const providers = Array.isArray(user?.providers) ? user.providers : [];
  if (providers.includes('google')) return 'google';
  if (providers.includes('github')) return 'github';
  return providers.includes('local') ? 'email' : 'unknown';
}

function buildAccountCreatedAlert(user, options = {}) {
  const createdAt = options.createdAt || user?.createdAt || new Date();
  const pendingPromptPreview = safePromptPreview(options.pendingPrompt || '');

  return [
    '🆕 <b>New Fluid user</b>',
    '',
    `Email: ${escapeTelegramHtml(maskEmail(user?.email))}`,
    `Provider: ${escapeTelegramHtml(getPrimaryProvider(user, options.provider))}`,
    `Onboarding: ${user?.onboardingComplete ? 'complete' : 'pending'}`,
    `Pending prompt: ${pendingPromptPreview ? 'yes' : 'no'}`,
    `Created: ${escapeTelegramHtml(formatUtcTimestamp(createdAt))}`,
  ].join('\n');
}

function buildOnboardingCompletedAlert(user, options = {}) {
  const preferences = user?.preferences || {};
  const completedAt = options.completedAt || preferences.completedAt || new Date();
  const promptPreview = safePromptPreview(options.pendingPrompt || user?.pendingPrompt || '');
  const lines = [
    '✅ <b>Fluid onboarding completed</b>',
    '',
    `Email: ${escapeTelegramHtml(maskEmail(user?.email))}`,
    `Role: ${escapeTelegramHtml(truncateText(preferences.role || 'unknown', 120))}`,
    `Goal: ${escapeTelegramHtml(truncateText(preferences.goal || 'unknown', 160))}`,
  ];

  if (promptPreview) {
    lines.push(`Pending prompt: ${escapeTelegramHtml(promptPreview)}`);
  }

  lines.push(`Completed: ${escapeTelegramHtml(formatUtcTimestamp(completedAt))}`);

  return lines.join('\n');
}

async function sendTelegramMessage(text) {
  const config = getTelegramConfig();

  if (!config || isAutomatedTestRuntime()) {
    return false;
  }

  const response = await fetch(`${TELEGRAM_API_ORIGIN}/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed with status ${response.status}.`);
  }

  return true;
}

async function sendAlert(text) {
  if (injectedTelegramSender) {
    return injectedTelegramSender(text);
  }

  return sendTelegramMessage(text);
}

function alertDeliveryAvailable() {
  return Boolean(injectedTelegramSender || (getTelegramConfig() && !isAutomatedTestRuntime()));
}

function logAlertFailure(alertType, error) {
  const message = redactSecrets(error?.message || 'unknown error');
  console.error('Operator Telegram alert failed.', {
    alertType,
    message,
  });
}

function enqueueAlert(alertType, task) {
  const job = Promise.resolve()
    .then(task)
    .catch((error) => {
      logAlertFailure(alertType, error);
    });

  alertJobs.add(job);
  job.finally(() => alertJobs.delete(job));
  return job;
}

async function tryMarkAlert(userId, fieldName, timestamp) {
  if (!userId) {
    return false;
  }

  const result = await User.updateOne(
    {
      _id: userId,
      [fieldName]: { $exists: false },
    },
    {
      $set: {
        [fieldName]: timestamp,
      },
    }
  );

  return Boolean(result?.modifiedCount || result?.matchedCount);
}

function dispatchAccountCreatedAlert(user, options = {}) {
  return enqueueAlert('account_created', async () => {
    if (!alertDeliveryAvailable()) {
      return false;
    }

    const timestamp = options.createdAt || user?.createdAt || new Date();
    const marked = await tryMarkAlert(user?._id, 'operatorAlerts.accountCreatedAt', timestamp);

    if (!marked) {
      return false;
    }

    return sendAlert(buildAccountCreatedAlert(user, { ...options, createdAt: timestamp }));
  });
}

function dispatchOnboardingCompletedAlert(user, options = {}) {
  return enqueueAlert('onboarding_completed', async () => {
    if (!alertDeliveryAvailable()) {
      return false;
    }

    const timestamp = options.completedAt || user?.preferences?.completedAt || new Date();
    const marked = await tryMarkAlert(user?._id, 'operatorAlerts.onboardingCompletedAt', timestamp);

    if (!marked) {
      return false;
    }

    return sendAlert(buildOnboardingCompletedAlert(user, { ...options, completedAt: timestamp }));
  });
}

async function drainOperatorAlertJobs() {
  while (alertJobs.size > 0) {
    await Promise.all(Array.from(alertJobs));
  }
}

function setOperatorAlertSender(sender) {
  injectedTelegramSender = typeof sender === 'function' ? sender : null;
}

module.exports = {
  buildAccountCreatedAlert,
  buildOnboardingCompletedAlert,
  dispatchAccountCreatedAlert,
  dispatchOnboardingCompletedAlert,
  drainOperatorAlertJobs,
  escapeTelegramHtml,
  maskEmail,
  safePromptPreview,
  setOperatorAlertSender,
};
