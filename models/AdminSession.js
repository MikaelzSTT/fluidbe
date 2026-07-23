const mongoose = require('mongoose');

const adminSessionSchema = new mongoose.Schema({
  adminUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdminUser',
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

adminSessionSchema.index({ adminUserId: 1, revokedAt: 1, createdAt: -1, expiresAt: 1 });
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AdminSession', adminSessionSchema);
