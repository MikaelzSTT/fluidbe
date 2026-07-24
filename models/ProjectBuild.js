const mongoose = require('mongoose');

const BUILD_TYPES = ['html', 'full_html', 'react_vite', 'backend'];
const BUILD_STATUSES = ['draft', 'in_progress', 'done', 'failed'];

const projectBuildSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
    },

    buildJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BuildJob',
      default: null,
    },

    type: {
      type: String,
      enum: BUILD_TYPES,
      required: true,
      default: 'html',
    },

    status: {
      type: String,
      enum: BUILD_STATUSES,
      required: true,
      default: 'draft',
    },

    html: {
      type: String,
      default: '',
    },

    css: {
      type: String,
      default: '',
    },

    js: {
      type: String,
      default: '',
    },

    fullHtml: {
      type: String,
      default: '',
    },

    distUrl: {
      type: String,
      default: '',
    },

    previewUrl: {
      type: String,
      default: '',
    },

    buildUrl: {
      type: String,
      default: '',
    },

    deployUrl: {
      type: String,
      default: '',
    },

    sourceZipUrl: {
      type: String,
      default: '',
    },

    artifactFiles: {
      type: [
        {
          relativePath: {
            type: String,
            default: '',
          },
          path: {
            type: String,
            default: '',
          },
          mimeType: {
            type: String,
            default: '',
          },
          contentType: {
            type: String,
            default: 'application/octet-stream',
          },
          encoding: {
            type: String,
            enum: ['base64'],
            default: 'base64',
          },
          content: {
            type: String,
            required: true,
          },
          sha256: {
            type: String,
            default: '',
          },
          byteLength: {
            type: Number,
            default: 0,
            min: 0,
          },
        },
      ],
      default: [],
    },

    sourceFiles: {
      type: [
        {
          relativePath: {
            type: String,
            default: '',
          },
          path: {
            type: String,
            default: '',
          },
          mimeType: {
            type: String,
            default: '',
          },
          contentType: {
            type: String,
            default: 'application/octet-stream',
          },
          encoding: {
            type: String,
            enum: ['base64'],
            default: 'base64',
          },
          content: {
            type: String,
            required: true,
          },
          sha256: {
            type: String,
            default: '',
          },
          byteLength: {
            type: Number,
            default: 0,
            min: 0,
          },
        },
      ],
      default: [],
    },

    sourceSummary: {
      type: String,
      default: '',
    },

    indexedFiles: {
      type: [
        {
          _id: false,
          path: {
            type: String,
            required: true,
          },
          kind: {
            type: String,
            required: true,
          },
          size: {
            type: Number,
            required: true,
            min: 0,
          },
          excerpt: {
            type: String,
            default: '',
          },
        },
      ],
      default: [],
    },

    artifactFilesSource: {
      type: [
        {
          relativePath: {
            type: String,
            default: '',
          },
          path: {
            type: String,
            default: '',
          },
          mimeType: {
            type: String,
            default: '',
          },
          contentType: {
            type: String,
            default: 'application/octet-stream',
          },
          encoding: {
            type: String,
            enum: ['base64'],
            default: 'base64',
          },
          content: {
            type: String,
            required: true,
          },
          sha256: {
            type: String,
            default: '',
          },
          byteLength: {
            type: Number,
            default: 0,
            min: 0,
          },
        },
      ],
      default: [],
    },

    logs: {
      type: mongoose.Schema.Types.Mixed,
      default: '',
    },
  },
  { timestamps: true }
);

projectBuildSchema.index({ projectId: 1, status: 1, createdAt: -1, updatedAt: -1, _id: -1 });
projectBuildSchema.index({ projectId: 1, createdAt: -1, updatedAt: -1, _id: -1 });
projectBuildSchema.index({ projectId: 1, updatedAt: -1, createdAt: -1, _id: -1 });

module.exports = mongoose.model('ProjectBuild', projectBuildSchema);
module.exports.BUILD_TYPES = BUILD_TYPES;
module.exports.BUILD_STATUSES = BUILD_STATUSES;
