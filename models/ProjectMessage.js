const mongoose = require('mongoose');

const MESSAGE_ROLES = ['user', 'assistant', 'system'];

const projectMessageSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: MESSAGE_ROLES,
      required: true,
      index: true,
    },

    content: {
      type: String,
      required: true,
      trim: true,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
  }
);

projectMessageSchema.index({ projectId: 1, createdAt: 1 });

module.exports = mongoose.model('ProjectMessage', projectMessageSchema);
module.exports.MESSAGE_ROLES = MESSAGE_ROLES;
