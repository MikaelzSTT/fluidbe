const mongoose = require('mongoose');

const encryptedFieldSchema = new mongoose.Schema(
  {
    iv: {
      type: String,
      required: true,
    },
    tag: {
      type: String,
      required: true,
    },
    value: {
      type: String,
      required: true,
    },
    algorithm: {
      type: String,
      required: true,
      default: 'aes-256-gcm',
    },
  },
  { _id: false }
);

const connectorSecretSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    encryptedValues: {
      type: Map,
      of: encryptedFieldSchema,
      default: {},
    },
    fieldsMeta: {
      type: [
        {
          name: {
            type: String,
            required: true,
            trim: true,
          },
          label: {
            type: String,
            default: '',
            trim: true,
          },
          type: {
            type: String,
            default: '',
            trim: true,
          },
          required: {
            type: Boolean,
            default: false,
          },
          configured: {
            type: Boolean,
            default: true,
          },
        },
      ],
      default: [],
    },
    lastUpdatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

connectorSecretSchema.index({ projectId: 1, userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('ConnectorSecret', connectorSecretSchema);
