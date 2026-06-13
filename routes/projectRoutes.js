const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const ProjectBuild = require('../models/ProjectBuild');
const ProjectMessage = require('../models/ProjectMessage');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();
const CONNECTOR_RULES = [
  {
    provider: 'stripe',
    label: 'Stripe',
    reason: 'Necessário para pagamentos por cartão, checkout ou assinaturas.',
    patterns: [/\bpagament\w*\b/, /\bcartao\b/, /\bcartoes\b/, /\bcheckout\b/, /\bassinat\w*\b/, /\bloja\b/, /\bmarketplace\b/, /\bcorrida paga\b/],
  },
  {
    provider: 'google_maps',
    label: 'Google Maps',
    reason: 'Necessário para mapas, localização, rotas ou endereços.',
    patterns: [/\bmapa\w*\b/, /\blocaliz\w*\b/, /\brota\w*\b/, /\bentrega\w*\b/, /\buber\b/, /\bdelivery\b/, /\bmotorista\w*\b/, /\bendereco\w*\b/],
  },
  {
    provider: 'resend',
    label: 'Resend',
    reason: 'Necessário para envio de emails, recibos ou formulários de contato.',
    patterns: [/\bemail\w*\b/, /\be-mail\w*\b/, /\bnotificacao por email\b/, /\bnotificacoes por email\b/, /\brecibo\w*\b/, /\bformulario de contato\b/, /\bformularios de contato\b/],
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    reason: 'Necessário para login, banco de dados, usuários, dados salvos ou storage.',
    patterns: [/\blogin\b/, /\bbanco de dados\b/, /\bdashboard\b/, /\bcrm\b/, /\busuario\w*\b/, /\bdados salvos\b/, /\bstorage\b/],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    reason: 'Necessário para recursos de IA, chatbot, assistente ou geração por IA.',
    patterns: [/\bia\b/, /\bchatbot\w*\b/, /\bassistente\w*\b/, /\bgeracao por ia\b/, /\bgerar por ia\b/],
  },
  {
    provider: 'cloudinary',
    label: 'Cloudinary',
    reason: 'Necessário para upload e gerenciamento de imagens.',
    patterns: [/\bupload de imagen\w*\b/, /\bupload de foto\w*\b/, /\bfoto\w*\b/, /\bavatar\w*\b/, /\bproduto\w* com imagen\w*\b/],
  },
  {
    provider: 'backend',
    label: 'Backend',
    reason: 'Necessário para APIs, pedidos, corridas, status, realtime ou autenticação complexa.',
    patterns: [/\bbackend\b/, /\bapi\b/, /\bapis\b/, /\bpedido\w*\b/, /\bcorrida\w*\b/, /\bstatus\b/, /\brealtime\b/, /\btempo real\b/, /\bautenticacao complexa\b/],
  },
];

function normalizeConnectorText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConnectorProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function sanitizeRequiredConnector(connector) {
  if (!connector || typeof connector !== 'object') {
    return null;
  }

  const provider = normalizeConnectorProvider(connector.provider);

  if (!provider) {
    return null;
  }

  return {
    provider,
    label: String(connector.label || provider).replace(/\s+/g, ' ').trim(),
    reason: String(connector.reason || '').replace(/\s+/g, ' ').trim(),
    status: ['pending', 'connected', 'skipped'].includes(connector.status)
      ? connector.status
      : 'pending',
  };
}

function detectInitialRequiredConnectors({ name, description, prompt, requiredConnectors }) {
  const detectedConnectors = [];
  const seenProviders = new Set();
  const detectionText = normalizeConnectorText([name, description, prompt].filter(Boolean).join('\n'));

  CONNECTOR_RULES.forEach((rule) => {
    if (!detectionText || !rule.patterns.some((pattern) => pattern.test(detectionText))) {
      return;
    }

    seenProviders.add(rule.provider);
    detectedConnectors.push({
      provider: rule.provider,
      label: rule.label,
      reason: rule.reason,
      status: 'pending',
    });
  });

  (Array.isArray(requiredConnectors) ? requiredConnectors : []).forEach((connector) => {
    const sanitized = sanitizeRequiredConnector(connector);

    if (!sanitized || seenProviders.has(sanitized.provider)) {
      return;
    }

    seenProviders.add(sanitized.provider);
    detectedConnectors.push(sanitized);
  });

  return detectedConnectors;
}

function getBackendBaseUrl(req) {
  const configuredBaseUrl =
    process.env.BACKEND_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    '';

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  return `${req.protocol}://${req.get('host')}`;
}

function toAbsoluteBackendUrl(req, value) {
  if (typeof value !== 'string' || !value) {
    return value || '';
  }

  if (!value.startsWith('/builds/')) {
    return value;
  }

  return new URL(value, `${getBackendBaseUrl(req)}/`).toString();
}

function withAbsoluteBuildUrls(req, value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const payload =
    typeof value.toObject === 'function'
      ? value.toObject({ getters: true, virtuals: true })
      : { ...value };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl', 'deployUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  return payload;
}

function withAbsoluteProjectBuildUrls(req, value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  const payload =
    typeof value.toObject === 'function'
      ? value.toObject({ getters: true, virtuals: true })
      : { ...value };

  for (const field of ['distUrl', 'previewUrl', 'buildUrl']) {
    payload[field] = toAbsoluteBackendUrl(req, payload[field]);
  }

  if (payload.build && typeof payload.build === 'object') {
    payload.build = withAbsoluteBuildUrls(req, payload.build);
  }

  return payload;
}

function getEffectiveBuildStatus(project) {
  return project.generationStatus || project.generation_status || project.status || 'pending';
}

function buildProjectPayload(req, projectDocument) {
  const project =
    typeof projectDocument.toObject === 'function'
      ? projectDocument.toObject({ getters: true, virtuals: true })
      : projectDocument;
  const effectiveStatus = getEffectiveBuildStatus(project);
  const fullHtml = project.fullHtml || project.latestFullHtml || '';
  const build = project.build && typeof project.build === 'object' ? project.build : {};
  const payload = {
    success: true,
    status: effectiveStatus,
    generationStatus: effectiveStatus,
    generation_status: effectiveStatus,
    project: withAbsoluteProjectBuildUrls(req, project),
  };

  if (effectiveStatus !== 'done') {
    return payload;
  }

  return {
    ...payload,
    response: project.response || '',
    summary: project.summary || '',
    html: project.html || '',
    css: project.css || '',
    js: project.js || '',
    fullHtml,
    latestFullHtml: project.latestFullHtml || fullHtml,
    distUrl: toAbsoluteBackendUrl(req, project.distUrl || build.distUrl || ''),
    previewUrl: toAbsoluteBackendUrl(req, project.previewUrl || build.previewUrl || ''),
    buildUrl: toAbsoluteBackendUrl(req, project.buildUrl || build.buildUrl || ''),
    deploy: project.deploy || {},
    reactVite: project.reactVite === true || build.reactVite === true,
    build: withAbsoluteBuildUrls(req, build),
  };
}

function buildDoneProjectBuildPayload(req, project, buildDocument) {
  const build =
    typeof buildDocument.toObject === 'function'
      ? buildDocument.toObject({ getters: true, virtuals: true })
      : buildDocument;

  return {
    success: true,
    status: 'done',
    generationStatus: 'done',
    generation_status: 'done',
    project: withAbsoluteProjectBuildUrls(req, project),
    build: withAbsoluteBuildUrls(req, build),
    html: build.html || '',
    css: build.css || '',
    js: build.js || '',
    fullHtml: build.fullHtml || '',
    latestFullHtml: build.fullHtml || '',
    distUrl: toAbsoluteBackendUrl(req, build.distUrl || ''),
    previewUrl: toAbsoluteBackendUrl(req, build.previewUrl || ''),
    buildUrl: toAbsoluteBackendUrl(req, build.buildUrl || build.deployUrl || build.previewUrl || build.distUrl || ''),
    deployUrl: toAbsoluteBackendUrl(req, build.deployUrl || ''),
    sourceZipUrl: build.sourceZipUrl || '',
    logs: build.logs || '',
    reactVite: build.type === 'react_vite',
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find({ userId: req.userId }).sort({
      createdAt: -1,
    });

    return res.json(projects);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings, requiredConnectors } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'Nome do projeto é obrigatório.' });
    }

    const project = await Project.create({
  userId: req.userId,
  name,
  description,
  status,
  prompt,
  type,
  settings,
  requiredConnectors: detectInitialRequiredConnectors({
    name,
    description,
    prompt,
    requiredConnectors,
  }),
});
    return res.status(201).json({
      message: 'Projeto criado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao criar projeto.',
      error: error.message,
    });
  }
});

router.get('/:id/build', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'ID de projeto inválido.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const latestDoneBuild = await ProjectBuild.findOne({
      projectId: project._id,
      status: 'done',
    }).sort({
      createdAt: -1,
      updatedAt: -1,
    });

    if (latestDoneBuild) {
      return res.json(buildDoneProjectBuildPayload(req, project, latestDoneBuild));
    }

    return res.json(buildProjectPayload(req, project));
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar build do projeto.',
      error: error.message,
    });
  }
});

router.get('/:id/messages', authMiddleware, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).select('_id');

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const messages = await ProjectMessage.find({
      projectId: project._id,
      role: { $in: ['user', 'assistant'] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .select('role content createdAt -_id')
      .lean();

    return res.json({
      success: true,
      messages,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar mensagens do projeto.',
      error: error.message,
    });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json(project);
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projeto.',
      error: error.message,
    });
  }
});

router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, status, prompt, type, settings } = req.body;

    const project = await Project.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.userId,
      },
      {
        name,
        description,
        status,
        prompt,
        type,
        settings,
        


      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto atualizado com sucesso.',
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar projeto.',
      error: error.message,
    });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      message: 'Projeto excluído com sucesso.',
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao excluir projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
