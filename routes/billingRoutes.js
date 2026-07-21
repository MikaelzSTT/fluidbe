const express = require('express');
const Stripe = require('stripe');
const User = require('../models/User');
const Project = require('../models/Project');
const StripeWebhookEvent = require('../models/StripeWebhookEvent');
const authMiddleware = require('../middleware/authMiddleware');
const { createRateLimit, getClientIp } = require('../middleware/rateLimit');
const { unpublishActiveProjectsForUser } = require('../utils/projectPublication');

const router = express.Router();
const stripeWebhookRateLimit = createRateLimit({
  name: 'billing-stripe-webhook',
  windowMs: 60 * 1000,
  max: 1200,
  keyGenerator: getClientIp,
});
const billingMutationRateLimit = createRateLimit({
  name: 'billing-mutation',
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => String(req.userId || 'anonymous'),
});

const PLAN_DETAILS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free',
    price: 0,
    currency: 'USD',
    interval: null,
    projectLimit: null,
    publishedProjectLimit: 0,
    messagesLimitLabel: '15 messages per project',
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    price: 20,
    currency: 'USD',
    interval: 'month',
    projectLimit: null,
    publishedProjectLimit: 3,
    messagesLimitLabel: 'Unlimited messages',
  }),
  business: Object.freeze({
    id: 'business',
    name: 'Business',
    price: 49,
    currency: 'USD',
    interval: 'month',
    projectLimit: null,
    publishedProjectLimit: 10,
    messagesLimitLabel: 'Unlimited messages',
  }),
});

const BILLING_ENV_NAMES = Object.freeze([
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_PRO_PRICE_ID',
  'STRIPE_BUSINESS_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
  'FRONTEND_URL',
]);
const PLAN_PRICE_ENV_NAMES = Object.freeze({
  pro: 'STRIPE_PRO_PRICE_ID',
  business: 'STRIPE_BUSINESS_PRICE_ID',
});
const STRIPE_MODE_FIELDS = Object.freeze({
  sk_test: Object.freeze({
    customerId: 'stripeTestCustomerId',
    subscriptionId: 'stripeTestSubscriptionId',
    subscriptionStatus: 'stripeTestSubscriptionStatus',
    currentPeriodEnd: 'stripeTestSubscriptionCurrentPeriodEnd',
  }),
  sk_live: Object.freeze({
    customerId: 'stripeLiveCustomerId',
    subscriptionId: 'stripeLiveSubscriptionId',
    subscriptionStatus: 'stripeLiveSubscriptionStatus',
    currentPeriodEnd: 'stripeLiveSubscriptionCurrentPeriodEnd',
  }),
});
const loggedMissingBillingConfig = new Set();

function logBillingError(context, error) {
  console.error(context, {
    name: error?.name || 'Error',
    code: error?.code || null,
    status: error?.statusCode || error?.status || null,
  });
}

function envMode(value, testPrefix, livePrefix) {
  if (!value) {
    return 'missing';
  }

  if (String(value).startsWith(`${testPrefix}_`)) {
    return testPrefix;
  }

  if (String(value).startsWith(`${livePrefix}_`)) {
    return livePrefix;
  }

  return 'invalid';
}

function getStripeMode() {
  return envMode(process.env.STRIPE_SECRET_KEY, 'sk_test', 'sk_live');
}

function getStripeModeFields(stripeMode = getStripeMode()) {
  return STRIPE_MODE_FIELDS[stripeMode] || null;
}

function getStripeEventMode(eventOrObject) {
  return eventOrObject?.livemode ? 'sk_live' : 'sk_test';
}

function getPublishableMode() {
  return envMode(process.env.STRIPE_PUBLISHABLE_KEY, 'pk_test', 'pk_live');
}

function getStripeIdPrefix(stripeId) {
  if (!stripeId) {
    return null;
  }

  const match = String(stripeId).match(/^[A-Za-z]+_/);
  return match ? match[0] : 'invalid';
}

function getStripeIdLast4(stripeId) {
  return stripeId ? String(stripeId).slice(-4) : null;
}

function getPriceIdPrefix(priceId) {
  if (!priceId) {
    return 'missing';
  }

  return String(priceId).startsWith('price_') ? 'price_' : 'invalid';
}

function getPriceIdLast4(priceId) {
  return priceId ? String(priceId).slice(-4) : null;
}

function buildSafeBillingConfigDiagnostics() {
  return {
    stripeMode: getStripeMode(),
    publishableMode: getPublishableMode(),
    webhookSecretPresent: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    prices: {
      pro: {
        envVar: PLAN_PRICE_ENV_NAMES.pro,
        priceIdPrefix: getPriceIdPrefix(process.env.STRIPE_PRO_PRICE_ID),
        priceIdLast4: getPriceIdLast4(process.env.STRIPE_PRO_PRICE_ID),
      },
      business: {
        envVar: PLAN_PRICE_ENV_NAMES.business,
        priceIdPrefix: getPriceIdPrefix(process.env.STRIPE_BUSINESS_PRICE_ID),
        priceIdLast4: getPriceIdLast4(process.env.STRIPE_BUSINESS_PRICE_ID),
      },
    },
  };
}

function buildSafeCheckoutDiagnostics(selectedPlan, priceId) {
  return {
    stripeMode: getStripeMode(),
    publishableMode: getPublishableMode(),
    webhookSecretPresent: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    selectedPlan,
    envVar: PLAN_PRICE_ENV_NAMES[selectedPlan] || null,
    priceIdPrefix: getPriceIdPrefix(priceId),
    priceIdLast4: getPriceIdLast4(priceId),
  };
}

function logCheckoutDiagnostics(message, selectedPlan, priceId, extra = {}) {
  console.info(message, {
    ...buildSafeCheckoutDiagnostics(selectedPlan, priceId),
    ...extra,
  });
}

function buildStripePriceNotFoundResponse(selectedPlan) {
  return {
    error: 'STRIPE_PRICE_NOT_FOUND',
    reason: 'The configured price ID does not exist in the Stripe account/mode used by STRIPE_SECRET_KEY.',
    selectedPlan,
    envVar: PLAN_PRICE_ENV_NAMES[selectedPlan],
  };
}

async function retrieveStripeAccountId(stripe, selectedPlan, priceId) {
  try {
    const account = await stripe.accounts.retrieve();
    logCheckoutDiagnostics('Stripe checkout account resolved.', selectedPlan, priceId, {
      stripeAccountIdPrefix: getStripeIdPrefix(account?.id),
      stripeAccountIdLast4: getStripeIdLast4(account?.id),
    });
    return account?.id || null;
  } catch (error) {
    logCheckoutDiagnostics('Stripe checkout account lookup failed.', selectedPlan, priceId, {
      errorCode: error?.code || null,
      status: error?.statusCode || error?.status || null,
    });
    throw error;
  }
}

async function retrieveConfiguredPrice(stripe, selectedPlan, priceId) {
  try {
    const price = await stripe.prices.retrieve(priceId);
    logCheckoutDiagnostics('Stripe checkout price resolved.', selectedPlan, priceId, {
      priceActive: Boolean(price?.active),
      currency: price?.currency || null,
      recurringInterval: price?.recurring?.interval || null,
      lookupKey: price?.lookup_key || null,
    });
    return price;
  } catch (error) {
    logCheckoutDiagnostics('Stripe checkout price lookup failed.', selectedPlan, priceId, {
      errorCode: error?.code || null,
      status: error?.statusCode || error?.status || null,
    });
    throw error;
  }
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://askfluid.now').replace(/\/+$/, '');
}

function getMissingBillingEnv(requiredNames = BILLING_ENV_NAMES) {
  return requiredNames.filter((name) => !process.env[name]);
}

function logMissingBillingConfig(context, missingNames) {
  if (!missingNames.length) {
    return;
  }

  const key = `${context}:${missingNames.join(',')}`;

  if (loggedMissingBillingConfig.has(key)) {
    return;
  }

  loggedMissingBillingConfig.add(key);
  console.warn(`Stripe billing config missing for ${context}: ${missingNames.join(', ')}`);
}

function getConfigError(context, requiredNames) {
  const missing = getMissingBillingEnv(requiredNames);

  logMissingBillingConfig(context, missing);

  return missing.length
    ? {
        message: 'Stripe billing is not configured.',
        missing,
      }
    : null;
}

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return null;
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function getBillingConfig() {
  return {
    stripe: getStripeClient(),
    priceIds: {
      pro: process.env.STRIPE_PRO_PRICE_ID,
      business: process.env.STRIPE_BUSINESS_PRICE_ID,
    },
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  };
}

function isDuplicateKeyError(error) {
  return error && (error.code === 11000 || error.code === 11001);
}

async function claimStripeWebhookEvent(event) {
  try {
    await StripeWebhookEvent.create({
      eventId: event.id,
      type: event.type || '',
      status: 'processing',
      receivedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
  }

  const existing = await StripeWebhookEvent.findOne({ eventId: event.id }).select('status');

  if (!existing || existing.status !== 'failed') {
    return false;
  }

  const reclaimed = await StripeWebhookEvent.findOneAndUpdate(
    {
      eventId: event.id,
      status: 'failed',
    },
    {
      $set: {
        type: event.type || '',
        status: 'processing',
        receivedAt: new Date(),
        processedAt: null,
        failedAt: null,
      },
    },
    { new: true }
  ).select('_id');

  return Boolean(reclaimed);
}

async function markStripeWebhookEventProcessed(event) {
  await StripeWebhookEvent.updateOne(
    { eventId: event.id },
    {
      $set: {
        status: 'processed',
        processedAt: new Date(),
      },
    }
  );
}

async function markStripeWebhookEventFailed(event) {
  await StripeWebhookEvent.updateOne(
    { eventId: event.id },
    {
      $set: {
        status: 'failed',
        failedAt: new Date(),
      },
    }
  );
}

function normalizePlanId(plan) {
  return PLAN_DETAILS[plan] ? plan : 'free';
}

function normalizeBillingStatus(user) {
  const planId = normalizePlanId(user.plan);
  const status = String(user.subscriptionStatus || '').toLowerCase();

  if (planId === 'free') {
    if (['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'].includes(status)) {
      return status;
    }

    return 'active';
  }

  if (['active', 'trialing', 'past_due', 'canceled', 'inactive'].includes(status)) {
    return status;
  }

  return 'active';
}

function toIsoDateOrNull(date) {
  if (!date) {
    return null;
  }

  const parsedDate = new Date(date);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

async function countUserProjects(userId) {
  const [activeProjects, publishedProjects] = await Promise.all([
    Project.countDocuments({
      userId,
    }),
    Project.countDocuments({
      userId,
      $or: [
        { isPublished: true },
        { status: { $in: ['published', 'deployed', 'live'] } },
        { 'deploy.isPublished': true },
      ],
    }),
  ]);

  return {
    activeProjects,
    publishedProjects,
  };
}

async function serializeBilling(user) {
  const planId = normalizePlanId(user.plan);
  const planDetails = PLAN_DETAILS[planId];
  const usageCounts = await countUserProjects(user._id);

  return {
    ok: true,
    plan: {
      id: planDetails.id,
      name: planDetails.name,
      status: normalizeBillingStatus(user),
      price: planDetails.price,
      currency: planDetails.currency,
      interval: planDetails.interval,
      currentPeriodEnd: toIsoDateOrNull(user.subscriptionCurrentPeriodEnd),
    },
    usage: {
      activeProjects: usageCounts.activeProjects,
      publishedProjects: usageCounts.publishedProjects,
      projectLimit: planDetails.projectLimit,
      publishedProjectLimit: planDetails.publishedProjectLimit,
      messagesLimitLabel: planDetails.messagesLimitLabel,
    },
    billingHistory: [],
  };
}

function subscriptionPeriodEnd(subscription) {
  const periodEnd =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end ||
    null;

  return periodEnd ? new Date(periodEnd * 1000) : undefined;
}

function isActiveSubscriptionStatus(status) {
  return status === 'active' || status === 'trialing';
}

function getPriceIdsFromSubscription(subscription) {
  return (subscription.items?.data || [])
    .map((item) => item.price?.id || item.plan?.id)
    .filter(Boolean);
}

function getPriceIdsFromInvoice(invoice) {
  return (invoice.lines?.data || [])
    .map((line) => line.price?.id || line.plan?.id)
    .filter(Boolean);
}

function invoicePeriodEnd(invoice) {
  const periodEnd = invoice.lines?.data
    ?.map((line) => line.period?.end)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];

  return periodEnd ? new Date(periodEnd * 1000) : undefined;
}

function logUnknownStripePrice(source, priceIds) {
  console.warn('Stripe billing event ignored unknown price ids.', {
    source,
    priceCount: priceIds.length,
  });
}

function planForPriceIds(priceIds, source) {
  if (process.env.STRIPE_BUSINESS_PRICE_ID && priceIds.includes(process.env.STRIPE_BUSINESS_PRICE_ID)) {
    return 'business';
  }

  if (process.env.STRIPE_PRO_PRICE_ID && priceIds.includes(process.env.STRIPE_PRO_PRICE_ID)) {
    return 'pro';
  }

  logUnknownStripePrice(source, priceIds);
  return null;
}

function planForSubscription(subscription) {
  if (!isActiveSubscriptionStatus(subscription.status)) {
    return 'free';
  }

  return planForPriceIds(getPriceIdsFromSubscription(subscription), 'subscription');
}

function planForInvoiceStatus(status, invoice) {
  if (!isActiveSubscriptionStatus(status)) {
    return 'free';
  }

  return planForPriceIds(getPriceIdsFromInvoice(invoice), 'invoice');
}

async function unpublishIfPlanIsFree(user) {
  if (!user || user.plan !== 'free') {
    return;
  }

  await unpublishActiveProjectsForUser(user._id);
}

async function findCurrentUser(req, res) {
  const user = await User.findById(req.userId);

  if (!user) {
    res.status(404).json({ message: 'User not found.' });
    return null;
  }

  return user;
}

function getModeSpecificValue(user, stripeMode, fieldName) {
  const fields = getStripeModeFields(stripeMode);
  return fields ? user?.[fields[fieldName]] : null;
}

function setModeSpecificValue(target, stripeMode, fieldName, value) {
  const fields = getStripeModeFields(stripeMode);

  if (fields?.[fieldName] && value !== undefined) {
    target[fields[fieldName]] = value;
  }
}

function unsetModeSpecificValue(target, stripeMode, fieldName) {
  const fields = getStripeModeFields(stripeMode);

  if (fields?.[fieldName]) {
    target[fields[fieldName]] = '';
  }
}

function buildStripeUserLookup({ stripeCustomerId, stripeSubscriptionId, userId, stripeMode }) {
  const modeFields = getStripeModeFields(stripeMode);

  return [
    ...(stripeCustomerId && modeFields ? [{ [modeFields.customerId]: stripeCustomerId }] : []),
    ...(stripeSubscriptionId && modeFields ? [{ [modeFields.subscriptionId]: stripeSubscriptionId }] : []),
    ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
    ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
    ...(userId ? [{ _id: userId }] : []),
  ];
}

function getStoredStripeCustomerIdForMode(user, stripeMode) {
  const modeCustomerId = getModeSpecificValue(user, stripeMode, 'customerId');

  if (modeCustomerId) {
    return {
      customerId: modeCustomerId,
      source: getStripeModeFields(stripeMode)?.customerId || 'modeSpecific',
      isLegacyFallback: false,
    };
  }

  if (user?.stripeCustomerId) {
    return {
      customerId: user.stripeCustomerId,
      source: 'stripeCustomerId',
      isLegacyFallback: true,
    };
  }

  return {
    customerId: null,
    source: null,
    isLegacyFallback: false,
  };
}

function getResourceHint(error) {
  const param = String(error?.param || error?.raw?.param || '').toLowerCase();

  if (param.includes('customer')) {
    return 'customer';
  }

  if (param.includes('subscription')) {
    return 'subscription';
  }

  const message = String(error?.message || error?.raw?.message || '').toLowerCase();

  if (message.includes('customer')) {
    return 'customer';
  }

  if (message.includes('subscription')) {
    return 'subscription';
  }

  return 'unknown';
}

function buildStripeResourceNotFoundResponse(error, selectedPlan) {
  return {
    error: 'STRIPE_RESOURCE_NOT_FOUND',
    resourceHint: getResourceHint(error),
    selectedPlan,
    stripeMode: getStripeMode(),
  };
}

async function createStripeCustomerForUser(stripe, user, stripeMode) {
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: {
      userId: String(user._id),
    },
  });

  setModeSpecificValue(user, stripeMode, 'customerId', customer.id);

  if (stripeMode === 'sk_live') {
    user.stripeCustomerId = customer.id;
  }

  user.billingUpdatedAt = new Date();
  await user.save();

  return customer.id;
}

async function resolveCheckoutCustomerId(stripe, user, selectedPlan, priceId, stripeMode) {
  const storedCustomer = getStoredStripeCustomerIdForMode(user, stripeMode);

  logCheckoutDiagnostics('Stripe checkout customer diagnostics.', selectedPlan, priceId, {
    storedCustomerIdExists: Boolean(storedCustomer.customerId),
    storedCustomerIdPrefix: getStripeIdPrefix(storedCustomer.customerId),
    storedCustomerIdLast4: getStripeIdLast4(storedCustomer.customerId),
    storedCustomerIdSource: storedCustomer.source,
  });

  if (storedCustomer.customerId) {
    try {
      const customer = await stripe.customers.retrieve(storedCustomer.customerId);

      if (customer?.deleted) {
        throw Object.assign(new Error('Stored Stripe customer was deleted.'), {
          code: 'resource_missing',
          param: 'customer',
        });
      }

      if (storedCustomer.isLegacyFallback) {
        setModeSpecificValue(user, stripeMode, 'customerId', storedCustomer.customerId);
        user.billingUpdatedAt = new Date();
        await user.save();
      }

      return storedCustomer.customerId;
    } catch (error) {
      if (error?.code !== 'resource_missing') {
        throw error;
      }

      logCheckoutDiagnostics('Stored Stripe customer missing in current mode; creating a replacement.', selectedPlan, priceId, {
        storedCustomerIdPrefix: getStripeIdPrefix(storedCustomer.customerId),
        storedCustomerIdLast4: getStripeIdLast4(storedCustomer.customerId),
        storedCustomerIdSource: storedCustomer.source,
      });
    }
  }

  return createStripeCustomerForUser(stripe, user, stripeMode);
}

async function resolvePortalCustomerId(stripe, user, stripeMode) {
  const storedCustomer = getStoredStripeCustomerIdForMode(user, stripeMode);

  if (!storedCustomer.customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(storedCustomer.customerId);

    if (customer?.deleted) {
      return null;
    }

    if (storedCustomer.isLegacyFallback) {
      setModeSpecificValue(user, stripeMode, 'customerId', storedCustomer.customerId);
      user.billingUpdatedAt = new Date();
      await user.save();
    }

    return storedCustomer.customerId;
  } catch (error) {
    if (error?.code === 'resource_missing') {
      console.info('Stripe portal customer missing in current mode.', {
        stripeMode,
        storedCustomerIdExists: true,
        storedCustomerIdPrefix: getStripeIdPrefix(storedCustomer.customerId),
        storedCustomerIdLast4: getStripeIdLast4(storedCustomer.customerId),
        storedCustomerIdSource: storedCustomer.source,
      });
      return null;
    }

    throw error;
  }
}

async function updateUserFromSubscription(subscription, stripeMode = getStripeMode()) {
  const stripeCustomerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;
  const stripeSubscriptionId = subscription.id;
  const userId = subscription.metadata?.userId;

  if (!stripeCustomerId && !stripeSubscriptionId && !userId) {
    return null;
  }

  const nextPlan = planForSubscription(subscription);

  if (!nextPlan) {
    return null;
  }

  const update = {
    plan: nextPlan,
    subscriptionStatus: subscription.status,
    billingUpdatedAt: new Date(),
  };
  setModeSpecificValue(update, stripeMode, 'subscriptionStatus', subscription.status);

  const periodEnd = subscriptionPeriodEnd(subscription);
  const unset = {};
  const isCanceled = subscription.status === 'canceled' || subscription.status === 'incomplete_expired';

  if (stripeCustomerId) {
    setModeSpecificValue(update, stripeMode, 'customerId', stripeCustomerId);

    if (stripeMode === 'sk_live') {
      update.stripeCustomerId = stripeCustomerId;
    }
  }

  if (!isCanceled && stripeSubscriptionId) {
    setModeSpecificValue(update, stripeMode, 'subscriptionId', stripeSubscriptionId);

    if (stripeMode === 'sk_live') {
      update.stripeSubscriptionId = stripeSubscriptionId;
    }
  }

  if (!isCanceled && periodEnd) {
    update.subscriptionCurrentPeriodEnd = periodEnd;
    setModeSpecificValue(update, stripeMode, 'currentPeriodEnd', periodEnd);
  } else if (nextPlan === 'free') {
    unset.subscriptionCurrentPeriodEnd = '';
    unsetModeSpecificValue(unset, stripeMode, 'currentPeriodEnd');
  }

  if (isCanceled) {
    unsetModeSpecificValue(unset, stripeMode, 'subscriptionId');

    if (stripeMode === 'sk_live') {
      unset.stripeSubscriptionId = '';
    }
  }

  const lookup = buildStripeUserLookup({
    stripeCustomerId,
    stripeSubscriptionId,
    userId,
    stripeMode,
  });

  if (!lookup.length) {
    return null;
  }

  const user = await User.findOneAndUpdate(
    {
      $or: lookup,
    },
    {
      $set: update,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { new: true }
  );

  await unpublishIfPlanIsFree(user);

  return user;
}

async function updateUserFromCheckoutSession(session, stripe, stripeMode = getStripeMode()) {
  const stripeCustomerId =
    typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const stripeSubscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
  const userId = session.metadata?.userId;

  if (!stripeCustomerId && !userId) {
    return null;
  }

  if (stripeSubscriptionId && stripe) {
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    return updateUserFromSubscription(subscription, stripeMode);
  }

  const update = {
    billingUpdatedAt: new Date(),
  };

  if (stripeCustomerId) {
    setModeSpecificValue(update, stripeMode, 'customerId', stripeCustomerId);

    if (stripeMode === 'sk_live') {
      update.stripeCustomerId = stripeCustomerId;
    }
  }

  if (stripeSubscriptionId) {
    setModeSpecificValue(update, stripeMode, 'subscriptionId', stripeSubscriptionId);

    if (stripeMode === 'sk_live') {
      update.stripeSubscriptionId = stripeSubscriptionId;
    }
  }

  const lookup = buildStripeUserLookup({
    stripeCustomerId,
    stripeSubscriptionId,
    userId,
    stripeMode,
  });

  if (!lookup.length) {
    return null;
  }

  const user = await User.findOneAndUpdate(
    {
      $or: lookup,
    },
    {
      $set: update,
    },
    { new: true }
  );

  await unpublishIfPlanIsFree(user);

  return user;
}

async function updateUserFromInvoice(invoice, status, stripeMode = getStripeEventMode(invoice)) {
  const stripeCustomerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const stripeSubscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id;
  const userId = invoice.subscription_details?.metadata?.userId;

  if (!stripeCustomerId && !stripeSubscriptionId && !userId) {
    return null;
  }

  const nextPlan = planForInvoiceStatus(status, invoice);

  if (!nextPlan) {
    return null;
  }

  const update = {
    subscriptionStatus: status,
    plan: nextPlan,
    billingUpdatedAt: new Date(),
  };
  setModeSpecificValue(update, stripeMode, 'subscriptionStatus', status);

  if (stripeCustomerId) {
    setModeSpecificValue(update, stripeMode, 'customerId', stripeCustomerId);

    if (stripeMode === 'sk_live') {
      update.stripeCustomerId = stripeCustomerId;
    }
  }

  if (stripeSubscriptionId) {
    setModeSpecificValue(update, stripeMode, 'subscriptionId', stripeSubscriptionId);

    if (stripeMode === 'sk_live') {
      update.stripeSubscriptionId = stripeSubscriptionId;
    }
  }

  const unset = {};
  const periodEnd = invoicePeriodEnd(invoice);

  if (nextPlan === 'free') {
    unset.subscriptionCurrentPeriodEnd = '';
    unsetModeSpecificValue(unset, stripeMode, 'currentPeriodEnd');
  } else if (periodEnd) {
    update.subscriptionCurrentPeriodEnd = periodEnd;
    setModeSpecificValue(update, stripeMode, 'currentPeriodEnd', periodEnd);
  }

  const lookup = buildStripeUserLookup({
    stripeCustomerId,
    stripeSubscriptionId,
    userId,
    stripeMode,
  });

  if (!lookup.length) {
    return null;
  }

  const user = await User.findOneAndUpdate(
    {
      $or: lookup,
    },
    {
      $set: update,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    },
    { new: true }
  );

  await unpublishIfPlanIsFree(user);

  return user;
}

router.post('/webhook', stripeWebhookRateLimit, express.raw({ type: 'application/json' }), async (req, res) => {
  const configError = getConfigError('webhook', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);

  if (configError) {
    return res.status(503).json({ message: configError.message });
  }

  const { stripe, webhookSecret } = getBillingConfig();

  if (!stripe || !webhookSecret) {
    return res.status(503).json({ message: 'Stripe webhook is not configured.' });
  }

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    return res.status(400).json({ message: 'Webhook signature verification failed.' });
  }

  try {
    if (!event.id) {
      return res.status(400).json({ message: 'Invalid webhook event.' });
    }

    if (!(await claimStripeWebhookEvent(event))) {
      return res.json({ received: true });
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await updateUserFromCheckoutSession(event.data.object, stripe, getStripeEventMode(event));
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await updateUserFromSubscription(event.data.object, getStripeEventMode(event));
        break;
      case 'invoice.paid':
        await updateUserFromInvoice(event.data.object, 'active', getStripeEventMode(event));
        break;
      case 'invoice.payment_failed':
        await updateUserFromInvoice(event.data.object, 'past_due', getStripeEventMode(event));
        break;
      default:
        break;
    }

    await markStripeWebhookEventProcessed(event);
    return res.json({ received: true });
  } catch (error) {
    if (event && event.id) {
      await markStripeWebhookEventFailed(event).catch(() => {});
    }
    logBillingError('Stripe webhook handling failed.', error);
    return res.status(500).json({ message: 'Stripe webhook handling failed.' });
  }
});

router.use(express.json());

router.get('/config', authMiddleware, async (req, res) => {
  return res.json({
    ok: true,
    ...buildSafeBillingConfigDiagnostics(),
  });
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await findCurrentUser(req, res);

    if (!user) {
      return null;
    }

    return res.json(await serializeBilling(user));
  } catch (error) {
    logBillingError('Billing lookup failed.', error);
    return res.status(500).json({ message: 'Unable to load billing details.' });
  }
});

router.post('/checkout', authMiddleware, billingMutationRateLimit, async (req, res) => {
  const requestedPlan = String(req.body?.plan || req.body?.targetPlan || 'pro').toLowerCase();

  if (!['pro', 'business'].includes(requestedPlan)) {
    return res.status(400).json({ message: 'Invalid billing plan.' });
  }

  const configError = getConfigError('checkout', [
    'STRIPE_SECRET_KEY',
    'STRIPE_PRO_PRICE_ID',
    'STRIPE_BUSINESS_PRICE_ID',
    'FRONTEND_URL',
  ]);

  if (configError) {
    return res.status(503).json({ message: configError.message });
  }

  const { stripe, priceIds } = getBillingConfig();
  const priceId = priceIds[requestedPlan];
  const priceEnvVar = PLAN_PRICE_ENV_NAMES[requestedPlan];

  if (!stripe || !priceId) {
    return res.status(503).json({ message: 'Stripe checkout is not configured.' });
  }

  try {
    const stripeMode = getStripeMode();
    logCheckoutDiagnostics('Stripe checkout diagnostics.', requestedPlan, priceId);
    await retrieveStripeAccountId(stripe, requestedPlan, priceId);

    let configuredPrice;

    try {
      configuredPrice = await retrieveConfiguredPrice(stripe, requestedPlan, priceId);
    } catch (error) {
      if (error?.code === 'resource_missing') {
        return res.status(400).json(buildStripePriceNotFoundResponse(requestedPlan));
      }

      throw error;
    }

    const user = await findCurrentUser(req, res);

    if (!user) {
      return null;
    }

    const stripeCustomerId = await resolveCheckoutCustomerId(
      stripe,
      user,
      requestedPlan,
      priceId,
      stripeMode
    );

    logCheckoutDiagnostics('Stripe checkout create input diagnostics.', requestedPlan, priceId, {
      priceRetrieveSucceeded: Boolean(configuredPrice?.id),
      priceActive: Boolean(configuredPrice?.active),
      priceCurrency: configuredPrice?.currency || null,
      priceRecurringInterval: configuredPrice?.recurring?.interval || null,
      customerIdPrefix: getStripeIdPrefix(stripeCustomerId),
      customerIdLast4: getStripeIdLast4(stripeCustomerId),
      lineItemCount: 1,
      customerEmailProvided: false,
      subscriptionProvided: false,
    });

    const frontendUrl = getFrontendUrl();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/projects.html?billing=success`,
      cancel_url: `${frontendUrl}/pricing?billing=cancelled`,
      metadata: {
        userId: String(user._id),
        plan: requestedPlan,
      },
      subscription_data: {
        metadata: {
          userId: String(user._id),
          plan: requestedPlan,
        },
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    logBillingError('Stripe checkout session creation failed.', error);

    if (error?.code === 'resource_missing') {
      return res.status(400).json(buildStripeResourceNotFoundResponse(error, requestedPlan));
    }

    return res.status(500).json({
      message: 'Unable to create checkout session.',
      selectedPlan: requestedPlan,
      envVar: priceEnvVar,
    });
  }
});

router.post('/portal', authMiddleware, billingMutationRateLimit, async (req, res) => {
  const configError = getConfigError('portal', ['STRIPE_SECRET_KEY', 'FRONTEND_URL']);

  if (configError) {
    return res.status(503).json({ message: configError.message });
  }

  const { stripe } = getBillingConfig();

  if (!stripe) {
    return res.status(503).json({ message: 'Stripe portal is not configured.' });
  }

  try {
    const user = await findCurrentUser(req, res);

    if (!user) {
      return null;
    }

    const stripeMode = getStripeMode();
    const stripeCustomerId = await resolvePortalCustomerId(stripe, user, stripeMode);

    if (!stripeCustomerId) {
      return res.status(400).json({ message: 'No Stripe customer is linked to this user.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${getFrontendUrl()}/projects.html`,
    });

    return res.json({ url: session.url });
  } catch (error) {
    logBillingError('Stripe portal session creation failed.', error);

    if (error?.code === 'resource_missing') {
      return res.status(400).json({
        error: 'STRIPE_RESOURCE_NOT_FOUND',
        resourceHint: getResourceHint(error),
        stripeMode: getStripeMode(),
      });
    }

    return res.status(500).json({ message: 'Unable to create billing portal session.' });
  }
});

module.exports = router;
module.exports.stripeWebhookTestHelpers = {
  claimStripeWebhookEvent,
};
