const mongoose = require('mongoose');

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

    reactVite: {
      type: Boolean,
      default: false,
    },

    build: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);
