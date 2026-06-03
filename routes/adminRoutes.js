const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');

const router = express.Router();

const WIZARD_STATUSES = ['pending', 'in_progress', 'done'];

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ message: 'Admin não autorizado' });
  }

  return next();
}

function validateProjectId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: 'ID de projeto inválido.' });
  }

  return next();
}

router.get('/projects', requireAdmin, async (req, res) => {
  try {
    const projects = await Project.find().sort({
      updatedAt: -1,
      createdAt: -1,
    });

    return res.json({
      success: true,
      projects,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar projetos.',
      error: error.message,
    });
  }
});

router.get('/projects/:id/versions', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    const ProjectVersion = mongoose.models.ProjectVersion;

    if (!ProjectVersion) {
      return res.json({
        success: true,
        versions: [],
      });
    }

    const versions = await ProjectVersion.find({ projectId: req.params.id }).sort({
      createdAt: -1,
    });

    return res.json({
      success: true,
      versions,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao buscar versões do projeto.',
      error: error.message,
    });
  }
});

router.patch('/projects/:id/manual', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const {
      title,
      response,
      html,
      css,
      js,
      fullHtml,
      latestFullHtml,
      summary,
      status,
      publish,
      distUrl,
      previewUrl,
      buildUrl,
      deploy,
      reactVite,
      build,
    } = req.body;
    const update = {};
    const setIfDefined = (field, value) => {
      if (value !== undefined) {
        update[field] = value;
      }
    };

    if (title !== undefined) {
      update.title = title;
      update.name = title;
    }

    setIfDefined('response', response);
    setIfDefined('html', html);
    setIfDefined('css', css);
    setIfDefined('js', js);
    setIfDefined('fullHtml', fullHtml);
    setIfDefined('latestFullHtml', latestFullHtml !== undefined ? latestFullHtml : fullHtml);
    setIfDefined('summary', summary);
    setIfDefined('distUrl', distUrl);
    setIfDefined('previewUrl', previewUrl);
    setIfDefined('buildUrl', buildUrl);
    setIfDefined('deploy', deploy);
    setIfDefined('reactVite', reactVite);
    setIfDefined('build', build);

    if (status !== undefined) {
      if (!WIZARD_STATUSES.includes(status)) {
        return res.status(400).json({
          message: 'Status inválido.',
          allowedStatuses: WIZARD_STATUSES,
        });
      }

      update.status = status;
      update.generation_status = status;
    }

    if (publish !== undefined) {
      update.publish = publish === true;

      if (publish === true) {
        update.status = 'done';
        update.generation_status = 'done';
        update['deploy.isPublished'] = true;
        update['deploy.publishedAt'] = new Date();
        update['metadata.lastBuildAt'] = new Date();
      }
    }

    const project = await Project.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!project) {
      return res.status(404).json({ message: 'Projeto não encontrado.' });
    }

    return res.json({
      success: true,
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar projeto manualmente.',
      error: error.message,
    });
  }
});

router.patch('/projects/:id/status', requireAdmin, validateProjectId, async (req, res) => {
  try {
    const { status } = req.body;

    if (!WIZARD_STATUSES.includes(status)) {
      return res.status(400).json({
        message: 'Status inválido.',
        allowedStatuses: WIZARD_STATUSES,
      });
    }

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      {
        status,
        generation_status: status,
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
      success: true,
      project,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Erro ao atualizar status do projeto.',
      error: error.message,
    });
  }
});

module.exports = router;
