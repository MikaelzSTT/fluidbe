const express = require('express');
const Stripe = require('stripe');
const User = require('../models/User');
const authMiddleware = require('../middleware/authMiddleware');
const { unpublishActiveProjectsForUser } = require('../utils/projectPublication');

const router = express.Router();

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'https://askfluid.now').replace(/\/+$/, '');
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
    priceId: process.env.STRIPE_PRO_PRICE_ID,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  };
}

function serializeBilling(user) {
  return {
    plan: user.plan || 'free',
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
    subscriptionStatus: user.subscriptionStatus || null,
    subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd || null,
    billingUpdatedAt: user.billingUpdatedAt || null,
  };
}

function subscriptionPeriodEnd(subscription) {
  const periodEnd =
    subscription.current_period_end ||
    subscription.items?.data?.[0]?.current_period_end ||
    null;

  return periodEnd ? new Date(periodEnd * 1000) : undefined;
}

function planForSubscriptionStatus(status) {
  return status === 'active' || status === 'trialing' ? 'pro' : 'free';
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

  const update = {
    plan: planForSubscriptionStatus(subscription.status),
    subscriptionStatus: subscription.status,
    stripeSubscriptionId,
    billingUpdatedAt: new Date(),
  };
  const periodEnd = subscriptionPeriodEnd(subscription);

  if (stripeCustomerId) {
    update.stripeCustomerId = stripeCustomerId;
  }

  if (periodEnd) {
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
    { $set: update },
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

  const user = await User.findOneAndUpdate(
    {
      $or: [
        ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
        ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
        ...(userId ? [{ _id: userId }] : []),
      ],
    },
    {
      $set: {
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
        ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
        subscriptionStatus: status,
        plan: planForSubscriptionStatus(status),
        billingUpdatedAt: new Date(),
      },
    },
    { new: true }
  );

  await unpublishIfPlanIsFree(user);

  return user;
}

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
    console.error('Stripe webhook handling failed:', error);
    return res.status(500).json({ message: 'Stripe webhook handling failed.' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await findCurrentUser(req, res);

    if (!user) {
      return null;
    }

    return res.json(serializeBilling(user));
  } catch (error) {
    console.error('Billing lookup failed:', error);
    return res.status(500).json({ message: 'Unable to load billing details.' });
  }
});

router.post('/checkout', authMiddleware, async (req, res) => {
  const { stripe, priceId } = getBillingConfig();

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
      },
      subscription_data: {
        metadata: {
          userId: String(user._id),
        },
      },
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout session creation failed:', error);
    return res.status(500).json({ message: 'Unable to create checkout session.' });
  }
});

router.post('/portal', authMiddleware, async (req, res) => {
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
    console.error('Stripe portal session creation failed:', error);
    return res.status(500).json({ message: 'Unable to create billing portal session.' });
  }
});

module.exports = router;
