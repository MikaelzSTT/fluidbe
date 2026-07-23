const mongoose = require('mongoose');

const stripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
    },
    type: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: ['processing', 'processed', 'failed'],
      required: true,
      default: 'processing',
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

stripeWebhookEventSchema.index(
  { receivedAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { status: 'processed' },
  }
);

module.exports = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);
