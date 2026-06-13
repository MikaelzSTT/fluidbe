const mongoose = require('mongoose');

const CHANGE_REQUEST_STATUSES = ['pending', 'in_progress', 'done', 'rejected'];

const projectChangeRequestSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectMessage',
      default: null,
      index: true,
    },

    assistantMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectMessage',
      default: null,
    },

    content: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: CHANGE_REQUEST_STATUSES,
      default: 'pending',
      index: true,
    },

    requiredConnectors: {
      type: [
        {
          provider: {
            type: String,
            required: true,
            trim: true,
          },
          label: {
            type: String,
            default: '',
            trim: true,
          },
          reason: {
            type: String,
            default: '',
          },
        },
      ],
      default: [],
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

projectChangeRequestSchema.index({ projectId: 1, status: 1, createdAt: -1 });
projectChangeRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ProjectChangeRequest', projectChangeRequestSchema);
module.exports.CHANGE_REQUEST_STATUSES = CHANGE_REQUEST_STATUSES;
