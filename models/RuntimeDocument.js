const mongoose = require('mongoose');

const runtimeDocumentSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },

    collection: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    collection: 'runtime_documents',
    timestamps: true,
  }
);

runtimeDocumentSchema.index({ projectId: 1, collection: 1, createdAt: -1 });
runtimeDocumentSchema.index({ projectId: 1, collection: 1, updatedAt: -1 });

module.exports = mongoose.model('RuntimeDocument', runtimeDocumentSchema);
