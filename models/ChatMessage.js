const mongoose = require('mongoose');
const { MESSAGE_ROLES } = require('./ProjectMessage');

const chatMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    sessionId: {
      type: String,
      required: true,
      trim: true,
    },

    role: {
      type: String,
      enum: MESSAGE_ROLES,
      required: true,
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

chatMessageSchema.index({ userId: 1, sessionId: 1, createdAt: 1, _id: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
