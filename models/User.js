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

    profile: {
      displayName: {
        type: String,
        trim: true,
        maxlength: 80,
      },
      username: {
        type: String,
        trim: true,
        lowercase: true,
        maxlength: 32,
        index: {
          unique: true,
          sparse: true,
        },
      },
      bio: {
        type: String,
        trim: true,
        maxlength: 240,
      },
      website: {
        type: String,
        trim: true,
        maxlength: 120,
      },
      company: {
        type: String,
        trim: true,
        maxlength: 80,
      },
      location: {
        type: String,
        trim: true,
        maxlength: 80,
      },
      visibility: {
        type: String,
        enum: ['public', 'private'],
        default: 'public',
      },
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
      language: {
        type: String,
        enum: ['english', 'portuguese'],
        default: 'english',
      },
      appearance: {
        type: String,
        enum: ['light', 'dark', 'system'],
        default: 'system',
      },
      chatSuggestions: {
        type: Boolean,
        default: true,
      },
      soundOnComplete: {
        type: String,
        enum: ['first', 'always', 'never'],
        default: 'first',
      },
      autoSave: {
        type: Boolean,
        default: true,
      },
      confirmBeforeDelete: {
        type: Boolean,
        default: true,
      },
      compactMode: {
        type: Boolean,
        default: false,
      },
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
