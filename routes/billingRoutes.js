const express = require('express');
const Stripe = require('stripe');
const User = require('../models/User');
const Project = require('../models/Project');
const authMiddleware = require('../middleware/authMiddleware');
const { unpublishActiveProjectsForUser } = require('../utils/projectPublication');

const router = express.Router();

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
  'STRIPE_PRO_PRICE_ID',
  'STRIPE_BUSINESS_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
  'FRONTEND_URL',
]);
const loggedMissingBillingConfig = new Set();

function logBillingError(context, error) {
  console.error(context, {
    name: error?.name || 'Error',
    code: error?.code || null,
    status: error?.statusCode || error?.status || null,
  });
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

async function updateUserFromSubscription(subscription) {
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
  const periodEnd = subscriptionPeriodEnd(subscription);
  const unset = {};
  const isCanceled = subscription.status === 'canceled' || subscription.status === 'incomplete_expired';

  if (stripeCustomerId) {
    update.stripeCustomerId = stripeCustomerId;
  }

  if (!isCanceled && stripeSubscriptionId) {
    update.stripeSubscriptionId = stripeSubscriptionId;
  }

  if (!isCanceled && periodEnd) {
    update.subscriptionCurrentPeriodEnd = periodEnd;
  } else if (nextPlan === 'free') {
    unset.subscriptionCurrentPeriodEnd = '';
  }

  if (isCanceled) {
    unset.stripeSubscriptionId = '';
  }

  const user = await User.findOneAndUpdate(
    {
      $or: [
        ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
        ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
        ...(userId ? [{ _id: userId }] : []),
      ],
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

async function updateUserFromCheckoutSession(session, stripe) {
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
    return updateUserFromSubscription(subscription);
  }

  const user = await User.findOneAndUpdate(
    {
      $or: [
        ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
        ...(userId ? [{ _id: userId }] : []),
      ],
    },
    {
      $set: {
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
        ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
        billingUpdatedAt: new Date(),
      },
    },
    { new: true }
  );

  await unpublishIfPlanIsFree(user);

  return user;
}

async function updateUserFromInvoice(invoice, status) {
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
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
    ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
    subscriptionStatus: status,
    plan: nextPlan,
    billingUpdatedAt: new Date(),
  };
  const unset = {};
  const periodEnd = invoicePeriodEnd(invoice);

  if (nextPlan === 'free') {
    unset.subscriptionCurrentPeriodEnd = '';
  } else if (periodEnd) {
    update.subscriptionCurrentPeriodEnd = periodEnd;
  }

  const user = await User.findOneAndUpdate(
    {
      $or: [
        ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
        ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
        ...(userId ? [{ _id: userId }] : []),
      ],
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

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const configError = getConfigError('webhook', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);

  if (configError) {
    return res.status(503).json({ message: configError.message, missing: configError.missing });
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
    return res.status(400).json({ message: `Webhook signature verification failed: ${error.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await updateUserFromCheckoutSession(event.data.object, stripe);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await updateUserFromSubscription(event.data.object);
        break;
      case 'invoice.paid':
        await updateUserFromInvoice(event.data.object, 'active');
        break;
      case 'invoice.payment_failed':
        await updateUserFromInvoice(event.data.object, 'past_due');
        break;
      default:
        break;
    }

    return res.json({ received: true });
  } catch (error) {
    logBillingError('Stripe webhook handling failed.', error);
    return res.status(500).json({ message: 'Stripe webhook handling failed.' });
  }
});

router.use(express.json());

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

router.post('/checkout', authMiddleware, async (req, res) => {
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
    return res.status(503).json({ message: configError.message, missing: configError.missing });
  }

  const { stripe, priceIds } = getBillingConfig();
  const priceId = priceIds[requestedPlan];

  if (!stripe || !priceId) {
    return res.status(503).json({ message: 'Stripe checkout is not configured.' });
  }

  try {
    const user = await findCurrentUser(req, res);

    if (!user) {
      return null;
    }

    let stripeCustomerId = user.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          userId: String(user._id),
        },
      });

      stripeCustomerId = customer.id;
      user.stripeCustomerId = stripeCustomerId;
      user.billingUpdatedAt = new Date();
      await user.save();
    }

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
    return res.status(500).json({ message: 'Unable to create checkout session.' });
  }
});

router.post('/portal', authMiddleware, async (req, res) => {
  const configError = getConfigError('portal', ['STRIPE_SECRET_KEY', 'FRONTEND_URL']);

  if (configError) {
    return res.status(503).json({ message: configError.message, missing: configError.missing });
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

    if (!user.stripeCustomerId) {
      return res.status(400).json({ message: 'No Stripe customer is linked to this user.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${getFrontendUrl()}/projects.html`,
    });

    return res.json({ url: session.url });
  } catch (error) {
    logBillingError('Stripe portal session creation failed.', error);
    return res.status(500).json({ message: 'Unable to create billing portal session.' });
  }
});

module.exports = router;
