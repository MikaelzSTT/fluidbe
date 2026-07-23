const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      default: null,
      immutable: true,
    },
    actorType: {
      type: String,
      enum: ['admin_user', 'legacy_token', 'user'],
      required: true,
      immutable: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    resourceType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      immutable: true,
    },
    resourceId: {
      type: String,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
    result: {
      type: String,
      enum: ['pending', 'success', 'failure'],
      required: true,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    requestHash: {
      type: String,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    statusCode: {
      type: Number,
      immutable: true,
    },
    requestId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      immutable: true,
    },
    ip: {
      type: String,
      trim: true,
      maxlength: 64,
      immutable: true,
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: 180,
      immutable: true,
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 120,
      immutable: true,
    },
  },
  {
    timestamps: { createdAt: 'timestamp', updatedAt: false },
    versionKey: false,
  }
);

function blockMutation(next) {
  next(new Error('Admin audit logs are append-only.'));
}

adminAuditLogSchema.pre('updateOne', blockMutation);
adminAuditLogSchema.pre('updateMany', blockMutation);
adminAuditLogSchema.pre('findOneAndUpdate', blockMutation);
adminAuditLogSchema.pre('deleteOne', blockMutation);
adminAuditLogSchema.pre('deleteMany', blockMutation);
adminAuditLogSchema.pre('findOneAndDelete', blockMutation);

adminAuditLogSchema.index(
  { idempotencyKey: 1, result: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $exists: true },
      result: { $in: ['pending', 'success'] },
    },
  }
);

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
