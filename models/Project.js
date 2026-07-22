const mongoose = require('mongoose');
const { buildPublishedProjectUrl } = require('../utils/previewOrigin');

const projectSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    title: {
      type: String,
      default: '',
      trim: true,
    },

    appName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 24,
    },

    appNameSource: {
      type: String,
      enum: ['user', 'generated', 'manual', 'unknown'],
      default: 'unknown',
    },

    appNameLocked: {
      type: Boolean,
      default: false,
    },

    slug: {
      type: String,
      trim: true,
      lowercase: true,
    },

    publishedAt: {
      type: Date,
      default: null,
    },

    isPublished: {
      type: Boolean,
      default: false,
    },

    runtimeEnabled: {
      type: Boolean,
      default: false,
    },

    visibility: {
      type: String,
      enum: ['public'],
      default: 'public',
    },

    seo: {
      title: {
        type: String,
        trim: true,
        maxlength: 60,
      },
      description: {
        type: String,
        trim: true,
        maxlength: 160,
      },
      socialImage: {
        type: String,
        trim: true,
      },
    },

    description: {
      type: String,
      default: '',
    },

    type: {
      type: String,
      default: 'web-app',
    },

    status: {
      type: String,
      enum: ['draft', 'building', 'published', 'archived', 'pending', 'in_progress', 'done'],
      default: 'draft',
    },

    buildMode: {
      type: String,
      enum: ['manual', 'assisted', 'automatic'],
      default: 'manual',
    },

    generationStatus: {
      type: String,
      enum: ['pending', 'in_progress', 'done'],
    },

    generation_status: {
      type: String,
      enum: ['pending', 'in_progress', 'done'],
      default: 'pending',
    },

    response: {
      type: String,
      default: '',
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

    latestFullHtml: {
      type: String,
      default: '',
    },

    summary: {
      type: String,
      default: '',
    },

    publish: {
      type: Boolean,
      default: false,
    },

    prompt: {
      type: String,
      default: '',
    },

    briefing: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    pages: {
      type: Array,
      default: [],
    },

    components: {
      type: Array,
      default: [],
    },

    files: {
      type: Array,
      default: [],
    },

    settings: {
      theme: {
        type: String,
        default: 'light',
      },
      primaryColor: {
        type: String,
        default: '#2563eb',
      },
      language: {
        type: String,
        default: 'pt-BR',
      },
    },

    deploy: {
      isPublished: {
        type: Boolean,
        default: false,
      },
      url: {
        type: String,
        default: '',
      },
      provider: {
        type: String,
        default: '',
      },
      publishedAt: {
        type: Date,
        default: null,
      },
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

    latestPublishedBuildId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectBuild',
      default: null,
    },

    reactVite: {
      type: Boolean,
      default: false,
    },

    build: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    requiredConnectors: {
      type: [
        {
          provider: {
            type: String,
            required: true,
            trim: true,
          },
          label: {
            type: String,
            default: '',
            trim: true,
          },
          reason: {
            type: String,
            default: '',
          },
          status: {
            type: String,
            enum: ['pending', 'connected', 'skipped', 'error'],
            default: 'pending',
          },
          createdAt: {
            type: Date,
            default: Date.now,
          },
          updatedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    metadata: {
      lastPromptAt: {
        type: Date,
        default: null,
      },
      lastBuildAt: {
        type: Date,
        default: null,
      },
      buildCount: {
        type: Number,
        default: 0,
      },
    },

    ownerDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    accountDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    ownerDeletedAt: {
      type: Date,
      default: null,
    },

    accountDeletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

projectSchema.index({ slug: 1 }, { unique: true, sparse: true });

projectSchema.virtual('publicUrl').get(function getPublicUrl() {
  return this.slug ? buildPublishedProjectUrl(this.slug) : '';
});

module.exports = mongoose.model('Project', projectSchema);
