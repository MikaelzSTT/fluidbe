const mongoose = require('mongoose');

const stripeWebhookEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
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
      index: true,
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

module.exports = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);
