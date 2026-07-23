const mongoose = require('mongoose');

const ADMIN_PERMISSIONS = Object.freeze([
  'admin:read',
  'admin:write',
  'admin:build',
  'admin:users',
  'admin:secrets',
]);

const adminUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
    permissions: {
      type: [String],
      enum: ADMIN_PERMISSIONS,
      default: [],
    },
    mfa: {
      enabled: {
        type: Boolean,
        default: false,
      },
      secretEnc: {
        type: String,
        default: '',
        select: false,
      },
      enabledAt: {
        type: Date,
      },
      recoveryCodes: [
        {
          hash: {
            type: String,
            required: true,
            select: false,
          },
          usedAt: {
            type: Date,
          },
        },
      ],
      lastVerifiedAt: {
        type: Date,
      },
    },
    failedLoginCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
    },
    lastLoginIpHash: {
      type: String,
      trim: true,
    },
    passwordChangedAt: {
      type: Date,
    },
    disabledAt: {
      type: Date,
    },
    disabledReason: {
      type: String,
      trim: true,
      maxlength: 160,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminUser', adminUserSchema);
module.exports.ADMIN_PERMISSIONS = ADMIN_PERMISSIONS;
