const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: function requirePasswordForLocalUser() {
        return !Array.isArray(this.providers) || this.providers.includes('local');
      },
    },

    googleId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    avatar: {
      type: String,
      trim: true,
    },

    emailVerified: {
      type: Boolean,
      default: false,
    },

    providers: {
      type: [String],
      enum: ['local', 'google'],
      default: ['local'],
    },

    onboardingComplete: {
      type: Boolean,
      default: false,
    },

    plan: {
      type: String,
      enum: ['free', 'pro', 'business'],
      default: 'free',
    },

    stripeCustomerId: {
      type: String,
      trim: true,
      index: true,
    },

    stripeSubscriptionId: {
      type: String,
      trim: true,
      index: true,
    },

    subscriptionStatus: {
      type: String,
      trim: true,
    },

    subscriptionCurrentPeriodEnd: {
      type: Date,
    },

    billingUpdatedAt: {
      type: Date,
    },

    preferences: {
      theme: {
        type: String,
        trim: true,
      },
      displayName: {
        type: String,
        trim: true,
      },
      role: {
        type: String,
        trim: true,
      },
      goal: {
        type: String,
        trim: true,
      },
      completedAt: {
        type: Date,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
