const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  jti: {
    type: String,
    required: true,
    unique: true,
  },
  userAgent: {
    type: String,
    trim: true,
    maxlength: 512,
  },
  ipHash: {
    type: String,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  revokedAt: {
    type: Date,
    default: null,
  },
  revokedReason: {
    type: String,
    trim: true,
    default: null,
  },
});

sessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);
