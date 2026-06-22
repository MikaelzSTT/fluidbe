const mongoose = require('mongoose');

const BUILD_JOB_TYPES = ['react_vite'];
const BUILD_JOB_STATUSES = [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

const buildJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: BUILD_JOB_TYPES,
      required: true,
      default: 'react_vite',
    },

    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },

    projectBuildId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectBuild',
      required: true,
      index: true,
    },

    sourceGridFsFileId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    status: {
      type: String,
      enum: BUILD_JOB_STATUSES,
      required: true,
      default: 'queued',
      index: true,
    },

    attempt: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },

    claimedBy: {
      type: String,
      default: '',
    },

    leaseUntil: {
      type: Date,
      default: null,
    },

    queuedAt: {
      type: Date,
      default: Date.now,
    },

    startedAt: {
      type: Date,
      default: null,
    },

    finishedAt: {
      type: Date,
      default: null,
    },

    errorCode: {
      type: String,
      default: '',
    },

    errorMessage: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

buildJobSchema.index({ status: 1, queuedAt: 1 });
buildJobSchema.index({ leaseUntil: 1 });
buildJobSchema.index({ projectBuildId: 1, createdAt: -1 });

module.exports = mongoose.model('BuildJob', buildJobSchema);
module.exports.BUILD_JOB_TYPES = BUILD_JOB_TYPES;
module.exports.BUILD_JOB_STATUSES = BUILD_JOB_STATUSES;
