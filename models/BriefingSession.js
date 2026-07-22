const mongoose = require('mongoose');

const BRIEFING_SESSION_STATUSES = ['active', 'completed', 'expired'];

const briefingSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    conversationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    status: {
      type: String,
      enum: BRIEFING_SESSION_STATUSES,
      default: 'active',
      required: true,
      index: true,
    },

    briefing: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    briefingSummary: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    structuredAnswers: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    sourcePrompt: {
      type: String,
      default: '',
      trim: true,
      maxlength: 20_000,
    },

    complete: {
      type: Boolean,
      default: false,
    },

    canBuild: {
      type: Boolean,
      default: false,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      default: null,
      index: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

briefingSessionSchema.index({ userId: 1, conversationId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.model('BriefingSession', briefingSessionSchema);
module.exports.BRIEFING_SESSION_STATUSES = BRIEFING_SESSION_STATUSES;
