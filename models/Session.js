const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
  mfaVerifiedAt: {
    type: Date,
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

sessionSchema.index({ userId: 1, revokedAt: 1, createdAt: -1, expiresAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
